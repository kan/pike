# ターミナル実装ルール

PTY・シェル・xterm.js と、ターミナル上で動かすコーディングエージェントの補助。
実体は `src-tauri/src/pty/`、`src/components/tabs/TerminalTab.vue`、`src/composables/usePtyRouter.ts`、`src/composables/useTerminalInject.ts`。

## PTY / シェル対応
- WSL のコマンドは `bash -c`（非ログイン）で走るので、`.profile` が足すパスは効かない。ツールチェインの場所は `types.rs` の `WSL_EXTRA_PATH` に明示する（`/usr/local/go/bin` の抜けで Problems パネルの `go vet` が長らく無言の空振りをしていた）
- PTY 管理は `portable-pty` クレートを使う（ConPTY 対応済み）
- `pty_spawn` コマンドが `ShellConfig` に応じてシェルを起動:
  - WSL: `wsl.exe [-d distro] [--cd path] bash`
  - cmd: `cmd.exe`
  - PowerShell: `powershell.exe -NoLogo`
  - Git Bash: `C:\Program Files\Git\bin\bash.exe --login`（自動検出）
  - Unix（macOS / Linux）: `$SHELL` を **`-l`（ログインシェル）** で起動する。GUI プロセスの PATH は最小なので、rc / profile を読ませないとターミナルから何も呼べない（`.claude/rules/platform.md` の「PATH」）
- **シェル未指定（`None`）の既定は OS で変わる**。Windows は従来どおり WSL、macOS / Linux はログインシェル（`wsl.exe` が無いので WSL に落とすと即死する）
- 環境変数 `TERM=xterm-256color` を cmd 以外に設定
- リサイズは `pty.resize()` で PTY サイズを更新
- **xterm は端数の行を持てないので、余白は上下に振り分ける（#268）**: 高さは `rows × セル高` で、FitAddon は行数を floor する。`.terminal-inner` を何もしないコンテナにすると端数（最大でセル 1 行ぶん ≒ 20px）が全部下に溜まり、4 辺 10px のはずの余白が下だけ広く見える。flex の `justify-content: center` で上下に割る。横も同じ理屈で余るが、セル幅は 8px 程度なので触っていない
- `autoStart` 対応: PTY spawn 後に指定コマンドを自動実行（例: `claude`）
- `PtySession` に `Drop` 実装: セッション破棄時に `child.kill()` で子プロセスを確実に終了
- ウィンドウ破棄時（`WindowEvent::Destroyed`）に全 PTY セッション・Docker log stream を一括 cleanup（main ウィンドウのみ）
- タブ切替時の TUI 再描画: `nextTick` → `requestAnimationFrame` → `terminal.refresh()` + PTY resize nudge（1col 縮小→復元で SIGWINCH 発火）
- ターミナルアクティビティ表示: 非アクティブタブが **BEL を受け取ると**ドット表示（`hasActivity`。`terminal.onBell` 経由で、全出力での点灯はトークンを流し続けるエージェントで鳴りっぱなしになるため採らない。タブ活性化直後 500ms のベルは無視）、プロセス終了で終了コードバッジ（`exitCode`）、非 pinned タブはプロセス終了 1 秒後に自動クローズ

## ターミナルの coding agent 補助（#89）
`claude` 等をターミナルで使う運用を、Pike の既存機能（エディタ / 診断）と橋渡しする一連の機能。注入はすべて `ptyWrite` 経由。

