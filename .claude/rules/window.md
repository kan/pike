---
paths:
  - "src-tauri/src/lib.rs"
  - "src-tauri/src/window_geom.rs"
  - "src-tauri/src/vdesk/**"
  - "src-tauri/capabilities/**"
  - "src/App.vue"
  - "src/lib/window.ts"
  - "src/assets/theme.css"
---

# ウィンドウ実装ルール

ウィンドウの生成と対応づけ、状態の永続化（geometry・仮想デスクトップ）、背景透過。
プロジェクトとの対応の中身は `project.md`、グローバルモードと CLI・トレイは `os-integration.md`。

## マルチウィンドウ
- ProjectSwitcher の Ctrl+Enter または ProjectPanel の ExternalLink ボタンで新ウィンドウにプロジェクトを開く
- ウィンドウラベルは**不透明な `project-{uuid}`**（`global-{uuid}` と同様）。プロジェクトとの対応は Rust の `ProjectState.window_projects`（label → 現在のプロジェクト id）が**唯一の真実**で、`build_project_window` が生成時に seed し、in-place の `switchProject` ごとに `project_add_open` が更新する（#175）。**ラベルから id をパースしない**。フロントは起動時に `project_for_window` コマンドで自ウィンドウのプロジェクトを取得する。ウィンドウ解決（フォーカス/新規・CLI ルーティング・破棄時の `last_project.txt` 掃除）はすべてこのマップ経由（`focus_project_window` / `focus_or_build_project_window` / `focus_project_window_anywhere` と、project 側の `window_holding`）。同一プロジェクトの二重起動は既存ウィンドウをフォーカス（マップで検出）
- **ウィンドウラベル prefix を追加・変更したら `src-tauri/capabilities/default.json` の `windows` も更新すること**。ここはラベルのホワイトリストで、漏れると新ウィンドウで IPC（invoke / listen / set_title 等）が全部 permission エラーになり、App.vue の onMounted が途中で落ちてタブが一切開かない（DevTools コンソールの `not allowed on window "..."` が症状）
- **フロントからウィンドウの状態を変える操作も、同じファイルの `permissions` に 1 行要る。** `core:window:default` に入っているのは**読み取り系だけ**（`is_visible` / `theme` / `title` 等）なので、`show` / `unminimize` / `set_focus` のように状態を変えるものは明示的に許可する。**失敗は静かで**、コンソールに `not allowed` が出るだけでウィンドウが前に出ない
- Tauri v2 の各ウィンドウは独立 JS コンテキスト → Pinia ストアは自然にウィンドウごとに分離
- PTY/Docker イベントは `app.emit()` で全ウィンドウにブロードキャスト、ルーターが ID でフィルタ
- **特定ウィンドウ宛てイベントの受信は `getCurrentWindow().listen()` を使う**（`@tauri-apps/api/event` の素の `listen()` は使わない）: Rust が `app.emit_to(label, …)` で 1 ウィンドウに送っても、素の `listen()` はデフォルト target が `Any` のため**全ウィンドウで発火**する。`cli_open` のようにルーティング済みの宛先ウィンドウだけで処理したいイベントは、必ず `getCurrentWindow().listen()`（target = 自ラベル）で受ける。全ブロードキャスト＋ID フィルタ方式（PTY/Docker）とは使い分ける
- 全ウィンドウ（main + 子）が `last_project.txt` に自身のプロジェクト ID を登録し、起動時に復元
- **main ウィンドウ close → 設定 `closeToTray` が ON ならトレイに常駐（#161、`os-integration.md` の「システムトレイ」。既定は OFF）**。ON では main は破棄せず hide し、アプリは終了しない。実際の終了はトレイの「終了」（`app.exit`）のみ。子ウィンドウを全部閉じても hidden main が残るためアプリは常駐し続ける。**OFF でも main の close が他ウィンドウを道連れにすることは無い**（詳細は「システムトレイ」の #202 の bullet）
- `window_holding` はマップが一致したウィンドウのラベルをそのまま返す（可視判定なし。`focus_project_window_anywhere` が、見せているなら `restore_window`、保持しているだけなら `OpenProject` を届ける、と分ける）。**非可視のヒットを stale とみなして閉じないこと**: ラベルが単発 uuid で `Destroyed` がマップを drain するので、非可視で残りうるのは hide 中の main だけ。閉じると main の close 経路に再入し、OFF 設定ではアプリが終了する（#202）
- 子ウィンドウ close → `beforeunload` で session 保存 + PTY kill（ベストエフォート）

