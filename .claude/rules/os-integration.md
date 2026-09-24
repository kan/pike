---
paths:
  - "src-tauri/src/main.rs"
  - "src-tauri/src/lib.rs"
  - "src-tauri/src/cli.rs"
  - "src-tauri/src/wait.rs"
  - "src-tauri/src/elevate.rs"
  - "src-tauri/src/tray/**"
  - "src-tauri/src/jumplist/**"
  - "src-tauri/nsis/**"
  - "src/App.vue"
  - "src/composables/useCliOpen.ts"
  - "src/composables/useBusyExit.ts"
---

# グローバルモード・CLI・OS 統合 実装ルール

グローバルモードのウィンドウ、`pike` CLI と `--wait`、ジャンプリスト、システムトレイ。
ウィンドウの生成と永続化は `window.md`、プロジェクトの解決は `project.md`。

## グローバルモード（#123）
- プロジェクト非依存・サイドバー無しのウィンドウ。ラベル prefix `global-`（Rust `GLOBAL_PREFIX` / front `isGlobalWindow()`）。prefix を変えるときは capabilities も直す（`window.md` の「マルチウィンドウ」）
- App.vue の `globalMode` ref が制御: SideBar / ProjectSwitcher / QuickOpen を非表示、プロジェクト復元をスキップ、**全タブを閉じるとウィンドウも close**（`tabs.length` の watch、prev>0 → 0 のみ）
- 発動経路は 3 つ:
  1. **エディタ**: `--wait` と、プロジェクトウィンドウに一致しないファイル引数（`global-` ウィンドウ生成 + pending）。**コールドスタートのファイル引数**（「プログラムから開く」等）は main ウィンドウが `peekInitialCliAction()` で openFiles を検知して globalMode に入る（`last_project.txt` は消費しないので次回の素の起動で全プロジェクト復元される）
  2. **ターミナル**: `pike --terminal`（ジャンプリストとトレイのシェルごとの項目も同じ形）→ `CliAction::OpenTerminal { cwd, shell: Option<ShellConfig> }`（`--shell=` が無ければ `cli::terminal_action_for_cwd`: cwd が WSL UNC ならその distro の WSL を `Some` で指定、それ以外は `shell=None`＝「指定なし」。#125）。フロント `useCliOpen` が `None` の時は Settings の `globalShell` で開き、`globalShell` が WSL なら Windows の cwd を捨てて WSL ホーム開始（`--cd ~`）、Windows シェルなら cwd 引き継ぎ
     - **起動済みで引数なしの `pike` はターミナルを開かず、main を前に出す**（`show_main_window`。トレイの「表示」と同じ）。**タスクバーのボタンからの起動も同じ経路に来る**ので、ここでターミナルを開くとトレイに畳んだ Pike を呼び戻せない。ターミナルはジャンプリストとトレイのメニューから開ける
  3. **OpenDirectory の ad-hoc 作成失敗フォールバック**（ターミナルタブ）
- **WSL パスの UNC 化**: プロジェクト無しウィンドウのファイル I/O は Windows 側（`shellForIO` fallback = powershell）で走るため、WSL native パスは `CliFileTarget.distro` ヒントから `\\wsl.localhost\{distro}\...` に組み立てて開く（front `tabPathFor` ↔ Rust `wait_tab_path` が同期必須: --wait の解放照合はタブの path で行われる）
- CLI で開くファイルは拡張子ルーティング（画像→PreviewTab / pdf→PdfTab / 他→EditorTab、`useCliOpen.openFileTarget`）。PdfTab は shell fallback（powershell）でプロジェクト無しでも表示可
- **ターミナルの「+」**: グローバルモードでは Settings の `globalShell`（`ShellType`、既定 powershell）で起動。この設定はマシンの WSL distro に依存するため **`pike:sync-path` と同じマシンローカル扱い**: 独立キー `pike:global-shell` に保存し、同期ファイル・クロスウィンドウ broadcast の対象外（`sanitizeGlobalShell` で破損値ガード）。▾ ドロップダウンの内容は **シェルプロファイル**（#129。`settings-ui.md`）駆動。アイコンは `lib/shellIcons.ts` の `SHELL_KIND_ICONS`（TabPane と SettingsTab で共有）。distro 検出はメニュー初回オープン時に lazy
- **ProjectSwitcher（Ctrl+Shift+P）はグローバルモードでも使用可**。選択・新規作成は常に `openProjectWindow`（グローバルウィンドウ自身はプロジェクトレスを維持、`selectProject`）。グローバルウィンドウは起動時に projects を読まないため showSwitcher の watch で lazy load。QuickOpen（Ctrl+P）は非表示のまま

