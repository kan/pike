# フロント実装ルール

## 基本方針
- Vue 3 Composition API + `<script setup>` で統一
- 状態管理は Pinia、ストアは `src/stores/` に置く
- Tauri invoke は `src/lib/tauri.ts` に型付きラッパーを作って使う（直接 invoke しない）。**あそこに置くのはラッパーだけ**で、ダイアログ・i18n・ストアを読む流れは別ファイルに出す（`lib/openUrl.ts` はそれで切り出した。#311）
- **`lib/` はストアを import してよい**（`openFile.ts` / `openUrl.ts` は「〜を開く唯一の入口」としてストアを読む）。**例外は、ストアから import される `lib/`**（`shortcuts.ts` / `projectPaths.ts` / `paths.ts`）で、そこからストアを読むと循環する。値が要るなら設定側から流し込む（`setShortcutPreset`）。不変条件は「純粋かどうか」ではなく**向き**
- コンポーネントは `src/components/{category}/XxxYyy.vue` の命名

## 外部ブラウザで URL を開く（#311）

- **入口は `lib/openUrl.ts`**。外へ出て行く URL は全部このファイルを通る（確認つきの `openUrlWithConfirm` と、Docker のトンネル用の `openLocalTunnel`）。**素の `openUrl` を呼ぶ経路を増やさないこと**: `check-docs` はシンボルの実在しか見ないので、この不変条件が破れても検出されない
- **開けるのは http(s) と `mailto:` だけ**（同ファイルの `isExternalLink` が述語。プレビューはこれでリンクを振り分ける）。`mailto:` は毎回確認する（承認の鍵はホスト名で、あれは持たないため）
  - **開けないスキームはリンクにしない。** DOMPurify の既定は `ftp` / `tel` / `sms` / `cid` / `xmpp` も通すので、絞らないと「押せるのに何も起きないリンク」ができる（実際にそうなっていた）。許可の正本は `lib/sanitizeHtml.ts` の `ALLOWED_URI_REGEXP` で、**4 つのプレビュー（Markdown / rst / issue / マニュアル）が全部これを渡す**。`isExternalLink` と対で、片方だけ広げると同じ状態が戻る
- 確認ダイアログのチェックボックスでホストを承認すると、以後そのホストは確認なしで開く（`settings.allowedUrlHosts`。マシン非依存なので同期の対象）。**承認の対象はこの関数を通る全経路**で、ターミナルと Docker ログの `WebLinksAddon` が拾った URL も含む
- **`lib/tauri.ts` に置けない理由・ホスト名を完全一致にした理由・トンネルを別関数にした理由は、あのファイルの doc コメントが正本。** 画像ホストの一覧（#239）と分けてある理由は `stores/settings.ts` の宣言の隣
- **「どこから来たリンクか」で経路を分けない**（#311 で検討して見送った）。`github.com` を承認すると、issue の本文や Markdown の `[説明](別の宛先)` も確認なしで開く＝リンクの表示文字列と実際の宛先が食い違いうる経路でも、ダイアログという唯一の開示の場が消える。それでも分けないのは、開く先がブラウザ自身の保護層を持つこと、承認が明示的なオプトインで設定画面から取り消せること、経路ごとに挙動が変わると「なぜここだけ聞かれるのか」を説明できなくなることによる。**分けるなら Markdown プレビューと issue タブの 2 か所**（生の URL が画面に出ているターミナルと、Pike 自身が URL を組み立てるボタン類は、この軸では危険側に入らない）
- 承認済みホストの一覧の UI は `components/panels/AllowedHostList.vue`（画像とリンクで共有）。**2 つのリスト自体は畳まない**: 承認したことの意味が違うので、`ref` を 1 本にすると型からもコメントからもその違いが消える。畳んでよいのは政策を持たない部分（正規化の `withHost` / 一覧の markup / 空表示の文言）だけ