- **起動ボタン**: ターミナル右上のフローティング split ボタン（`TerminalTab.vue`）。主＝先頭コマンド / ▾＝一覧。クリックで `agentCommands`（`pike:settings`）をそのまま注入＋Enter。代替画面（alternate screen）検出で vim/less 等の全画面 TUI 中は非表示。**clear プレフィックスは付けない**（#220。以前は `clear && claude` を流していたが、今のエージェントは画面をその場に描くので直前までの出力を消す意味がない）。タブ生成時の `autoStart` 側は `buildAutoStartLine` で clear を付けたまま（あちらは同時に流すシェル初期化行を隠す役目がある）
- **セッション再開メニュー（#220）**: 起動メニューの下段に `claude -r` 相当の一覧を出し、選ぶと `claude --resume <id>` を注入する。`claude_usage/sessions.rs` が `~/.claude/projects/<encoded-root>/*.jsonl` を直接読む（CLI に機械可読な一覧が無いため。パスのエンコードとホーム解決は `claude_usage` と共有）。走査の打ち切り（`MAX_SCAN_FILES` / `MAX_TRANSCRIPT_BYTES` 等）とパースの詳細はコード側の doc コメントを正本とする
  - **対話セッションだけを出す**: 同じディレクトリには `-p` / SDK 実行（Pike 自身のレート取得 `claude -p "/usage"`、フック、レビューエージェント）の記録も溜まるので、`entrypoint` が `cli` 以外なら捨てる。これが無いと一覧が `/usage` の残骸で埋まる（実測で直近 60 件のうち対話セッションは 5 件）
  - 取得はメニューを開いたときだけ（WSL プロジェクトでは `\\wsl.localhost` 越しの読みになるためポーリングしない）。`claude` の起動コマンドが設定に無ければセクションごと出さない
  - 参照するディレクトリは `pty_get_cwd`（OSC 7 追跡の現在地）→ タブの `cwd` → プロジェクト root の順。**タブ生成時の cwd で決め打ちしない**: セッション記録は `claude` を起動した cwd ごとに分かれるので、`cd` したあとは別のバケットになる
- **定型プロンプト挿入ボタン**: 起動ボタンの隣の2つ目のドロップダウン。`agentPrompts`（`{ label, text }[]`、`pike:settings`）を**ブラケットペースト（`ESC[200~…ESC[201~`）で挿入のみ・Enter なし**（複数行も1入力として届き途中確定しない）。2つのメニューは相互排他、alt-screen 中は非表示。挿入の primitive は `lib/tauri.ts` の `ptyPasteText`
- **出力のパスのクリックでファイルを開く**: `lib/terminalLinks.ts` の `findPathLinks`（インライン `path:line(:col)` 検出。拡張子必須で誤検出抑制、Windows ドライブ・URL 除外）
  - **行番号は任意（#252）**。エージェントは書いたファイルを `› [file] /tmp/…/test.md (7.7KB)` の形で案内してくるので、行の一部にある裸のパスも拾う（行全体がパスであることを求める `asPathHeader` では届かない）。開くのは 1 行目
  - **行番号が無いときだけ判定を厳しくする**（`isPathLike`）: 区切りを必須にして文章中の `foo.md` を落とし、先頭セグメントがホスト名に見えるもの（`www.example.com/a/b.html`）も落とす。ただし `.` 始まりは通す（`.claude/rules/editor.md` は実在する）
  - **`://` を含むトークンは捨てる**。`(?:[A-Za-z]:)?` のドライブ接頭辞は `https://…` の `s:` にも当たるので、行番号を必須にしていた頃は `:数字` で終わらず弾かれていた URL が、任意にした途端すり抜ける
  - **rg のグループ出力の分岐を「他にマッチが無いとき」に限定しない**。裸のパスを拾うようになったため、`12:const x = require('./foo.js')` のようなマッチ行で先頭の行番号がリンクにならなくなる。重なりだけを見る＋ rg/grep の heading 出力対応（マッチ行の行番号 → 直近のファイル名見出しを辿る）。`TerminalTab.vue` が xterm の link provider として登録（ワイド文字対応の char→セル列マップで範囲を正確化）。相対パスは `activeRoot` 起点で解決し、**`lib/openFile.ts` の `openPathInTab` に渡す**（`addEditorTab` 直呼びだったころは、画像や PDF のパスをクリックすると CodeMirror に入ってバイナリガードに当たっていた）。**ディレクトリのパスもここを通ってエディタタブに着く**: 拡張子ルーティングでは区別できないので、判定は EditorTab 側の読み込み失敗時に置いてある（次の bullet）