## pike CLI
- バイナリ名 `pike.exe`（`Cargo.toml` `[[bin]] name = "pike"`）
- `tauri-plugin-single-instance` で二重起動を防止、引数を既存インスタンスに転送
- `pike file.rs:42` → ファイルを開いてジャンプ、`pike open <file>` も同様。**複数ファイル引数対応**（`CliAction::OpenFiles { files: Vec<CliFileTarget{path,line,distro}> }`、pike.exe へのドラッグ&ドロップ / エクスプローラー「プログラムから開く」経由）
- `pike .` / `pike <dir>` → ディレクトリに一致するプロジェクトに切替（ディレクトリは**先頭引数のみ**有効）
- マッチしない場合は**一時プロジェクト**として開き、ウィンドウが登録するか 1 度だけ聞く（#230。`project.md` の一時プロジェクトの節）
- **存在しない root もプロジェクト起動として扱う（#212）**: `resolve_path_arg` はファイルシステムにしか聞けないので、未 clone のプロジェクト root（や WSL 停止中の root）は `is_dir=false` で `OpenFiles` になり、ディレクトリを開くエディタタブができる。ジャンプリスト（#160）が渡すのは正にこの root なので、`lib.rs` の `as_project_dir` が**単独・行番号なしのパス引数が登録済み root と一致したら `OpenDirectory` に読み替える**（`project_for_root` は `normalize_path` 比較）。これで通常のプロジェクトルーティングに乗り、開いたウィンドウが clone を提案できる
- **コールドスタートでプロジェクトを開く（#212）**: Pike 停止中の `pike <dir>` は、setup で root が登録済みプロジェクトに一致したら `project::set_window_project(state, "main", id)` で **`window_projects` を seed** し、フロントは既存の `project_for_window` 経路でそのプロジェクトに切り替わる（seed しないとフロントが `restoreLastProject` に落ち、ジャンプリストから起動しても前回セッションが開く）。`window_projects` への書き込みはこの関数に一本化（`build_project_window` / `project_add_open` も同じ入口）。`last_project.txt` のクリアは**フロント側**（App.vue の `isMainWindow()` 分岐）で行う: この起動は前回セッションの復元ではなく、`project_add_open` が直後に自分を書き戻す。クリアしないと前回分が積み上がって次の素の起動で全部開く。`restoreLastProject` も同じ `projectSetLast([])` を呼ぶので、クリアの所有者はフロント 1 箇所に揃う
- **`pike agent-hook` は Tauri を起動しない（#299）**: `main.rs` が argv を見て `agent_hook::try_agent_hook_and_exit` へ分岐し、そこでプロセスが終わる。**`wait::try_forward_pty_origin_and_exit` より先に見ること**（hook は Pike のターミナルの中で走るので `PIKE_WINDOW_LABEL` を持っており、あちらが先に走ると `--from-window` 付きで転送されて「`agent-hook` という名前のファイルを開く」になる）。**走行中のインスタンスへは何も送らない**（申告はファイルに書き、`resolve` のキャッシュが mtime で拾う）ので、single-instance の経路には一切現れない。詳細は `.claude/rules/agent.md` と `agent_hook.rs` の doc
- ファイル引数のルーティング: `--from-window` 発ウィンドウ → **全ファイルを含む**プロジェクトウィンドウ → グローバルウィンドウの順（`CliState.pending` でアクションを転送）
- **ディレクトリ引数も発ウィンドウで開く（#352）**: `pike <dir>` を Pike のターミナルから
  叩いたら、そのウィンドウのプロジェクトを切り替える（`CliAction::AdoptProject` を届ける。
  変種を分けた理由はあの宣言の隣）。**順序が要点**で、まず「どこかのウィンドウが既に持って
  いるか」を見てから `--from-window` を見る（1 プロジェクト 1 ウィンドウを崩さない。自分の
  ウィンドウが持っているなら前に出るだけ）
  - **グローバルモードのウィンドウは除く**（プロジェクトを抱えられない）。**判定が Rust と
    フロントの 2 段に分かれている**理由は `useCliOpen.ts` の受け口が正本。要点だけ:
    `main` は実行時にグローバルモードへ入るので、ラベルからは見分けられない
  - **既知の制約**: `--from-window` のラベルはプロセスをまたいで一意ではない。昇格した
    インスタンス（#138、`--new-instance`）のターミナルから叩くと `main` が通常のインスタンス
    の `main` に当たる。ファイル引数（`OpenFiles`）が前から抱えている穴と同じもので、塞ぐには
    `PIKE_WINDOW_LABEL` にプロセスの目印を足すことになる
  - **効くのは Windows だけ**（`--from-window` を付けるのは `wait.rs` の
    `try_forward_pty_origin_and_exit` で、あれが WM_COPYDATA 前提）。他の OS では
    新しいウィンドウで開く
  - **一時プロジェクト（#230）の据え付けと `projectTransientBind` は `switchProject` の
    持ち物**（#352）。呼び出し側に置くと、離れる側の後始末が飛ぶ順序で書けてしまう（理由は
    あの関数の中のコメント）