## ウィンドウのフォーカス
- 「このウィンドウがアクティブか」の出典は **`lib/window.ts` の `windowFocused`** ただ 1 つ。元は Rust の `WindowEvent::Focused`（`onFocusChanged`）で、アクリルの付け外し（#277）と同じ信号
- **`document.hasFocus()` で代用しないこと**。タイトルバーだけをクリックしてウィンドウがアクティブになったときは webview にフォーカスが入らないので、そのあいだ止まったままになる。以前は 4 ストアがこれを各自で見ていて、2 つは `windowFocused` という同名のローカル変数まで持っていた
- 「アクティブなあいだだけポーリングし、戻ってきたら 1 回取り直す」は **`composables/useFocusPolling.ts`**。`{ every, tick }` の配列を渡すだけで、`git` / `docker` / `worktree` / `usageStore` が共有する
  - **タイマーも composable が持つ**。フォーカス側だけ畳むと「張る前に必ず消す」が呼び出し側に 4 つ残り、5 つ目を書く人が落とせる
  - 復帰時に撃つのは**先頭の interval だけ**。どのストアもそれが主ポーリングで、後ろに続くのは自前の間隔ガードを持つ重い処理（git の `fetchInBackground`）
  - **ストアの setup 直下で呼ぶこと**。監視をそこで 1 回だけ張るので持ち主が Pinia のストアの scope になる。`start()` の中で張ると、`onMounted` から呼ばれたときにコンポーネントの scope に入ってマウント解除で黙って止まる
- 例外は「webview に DOM フォーカスがあるか」そのものを問うている箇所だけ（`TerminalTab` の IME 周り。blur の完了前に退避する必要があり、focus 側は WebView2 のフォーカス受け渡しに紐付いている）。**「ユーザーがこのウィンドウを見ているか」を聞きたいところは `windowFocused`**（`document.hasFocus()` のままだと、タイトルバーをクリックして前に出したときに「見ていない」と誤判定する）

## 作業領域の分割（#308）

左右 2 ペインに分けられる。**既定は分割なし**で、`Mod+\`・タブバーの分割ボタン・タブの
右クリック「反対のペインへ移動」・ペインをまたぐドラッグが入口。

- **「アクティブ」は 3 つに割れる。** どのタブがどこにあるか（`tab.pane`）、打鍵の行き先の
  ペイン（`focusedPane`）、そのペインで選んでいるタブ（`activeByPane`）。`activeTabId` は
  この最後のもので、**代入するとそのタブのあるペインへフォーカスが移る**（タブを開く 12 経路が
  そのまま正しく動くのはこのため）
- **タブのコンポーネントが聞く述語は 2 つ**。`isTabVisible`（描かれているか。xterm の fit・
  PTY のリサイズ・再描画・CodeMirror の `requestMeasure`）と `isTabFocused`（打鍵の行き先か。
  初期フォーカス・IME の退避・StatusBar のカーソル情報・アウトラインの登録）。**`activeTabId`
  との比較に戻さないこと**: 分割すると見えているタブが 2 枚になるので、隠れていないほうが
  0×0 のまま測られる
- **`tab.pane` を直に読まない**（`tabStore.paneOf`）。分割していないあいだは右に置いたままの
  タブも左に出る、という解釈が 1 箇所に閉じている。**分割を解除しても書き換えない**
  （`tabs` にはパーク中の他プロジェクトのタブも入っているので、片方のプロジェクトでの
  解除がもう片方の置き場を消す）
- **開いたタブはフォーカスのあるペインに入る**（`pushTab` の既定）。タブバーから開いたものが
  押した側に入るのは、`TabPane` の `.pane` に付けた `mousedown.capture` が click より先に
  `focusPane` を済ませているため。**マウスを伴わない経路だけが自分で言う**（OS からの
  ファイルドロップ、セッションの復元は `add*Tab` の `pane` オプション）
- **中身は「タブ 1 枚 = `Teleport` 1 つ」で行き先だけを変える。** `to` の差し替えは
  `moveTeleport` が DOM ノードを移すだけで、コンポーネントは作り直されない。ペインごとに
  `v-for` を分けると、移った瞬間に `onUnmounted` が走って xterm がセッションごと消える。
  **行き先はセレクタ文字列**（`#pane-left` / `#pane-right`）で、要素の ref だと分割を開いた
  最初の描画で `v-if` が false になり同じことが起きる
- ナビゲーション（`Ctrl+1`〜`9`・タブ移動）と一括クローズは**そのペインの中だけ**を見る
  （`focusedTabs` / `tabsIn(pane)`）。母集合を `visibleTabs` に戻すと、1 本のタブバーから出た
  操作が反対のペインのタブを閉じる
