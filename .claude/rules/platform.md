---
paths:
  - "src-tauri/src/types.rs"
  - "src-tauri/src/main.rs"
  - "src-tauri/src/lib.rs"
  - "src-tauri/src/appmenu/**"
  - "src-tauri/src/pty/**"
  - "src-tauri/*.plist"
  - "src-tauri/icons/**"
  - "src/lib/host.ts"
  - "src/lib/keys.ts"
  - "src/types/tab.ts"
  - "src/composables/useAppMenu.ts"
  - "scripts/download-rg.sh"
  - "scripts/make-icons.sh"
---

# プラットフォーム対応ルール（Windows / macOS）

Pike の第一ターゲットは Windows で、macOS は**ローカルのシェルで開発できる**ところまでを持つ。
実体は `src-tauri/src/types.rs` の `ShellConfig`、`src/lib/host.ts`、`src/types/tab.ts`。

## どこで分岐するか

分岐は**シェル種別**（`ShellConfig` / `ShellType`）でするのが原則で、`cfg!(windows)` を撒かない。
プロジェクトはウィンドウごとに開かれ、そのシェルがパスの作法を決めるため。`cfg` を使うのは
「その OS に API そのものが無い」ものだけ（COM・DWM・WM_COPYDATA・`std::os::windows`）。

- `ShellConfig::Unix { program }` … macOS / Linux ホストのローカルシェル。`program` はログイン
  シェルの絶対パスで、**空にしておくのが既定**（実行時に `$SHELL` を見る。焼き込むと
  ログインシェルを変えたあとも保存済みのタブが古いシェルを起動する）
- **`_ =>` を「Windows である」の意味で使わないこと。** 既存の `match` は WSL とそれ以外の
  2 分岐で書かれていて、`Unix` は黙って Windows 側へ落ちる。判定は次の 2 つで行う:
  - `is_posix()` … 引用・パス区切り・null デバイスが POSIX か（`Wsl` と `Unix`）。
    **`GitBash` は含めない**（引用は bash だが扱うパスは Windows のもの）
  - ファイル I/O は「WSL かどうか」だけ。`Unix` はホスト自身なので `fs/mod.rs` の
    `std::fs` 側の腕にそのまま乗る（WSL だけが `wsl.exe` 越しにコマンドで運ぶ）
- `ShellConfig::host_default()` … シェル指定が無いときの既定（Windows は PowerShell、
  他はログインシェル）。プロジェクト作成・CLI・一時プロジェクトが通る。**`program` は
  空のまま返すこと**（`unix_program()` が起動時に `$SHELL` から解決する）。焼き込むと
  `pike <dir>` で開いて登録したプロジェクトが `/bin/zsh` を恒久的に指し、`shellId` が
  `unix:/bin/zsh` になってシェルプロファイルの id と一致しなくなる。値の検証も
  **`unix_program()` 側**に置く: `shell_from_id` は id 経由の入口だけで、`ShellConfig` は
  serde 越しの IPC と `project.json` からも届く
- フロントのホスト判定は **`src/lib/host.ts` の `isWindowsHost` だけ**。判定は WebView の
  User-Agent で行う（`@tauri-apps/plugin-os` を足さない方針。`defaultShellProfiles` のように
  同期で答えが要る場所から呼ばれるので、IPC にすると起動直後だけ別の一覧が出る）。
  `isUnixHost` のような否定の別名も、3 値の enum も置かない（区別が要る問いが出てから足す）
- ホスト依存の既定値（`hostDefaultShell` / `defaultProjectPlatform`）も `lib/host.ts` に置く。
  **`types/tab.ts` へ戻さないこと**: あちらは値 import を持たない方針（`tabs.md`）で、
  これらは `navigator` を読む。逆に `isPosixShell` のような `ShellType` の純粋な述語は
  `types/tab.ts` 側に置く（`lib/paths.ts` がそれを import する向きが正しい）