- 既存エディタタブがある場合はフォーカス＋リロード（`reloadRequested` タイムスタンプ）
- **NSIS インストーラフック**（`src-tauri/nsis/hooks.nsi`、`tauri.conf.json` の `bundle.windows.nsis.installerHooks`）: POSTINSTALL でユーザー PATH に `$INSTDIR` を冪等追加（#146。REG_EXPAND_SZ 維持・updater の再インストールでも重複しない）と、**エクスプローラー「プログラムから開く」候補登録**（`SHCTX\Software\Classes\Applications\pike.exe` に `FriendlyAppName` + `shell\open\command`。SupportedTypes 非設定 = 全拡張子の「別のアプリを選択」一覧に出る。既定の関連付けは変更しない）。PREUNINSTALL で両方を削除。MSI インストーラにはこのフックは無い（NSIS 推奨の理由の 1 つ）

## `pike --wait`（GIT_EDITOR 連携）
- `src-tauri/src/wait.rs`。`GIT_EDITOR="pike.exe --wait"` でコミットメッセージ編集に対応
- 二次インスタンスが WM_COPYDATA（single-instance プラグインの規約）でファイルパスを既存ウィンドウに転送、`WaitState` で wait_id ↔ (パス, ウィンドウラベル) を管理
- エディタタブを閉じると待機中プロセスが解放され、ウィンドウも自動で閉じる。ウィンドウ破棄時の abort は**そのウィンドウが所有する wait のみ**（グローバルターミナルウィンドウの開閉が無関係な GIT_EDITOR 待機を解放しないため）
- **ファイル引数なしの `--wait`**（素の `pike --wait` や directory 引数）は待機対象が無いため、abort イベントで即座に CLI を解放してから通常のアクション処理に回す（解放しないと CLI が永遠にブロックする）