## ウィンドウ状態永続化
- `tauri-plugin-window-state` でウィンドウサイズ・位置・最大化状態を自動保存・復元。ただし**追跡するのは `main` ラベルだけ**（`with_filter`）
- **プロジェクト単位の geometry（#200）**: プロジェクト/グローバルウィンドウのラベルは起動ごとの UUID（#175）なので、ラベル keyed のプラグインでは永久に復元できず `.window-state.json` に死んだエントリが溜まる。そこで `src-tauri/src/window_geom.rs` が **`window_projects` 経由で「そのウィンドウが今表示しているプロジェクト id」をキー**に `%APPDATA%/{identifier}/window-geometry.json` へ保存する（プロジェクト無しは `global` キー、main も同じ規則で記録するので main で開いていたプロジェクトが子ウィンドウへ移っても size を引き継ぐ）。マシンローカルな情報なので同期対象の `project.json` には入れない
  - 保存契機: 既存の Moved/Resized 500ms デバウンス、`CloseRequested`（デバウンス待ちの取りこぼし防止）、`RunEvent::Exit`（トレイ「終了」は CloseRequested を経ずに破棄されるため）、`save_all_window_state`（updater の relaunch 前）
  - **単位は物理ピクセルで統一する**: 記録元の `inner_size()` / `outer_position()` は物理ピクセルだが、`WebviewWindowBuilder` の `inner_size` / `position` は**論理ピクセル**（tauri の doc comment。tao 側も `to_physical(target_monitor.scale_factor())` で変換する）。ビルダーに渡すと 150% ディスプレイでは幅も位置も 1.5 倍になり、開くたびに右下へ膨らんでいく。そのため `window_geom::restore` は **build 後**に `set_position` / `set_size` へ物理ピクセルのまま渡す（`tauri-plugin-window-state` の `restore_state` と同じ手順）。既定サイズから復元サイズへ飛ぶのが見えないよう、`build_window` は `.visible(false)` で生成し restore 後に `show()` する
  - 適用順は **位置 → サイズ → 最大化**。スケール factor の違うディスプレイへ移すと Windows がウィンドウをリサイズするため位置が先。最大化はビルダーではなく最後に呼ぶ（復元矩形の上で最大化すると、解除したときそこへ戻る）
  - 位置は保存時の矩形がいずれかのモニタと重なる場合のみ適用（ディスプレイを外したときに画面外へ行かない）。最大化/最小化中は「戻る先の矩形」を上書きしないようフラグだけ更新
  - プラグインのファイルに残った死蔵エントリは `prune_plugin_state` が起動時に掃除する。**プラグイン登録より前**に走らせる必要がある（プラグインはファイルをメモリへ読み込み、保存ごとにキャッシュ全体を書き戻すため後から消しても復活する）。`AppHandle` がまだ無いので `%APPDATA%/{identifier}` を手組みする（Windows の `app_config_dir` と同一）