- ファイル I/O のシェルは **`projectStore.shellForIO`** を通す。プロジェクトが無いウィンドウの
  フォールバックを `{ kind: 'powershell' }` と直書きすると、macOS で区切りが `\` になり
  `notes\img.png` のような名前のファイルを作りに行く
- 「これを開く」は **`types::os_open`** を通す（`explorer.exe` / `open` / `xdg-open`）。
  直書きすると、外部リンクや Codex の OAuth ログインが macOS で無言で失敗する
- プロジェクトのプラットフォームの一覧は `lib/projectPaths.ts` の **`PROJECT_PLATFORMS`**
  が単一の出典。型も実行時検証（`isProjectPlatform`）もここから導く。同期ファイルの
  allowlist が漏れると、知らない platform のエントリを**他マシンから消す**

## PATH（macOS でいちばん踏みやすい落とし穴）

**Finder / Dock / `open` から起動した macOS の GUI プロセスは `launchd` の最小 PATH
（`/usr/bin:/bin:/usr/sbin:/sbin`）しか持たない。** `git` も `rg` も `claude` も解決できない。
ターミナルから `just dev` すると開発者のシェル PATH を継ぐので、**開発中はまったく再現せず
インストール版だけで壊れる**。

- 対策は `main.rs` の先頭で呼ぶ `types::augment_process_path()`。`UNIX_EXTRA_PATH` のうち
  実在するディレクトリをプロセスの PATH に足す。**スレッドが立つ前に呼ぶこと**（`set_var` は
  プロセス全体を触る）
- 呼び出しごとに PATH を組み立てる（`run_shell_line_env` 等）だけでは足りない。`ShellConfig` を
  通らない直接 spawn（PTY・エージェント・updater）が取り残される
- ログインシェルに `$PATH` を聞く方式（VS Code のやり方）は採らない。起動のたびに対話シェルを
  1 本起こすことになり、rc が `exec tmux` する環境で固まる
- 判断は純粋関数 `augmented_path_with` に置いてテストしてある（`set_var` を触るテストは
  互いに干渉するため）
- **Windows 版の `augment_process_path` は自分のインストール先を足す**（#370）。インストーラが
  ユーザー PATH に書いても、インストール直後の「Pike を起動」とセルフアップデート後の再起動は
  **インストーラの（PATH 追記前の）環境を継ぐ**ので、Pike のターミナルから `pike.exe` が見つからない。
  WSL は `wsl.exe` を起動したプロセスの PATH を distro の PATH に付ける（実測）ので、WSL も同じ。
  理由の詳細は関数の doc が正本
- **Pike が自分で入れるものの置き場（`~/.local/bin` と `%USERPROFILE%\.local\bin`、#397 の
  vue-preview）は、実在しなくても PATH に足す**（macOS は `UNIX_INSTALL_BIN`、Windows は
  `user_bin_dir`）。PATH は起動時にしか広げられないので、無い状態で起動してから Pike の導線で
  入れると、足していないと再起動するまで見つからない。**他のディレクトリは実在するものだけ**の
  規則のまま
- 対話ターミナルは別経路で解決している。`pty_spawn` の `Unix` は**ログインシェル（`-l`）**で
  起動するので、rc / profile を読んで本来の PATH になる

## macOS で持たない機能

いずれも Windows 専用 API に依存する。**stub を置いて呼び出し側は分岐させない**
（`lib.rs` の `#[cfg(not(windows))] mod ...` が何もしない実装を持つ）。

| 機能 | 理由 |
|---|---|
| ジャンプリスト（#160） | `ICustomDestinationList`（COM）。Dock メニューは別物 |
| タブバーへの OS ファイルドロップの実パス解決 | WebView2 の `ICoreWebView2File`。WKWebView に相当物が無い |
| 管理者ターミナル（#138）・`--wait` の WM_COPYDATA 転送 | すでに `elevate.rs` / `wait.rs` が cfg 済み |
| ウィンドウ背景の透過・アクリル（#162） | `transparent` は `macos-private-api` feature が要るのでビルダーにメソッドが生えない。不透明で生成する。**設定の値も潰す**（`sanitizeBackdrop`）: この設定は同期対象なので、Windows 機でアクリルにした値が流れてくると、透けない下地の上に半透明の UI が描かれて黒く潰れる |
| 仮想デスクトップごとのウィンドウ復元（#317） | `IVirtualDesktopManager`（COM）。macOS の Spaces と Linux のワークスペースには相当する公開 API が無い。`vdesk` の stub が「常に見えている / どこにも属さない / 移せない」を返し、復元は現在のデスクトップに出す側へ落ちる |
| デスクトップ通知（#318） | WinRT のトーストと、AUMID を書いたスタートメニューのショートカット（`IShellLinkW` + `IPropertyStore`）。**そもそも入力待ちの知らせ（#265）が Windows 限定**（配送の WM_COPYDATA がそこにしか無い）なので、通知が要る場面も無い。`toast` の stub が何もしない |