## Windows ジャンプリスト（タスクバー右クリック、#160）
- タスクバーのピン留め / 実行中ボタンを右クリックしたときのメニュー（ジャンプリスト）に独自項目を差し込む。`src-tauri/src/jumplist/mod.rs`（Windows 専用、`ICustomDestinationList` COM API）
- 構成: (1) Tasks カテゴリ＝**シェルごとのターミナル起動**（#240。表示中のシェル 1 つにつき 1 項目で、タイトルはシェル名、`pike.exe --terminal "--shell=<id>"`、作業ディレクトリ=`%USERPROFILE%`）。ジャンプリストはサブメニューを持てないので平並びにする（Windows Terminal のプロファイル一覧と同じ形）、(2) 独自カテゴリ「プロジェクト」→ 登録プロジェクトを **`last_opened` 降順**で最大 `MAX_PROJECTS`=10 件。選ぶと `pike.exe <root>`（single-instance の `OpenDirectory` ルーティングを再利用＝既存ウィンドウならフォーカス、無ければ新規＋セッション復元）、(3) `AppendKnownCategory(KDC_RECENT)` で既定の「最近開いたファイル」を復元（カスタムリストを構築すると明示追加しない限り消えるため）
- **WSL プロジェクトのパス引数**: root がネイティブパス（`/home/...`）なので、CLI で解釈できる UNC 形 `\\wsl.localhost\<distro>\...`（`open_arg_for`）に変換して渡す。`cli::resolve_path_arg` が native へ戻して `OpenDirectory` のマッチに使う（WSL 停止中は canonicalize 失敗で file 扱いに劣化するが実害小）
- **タイトルは VT_LPWSTR**: `IPropertyStore` の `PKEY_Title` に手組み PROPVARIANT（`CoTaskMemAlloc` した文字列、Drop の `PropVariantClear` が解放）を入れる。crate の `From<&str>` は **VT_BSTR** になりジャンプリストのタイトルとして表示されないため
- **COM スレッド（main に載せてはいけない）**: shell オブジェクトは STA なので専用スレッドが要る。**構築は `jumplist` という常駐スレッド**（`worker()` が lazy 起動、起動時に `CoInitializeEx(COINIT_APARTMENTTHREADED)` して以後初期化しっぱなし、ジョブは channel 送信で投げっぱなし）で行う。**`run_on_main_thread` に載せるとアプリ全体がハングする**: `AppendKnownCategory(KDC_RECENT)` と `CommitList` はシェルの最近使った項目を解決するため AppResolver と LINKINFO/MPR を引き込み、Pike が WSL プロジェクトに渡す `\\wsl.localhost\<distro>\...` の UNC 解決で数十秒ブロックしうる。その間 UI スレッドが止まり Windows に AppHangB1 で強制終了される（WER の LoadedModule に `appresolver.dll` / `LINKINFO.dll` / `MPR.dll` / `ntshrui.dll` が並ぶのが指紋）。溜まったジョブは `try_iter().last()` で最新だけ処理する（複数ウィンドウが同じ変更で一斉に呼ぶため）
- **AppUserModelID**: 明示設定せず exe パス由来の暗黙 ID に載せる（インストーラのショートカット・実行プロセス・カスタムリストが同一 ID になり整合。dev ビルドと本番は exe パスが違うので自然に分離）
- **シェル一覧はフロントから渡す**（#240）: `pike:shell-profiles` は localStorage にありマシンローカルなので Rust からは読めない。`menus_refresh` の引数 `shells: Vec<MenuShell>`（`{ id, label }`）で受け、Rust は表示と引数の組み立てだけを行う。`id` はフロントの `shellId` と同じ表記（`wsl:<distro>` / `cmd` / `powershell` / `pwsh` / `git-bash`）で、**戻す側は `types::shell_from_id` の 1 箇所**（CLI の `--shell=` とトレイの `tray:new-terminal:<id>` が同じ関数を通る）。信頼できない入力の入口なので distro は文字種を絞って検証する
- **WSL シェルを指定したときの cwd は落とす**（`cli::terminal_cwd_for`）: ジャンプリストのリンクは作業ディレクトリが `%USERPROFILE%` なので、そのまま渡すと distro の中で意味を持たない Windows パスで開こうとする。UNC 形（`\\wsl.localhost\<distro>\...`）なら native へ直し、別の distro のものなら捨てる。フロント側の globalShell 経路（`useCliOpen`）と同じ判断を、明示指定の経路でも Rust 側で 1 回だけ行う
- **WSL のエントリはディストロ検出のあとに出る**: `syncShellProfiles` はターミナル追加の ▾ を初めて開いたときに走る。検出前は Windows のシェルだけが並ぶが、プロファイルは永続化されるので次回以降は起動直後から出る（検出のためだけに起動時へ `wsl.exe` を足さない）
- **更新契機**: `stores/project.ts` の **`watch`（`projects` の id/name/root/lastOpened ＋ `locale` ＋ `settings.menuShells` をキー化）** → `menusRefresh(locale, shells)` コマンド（jump list と tray を 1 コマンドで更新。Rust 側でプロジェクト一覧を 1 回だけ読んで両者に渡す＝二重ディスク読み回避）。起動時のロード・プロジェクト追加/削除/編集・切替（recency）・UI 言語切替を 1 箇所でカバーする。**session flush（`lastSession` 書き換え）は同一オブジェクトを触るが、Vue のプロパティ単位トラッキングでキーのゲッターが再評価されず発火しない**（`currentProject` は `projects` の要素と同一参照なので naive な deep watch だと flush ごとに発火してしまう点に注意）。加えて Rust 側が **署名（exe＋lang＋各項目の title/args＋シェル一覧）を比較して不変なら CommitList をスキップ**するので二重に過剰再構築を防ぐ。ラベルは Rust からフロント i18n を読めないため locale を引数で受け 2 文字列だけ言語別に持つ
- ユーザーが「一覧から削除」した項目は `BeginList` の removed 配列（引数で照合）で除外し、`AppendCategory` 失敗時も Tasks/Recent は生かす