- **仮想デスクトップも同じ入れ物で覚える（#317、Windows のみ）**: `Geometry.desktop` に `IVirtualDesktopManager` の GUID を持ち、復元のときにそのデスクトップへ戻す（Chrome / Edge と同じ挙動）。COM の呼び出しは `src-tauri/src/vdesk/`（他 OS は何もしない stub）に集約し、`window_geom` は `move_to` を呼ぶだけ
  - **覚えるのはプロジェクトのウィンドウだけ（#363）**。グローバルウィンドウ（`GLOBAL_KEY`）は今いるデスクトップでその場で呼び出すもの（ジャンプリスト・トレイ・`pike` / `--wait`）なので、覚えたデスクトップへ飛ばすと呼んだ本人の前に出てこない。判定は `remembers_desktop` の 1 つで、**書く側（`record_all`）と読む側（`move_to_stored_desktop`）の両方が見る**（読む側で見ないと、古いファイルに残った `global` のデスクトップで飛び続ける）。サイズと位置は従来どおり覚える
    - **コールドスタートの main も同じ**。ファイルやターミナルを渡された起動はフロントがグローバルモードにするので、`main_geom_key` は `last_project.txt` より先に `initial_action` を見て `GLOBAL_KEY` を返す（見ないと、ジャンプリストから開いたターミナルが前回のプロジェクトのデスクトップへ飛ぶ）。条件は App.vue の `peekInitialCliAction` の分岐と揃える
  - **矩形より先に移す。** 順序を分けておけば「どのデスクトップの、どこに、どの大きさで」が上から順に決まる
  - **答えが無ければ前の値を残す。** 最小化中や未表示のウィンドウは `GUID_NULL` を返すので、そのまま書くと「どこにも属さない」を覚えてしまう
  - **失敗しても進む。** 保存したデスクトップが消えていれば `MoveWindowToDesktop` は失敗するが、**公開 API では作り直せない**（非公開の `IVirtualDesktopManagerInternal` は Windows の更新で壊れる前提のもの）。現在のデスクトップに出す＝この機能が入る前と同じ挙動へ落とす
  - **main ウィンドウは別の入口が要る**（`restore_desktop`）。あれは `tauri.conf.json` 由来で `build_window` を通らず、矩形は window-state プラグインが label で戻すが、あれはデスクトップを知らない
  - **呼ぶ場所が 2 つの条件に挟まれている。** setup の中（イベントループが回り出す前＝表示の前。あとから移すと一瞬だけ今のデスクトップに出てから飛ぶ）で、かつ **CLI の解決より後**（`pike <dir>` で開くプロジェクトが `window_projects` に入るのはそこ。前に置くと、常に前回セッションのデスクトップへ移してしまう）
  - **setup では main が開くプロジェクトを当てにいく**（`main_geom_key`）。CLI にディレクトリを渡された起動では `window_projects` の main が seed 済みで（#212）、素の起動では `last_project.txt` の 1 行目。どちらでもなければ `global`。1 行目を読む `first_shown` は **`project_get_last` と同じく実在するものだけを返す**: あちらは読めない id を落として行ごと捨てるので、濾さないと「フロントは 2 行目を開くのに main だけ 1 行目のデスクトップへ飛ぶ」がありうる（`project_delete` は `window-geometry.json` のエントリまでは消さない）
  - **表示のあとにもう一度移す**（`build_window`）。仮想デスクトップの管理下に入るのは表示されてからなので、`restore` の中の移動（非表示の時点）は環境によって黙って失敗する。冪等なので、効いていれば 2 回目は何もしない。**先の 1 回も残す**: 効く環境ではあちらが表示前に済ませており、削ると一瞬だけ今のデスクトップに見える
  - **COM の初期化は使うあいだだけ**（`ComScope`）。`record_all` はウィンドウを動かすたびに tokio のワーカースレッドから走るので、入れっぱなしにするとメッセージポンプを持たないワーカーが恒久的に STA のまま残る。既に初期化済みのスレッド（メインは WebView2 が STA にしている）では解除もしない
  - **起動すると、最後に復元したウィンドウのデスクトップへ OS が切り替わる**（実機で確認）。表示とともにそのウィンドウがアクティブになるためで、Windows 側の挙動。抑えるには全ウィンドウを復元し終えてから元のデスクトップへ戻す操作が要り、そこまでする価値は無いと判断した（利用者の判断）
  - GUID は**文字列**で持つ（`u128` にすると JSON で 2^53 を超える整数になる）。`GUID` の `Debug` の綴りと `TryFrom<&str>` が対になっているので往復する。この欄が無い古い `window-geometry.json` もそのまま読める
- サイドバーの展開状態（activePanel）と幅は `localStorage` で永続化

## ウィンドウ背景透過（#162）
設定「外観」の 不透明 / 透過 / アクリル と不透明度スライダーで、ウィンドウ背景を半透明にする。ウィンドウは常に transparent 生成し、実際の透け方は `window_set_backdrop` が実行時に切り替える。