- **ディレクトリを開いたときはエラーではなく開き方を出す**: `fs_read_file` はディレクトリでも読めないファイルでも同じように失敗するので、`EditorTab.vue` の `reportLoadError` が失敗時に `fsDirsExist` で理由を確かめ、ディレクトリなら専用のアクションを出す（**読み込みが成功する経路では 1 回も IPC を増やさない**）。登録済みなら「プロジェクトを開く」、未登録なら「ディレクトリを開く」（`openDirectory`＝#230 の一時プロジェクト）と「プロジェクトとして開く」（`openDirectoryAsProject`＝登録して開く）。**既定は新しいウィンドウ**で、`switch` は全タブ kill ＝クリック元のターミナルごと消えるため、チェックボックスで明示的に選ばせる。自動で開かないのも同じ理由（誤クリックで作業が消える）。判定を EditorTab に置いたので、Markdown リンクなど他の経路でディレクトリが着いても同じ画面になる
- **エディタ選択範囲・診断をターミナルへ注入**: `composables/useTerminalInject.ts` の `injectToTerminal(text)` が注入先ターミナルを解決（**`lastTerminalId`（直近アクティブなターミナル）→ アクティブタブ → pinned → 任意**）し `ptyPasteText` で挿入、当該タブをアクティブ化。注入先が無ければ statusMessage で通知。`stores/tabs.ts` の `lastTerminalId` は `activeTabId` watcher で更新（タブ閉じは use 時の liveness 再チェックで自己修復）
  - EditorTab: 右クリック「ターミナルに送る」（選択時のみ）→ `relpath:行` 参照 + 選択本文を注入
  - DiagnosticsPanel: 各行ホバーの 🤖 ボタン → `t('diagnostics.fixPrompt')`（i18n、UI 言語追従）で修正依頼文を注入
- **設定**: `agentCommands` / `agentPrompts` は Settings の Terminal セクションで追加/編集/削除/並べ替え。両方とも `pike:settings` の配列で deep-watch 永続化

## キーボードショートカット
- **修飾キーの読み替えと macOS のメニューバーは `.claude/rules/platform.md` の
  「キーボードショートカット」が正本**（#254）。`Cmd` 付きのキーはネイティブメニューが
  唯一の入口で、`e.ctrlKey` の直書きは `lib/keys.ts` の `hasMod` に寄せてある。
  表示は同ファイルの `chordChips` / `chordLabel`（`Mod+W` → `⌘W` / `Ctrl+W`）を通す:
  UI に `Ctrl+` と直接書くと macOS で嘘になる
- グローバルは `composables/useKeyboardShortcuts.ts`（window の keydown）。エディタ内は CodeMirror の keymap（`EditorTab.vue`）、ターミナルは xterm の `attachCustomKeyEventHandler`、各モーダルは自前の keydown と、**4 層に分かれている**。一覧は `components/KeyboardShortcuts.vue` + `composables/useShortcutsModal.ts`、マニュアルは `docs/manual/shortcuts-and-cli.md`。**キーの割り当ての正本は `lib/shortcuts.ts` の `keyBindings`**（#254 / #261。プリセットで切り替わる computed）。グローバル層のキーを増やすときに触るのは表とマニュアルの 2 箇所で、判定・一覧の表記・macOS メニューのアクセラレータは全部そこから導出される。表に無い層（CodeMirror・xterm・画像ビューワ）のキーは従来どおり実装・モーダル・マニュアルの 3 箇所を揃える
- **「Pike にできること」の正本は `lib/shortcuts.ts` の `APP_ACTIONS`**（#270）。**キーの表とは別**にしてある: パレットに出したい操作のほとんどはキーを持たない（パネルを開く、git pull など）ので、chord を行にした `keyBindings` では表現できない。`AppActionId` はこの表から導出する
  - **機能を足すときはここに 1 行足す。** 実装（`useAppActions`）は `Record<AppActionId, …>` なので、足して実装を忘れると型エラーになる。パレット（`QuickOpen` の `>` モード）は `palette` を持つ行を流すだけで、**一覧を別に持たない**（以前は `QuickOpen.vue` に 3 件ハードコードされていて、機能を足しても誰も気付かなかった）
  - `palette` は分類（`view` / `git` / `project` / `terminal` / `file` / `help`）。名前だけでは領域が分からないものに接頭辞を付けるためで、絞り込みの対象にも入れてある。**パレットに出さないものには付けない**（タブ移動のように、パレットを開いている時点で意味を失うもの）
  - `needsProject` を付けたものは、プロジェクトを持たないウィンドウでは出さない