## システムトレイ（タスクトレイ、#161）
- `src-tauri/src/tray/mod.rs`（`tauri` の `tray-icon` feature）。トレイに常駐し、ウィンドウを閉じても復帰できる。`tray/mod.rs` は presentation（アイコン・メニュー・ツールチップ構築）に徹し、メニューの動作は lib.rs の `pub(crate) fn tray_menu_action` / `toggle_main_window` に委譲（ウィンドウ生成/フォーカスの private ヘルパーが lib.rs 側にあるため）
- **クローズ動作 = トレイ常駐（設定で切替）**: main の `CloseRequested` は常に `prevent_close`（main は async ランタイムを所有しているので、生の破棄は他のウィンドウの非同期コマンドごと道連れにする。必ず防ぐ）した上で、**設定 `closeToTray`（既定 OFF。トレイに残すのはオプトイン）で分岐**。ON → `hide` + `main-minimized-to-tray` emit（session/PTY/ポーリングは生かしたまま、トレイから復帰、実終了はトレイ「終了」の `app.exit(0)` のみ）。OFF → 次の bullet の分岐で終了する。設定はフロントの localStorage にあり Rust から読めないので、プロセスグローバルな `static CLOSE_TO_TRAY: AtomicBool`（既定 false。フロントの既定と揃える）を `tray_set_close_to_tray` コマンドで同期（App.vue の `watch(settingsStore.closeToTray, immediate)`、**main ウィンドウのみ**。他ウィンドウでの切替はクロスウィンドウ設定ブロードキャストで main のストアに伝播し main の watch が発火する）
- **トレイの「終了」とセルフアップデートも実行中の確認を通す（#178）**。トレイは Rust の `request_quit_from_tray` が動いているものを数え（`pty::busy_count`）、0 ならそのまま終了、あれば **main を表示してから** `main-exit-requested` を送る（隠れた main にダイアログを出すと誰にも見えず、終了が黙って止まる）。数えた件数は payload に載せ、フロントは数え直さない（WSL の判定がもう 1 周走る）。**代償は、何か動いているあいだは WebView が固まると「終了」が効かないこと**。アップデートは `useUpdater.downloadAndInstall` の**ダウンロードより前**に `confirmBusyExit`（Windows のインストーラは適用した時点でアプリを終わらせるので、後から聞けない）。**Pike ごと終了する経路を足すときは `useBusyExit.ts` を通す**
- **closeToTray OFF でも close は他ウィンドウを道連れにしない（#202）**: main の close は、他ウィンドウが残っていれば hide + `static MAIN_CLOSED_HIDDEN`（既定 false）を立てる + `main-window-hidden` emit（フロントは session 保存のみ。トレイ常駐ではないのでトレイヒントは出さない）、main が最後なら `main-exit-requested` → フロント確認 → `app_exit`。要点は**「論理的に閉じた main」をアプリを生かす対象に数えない**こと。判定は `close_would_quit(app, label)`（`label` 以外に生きたウィンドウが残るか。`MAIN_CLOSED_HIDDEN` が立った main は数えない）に集約し、`CloseRequested` / `Destroyed`（最後の 1 つが閉じたら cleanup 後に `app.exit(0)`）/ `window_close_quits_app`（フロントの close 確認をアプリ全体の busy 件数に切替）が共有する。破棄できない main の代用が hide なので、フラグの上げ下げは `hide_main_window(app, logically_closed)` と `restore_window`（トレイ左クリック・「表示」・プロジェクトフォーカス・CLI の `emit_action_to`）の対に集約し、`tray_set_close_to_tray(true)` も下ろす。**main を hide / 再表示する経路を足すときは必ずこの 2 つを通す**（自前で show すると論理的に閉じたままになり、次のウィンドウ close で見えている main ごと終了する）
- **左クリック**: `toggle_main_window`（表示中かつフォーカス時は hide、それ以外は show+unminimize+focus）。`show_menu_on_left_click(false)` でメニューは右クリック専用
- **右クリックメニュー**（`build_menu`、id 規約 `tray:show` / `tray:new-terminal:{shellId}` / `tray:switcher` / `tray:quit` / `tray:proj:{id}`）: 表示 / 新しいターミナルウィンドウ（**シェルごとのサブメニュー**、#240。`create_global_window`+OpenTerminal に `shell` を載せる。パースできない id は近そうなシェルで代用せず何も開かない。シェル一覧が空のときだけ単独項目 `tray:new-terminal` に落ちる＝`tray::build` が起動時に空で作るため。ジャンプリストのほうは `menus_refresh` 以外から呼ばれないので、この分岐を持たない）/ 最近のプロジェクト（サブメニュー、`read_all_projects_sorted` 最大 8 件、選ぶと該当ウィンドウ focus か `build_window`）/ プロジェクトを開く…（main を show して `tray-open-switcher` を emit_to→スイッチャー表示）/ 終了
- **更新契機**: jump list と共通の `menus_refresh` コマンド（前述）が `tray::refresh(app, lang, &projects, &shells)` を呼び `app.tray_by_id("main").set_menu` で作り直す。プロジェクト一覧は menus_refresh が 1 回だけ読んで jump list と共有。起動時の `tray::build` はサブメニュー空（静的項目のみ）で作り、mount 後の menus_refresh が一覧つきに差し替える。ラベルは locale 引数で言語別（Rust からフロント i18n は読めない）
- **使用量ツールチップ**: main の StatusBar だけが（トレイは 1 プロセス 1 リソースなので）usage を整形して `traySetTooltip` で push。Claude 5h レート（アカウント単位なので代表値）優先、無ければトークン総量、無ければ空文字。**フロントが渡すのは usage の要約だけ**で、先頭のアプリ名（開発版の `[DEBUG]` 目印を含む）は `tray::set_tooltip` が付ける。hide 中もポーリングを止めないので畳んだ状態でも更新される
- **初回ヒント**: 初めて閉じたとき `resolveNotifier`（`lib/notify.ts`）で OS 通知（`localStorage['pike:tray-hint-shown']` で 1 回のみ）。ウィンドウが消えたと勘違いさせないため
- アイコンは `app.default_window_icon()` を流用（追加の image feature 不要）