- **不透明モードは本当に不透明に戻す**: tao の `transparent` フラグ自体は後から変えられないが、その実体は「空リージョンの `DwmEnableBlurBehindWindow`（= per-pixel alpha 化）」なので**解除はできる**。`window_set_backdrop` は不透明モードで (1) `DwmEnableBlurBehindWindow(fEnable=false)` で per-pixel alpha を切り、(2) WebView2 の既定背景をテーマ色（α=255）に戻す。これをしないと、設定が既定の「不透明」でも全ユーザーが透過合成パスに乗り続ける。WebView2 は **α=0 だけを透過**として扱い、それ以外の α は 255 に丸める仕様なので、透過モードでは `Color(0,0,0,0)` を渡す
- **テーマ色の受け渡し**: 不透明時の下地色は App.vue が `getComputedStyle` で `--bg-primary-rgb`（`"30 30 30"` 形式）を読んで引数で渡す。`theme.css` を単一の真実に保つため。ダーク/ライト切替でも呼び直す必要があるので、watch のキーは `windowBackdrop` と `darkMode`。ただし**色を使うのは不透明モードだけ**なので、透過/アクリルのままテーマだけ変わったときは早期 return する。**不透明度スライダーも native 呼び出しの契機に入れない**（α は CSS しか使わないうえ、ドラッグ中に毎フレーム IPC が飛ぶ）。`data-theme` の差し替え後に読むため `nextTick` を挟む
- **mount 前の下地**: `window_set_backdrop` はフロントの mount 後にしか走らないので、それまでの数フレームは生成時点の背景色がそのまま見える。既定の不透明モードでデスクトップが透けないよう、`build_window` の `.background_color(...)` と `tauri.conf.json` の `backgroundColor`（main ウィンドウ）に下地色を置いてある。Rust 側の定数は `DARK_SURFACE_RGB` / `LIGHT_SURFACE_RGB` で、`theme.css` の `--bg-primary-rgb` と手動同期（ダーク側は parse 失敗時のフォールバックも兼ねる）。なお per-pixel alpha 自体は生成時に外せない（builder にフラグが無い）ので、mount までのごく短い間だけ透過ウィンドウのままである点は残る
  - **静的な指定はダーク固定なので、生成後・表示前に塗り直す**（`apply_startup_surface`、#310）。`build_window` は `.visible(false)` で作るので最初の 1 フレームから合い、main ウィンドウ（config 由来）は setup で塗る（イベントループが回り出す前なので間に合う）
  - **ここで見られるのは OS のテーマだけ**（`themeMode` は localStorage にあり webview の中）。テーマの既定が追従（#310）なので大半はこれで合い、**明示モードで OS と逆を選んでいる場合だけ mount までの数フレームがずれる**。そこまで消すには「前回の解決結果」を Rust から読めるファイルに持つことになり、数フレームのために永続化を 1 つ増やす価値が無いと判断した
  - **Rust 側だけでは足りない。** あれが塗るのはネイティブのウィンドウの下地で、**webview の中身は CSS が決める**。`theme.css` の `:root` はダークなので、`data-theme` が付く（Vue の mount 後）まで中身は黒いままになり、「**枠は白いのに中だけ黒い**」という形で出る。`prefers-color-scheme` の規則を `:root:not([data-theme])` に当てて塞いである（`theme.css` と、`theme.css` 自体が届く前に効く `index.html` のフォールバックの 2 箇所）。**属性が付いた瞬間に当たらなくなる**セレクタなので、明示モードの表示には影響しない
- **DWM 呼び出しは main スレッドで**: `window_set_backdrop` は tokio ワーカーで走るので、DWM / window-vibrancy の呼び出しは `run_on_main_thread` に載せる（ウィンドウ属性の変更はそのウィンドウの所有スレッドで行う）。なお `hwnd()` が返すのは tauri 側の windows 0.61 の `HWND` で、直接依存の 0.62 とは別型なので生ポインタ経由で渡し直す
- **アクリルの注意**: Win11 22621+ の `apply_acrylic` は `DWMWA_SYSTEMBACKDROP_TYPE`（TRANSIENTWINDOW）を使う。window-vibrancy 自身がドラッグ・リサイズが重くなる旨を警告しているので、体感の重さの報告が出たらまずここを疑う
- **アクリルは非アクティブのあいだ外す（#277）**: Win11 22621+ の `DWMWA_SYSTEMBACKDROP_TYPE` は、DWM が**非アクティブのウィンドウではマテリアルを描かず、代わりに不透明のフォールバックをウィンドウの裏に塗る**。per-pixel alpha は効いたままなのに何も透けなくなるので、「アクリルにすると非アクティブのとき透過が効かない」という形で出る（window-vibrancy #139 は OS の挙動として not planned でクローズ。Windows Terminal にも同じ報告が並ぶ）。そこで `WindowEvent::Focused` でマテリアルを付け外しし、非アクティブのあいだは `transparent` モードと同じ素の透過に落とす（ぼかしは消えるが透けたままになる）
  - **設定はプロセスに 1 つの `ACRYLIC_BACKDROP` に写す**（`CLOSE_TO_TRAY` と同じ手口）。`window_set_backdrop` はステートレスで、フロントは設定が変わったときにしか呼ばないので、focus 側から読む先が要る。**ウィンドウごとに持たなくてよい**: `windowBackdrop` は `pike:settings` にあり、全ウィンドウが同じ値をブロードキャストで共有する
  - **`window_set_backdrop` 自身も focus を見る**。テーマ切替などで非アクティブのまま呼ばれることがあり、素直に載せるとそこから次の focus まで不透明に戻る
  - **`clear_mica`（旧ビルドの後始末）は設定を変えた経路にだけ置く**。DWMSBT では `clear_acrylic` と同じ属性書き込みなので、focus のたびに撃つと同じ値を 2 回書くだけになる
  - **`clear_acrylic` は per-pixel alpha を触らない**。透過を殺しているのはあくまで DWM のフォールバックなので、外す側で `set_per_pixel_alpha` に手を出さないこと
  - **外れているあいだは alpha を不透明側へ寄せる**（`stores/settings.ts` の `ACRYLIC_FALLBACK_LIFT`＝0.4。不透明度 40% なら 64% になる）。アクリルは背後をぼかして薄めるので、素の透過に落ちると同じ不透明度でもずっと透けて見える。実効値は**store の `surfaceAlpha` が唯一の出典**で、透過する側はそこだけを読む。各所で `windowOpacity` から組み立てると、持ち上げを片方にだけ書いて画面の中で濃さが割れる
  - ターミナルの下地も同じ理由で store に上げた（`terminalSurfaceBg`）。**`xtermTheme` と対で置く**: あちらが xterm 側を透明にして、こちらが唯一の色を塗る、で 1 つの規則になっている。全ターミナルで同じ値なのでタブごとに組み立てる意味も無い
  - **focus はフロントも Rust と同じ信号で見る**（`lib/window.ts` の `windowFocused` ＝ `onFocusChanged`）。`document.hasFocus()` はタイトルバーだけをクリックしたときに webview へフォーカスが入らずネイティブ側とずれるので、alpha の持ち上げとマテリアルの付け外しのタイミングが食い違う
  - **アクリルでなければ focus のハンドラは何もしない**。既定は不透明モードなので、素通しにすると全ウィンドウの focus / blur ごとに dwmapi を叩くことになる。外す仕事は設定を変えた経路が済ませている
  - **Win11 22621 より前では、そもそもこの問題が起きない**（window-vibrancy が `SetWindowCompositionAttribute` の経路に落ち、非アクティブでもぼかしが残る）。そこでは Pike が余計にマテリアルを外すことになるが、README がサポート対象を Windows 11 と macOS に絞っているので分岐は足していない