- ドラッグの状態は `composables/useTabDrag.ts` のシングルトン。バーごとに
  `useDragAndDrop` を呼ぶと、掴んだ側と落とす側で `dragId` が別になり**ペインをまたぐ
  ドラッグだけが無言で効かない**
- 分割比は localStorage（`pike:split-ratio:{projectId}`）。マシンに依存する見た目なので
  `project.json` には入れない。ペインの割り当てと選択は `lastSession.panes`（#308）で、
  **分割していたときだけ書く**（古い版の Pike は `activeTabId` しか読まない）
- **ターミナルの複製は非対応**。xterm の `Terminal` は 1 つの DOM にしか描けず、2 つ目を
  作れば別の PTY になる（Rust 側にバッファを持って再アタッチする案は #264 で不採用）

## タブ管理
- タブの状態は `src/stores/tabs.ts` で一元管理
- **`Tab` 型の正本は `src/types/tab.ts`**（判別キーは `kind`）。現在の種別は `terminal` / `editor` / `preview` / `pdf` / `diff` / `history` / `docker-logs` / `settings` / `agent-status` / `manual` / `issue`。種別を増やすときは Union に足し、`TabPane.vue` の描画分岐と `snapshotSession`（永続化対象の絞り込み）の両方を更新する
- **タブ名を画面に出すときは `lib/tabTitle.ts` の `tabDisplayTitle(tab)` を通す**。シングルトンタブ（`settings` / `agent-status` / `manual`）は自分固有の名前を持たないので、`tab.title` に焼き込んだ英語リテラルではなく `SINGLETON_TITLE_KEYS` 経由で i18n を引く。`tab.title` を直接描くと、開いたときの言語のまま固定されて言語切替に追従しない（`types/tab.ts` は値 import を持たない方針なので、`t()` を呼ぶこの関数は `lib/` に置く）
- ファイルを開く操作は `lib/openFile.ts` の `openPathInTab` を通す（拡張子で editor / preview / pdf を振り分ける唯一の入口。`addEditorTab` を直接呼ぶと画像や PDF が化ける）
- pinned タブは ✕ ボタン非表示、Ctrl+W のハンドラで早期リターン
- **固定タブは左端に据え置き、スクロールしない（#305）**。ブラウザの固定タブと同じで、タブが増えても居場所が変わらない
  - **並べ替えはストアの 1 箇所**（ピン留めを先頭へ寄せる）。**タブバーだけ並べ替えないこと**: `Ctrl+1`〜`9`・タブ移動・溢れたタブの一覧・セッションの書き出しが別の順を見ることになり、「左から n 番目」が画面と食い違う。`tabs` の順（作った順）は動かさない
    - **2 つに分けた側（`pinnedTabs` / `unpinnedTabs`）を先に作り、繋いで `visibleTabs` にする。** タブバーは同じ境目で 2 列に描くので、あちらで濾し直すと同じ述語が 2 箇所に出るうえ、「先頭がピン留め」という不変条件がコメントでしか支えられなくなる
  - **タブ 1 枚のマークアップと CSS は `TabItem.vue`**（`v-for` が 2 つになったので、写すとバッジやアイコンを片方だけ直す事故が起きる）。**見た目を親に置かないこと**: scoped CSS は**子のルート要素までしか届かない**ので、`.tab` は当たるが中のアイコン・タイトル・✕ は素の見た目に戻る（切り出した直後に実際にそうなった）。一覧メニューと共有するファイルアイコンの箱だけ `theme.css` の `.tab-icon-svg`
    - 束縛は `tabBind(tab)` の 1 つを `v-bind` する。2 列に同じ props とハンドラを書き写すと、足したときに片方だけ直す事故が `TabItem` の外側で再発する
  - **グループをまたぐ並べ替えは受けない。** 述語は `types/tab.ts` の `canReorderTabs` で、**ドロップの印を出す側と実際に動かす `tabStore.reorderTab` が同じものを読む**。index で受けていたころのストアは、またぐ組でも受け取って `tabs` を黙って並べ替えていた（表示は寄せたあとの順なので画面上は何も起きない）
  - アクティブなタブへの追従（`revealActiveTab`）は `.tabs-scroll` の中だけを探す。固定タブはそこに居ないので、選んでもスクロールしない。**ピン留めの解除も契機にする**（`activeTabId` は変わらないのに、そのタブがスクロール列の外へ移る）
  - **溢れ判定は 2 列とも測る。** 固定タブの列はスクロールせず `overflow: hidden` で隠れるだけなので、一覧の `▾` が唯一の行き先になる。`ResizeObserver` の張り直しはピン留めの数も契機にする（付け外しは枚数を変えないが、タブは 2 列のあいだで別要素として作り直される）