`busy` 判定（#178）は**代替がある**ので実装してある: WSL の `/proc/*/environ` マーカー走査に
あたるものが、ローカル Unix では `ps -Ao ppid=`（PID が同じ名前空間にあるのでマーカーが
要らない）。**ホスト側の判定は `ProbeKind::Host` の 1 本**で、Windows の Toolhelp 走査と
同じ問いを OS ごとの `parent_pids()` が答える。種別を OS で割ると、どちらのホストでも
片方が到達不能なスタブになり、「macOS で cmd シェル」のような噛み合わない組み合わせが
黙ってそこへ落ちる。**判定を N 件まとめて行う `count_busy` を使うこと**（`is_busy` を
ターミナルの枚数だけ呼ぶと、プロセステーブルの走査がその回数だけ走る）。

**ターミナルの cwd 追跡（OSC 7）は macOS では動かない。** `TerminalTab.vue` の `isBash` が
仕込む `PROMPT_COMMAND` と `trap DEBUG` は bash 固有で、macOS の既定シェルである zsh では
文法が違う（`precmd` が相当）。`unix` を `isBash` に入れると zsh にエラーを流し込むので、
**入れないのが正しい**。影響は `pty_get_cwd` を使う機能（プロジェクト作成時の cwd 検出、
Claude のセッション一覧の参照先）がタブ生成時の cwd に留まること。zsh 用の `precmd` を
足すなら、シェルの実体を見て分岐する必要がある（既定の `Unix { program: "" }` は実体を
持たないので、まず `$SHELL` を解決するところから）。

## macOS で拾えない環境変数（`CLAUDE_CONFIG_DIR`）

`claude_usage/config.rs` の `shell_env_value` は、WSL 以外のシェルでは **Pike 自身のプロセス環境**から
`CLAUDE_CONFIG_DIR` を読む。Windows では cmd / Git Bash が起動時に継承するので一致するが、
**macOS の GUI プロセスは shell rc の export を継がない**（`augment_process_path` が回避している
launchd の最小環境と同じ話）。よって `.zshrc` に `export CLAUDE_CONFIG_DIR=…` を書いている
macOS ユーザーは、使用量・レート・セッション一覧のすべてが既定の `~/.claude` を見る。

**現状は既知の制約として据え置く**（`.envrc` 検出と同じく、失敗しても黙って既定に落ちる規約に沿う。
気付く先は StatusBar のアカウント行）。

**据え置く理由は、開発機に macOS が無く、値が正しいことを実機で確かめられないこと。** 直す手間は
小さい: エージェントの検出（`shell_probe.rs`）が macOS でも対話ログインシェル（`-lic`）を既に
起こしているので、環境変数はその 1 回に相乗りでき、変えるのは `shell_env_value` の腕と
`posix_script` の 1 行だけ。`resolve` は実在を確認できたディレクトリしか採らないので安全側では
あるが、それは取り違えを防ぐだけで、正しさの確認にはならない。

## プライバシー保護されたリソース（TCC、#296）

ターミナルで走らせたコマンドがカレンダー等を触ると、TCC は**責任プロセス**（＝Pike）に
対して可否を決める。実体は `src-tauri/entitlements.plist` と `src-tauri/Info.plist`。

**署名すると要件が 1 つ増える。** `codesign --options runtime`（hardened runtime）は
既定でリソースアクセスを禁じ、entitlement で個別に開ける。**Info.plist の usage description
だけ足すと「開発ビルドでは直るのに配布物では直らない」**という気付きにくい状態になる。

```
tccd: Prompting policy for hardened runtime; service: kTCCServiceCalendar
      requires entitlement com.apple.security.personal-information.calendars
tccd: Policy disallows prompt for Sub:{com.pike.dev}; access denied
```

- **entitlement と usage description は対で要る。** entitlement が無いとダイアログ自体が
  出ず、usage description が無いと出せるダイアログでも拒否される