- **合成の仕組み**: `theme.css` の背景変数は `rgb(<成分> / var(--surface-alpha))` で合成する。`--surface-alpha` は App.vue が backdrop 設定から算出して `documentElement` に書き込む 1 変数で、これだけで全サーフェスが一括で半透明になる。基盤レイヤーは `#app` の 1 枚だけ（html/body/#app で重ね塗りすると不透明度が掛け算になる）
- **xterm を載せるタブには `.xterm-surface` を付ける**: xterm.css が `.xterm-viewport` に不透明の黒を焼き込んでいる（OS-X のスクロールバー対策）ので、打ち消さないと下地の色が隠れる。規則は `theme.css` に 1 本置いてあり、`TerminalTab` と `DockerLogsTab` が同じクラスと `opaque` の出し分けを共有する。色は store の `terminalSurfaceBg`、`allowTransparency` も backdrop に追従させること（3 つのどれかが欠けると、backdrop を有効にしたときそのタブだけ不透明のまま残る）
- **浮遊サーフェスは不透明**: コンテキストメニュー・ドロップダウン・ダイアログ・ツールチップは透けると読み辛いので `.popup-surface` クラスをルート要素に付ける。**新しいポップアップを追加したら必ず付けること**（付け忘れは backdrop を有効にしたときだけ再現するので、既定の不透明モードでは気付けない）
- **なぜクラスで `--bg-*` を再宣言するのか**: カスタムプロパティの `var()` は**宣言した要素**（`:root`）で置換が確定し、子孫は合成済みの色を継承する。よって子孫で `--surface-alpha` だけ上書きしても効かない。`.popup-surface` はポップアップが実際に塗る 4 変数（`--bg-primary/secondary/tertiary`・`--tab-hover-bg`）を再宣言して、置換をその要素で起こす。背景変数を増やすときは `*-rgb` 側とこのブロックの同期に注意
- **ポップアップの色味**: 素のテーマ色だとアクリル上で黒浮きするため、`--popup-lift-color`（dark=白 / light=黒）を `--popup-lift`（= `(1 - --surface-alpha) × 10%`）だけ `color-mix` で混ぜ、周囲が背景の透けで持ち上がったぶんを不透明色で模倣する。係数 10 は目視調整値
- ターミナルは xterm 背景を透明にしラッパー 1 層でティント（`xtermTheme`）、エディタは CodeMirror の透過 Compartment で背景を透明化する