- **`e.key` の英字は `normalizedKey`（`lib/keys.ts`）を通して比較する**。Caps Lock は `e.key` の大小を反転させるので、`'p'` のようなリテラル比較だけだと Caps 中に全滅する（棚卸しで実際に見つかった）。グローバル・PreviewTab・DiffTab の 3 箇所が共有する
- **モーダルの `keys` は「候補コードの配列」**（`['Mod+Shift+Z', 'Mod+Y']`）。描画は `chordChips` が `+` で `<kbd>` に割り（mac は記号を 1 つに畳む）、配列の区切りに `/` を入れる。1 文字列に `/` を混ぜると `split('+')` が壊れて `Z / Ctrl` のようなチップが出る
- **CodeMirror 標準の redo は `Mod-y` と Linux 限定の `Ctrl-Shift-z`**。Windows が主対象なので `Mod-Shift-z` を明示的に足してある。足すまで、3 箇所で案内していた `Ctrl+Shift+Z` はどこでも効いていなかった
- **`Ctrl+H`（置換）は `searchKeymap` に無い**。`editorSearch.ts` の `openReplace` が `openSearchPanel` + `revealReplace` エフェクトで置換行を開き、`editorPresetKeys.ts` の `presetKeymap()` がそれをプリセットの置換 chord（`editorChords.replace`）に割り当てる。パネル自体は元から置換行を持っていたが、キーバインドだけが無く、案内だけが 3 箇所にあった
- **素のキーを見るハンドラは修飾キーを弾く**。`PreviewTab` の `switch (e.key)` は修飾を見ておらず、画像タブで `Ctrl+F` が fit、`Ctrl+R` が回転になっていた
- **ターミナルにフォーカスがあるとき、グローバルショートカットは既定で 1 つも効かない（#224）**。xterm は PTY へ送るキーで `preventDefault` だけでなく **`stopPropagation` も呼ぶ**（`CoreBrowserTerminal.cancel(ev, true)`。`_keyDown` が `evaluateKeyboardEvent` の結果を PTY へ流したあとに必ず通る）。よって window の keydown ハンドラには **Ctrl+英字も `Tab` も `PageUp/Down` も `F1` も届かない**
  - **#224 の issue 本文にある「両方に届く」は誤り**（コードの読みだけで書かれたもの）。実際は逆で、シェルが全部取っていた。`Ctrl+Shift+P` と `Ctrl+,` だけが効いていたのは、xterm がそれらに制御コードを割り当てず `cancel` を通らないため
  - 例外を作る側は**割り当ての表の行に付けた印**（`lib/shortcuts.ts` の `terminalFirst`。タブの出し入れと文字の大きさだけ）。判定は同ファイルの `pikeTakesTerminalKey` で、`TerminalTab.vue` の `attachCustomKeyEventHandler` がそれで **`false` を返す**と `_keyDown` が即 return するので、PTY へも流れず `cancel` も通らず window まで伝わる。**`stopPropagation` や `preventDefault` を足す方向では直らない**（xterm 本体はこのハンドラの後に走り、そこで両方呼ぶ）
  - **印を行に付けてあるのは、プリセット（#261）で chord が変わっても追従させるため。** キー名の集合を別に持っていたころの形だと、IDEA 互換に切り替えた瞬間に「シェルへ返す一覧」だけが VSCode 互換のまま残る。Windows の IDEA では `Ctrl+W` と `Ctrl+T` がシェルへ戻り、代わりに `Ctrl+F4` と `Alt+←→` を Pike が取る（mac の IDEA は Cmd 側のキーマップなので、この入れ替わりが起きない。#280）
  - **`Ctrl+W` だけは代替画面（`inAltScreen`）のあいだシェルへ返す**（行の `altScreenShell`）。vim のウィンドウ操作の prefix なので、奪うと `Ctrl+W s` 等が打てないうえタブが閉じる。素のシェル（readline の unix-werase）では Pike 優先のままにするため、判定はキー単位ではなく代替画面の有無で行う。IDEA 互換では閉じるキーが Windows で `Ctrl+F4`、mac で `⌘W` になり、どちらも vim と衝突しないので、この印は付けない
  - **`attachCustomKeyEventHandler` は Alt も調停に通す**（#261）。Windows の IDEA 互換がタブ移動を `Alt+←→`、新規ターミナルを `Alt+F12` に置くので、Alt を無条件でシェルへ渡すとそれらが一度も発火しない。VSCode 互換では Alt の chord に `terminalFirst` が無いため、素通しの挙動は変わらない
  - readline が使う `Ctrl+K`（行末まで削除）・`Ctrl+P` / `Ctrl+N`（履歴）と、TUI アプリの `F1` はシェルに残す方針。**一覧をグローバルハンドラと同じファイルに置く**のは、そこが同じキーを取り合う相手だから（ターミナル側に置くと、`useKeyboardShortcuts.ts` に Ctrl+英字を足す人が「ターミナルでは効かない」ことに気付けない。readline の `Ctrl+A/E/U/D/Y` は未使用のまま残っている）
  - 変更したら 3 箇所（この定数・`KeyboardShortcuts.vue` のターミナル節・`docs/manual/shortcuts-and-cli.md`）を揃える
