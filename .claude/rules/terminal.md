---
paths:
  - "src-tauri/src/pty/**"
  - "src/components/tabs/TerminalTab.vue"
  - "src/components/AgentSessionsMenu.vue"
  - "src/composables/usePtyRouter.ts"
  - "src/composables/useTerminal*.ts"
  - "src/composables/useCopyOnSelect.ts"
  - "src/composables/useImagePaste.ts"
  - "src/composables/useAgentMenu.ts"
  - "src/lib/terminalLinks.ts"
---

# ターミナル実装ルール

PTY・シェル・xterm.js と、ターミナル上で動かすコーディングエージェントの補助。
実体は `src-tauri/src/pty/`、`src/components/tabs/TerminalTab.vue`、`src/composables/usePtyRouter.ts`、`src/composables/useTerminalInject.ts`。

**キーの取り合い（どのキーをシェルへ渡し、どれを Pike が取るか）は `shortcuts.md` の
「ターミナルとの取り合い」が正本。** `attachCustomKeyEventHandler` を触るときは先に読む。

## PTY / シェル対応
- WSL のコマンドは `bash -c`（非ログイン）で走るので、`.profile` が足すパスは効かない。ツールチェインの場所は `types.rs` の `WSL_EXTRA_PATH` に明示する（抜けると `go vet` のような外部ツールの実行が無言で空振りする）
- PTY 管理は `portable-pty` クレートを使う（ConPTY 対応済み）
- PTY プロセスのライフタイムは `PtyState` が所有し、ウィンドウ破棄時に `pty::cleanup_for_window` で cleanup
- セッション ID（UUID）でタブと PTY インスタンスを 1:1 で紐付ける
- PTY の stdout 読み取りは専用スレッド（`std::thread::spawn`）で行い、`app_handle.emit` でフロントに送る
- `pty_spawn` コマンドが `ShellConfig` に応じてシェルを起動:
  - WSL: `wsl.exe [-d distro] [--cd path] bash`
  - cmd: `cmd.exe`
  - PowerShell: `powershell.exe -NoLogo`
  - Git Bash: `C:\Program Files\Git\bin\bash.exe --login`（自動検出）
  - Unix（macOS / Linux）: `$SHELL` を **`-l`（ログインシェル）** で起動する。GUI プロセスの PATH は最小なので、rc / profile を読ませないとターミナルから何も呼べない（`.claude/rules/platform.md` の「PATH」）
- **PowerShell 7（pwsh、#127）**: Windows PowerShell 5（`ShellConfig::Powershell`）と併存する独立シェル種別 `ShellConfig::Pwsh` / `ShellType {kind:'pwsh'}`。`pty/mod.rs` の `find_pwsh()` が PATH → `C:\Program Files\PowerShell\7\pwsh.exe` → bare `pwsh.exe`（Store 版の実行エイリアス対策）の順で解決する。実在が確認できたものだけが要る呼び出し側は `find_pwsh_path`。`cls`/`;`/`$LASTEXITCODE` の PowerShell 系分岐は front `isPowershellFamily(kind)` で powershell/pwsh 共通化
- 起動できるシェルの並びと表示/非表示（シェルプロファイル、#129）は `settings-ui.md`
- **シェル未指定（`None`）の既定は OS で変わる**。Windows は WSL、macOS / Linux はログインシェル（`wsl.exe` が無いので WSL に落とすと即死する）
- 環境変数 `TERM=xterm-256color` を cmd 以外に設定
- **WSL のターミナルに `BROWSER` を渡さない（#381 で見送った）**。Claude Code の `/login` のような「ブラウザを開く」は下の OSC 8 のリンクを押せば開く。`BROWSER` に Pike 自身を渡す形は次の 2 つで採らない
  - `cargo doc --open` や Python の `webbrowser` は URL ではなくローカルのパス（`file://`）を `$BROWSER` に渡すので、それが Pike のエディタで開く（xdg-open が動いていた環境では後退になる）
  - xdg-open と Python は `BROWSER` を空白で割るので、ユーザー名やインストール先に空白があると起動できない
