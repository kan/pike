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
- グローバルは `composables/useKeyboardShortcuts.ts`（window の keydown）。エディタ内は CodeMirror の keymap（`EditorTab.vue`）、ターミナルは xterm の `attachCustomKeyEventHandler`、各モーダルは自前の keydown と、**4 層に分かれている**。一覧は `components/KeyboardShortcuts.vue` + `composables/useShortcutsModal.ts`、マニュアルは `docs/manual/shortcuts-and-cli.md`。**キーを増やしたら 3 箇所（実装・モーダル・マニュアル）を揃える**
- **`e.key` の英字は `normalizedKey`（`lib/keys.ts`）を通して比較する**。Caps Lock は `e.key` の大小を反転させるので、`'p'` のようなリテラル比較だけだと Caps 中に全滅する（棚卸しで実際に見つかった）。グローバル・PreviewTab・DiffTab の 3 箇所が共有する
- **モーダルの `keys` は「候補コードの配列」**（`['Mod+Shift+Z', 'Mod+Y']`）。描画は `chordChips` が `+` で `<kbd>` に割り（mac は記号を 1 つに畳む）、配列の区切りに `/` を入れる。1 文字列に `/` を混ぜると `split('+')` が壊れて `Z / Ctrl` のようなチップが出る
- **CodeMirror 標準の redo は `Mod-y` と Linux 限定の `Ctrl-Shift-z`**。Windows が主対象なので `Mod-Shift-z` を明示的に足してある。足すまで、3 箇所で案内していた `Ctrl+Shift+Z` はどこでも効いていなかった
- **`Ctrl+H`（置換）は `searchKeymap` に無い**。`editorSearch.ts` の `replaceKeymap` が `openSearchPanel` + `revealReplace` エフェクトで置換行を開く。パネル自体は元から置換行を持っていたが、キーバインドだけが無く、案内だけが 3 箇所にあった
- **素のキーを見るハンドラは修飾キーを弾く**。`PreviewTab` の `switch (e.key)` は修飾を見ておらず、画像タブで `Ctrl+F` が fit、`Ctrl+R` が回転になっていた
- **ターミナルにフォーカスがあるとき、グローバルショートカットは既定で 1 つも効かない（#224）**。xterm は PTY へ送るキーで `preventDefault` だけでなく **`stopPropagation` も呼ぶ**（`CoreBrowserTerminal.cancel(ev, true)`。`_keyDown` が `evaluateKeyboardEvent` の結果を PTY へ流したあとに必ず通る）。よって window の keydown ハンドラには **Ctrl+英字も `Tab` も `PageUp/Down` も `F1` も届かない**
  - **#224 の issue 本文にある「両方に届く」は誤り**（コードの読みだけで書かれたもの）。実際は逆で、シェルが全部取っていた。`Ctrl+Shift+P` と `Ctrl+,` だけが効いていたのは、xterm がそれらに制御コードを割り当てず `cancel` を通らないため
  - 例外を作る側の実装は `useKeyboardShortcuts.ts` の `PIKE_FIRST_CTRL_KEYS`（`Ctrl+W` / `Ctrl+T` / `Ctrl+Tab` / `Ctrl+PageUp` / `Ctrl+PageDown`。タブの出し入れだけ）。`TerminalTab.vue` の `attachCustomKeyEventHandler` がこの一覧で **`false` を返す**と `_keyDown` が即 return するので、PTY へも流れず `cancel` も通らず window まで伝わる。**`stopPropagation` や `preventDefault` を足す方向では直らない**（xterm 本体はこのハンドラの後に走り、そこで両方呼ぶ）
  - **`Ctrl+W` だけは代替画面（`inAltScreen`）のあいだシェルへ返す**（`ALT_SCREEN_SHELL_KEYS`）。vim のウィンドウ操作の prefix なので、奪うと `Ctrl+W s` 等が打てないうえタブが閉じる。素のシェル（readline の unix-werase）では Pike 優先のままにするため、判定はキー単位ではなく代替画面の有無で行う
  - readline が使う `Ctrl+K`（行末まで削除）・`Ctrl+P` / `Ctrl+N`（履歴）と、TUI アプリの `F1` はシェルに残す方針。**一覧をグローバルハンドラと同じファイルに置く**のは、そこが同じキーを取り合う相手だから（ターミナル側に置くと、`useKeyboardShortcuts.ts` に Ctrl+英字を足す人が「ターミナルでは効かない」ことに気付けない。readline の `Ctrl+A/E/U/D/Y` は未使用のまま残っている）
  - 変更したら 3 箇所（この定数・`KeyboardShortcuts.vue` のターミナル節・`docs/manual/shortcuts-and-cli.md`）を揃える
- WebView リロード抑止: Ctrl+R / Ctrl+Shift+R / F5 を `preventDefault`。誤操作でのリロード（全 PTY セッション破棄＝実質再起動）を防ぐ。ターミナルの Ctrl+R（bash 逆方向検索）は xterm がイベントを消費するため影響なし