- **マニュアルの「プリセット別の早見表」は `just check-shortcuts` が実装と突き合わせる（#280）**。`scripts/check-shortcuts.ts` が `src/lib/` を実際に import し、`bindingsFor(preset, mac)` と `chordLabel(chord, mac)` で 4 通り（プリセット × プラットフォーム）を作って照合するので、**Windows で作業していても mac 側のずれが CI で落ちる**。正規表現でソースを読まないのは、`Mod` の解決・プリセットの重ね合わせ・`macChords` の差し替えという組み立てを写す羽目になるため。この 2 つが `mac` を引数で受けるのはそのためで、アプリの中からは既定（`isMacHost`）のまま呼ぶ
  - 見るのは**実装 → マニュアルの一方向**（表に無い chord があれば落ちる）。逆を見ないのは、早見表が CodeMirror 層のキー（保存・検索）も併記しているため。アクションを持たない行（`Mod+S` / `Mod+F` / `Mod+H`。ブラウザの既定を潰すだけ）は照合の対象外
  - 文字の大きさ（#260、`Mod+=` / `Mod++` / `Mod+Shift++` / `Mod+-` / `Mod+0`）もここに入れてある。
    **大きくする側の chord が 3 つあるのは配列の都合**で、`matchChord` が「chord に書いていない
    修飾キーは押されていない」ことを求めるため、`Mod++` は Shift 無しで `+` が出る numpad にしか
    一致しない。US の `Ctrl+Shift+=` と JIS の `Ctrl+Shift+;` は `Mod+Shift++` が受ける。**見ているものに効かせる**（エディタのタブならエディタのフォント、それ以外はターミナル）: 設定画面まで行かずに変えられることが目的なので、今フォーカスしている面が対象で自然。ターミナルで押したときに何も起きないのでは意味が無いので、xterm より先に取る