- **`entitlements.plist` に XML コメントを書かないこと。** codesign が使う AMFI の
  パーサはコメントを解釈せず、`Failed to parse entitlements: AMFIUnserializeXML:
  syntax error near line N` でビルドが落ちる（`Info.plist` 側は寛容なパーサなので通る）。
  だから理由はこのファイルに書いてある
- **リソースアクセス系は一通り宣言する。** 任意のコマンドを走らせる以上どれが要るかを
  予測できず、一部だけ開けると次に別のリソースを触るコマンドで同じ無言の失敗を踏む。
  iTerm2 も同じ組を宣言している。**entitlement は「許可」ではなく「ユーザーに尋ねる権利」**で、
  実際の可否は毎回ダイアログでユーザーが決める。宣言しても起動しただけでは
  ダイアログは出ない（WebView が起動時に出すのは能力の事前問い合わせで、
  実アクセスまでプロンプトに至らない。実機で確認）
- **宣言が要らないものもある。** デスクトップ・書類・ダウンロードのフォルダは何もしなくても
  プロンプトが出る（文言は OS が用意する）。**子プロセス発の AppleEvents も同じ**で、
  `osascript` は Apple 署名なので `accessing` 側の制約に当たらない
  （`NSAppleEventsUsageDescription` を置いてあるのは Pike 自身の WebView が出す要求のため）
- **フルディスクアクセス・画面収録・入力監視は entitlement では開かない。** ユーザーが
  システム設定で Pike を追加するもので、手順は `docs/manual/terminal-and-agents.md` にある
- **許可は再ビルドをまたいで持続する**（#283 の署名が前提）。TCC のレコードは指定要件
  （`identifier "com.pike.dev" and anchor apple generic and ... leaf[subject.OU] = <Team ID>`）に
  紐付くので、cdhash が変わっても一致する。ad-hoc 署名では `anchor apple generic` を
  満たせず、更新のたびに許可が消える
- 調査は `log show --last 3m --info --debug --predicate 'process == "tccd"'`。
  検証をやり直すときは `tccutil reset All com.pike.dev` で記録を消す

## キーボードショートカット（#254）

**`Cmd` 付きのショートカットは macOS のネイティブメニューが唯一の入口。** メニューの
key equivalent は AppKit が WebView へ渡す前に処理するので、`window` の keydown では
絶対に拾えない（自前のメニューが無いと Tauri の既定メニューの `Close Window ⌘W` が効き、
タブではなくウィンドウが閉じる）。

- 実体は `src-tauri/src/appmenu/mod.rs`（macOS 専用。他の OS はメニューバーを持たず、
  `lib.rs` の `#[cfg(not(target_os = "macos"))] mod appmenu` が何もしない stub）
- **メニューに載せた項目のアクセラレータは WebView に届かなくなる。** 載せてよいのは
  ウィンドウ／タブの操作と、AppKit から奪い返す必要があるものだけ。`Cmd+S` / `Cmd+F`
  （CodeMirror）・`Cmd+K`（Markdown のリンク挿入と一覧の取り合い）・`Cmd+1`〜`9` は
  **載せない**
- **Edit メニューの predefined 項目は必ず入れる。** WebView 内のテキスト入力の
  `Cmd+C` / `Cmd+V` / `Cmd+X` / `Cmd+A` は、対応するメニュー項目が無いと macOS では
  動かない（既定メニューが担っていた役割をそのまま引き継ぐ）
- メニュー項目は動作を持たず、フォーカス中のウィンドウへ `pike://menu` を emit する
  だけ。**動作の実体はフロントの `composables/useAppActions.ts` に 1 本**で、
  キーボード（`useKeyboardShortcuts.ts`）とメニューが同じものを呼ぶ。片方にしか
  無い動作を作らないこと（macOS ではメニューが正、他ではキーが正、という食い違いになる）
- **グローバルの menu-event リスナにはトレイのメニュー項目も届く**ので、`appmenu` は
  `menu:` の接頭辞で自分のぶんだけを拾う
- 修飾キーの読み替えは **`src/lib/keys.ts` の `hasMod`**（mac は `metaKey`、他は
  `ctrlKey`）。`e.ctrlKey` の直書きを増やさないこと