- **タブバーは横スクロールする（#281）**。CSS の判断（`overflow-x` を `auto` ではなく `scroll` にする理由、`min-width: 0`）は `TabPane.vue` の該当箇所のコメントが正本。ここに写しを置くと必ず片方が古くなるので、方針だけ残す
  - 溢れているかは **`ResizeObserver` で測る**。監視の対象はコンテナだけでなく**タブ 1 つ 1 つ**（枚数も寸法も変わらず中身の幅だけ増える経路がある。編集して `*` が付く、ターミナルのタイトルが伸びる）。スクロールでは変わらないので `scroll` は契機に要らない
  - アクティブなタブへの追従は `scrollIntoView({ inline: 'nearest', block: 'nearest' })`。`nearest` は「必要な分だけ動かす」意味で、既に見えている祖先は動かさない（ファイルツリー・アウトライン・QuickOpen が同じ書き方）。**`offsetLeft` の算術に置き換えないこと**: `offsetParent` が何になるかという暗黙の前提（タブバーの `position` や、その左に並ぶプロジェクトのチップ列）に依存し、型でもテストでも守られない
  - ホイールは**縦成分だけ**を横スクロールに変換する（`deltaX !== 0` の入力には触らない。タッチパッドの横スワイプはブラウザの既定で動く）
  - 溢れているときは `+` の左に一覧のボタンを出す。**隠れているタブだけに絞らず全部出す**（絞ると押すたびに中身が変わり、同じタブが列のどこにあるか覚えられない）。端をぼかすフェードも試したが、スクロールできることが読み取れないという理由で外した
  - **タブ種別のアイコンは `lib/tabIcons.ts` の `TAB_KIND_ICONS`**（`lib/shellIcons.ts` と同じ形）。タブバーと一覧メニューが共有する。`Record<Tab['kind'], …>` なので種別を足したら型エラーで気付く（`v-else-if` の連鎖だと網羅性が検査されず、片方の一覧にだけ足す事故が起きる）

## xterm.js
- `Terminal` インスタンスはタブごとに生成し、コンポーネントの `onUnmounted` で `.dispose()`
- `FitAddon` で初期サイズを確定してから `pty_spawn` を invoke する
- ResizeObserver でコンテナサイズ変化を検知 → `FitAddon.fit()` → `pty_resize` invoke
- フォントは等幅フォントを明示: `fontFamily: "'Cascadia Code', 'Fira Code', monospace"`

## スタイル
- CSS フレームワークは使わない（Tauri アプリなので外部 CDN 不要、軽量が正義）
- CSS Variables でテーマ変数を管理 (`--bg-primary`, `--text-primary` 等)
- レイアウトは CSS Grid / Flexbox のみ
- **scoped CSS は子コンポーネントのルート要素までしか届かない。** 親にしかないクラスを子で使うと、ルート要素だけ効いて**中の要素が素の見た目に戻る**。切り出した直後に 3 回踏んでいる（`TabItem.vue` の #305、`ProfileRow.vue` の #275、`AllowedHostList.vue` の `.setting-label` / `.setting-hint`）
  - **共有クラスへ上げるか、子に書き写すかは「同じ名前の別物があるか」で決める。** 無ければ `theme.css` へ上げる（`.row-icon` は 4 コピーから畳んだ。`.setting-label` / `.setting-hint` も同じ理由でそこにある）。あれば子で持つ（`.icon-btn` は `panels/IconSelect.vue` が幅 100%・枠あり・テキスト付きの別物を定義しているので上げられない）