- **プリセット（#261 / #280）**: `SHORTCUT_PRESETS`（`vscode` / `idea`）。既定の VSCode 互換は元からある割り当てそのもので、名前を付けただけ。IDEA 互換は `IDEA_OVERRIDES` に**差分だけ**を書き、`VSCODE_BINDINGS` に重ねて作る（表を複製すると片方にだけ行を足したとき黙ってずれる）
  - **OS 差は行の `macChords` で持つ（#280）。** `Mod`（mac は Cmd、他は Ctrl）は VSCode のように「Ctrl ↔ Cmd の機械的な読み替え」で出来ているキーマップにしか通用しない。IDEA は Windows / Linux 用と macOS 用に別のキーマップを配っていて、Go to File が `Ctrl+Shift+N` と `⇧⌘O` のようにキーそのものが違う。Windows のキーマップだけを見て書いていたころ、mac では 5 件が実際の IDEA と食い違っていた（Go to File・Settings・Close Tab・タブ移動の前後）。**表を OS ごとに 2 つ持つ形は採らない**: 行を片方にだけ足す事故が起き、しかも症状は mac でしか出ない（CI の macOS ジョブは Rust の cfg のためのもので、ここは走らない）。行ごとに両 OS が並んでいれば見落としが目で分かる。**mac だけの割り当ては空の `chords` と組にする**（`⌘Q`）
  - **OS を解決するのは `bindingsFor` の 1 箇所だけ**（`macChords` があればそれを `chords` に差し替える）。読む側（照合・一覧の表記・macOS のメニュー・ターミナルとの取り合い）はすべて解決後の `chords` を見る。以前あった `macOnly` フラグは `useKeyboardShortcuts` しか見ておらず、`chordsFor` / `terminalClaims` / `primaryChord` には Windows でも `⌘Q` が見えていた
  - **VSCode 互換にも OS 差がある**（#280）: `nextEditor` は mac だけ `⌘⇧]` で、Windows / Linux は `Ctrl+PageDown`。`Mod+Shift+]` は `isMacHost` のときだけ chords に入れる。新規ターミナルは VSCode の `Ctrl+Shift+` \` を足しつつ `Mod+T` も残す（あちらは配列で `e.key` が変わるうえ、JIS では打ちにくい。VSCode の `Ctrl+T` に当たる機能は Pike に無いので取り合わない）
  - **VSCode の chord（2 打鍵）には揃えられない**。`Ctrl+K Ctrl+S`（ショートカット一覧）と `Ctrl+K Ctrl+O`（フォルダを開く）がそれで、Pike は prefix 状態を持たないため `Mod+K` / `Mod+O` の 1 打鍵のままにしてある。実装するなら 4 層すべてで prefix の調停を書くことになる（「任意の再割り当ては採らない」のと同じ理由）
  - 設定は `shortcutPreset`（同期対象。好みはマシンに依存しない）。**`lib/shortcuts.ts` はストアを import できない**（`stores/project.ts` から import されるので循環する）ため、設定ストア側が `setShortcutPreset` で値を流し込む。`immediate: true` が要る（無いと起動直後の 1 回だけ既定のキーで動く）
  - 追従させる先が 4 つある: グローバル（`keyBindings` を読むので自動）・**CodeMirror のキー**（`lib/editorPresetKeys.ts` の `presetKeymap()` と `EditorTab.vue` の `presetKeymapCompartment`。開いているタブに反映するには張り直しが要る）・**xterm の取り合い**（前述の `terminalFirst`）・**macOS のメニュー**（`stores/project.ts` の watcher のキーに `shortcutPreset` を入れてある）
  - **CodeMirror のキー名は 1 文字を小文字にする**（`lib/keys.ts` の `toCodeMirrorKey`）。あちらは修飾キーだけ正規化してキー名は `e.key` と素で比較するので、`Mod-H` と書くと Shift を押したときにしか一致しない
  - **矢印の chord は `Alt+ArrowLeft` と書く**（`e.key` に合わせる）。表示だけ `chordChips` が `←` に読み替える
  - **macOS では IDEA 互換の `Alt+F12`（新規ターミナル）が届かない。** `terminalClaims` が mac では
    `Ctrl` を明示した chord だけに絞るのでターミナル上では取らず、そもそも `F12` は音量キーに
    食われる。加えて `primaryChord` は `Mod` を含む chord しか選ばないので、この項目だけ
    メニューにアクセラレータが出ない（項目自体は出るので、メニューからは開ける）。タブ移動は
    #280 で mac が `⇧⌘]` / `⇧⌘[` になったため、こちらは普通にアクセラレータが付く
  - **CodeMirror の既定と衝突する chord は塞ぐ**（`lib/editorPresetKeys.ts` の `presetKeymap`）。
    `Alt+←→` は `defaultKeymap` の `cursorSyntaxLeft/Right` と同じキーで、CodeMirror は
    `stopPropagation: true` を宣言した binding でしか伝播を止めないため、放っておくと
    **カーソルが動いたうえでタブも切り替わる**
  - IDEA 互換に入れていないものにも理由がある。`projectSwitcher` と `openDirectory` は IDEA に相当する既定キーが無く、`newFile` の `Ctrl+N` は IDEA では Go to Class だが Pike にクラス検索が無いので取り合いにならない。タブ移動は `Ctrl+Tab` 系も残す（Windows の `Alt+←→` は代替画面で矢印を使う TUI と重なるので、逃げ道が要る）
- WebView リロード抑止: Ctrl+R / Ctrl+Shift+R / F5 を `preventDefault`。誤操作でのリロード（全 PTY セッション破棄＝実質再起動）を防ぐ。ターミナルの Ctrl+R（bash 逆方向検索）は xterm がイベントを消費するため影響なし