- **macOS では Ctrl+英字を奪わない**（`terminalClaims` が mac では `Ctrl` を明示した chord だけに絞る）。ターミナルとの取り合い
  （#224）は Ctrl を Pike とシェルで分け合う Windows / Linux の事情で、mac の
  Ctrl は readline（`Ctrl+W` = unix-werase、`Ctrl+T` = transpose）のもの。**ただし
  `Tab` / `PageUp` / `PageDown` は返さない**: mac でもタブ切替のキーで、xterm は
  これらを PTY へ送って `stopPropagation` するため、返すとターミナルにフォーカスが
  あるあいだタブを切り替える手段が無くなる
- **グローバルの keydown ハンドラの早期 return に `e.ctrlKey` を残すこと。** mac の
  `hasMod` は Cmd なので、`if (!mod && !e.altKey) return` と書くと Ctrl+Tab 系が
  そこで死ぬ（キーの一覧より前に落ちるので、原因が見えない）
- **キーの割り当ての正本は `src/lib/shortcuts.ts` の `keyBindings`。** chord は
  `'Mod+Shift+P'` の表記で書き、判定（`matchChord`）・一覧の表記（`chordChips`）・
  macOS のメニューのアクセラレータ（`menuActions()` → `menusRefresh`）が同じ文字列を読む。
  **リテラルを増やさないこと**: 写しには型検査が効かず、実装と一覧の表記がずれる
- **メニューの項目名も Rust に写しを持たせない。** ラベルは `menu.*` の i18n が正本で、
  `MenuAction` として渡す。Rust が持つのはサブメニューの見出し 5 語と、メニューの構造
  （AppKit の作法なのでフロントに語彙が無い）だけ

**macOS のコードは CI の `Check & Test (macos-latest)` ジョブでしか型検査されない。** Windows 側のジョブは
`cfg` に阻まれて `appmenu` を 1 行も見ない。macOS 専用のコードを足したら、ローカルの
`just check` が通っても**それだけでは検査されていない**。

**lint を足すときも同じ死角を踏む**。`Cargo.toml` の
`[lints.clippy]` はクレート全体に効く一方、**`cargo clippy --fix` が直せるのは手元の
`cfg` から見えるコードだけ**なので、Windows で直し切ったつもりでも `cfg(not(windows))`
の中が残って macOS のジョブで落ちる。**Linux だけの枝（`cfg(not(any(windows,
target_os = "macos")))`）はどちらのジョブにも出てこない**ので、そこはコードを読むしかない。
`cargo clippy --target aarch64-apple-darwin` を手元で回す手は使えない（objc2 の
ビルドスクリプトが `cc` を要る）。

## ダイアログ

フォルダ / ファイル選択は Windows が PowerShell + WinForms、macOS が `osascript` の
`choose folder` / `choose file` / `choose file name`（`lib.rs`）。**キャンセルの見分け方が違う**:
PowerShell 版は「空文字」、`osascript` は「終了コード 1」なので、成功したときだけ stdout を見る。

**PowerShell の出力は UTF-8 に固定する**（`dialog::powershell` の先頭の
`[Console]::OutputEncoding`）。パイプへの出力は既定でコンソールの文字コード（日本語の
Windows では Shift_JIS）になり、選んだパスに日本語があると化ける。**化けたパスはその
まま使われ**、化けた名前のフォルダやファイルが作られる。

**Windows のコンソールのプログラムの出力は `types::decode_console_output` で読む**
（`ShellConfig` の `run` / `run_stdout` / `run_shell_line` はこれを通す。Windows 以外では
`into_lossy_string` と同じ）。UTF-8 として
読めない**行だけ** OEM の文字コード（`GetOEMCP`）で読み直す。全体で決めると、1 行混ざった
Shift_JIS のせいで UTF-8 の行まで化け、Problems の `path:line:col:` の解析が外れる。cmd の組み込みコマンド（`dir`・
`echo`）とエラー文は OEM で書き、**`chcp 65001` を前に置いても組み込みコマンドには
効かない**（`where` のような外部コマンドには効く。実測）。一方 git や node は UTF-8 で
書くので、1 回の出力に両方が混ざりうる。**cmd の組み込みコマンドの出力を読む経路は
増やさないこと**。ファイル一覧の切り戻しは `dir` ではなく `fs::list_files_native`、
Git Bash の場所は `where git` ではなく PATH を自分で歩いて探す（`find_pwsh_path` と同じ）。
**プロセスを起こさずに済むなら、そもそも出力を読まない**のがいちばん確か。