- **OSC 8 のハイパーリンクは `linkHandler` で `openUrlWithConfirm` へ送る（#381、`useTerminalUrlLinks.ts`）**。渡さないと xterm 既定の `window.confirm` → `window.open` が走り、WebView の中で開こうとして何も起きない。Claude Code はログイン URL をこれで出す（折り返した行をまたいでも URL 全体を持つ）。**URL のリンク化の設定では切らない**（理由はあのファイルのコメント）
- リサイズは `pty.resize()`（`portable-pty` の `PtySize`）で PTY サイズを更新
- **xterm は右に溝を持つ（#383 / #396）。** FitAddon は列数を決めるとき親の幅から
  `overviewRuler?.width` を引き、xterm 6 のスクロールバー（vscode の `ScrollableElement`）も
  同じ値で幅を決める。**1 つの値が確保量と描画幅の両方を決める**ので、`theme.css` の
  `::-webkit-scrollbar { width: 6px }` はターミナルには当たらない
  - **値の正本は `stores/settings.ts` の `TERM_SCROLLBAR_WIDTH`**（#396）。xterm の既定の
    14px だとターミナルのスクロールバーだけがアプリの他の面の倍以上に太いので、6px を渡して
    揃える。代償が 2 つある: 検索中はこの帯に一致の印（`findOptions` の
    `matchOverviewRuler`）が並ぶ（VSCode と同じ見え方）ことと、**幅を渡すと xterm が
    `OverviewRulerRenderer` を作る**こと（既定は幅が falsy なので作られない）。あれは描画の
    たびに rAF で細い canvas を塗り直すので、ターミナルの描画経路に仕事が 1 つ増える。
    避ける手は「14px のままにする」しか無い
  - **`theme.css` の `--term-gutter` を同じ値に保つこと**（CSS からあの定数は読めない。
    あちらは `--scrollbar-size` を読むので、揃えるのは TS 側の 1 つだけ）。本文の右には
    必ず溝のぶんが空くので、同じだけ左に置いて釣り合わせる（共有クラス `.xterm-surface`）。
    **余白をタブ側に書かないこと**: ターミナルと Docker ログの 2 面が同じ事情を持つ
  - **`align-items: center` で端数を散らしてはいけない。** `.xterm` が本文ちょうどの幅に
    縮み、スクロールバーが最終列に重なる（つまみのドラッグも取られうる）
  - **代替画面（`inAltScreen`）にスクロールバーは出せない。** xterm はあちらにスクロール
    バックを持たない（`scrollback` は通常のバッファのもの）ので、帯を出しても動かす先が
    無い。フルスクリーンの TUI は自前でスクロールを持つ側で、Pike から足す口は無い
- **xterm は端数の行を持てないので、余白は上下に振り分ける（#268）**: 高さは `rows × セル高` で、FitAddon は行数を floor する。`.terminal-inner` を何もしないコンテナにすると端数（最大でセル 1 行ぶん ≒ 20px）が全部下に溜まり、4 辺 10px のはずの余白が下だけ広く見える。flex の `justify-content: center` で上下に割る。横も同じ理屈で余るが、セル幅は 8px 程度なので触っていない
- `autoStart` 対応: PTY spawn 後に指定コマンドを自動実行（例: `claude`）
- `PtySession` に `Drop` 実装: セッション破棄時に `child.kill()` で子プロセスを確実に終了
- ウィンドウ破棄時（`WindowEvent::Destroyed`）に全 PTY セッション・Docker log stream を一括 cleanup（main ウィンドウのみ）
- タブ切替時の TUI 再描画: `nextTick` → `requestAnimationFrame` → `terminal.refresh()` + PTY resize nudge（1col 縮小→復元で SIGWINCH 発火）
- **クリップボードは user gesture の中でしか触れない（WebKit ＝ macOS、#342）**:
  Chromium（Windows の WebView2）は要求しないので、**症状は macOS にだけ出る**。
  判断の実体は 2 つの doc コメントが正本で、ここに写しを置かない
  - 選択してコピー … `composables/useCopyOnSelect.ts`（書く場所を mouseup へ持ち越さない
    理由と、初回だけ聞く形）
  - 右クリックで貼り付け … `useImagePaste.ts` の `readClipboard`（画像とテキストを
    1 回の `read()` で取る。2 回に分けると 1 回目の await で gesture が切れる）
  - **macOS で「動かないことがある」の原因はまだ確定していない**（#342 の調査）。上の
    経路は gesture の中に居るので、gesture の規則だけでは説明が付かない。残る候補は
    WKWebView で `navigator.clipboard` 自体が使えない（secure context 扱いでない）、
    権限で拒否される、のどちらか。**確かめるには実機で `window.isSecureContext` と
    `navigator.clipboard` の有無、書き込みの reject の中身を見る**（この開発機に macOS が
    無いので未確認）。塞ぐならネイティブ側（Rust）のクリップボードを足すことになる
  - **OSC 52（フルスクリーン TUI が出すクリップボード書き込み）は入力イベントを伴わない**
    ので、WebKit では通らない。これもネイティブ側を足さないと直らない
  - **確認のダイアログは「いいえ」と「答える前に別のダイアログへ置き換わった」を分けて
    返す**（`useConfirmDialog` の `displaced`、#342）。分けないと、初回の確認が横取り
    されただけで設定が OFF に落ち、二度と聞かれない