- **共有している形に、消費者の一方の名前を付けない。** 設定画面の一覧の器は `agent-cmd-*` という名前で 5 つの一覧に使われていて、そのうちエージェントのコマンドは 1 つだけだった。#275 でシェル一覧を `ProfileRow.vue` へ出したとき、同じ形を別名（`shell-row` / `shell-name`）で使っていた非表示プロジェクトの一覧だけが定義を失い、ボタンが折り返す形で残った（今は `setting-list` / `setting-list-row` / `setting-list-name`）

## アイコン
- UI アイコンは `lucide-vue-next` で統一（サイドバー・タブ・パネルボタン等）
- ファイルアイコンは `material-file-icons` の SVG（`getIcon(name).svg`）
- `src/lib/fileIcons.ts` でファイル名 → SVG のキャッシュ付きラッパーを提供
- SVG は `v-html` で注入する
- **行の先頭に置く 16px のアイコン枠は `theme.css` の `.row-icon`**（タブ・Git パネル・ファイルツリー・アウトラインが共有）。同じ枠を各コンポーネントの scoped CSS に持っていたころは 4 コピーあり、寸法を変えるのに 4 ファイルを直す必要があった。色や不透明度（フォルダの accent、gitignore の淡色）は消費者側に残す
  - **`v-html` した SVG の寸法合わせは `.row-icon-svg` を併記する**（`svg { 16px }`）。`v-html` の中身は scope 属性を持たないので scoped CSS では当てられず、共有クラスにしてある（置いた側で書くなら `:deep()` が要る）
  - **lucide のアイコンには `.row-icon-svg` を付けない。** あちらの寸法は `:size` で決まるので、付けると 14px で置いている消費者（アウトライン）が太る

## カスタム確認ダイアログ
- `window.confirm()` は WebView のオリジン URL がタイトルに表示されるため使わない
- `src/composables/useConfirmDialog.ts` が `confirmDialog(msg): Promise<boolean>` を提供
- **チェックボックスを 1 つ添えたいときは `confirmWithOption(msg, label): Promise<{ ok, checked }>`**（#286 の「今後は確認しない」）。文言が空ならチェックボックスは出ないので、`confirmDialog` はこれに委譲した薄い包みで、起動の手順は 1 箇所にある。**`confirmDialog` の戻り値は真偽値のまま変えないこと**（呼び出しが 20 箇所以上あり、どれもチェックの状態を要らない）
- ダイアログの状態はモジュール単位のシングルトン。**モードごとにしか使わないフィールド（`inputValue` / `optionLabel`）の後始末は `dismiss()` に置く**。ここが「次のダイアログを開く直前に前の状態を捨てる」唯一の場所で、開く側の関数それぞれに書くと、消し忘れたフィールドが無関係なダイアログに出る（実際にチェックボックスが後続の `promptDialog` に居座った）
- `src/components/ConfirmDialog.vue` を `App.vue` に配置（Teleport で body 直下に描画）
- Enter で OK、Escape / オーバーレイクリックでキャンセル

## 国際化（i18n）
- `src/i18n/`: `index.ts` が `useI18n()` / 標準関数 `t` / `locale` ref（デフォルト `en`）を提供、`en.ts` / `ja.ts` がメッセージ辞書
- `messages` は `locale` に対する `computed` でリアクティブ（locale 切替で即時反映）。ストア等コンポーネント外では `t` を直接 import
- `{name}` プレースホルダを `replaceAll` で展開。言語切替は Settings タブ

## タブバーへの OS ファイルドロップ
- エクスプローラーからタブバーへの D&D。ファイル → `useCliOpen` の `openFileTarget`（export 済み。画像→Preview / pdf→Pdf / 他→Editor の拡張子ルーティング）、ディレクトリ → `addTerminalTab({ cwd, shell })`。**Windows プロジェクトとグローバルモードのみ有効**（WSL プロジェクトはエディタ I/O・ターミナル cwd の Windows→WSL パス変換が要るため無効）。ディレクトリの shell はプロジェクト default / グローバルは `globalShell`（WSL なら `defaultWindowsShellKind()` にフォールバック。Windows パスの cwd が WSL シェルでは捨てられるため）
- **実パス解決**（`dragDropEnabled: false` のため DOM の File にパスが無い）: `lib/dropPaths.ts` が WebView2 の `postMessageWithAdditionalObjects`（`pike:drop-paths:{id}` + File 群）で host に渡し、Rust `drop_paths.rs` の `WebMessageReceived` ハンドラが `ICoreWebView2File::Path` + `is_dir` を解決して `drop_paths` イベント（`{id, entries}`、window-scoped）で返す。ハンドラの attach は `build_window` と setup の main ウィンドウの 2 箇所（`with_webview`）。wry の IPC も同じ WebMessageReceived を使うが COM イベントは多重購読できるため共存
- **依存の注意**: `webview2-com` 0.38 の COM 型は windows-core **0.61** 系で、本体の `windows` 0.62 とは別インスタンス。`drop_paths.rs` では `windows_core`（0.61、直接依存に追加済み）の `Interface`/`PWSTR` を使うこと
- App.vue に未処理ドロップの window レベル preventDefault ガードあり（未処理の OS ファイルドロップは WebView がファイルへナビゲートし、アプリごと置き換わる＝全 PTY 破棄のため）