**Windows では pwsh があればそちらで出す**（#271）。PowerShell 7 は .NET 5+ なので、同じ
`FolderBrowserDialog` がモダンなダイアログになり、アドレス欄でパスを打て、ナビゲーション
ペインに WSL の「Linux」が出る。`powershell.exe`（.NET Framework）は旧式の「フォルダーの
参照」ツリーで、UNC を打ち込む手段が無い。`pty::find_pwsh_path`（実在を確認する版）で探し、
無ければ `powershell.exe` に落ちる。

**WSL のディレクトリは UNC で選ぶ。** フォルダ選択に初期位置を渡せるようにしてあり
（`pickFolder(initial)`）、WSL プロジェクトでは `wslNativeToUnc` で作った
`wsl.localhost` の UNC を渡す。Windows のダイアログはこれをそのまま辿れるので、
WSL 用の選択 UI を自前で作る必要はない。

**cfg は「macOS かそれ以外か」で切らないこと。** それだと Linux が `powershell.exe` を起動しに行き、
終了コード判定に当たって意味の分からないエラーになる（`powershell` という名前の別物が PATH に
あれば、黙って「キャンセルされた」ことになる）。Windows / macOS / それ以外の 3 分岐で、
最後は `dialog::unsupported` が実装が無いことを言う。

## アプリアイコン（#256）

**macOS のアイコンには決まった余白がある。** Apple のグリッドでは 1024x1024 のキャンバスに
対して本体が **824x824（80.5%）**で、周囲に約 10% の透明な余白を残す。`tauri icon` はこれを
足さない（元画像をリサイズするだけ）ので、端まで描かれた素材を渡すと Dock で他のアプリより
**1 辺で約 1.24 倍・面積で約 1.54 倍**に見える。Windows のタスクバーは端まで描くアイコンが
普通なので、Windows だけで見ていると気付けない。

- 余白を付けるのは **`icon.icns` だけ**。`icon.ico` と PNG 一式（Windows のタスクバーと、
  `app.default_window_icon()` 由来のトレイが使う）は端まで描いたままにする。両方に付けると
  Windows のアイコンが理由なく小さくなる
- **正本は `src-tauri/icons/icon.svg`**。ラスタは全部 `bash scripts/make-icons.sh` で作り直す。
  あれは `tauri icon` を 2 回（そのままの SVG と、824 を 1024 に収めた版）走らせて、
  **icns だけ余白版から採る**。`tauri icon` は入力をリサイズするだけで余白を足さないため
- **`tauri icon` を直接 1 回で叩かないこと。** それだと icns にも余白が入らない
- icns は**アイコンを変えていなくても毎回バイトが変わる**（tauri CLI がエントリを違う順で
  書く。中身は同一）。絵が変わったかは PNG 側の差分で見る
- macOS の `iconutil` は要らない。tauri CLI は Windows でも icns を書ける

## rg サイドカー

`externalBin` は**ビルド対象のトリプルを接尾辞に持つファイル**を必ず要求するので、
`binaries/rg-<triple>` が無いとバンドル直前に落ちる（Rust のコンパイルは通っているのに
`resource path ... doesn't exist` で止まるので、原因が分かりにくい）。`scripts/download-rg.sh`
は既定で `rustc -vV` のホストトリプルを見る（クロスビルドは `TARGET` を明示）。
Windows は zip・それ以外は tar.gz と、アーカイブ形式も接尾辞の `.exe` の有無も変わる。

**取得はファイルの有無だけで判定する。** スクリプトの冒頭にある `if [ -f "$OUT_FILE" ]` は
中身のバージョンを見ないので、`VERSION` を上げても手元に古いバイナリが残っていれば
`already exists` で素通りする。上げたときは `rm -f src-tauri/binaries/rg-*` してから
取り直すこと。CI はクリーンなランナーなので毎回ダウンロードするが、取ってくるのは
`VERSION` に書いてあるものであって最新版ではない（`ci.yml` / `release.yml` はどちらも
`just fetch-rg` を呼ぶだけ）。**この差分に気付ける仕組みが無い**ので、確認する手順を
`release` スキル（`.claude/skills/release/SKILL.md`）の手順 1 に置いてある。