- ターミナルアクティビティ表示: 非アクティブタブが **BEL を受け取ると**ドット表示（`hasActivity`。`terminal.onBell` 経由で、全出力での点灯はトークンを流し続けるエージェントで鳴りっぱなしになるため採らない。タブ活性化直後 500ms のベルは無視）、プロセス終了で終了コードバッジ（`exitCode`）、非 pinned タブはプロセス終了 1 秒後に自動クローズ

## ターミナルの検索
- **`@xterm/addon-search` を使う**。折り返した行の結合とスクロールバックの走査を自前で持たないため。見た目は `components/editor/FindBar.vue`（diff タブ・プレビューと共有）。キーの受け方は `shortcuts.md` の `Ctrl+F` の項
  - **アドオンは検索バーを開いたときに読み込み、閉じたら捨てる**（`openFind` / `closeFind`）。読み込んだままだと、検索を使わないタブでも出力のたびに再検索の確認が走る。開いたままのタブが隠れているあいだの再走査は止めていない
  - **装飾の色は `#RRGGBB` しか受けない**ので、`theme.css` の `--find-*`（rgba）を渡せず、`FIND_DECORATIONS` にダーク / ライトの 2 組を持つ。明暗はアプリのテーマではなくターミナルの配色の下地（`colorScheme.background`）で選ぶ
  - **件数は `highlightLimit`（`FIND_LIMIT`=1000）で止まり、現在位置がその外だと `resultIndex` が -1 で届く**。打ち切りの判定は件数で行い（-1 だけを見ると先頭 1000 件の中にいるとき `+` が落ちる）、FindBar は `current < 0` を「位置不明」として件数だけ出す
  - **検索バーが開いているあいだは選択のコピー（#342）を止める**。アドオンは一致を選択範囲で示すので、打鍵・移動・出力のたびの再検索がクリップボードを書き換える
  - 開き直したら、残っている前回の検索語で探し直す（アドオンは閉じるときに捨てている）

## ターミナルの coding agent 補助（#89）
`claude` 等をターミナルで使う運用を、Pike の既存機能（エディタ / 診断）と橋渡しする一連の機能。注入はすべて `ptyWrite` 経由。

- **起動ボタン**: ターミナル右上のフローティング split ボタン（`TerminalTab.vue`）。主＝既定の起動行 / ▾＝一覧。クリックで `agentLaunchers`（`pike:settings`）の行をそのまま注入＋Enter。一覧の形と既定の決め方は `.claude/rules/agent.md` が正本。代替画面（alternate screen）検出で vim/less 等の全画面 TUI 中は非表示。**clear プレフィックスは付けない**（#220。今のエージェントは画面をその場に描くので、直前までの出力を消す意味がない）。タブ生成時の `autoStart` 側は `buildAutoStartLine` で clear を付けたまま（あちらは同時に流すシェル初期化行を隠す役目がある）
- **セッション再開メニュー（#220 / #267）**: 起動行ごとに、その行が動かすエージェントの過去セッションをサブメニューに出す。**4 つとも対応していて、出所も対話セッションの選び方も違う**（表は `src-tauri/src/agent_sessions.rs` の doc が正本。振り分けもあそこ）。再開コマンドの組み立てはフロントの表（`lib/agents.ts` の `AgentDef.resume`）
  - **メニューの構成と取得の作法は `composables/useAgentMenu.ts` が正本**（#375）。ターミナルに重ねる起動ボタンとタブバーの ▾ が共有する。第 1 階層は既定の起動行だけ、残りは「他のエージェント」、再開一覧はその行のサブメニュー。開いているかの鍵をメニュー上の位置にする理由と、取得を二重に起こさない印の持ち方はあのファイルの doc に書いてある
  - 行とサブメニューの部品は `components/AgentSessionsMenu.vue`（上の 2 つの消費者が共有）
  - 参照するディレクトリは消費者が決める（`useAgentMenu` の `where`）。ターミナル側は `pty_get_cwd`（OSC 7 追跡の現在地）→ タブの `cwd` → プロジェクト root の順。**タブ生成時の cwd で決め打ちしない**: セッション記録はエージェントを起動した cwd ごとに分かれるので、`cd` したあとは別のバケットになる。メニューを開いているあいだは 1 回だけ解決する。タブバーの ▾ は「これから開くターミナル」の場所（`terminalPlace`）を渡す