## 設定画面
- サイドバー下部の歯車アイコンからシングルトンタブとして開く
- 設定は `localStorage` (`pike:settings`) に永続化
- ダーク/ライト/システム追従（#310）: `data-theme` 属性で CSS Variables を切り替え
  - **保存する値と解決した値を分ける。** 永続化・同期・ブロードキャストの対象は `themeMode`（`dark` / `light` / `system`）だけで、`darkMode` は**解決結果の computed**。読み手（`data-theme` の適用・カラースキームとエディタテーマの Auto・`window_set_backdrop` の再適用・`ManualTab` の初期値）はどれも解決結果を見たいので、名前はそのまま。**解決結果は配らない**（OS の設定が違うマシンで食い違う）ので、追従のときは各ウィンドウが自分で OS に聞く
  - **外から来た設定は `sanitize` が唯一の入口**（既定とのマージもスキーマ移行もあの中）。理由と、追従のあいだ `setTheme(null)` を渡す理由は、それぞれ `stores/settings.ts` と `lib/window.ts` の doc コメントが正本
  - **OS のテーマを別経路で聞く形は採れない。** Tauri の JS API に独立した情報源が無く、`matchMedia` も `window.theme()` も**自分が呼んだ `setTheme` に汚染される**（だから `lib/window.ts` は pin 中の `onThemeChanged` を捨て、初期値にだけ `matchMedia` を使う）。「フォーカスはネイティブの信号を見る」という上の規範に対する例外に見えるが、そちらと違ってこちらは web 層の API を**初期値としてのみ**使っている
    - 本当に独立させるなら Rust 側（Windows の `AppsUseLightTheme` ＋ `WM_SETTINGCHANGE`、macOS の `effectiveAppearance`）をコマンドとイベントにすることになる。**pin 中に古くなるだけで、解除時に読み直せば閉じる**ので、OS ごとのコードを足す価値が無いと判断した
  - **書き出しの `darkMode` は後方互換**（同期ファイルは古い版の Pike も読む）。落としてよいのは、**同期ファイルを共有する全マシンが `themeMode` を知る版になったとき**。cross-version の経路は同期ファイル 1 本だけ（localStorage は同一インストール、broadcast は同一プロセス）なので、そこだけ見れば判断できる。目安は v0.48.0 以降しか相手にしなくてよくなった時点で、消すのは `withThemeMode` と `snapshot()` の 1 行
- ターミナルフォント: `font-kit` クレートでシステムのモノスペースフォントを列挙（`spawn_blocking` で非同期実行）
- フォントスキャンは Settings タブを開いた時に遅延ロード（起動時には実行しない）
- カラースキーム: 6種（Default Dark, Solarized Dark/Light, Monokai, Dracula, Nord）
- フォント・サイズ変更は既存ターミナルにライブ反映、カラースキーム変更は `terminal.refresh()` + PTY resize nudge で TUI 再描画
- 設定タブにターミナルプレビュー表示（選択中のフォント・サイズ・カラースキームを即時反映）
- Editor セクション: ミニマップ ON/OFF、ワードラップ ON/OFF、タブサイズ（2/4/8）。CM6 Compartment でライブ反映
- settings タブはセッション永続化の対象外（`snapshotSession` は terminal/editor のみフィルタ）

## 禁止事項
- Monaco Editor（重い）
- 不要な npm パッケージの追加（都度相談）
- `any` 型（型定義を作ること）