- **重ねて出す 3 つのボタンは個別に隠せる（#341）**: `terminalAgentButton` /
  `terminalPromptButton` / `terminalHelpButton`（同期対象。好みはマシンに依存しない）。
  **1 本のフラグに畳まない**理由は `stores/settings.ts` の宣言の隣が正本。設定画面での
  置き場はターミナル節の「重ねて出すボタン」で、**機能ごとの節に散らさない**（起動行の
  設定はエージェント節のまま）: 消したい人が探すのは「この画面に出ているもの」という軸
  - **ヘルプの「?」は上の 2 つが両方隠れたら一緒に消える。** 入れ子（ツールバーの `v-if`）に
    預けず述語にしてある理由は `TerminalTab.vue` の `showHelp` の隣が正本
  - **設定画面ではこの連動を説明文ではなく UI で見せる。** 2 つが両方オフの間、ヘルプの
    切り替えは OFF に固定して押せなくする（`SettingToggle` の `disabled`）。**保存値は書き換えない**:
    どちらかを戻したときに、利用者が選んでいた値へ戻すため
  - **隠すのはターミナルに重なる `HelpButton` だけ**（#341）。他の呼び出し元はそれぞれの UI に
    属するので、この設定では触らない（**場所も件数もここに写さないこと**。`check-docs` が見るのは
    バッククォートの名前が実在するかだけなので、黙って古くなる）
- **定型プロンプト挿入ボタン**: 起動ボタンの隣の2つ目のドロップダウン。`agentPrompts`（`{ label, text }[]`、`pike:settings`）を**ブラケットペースト（`ESC[200~…ESC[201~`）で挿入のみ・Enter なし**（複数行も1入力として届き途中確定しない）。2つのメニューは相互排他、alt-screen 中は非表示。挿入の primitive は `lib/tauri.ts` の `ptyPasteText`
- **リンク化は 2 つとも設定で切れる（#343）**: `terminalPathLinks`（3 値）と
  `terminalUrlLinks`。**切り方が違うのがこの節の要点**で、片方は自前のプロバイダなので
  `provideLinks` で何も返さないだけ、もう片方は `WebLinksAddon` ごと外す。それぞれの理由は
  `stores/settings.ts` の宣言の隣と `composables/useTerminalUrlLinks.ts` の doc が正本
  - 押したときの確認（見せるものと、URL 側と対称にしない理由）は `TerminalTab.vue` の
    `openPathLink` の隣が正本
- **出力のパスのクリックでファイルを開く**: `lib/terminalLinks.ts` の `findPathLinks`（インライン `path:line(:col)` 検出。拡張子必須で誤検出抑制、Windows ドライブ・URL 除外）
  - **行番号は任意（#252）**。エージェントは書いたファイルを `› [file] /tmp/…/test.md (7.7KB)` の形で案内してくるので、行の一部にある裸のパスも拾う（行全体がパスであることを求める `asPathHeader` では届かない）。開くのは 1 行目
  - **行番号が無いときだけ判定を厳しくする**（`isPathLike`）: 区切りを必須にして文章中の `foo.md` を落とし、先頭セグメントがホスト名に見えるもの（`www.example.com/a/b.html`）も落とす。ただし `.` 始まりは通す（`.claude/rules/editor.md` は実在する）
  - **`://` を含むトークンは捨てる**。`(?:[A-Za-z]:)?` のドライブ接頭辞は `https://…` の `s:` にも当たるので、行番号が任意だと URL がパスとしてすり抜ける
  - **rg のグループ出力の分岐を「他にマッチが無いとき」に限定しない**。裸のパスを拾うので、そうすると `12:const x = require('./foo.js')` のようなマッチ行で先頭の行番号がリンクにならない。重なりだけを見る＋ rg/grep の heading 出力対応（マッチ行の行番号 → 直近のファイル名見出しを辿る）。`TerminalTab.vue` が xterm の link provider として登録（ワイド文字対応の char→セル列マップで範囲を正確化）。相対パスは `activeRoot` 起点で解決し、**`lib/openFile.ts` の `openPathInTab` に渡す**（`addEditorTab` を直に呼ぶと、画像や PDF が CodeMirror に入ってバイナリガードに当たる）。**ディレクトリのパスもここを通ってエディタタブに着く**: 拡張子ルーティングでは区別できないので、判定は EditorTab 側の読み込み失敗時に置いてある（次の bullet）
- **ディレクトリを開いたときはエラーではなく開き方を出す**: `fs_read_file` はディレクトリでも読めないファイルでも同じように失敗するので、`EditorTab.vue` の `reportLoadError` が失敗時に `fsDirsExist` で理由を確かめ、ディレクトリなら専用のアクションを出す（**読み込みが成功する経路では 1 回も IPC を増やさない**）。登録済みなら「プロジェクトを開く」、未登録なら「ディレクトリを開く」（`openDirectory`＝#230 の一時プロジェクト）と「プロジェクトとして開く」（`openDirectoryAsProject`＝登録して開く）。**既定は新しいウィンドウ**で、`switch` は全タブ kill ＝クリック元のターミナルごと消えるため、チェックボックスで明示的に選ばせる。自動で開かないのも同じ理由（誤クリックで作業が消える）。判定を EditorTab に置いたので、Markdown リンクなど他の経路でディレクトリが着いても同じ画面になる
- **エディタ・診断・issue をターミナルへ注入**: `composables/useTerminalInject.ts` の `injectToTerminal(text)` が注入先ターミナルを解決（**`lastTerminalId`（直近アクティブなターミナル）→ アクティブタブ → pinned → 任意**）し `ptyPasteText` で挿入、当該タブをアクティブ化。注入先が無ければ statusMessage で通知。`stores/tabs.ts` の `lastTerminalId` は `activeTabId` watcher で更新（タブ閉じは use 時の liveness 再チェックで自己修復）
  - **アクティブ化だけでなく、DOM のフォーカスまで渡す（#355）**。`tabStore.focusTerminal` が `setActiveTab` に続けて `TerminalTab.focusRequested`（時刻の合図。`EditorTab.reloadRequested` と同じ形）を立て、`TerminalTab.vue` の watcher が xterm を focus する。**`setActiveTab` だけでは足りない**: あちらに反応する初期フォーカスの watcher は「打鍵の行き先になった」瞬間にしか発火しないので、**既にそのターミナルが選ばれていれば何も起きない**（issue パネルの 🤖 を押した普通の場合がそれで、文字列は届くのにフォーカスは押したボタンに残る）。ターミナル自身のボタン（起動行・定型プロンプト）は元から `terminal.focus()` を呼ぶので、この経路を通らない
  - EditorTab: 右クリック「ターミナルに送る」（選択時のみ）→ `relpath:行` 参照 + 選択本文を注入
  - EditorTab: 右クリック「参照をターミナルに送る」（#335。選択が要らない）→ 参照だけを注入。綴りは `lib/paths.ts` の `fileLineRef`（`editor.md`）
  - DiagnosticsPanel: 各行ホバーの 🤖 ボタン → `t('diagnostics.fixPrompt')`（i18n、UI 言語追従）で修正依頼文を注入
  - IssuesPanel / IssueTab: 🤖 ボタンと行の右クリックメニュー（#336）→ 同じファイルの `injectIssueStart` で「この issue に着手して」を注入。**文面の正本は `lib/issuePrompt.ts` の `issueStartPrompt`**: 同じ文面をクリップボードへ出す項目（文字列の流し込みが効かないエージェント向けの逃げ道）があるので、注入の側に置くと片方だけ古くなる。**本文を運ばない**理由はあのファイルの doc が正本
  - **パネルの右クリックメニューの器は `theme.css` の `.panel-ctx-menu`**（ファイルツリー・Git・issue が共有）。幅だけは置いた側に残す。キーの綴りを右に並べるメニュー（タブバー・エディタ）は `display: flex` の別様式なので、ここには乗らない
  - **ホバーで出すボタンは `theme.css` の `.row-action`**（Problems と issue が共有）。置いた側に残すのは `.<行>:hover .row-action` の 1 行だけ
- **設定**: `agentLaunchers` / `agentPrompts` は Settings の Agent セクションで追加/編集/削除/並べ替え。両方とも `pike:settings` の配列で deep-watch 永続化
