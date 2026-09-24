---
paths:
  - "src/stores/tabs.ts"
  - "src/types/tab.ts"
  - "src/components/layout/Tab*.vue"
  - "src/composables/useTabDrag.ts"
  - "src/composables/useDragAndDrop.ts"
  - "src/composables/useCliOpen.ts"
  - "src/lib/tabTitle.ts"
  - "src/lib/tabIcons.ts"
  - "src/lib/openFile.ts"
  - "src/lib/dropPaths.ts"
  - "src-tauri/src/drop_paths.rs"
---

# タブ・作業領域の実装ルール

## タブ管理
- タブの状態は `src/stores/tabs.ts` で一元管理
- **`Tab` 型の正本は `src/types/tab.ts`**（判別キーは `kind`）。現在の種別は `terminal` / `editor` / `preview` / `pdf` / `diff` / `history` / `docker-logs` / `settings` / `agent-status` / `manual` / `issue` / `commit` / `browser`。種別を増やすときは Union に足し、`TabPane.vue` の描画分岐と `snapshotSession`（永続化対象の絞り込み）の両方を更新する
- **タブ名を画面に出すときは `lib/tabTitle.ts` の `tabDisplayTitle(tab)` を通す**。シングルトンタブ（`settings` / `agent-status` / `manual`）は自分固有の名前を持たないので、`tab.title` に焼き込んだ英語リテラルではなく `SINGLETON_TITLE_KEYS` 経由で i18n を引く。`tab.title` を直接描くと、開いたときの言語のまま固定されて言語切替に追従しない（`types/tab.ts` は値 import を持たない方針なので、`t()` を呼ぶこの関数は `lib/` に置く）
- ファイルを開く操作は `lib/openFile.ts` の `openPathInTab` を通す（拡張子で editor / preview / pdf を振り分ける唯一の入口。`addEditorTab` を直接呼ぶと画像や PDF が化ける）
- **セッションの欄を足したら、Rust の `project::SessionTabDef` / `LastSession` を通っても残るか確かめる。** 両方に `#[serde(flatten)]` の受け皿（`extra`）を置いてあるので今は残る。受け皿が無いと、新しい欄が保存の時点で黙って消える
- pinned タブは ✕ ボタン非表示、Ctrl+W のハンドラで早期リターン
- **固定タブは左端に据え置き、スクロールしない（#305）**。ブラウザの固定タブと同じで、タブが増えても居場所が変わらない
  - **並べ替えはストアの 1 箇所**（ピン留めを先頭へ寄せる）。**タブバーだけ並べ替えないこと**: `Ctrl+1`〜`9`・タブ移動・溢れたタブの一覧・セッションの書き出しが別の順を見ることになり、「左から n 番目」が画面と食い違う。`tabs` の順（作った順）は動かさない
    - **2 つに分けた側（`pinnedTabs` / `unpinnedTabs`）を先に作り、繋いで `visibleTabs` にする。** タブバーは同じ境目で 2 列に描くので、あちらで濾し直すと同じ述語が 2 箇所に出るうえ、「先頭がピン留め」という不変条件がコメントでしか支えられなくなる
  - **タブ 1 枚のマークアップと CSS は `TabItem.vue`**（`v-for` が 2 つになったので、写すとバッジやアイコンを片方だけ直す事故が起きる）。**見た目を親に置かないこと**（scoped CSS が子のルート要素までしか届かない。`frontend.md` のスタイルの節）。一覧メニューと共有するファイルアイコンの箱だけ `theme.css` の `.tab-icon-svg`
    - 束縛は `tabBind(tab)` の 1 つを `v-bind` する。2 列に同じ props とハンドラを書き写すと、足したときに片方だけ直す事故が `TabItem` の外側で再発する
  - **グループをまたぐ並べ替えは受けない。** 述語は `types/tab.ts` の `canReorderTabs` で、**ドロップの印を出す側と実際に動かす `tabStore.reorderTab` が同じものを読む**（ストアだけが受けると、表示は寄せたあとの順なので `tabs` が黙って並べ替わる）
  - アクティブなタブへの追従（`revealActiveTab`）は `.tabs-scroll` の中だけを探す。固定タブはそこに居ないので、選んでもスクロールしない。**ピン留めの解除も契機にする**（`activeTabId` は変わらないのに、そのタブがスクロール列の外へ移る）
  - **溢れ判定は 2 列とも測る。** 固定タブの列はスクロールせず `overflow: hidden` で隠れるだけなので、一覧の `▾` が唯一の行き先になる。`ResizeObserver` の張り直しはピン留めの数も契機にする（付け外しは枚数を変えないが、タブは 2 列のあいだで別要素として作り直される）
- **タブバーは横スクロールする（#281）**。CSS の判断（`overflow-x` を `auto` ではなく `scroll` にする理由、`min-width: 0`）は `TabPane.vue` の該当箇所のコメントが正本。ここに写しを置くと必ず片方が古くなるので、方針だけ残す
  - 溢れているかは **`ResizeObserver` で測る**。監視の対象はコンテナだけでなく**タブ 1 つ 1 つ**（枚数も寸法も変わらず中身の幅だけ増える経路がある。編集して `*` が付く、ターミナルのタイトルが伸びる）。スクロールでは変わらないので `scroll` は契機に要らない
  - アクティブなタブへの追従は `scrollIntoView({ inline: 'nearest', block: 'nearest' })`。`nearest` は「必要な分だけ動かす」意味で、既に見えている祖先は動かさない（ファイルツリー・アウトライン・QuickOpen が同じ書き方）。**`offsetLeft` の算術に置き換えないこと**: `offsetParent` が何になるかという暗黙の前提（タブバーの `position` や、その左に並ぶプロジェクトのチップ列）に依存し、型でもテストでも守られない
  - ホイールは**縦成分だけ**を横スクロールに変換する（`deltaX !== 0` の入力には触らない。タッチパッドの横スワイプはブラウザの既定で動く）
  - 溢れているときは `+` の左に一覧のボタンを出す。**隠れているタブだけに絞らず全部出す**（絞ると押すたびに中身が変わり、同じタブが列のどこにあるか覚えられない）。端のフェードは使わない（スクロールできることが読み取れない）
  - **タブ種別のアイコンは `lib/tabIcons.ts` の `TAB_KIND_ICONS`**（`lib/shellIcons.ts` と同じ形）。タブバーと一覧メニューが共有する。`Record<Tab['kind'], …>` なので種別を足したら型エラーで気付く（`v-else-if` の連鎖だと網羅性が検査されず、片方の一覧にだけ足す事故が起きる）

## タブバーの「+」（#375 / #396）

- **設定は `tabAddOpens` の 1 本**（`menu` / `terminal` / `editor` / `browser` / `agent`）。
  既定の `menu` では「+」がメニューを開き、**▾ は出さない**: メニューが「+」から出るなら、
  ▾ は同じものを開く 2 つ目のボタンでしかない。種別を選ぶとそれを直接開き、▾ が戻る
- **設定の既定を変えるときは鍵ごと変える**（`tabAddAction` に値を足さず `tabAddOpens` にしたのはこのため）。
  `snapshot()` は全フィールドを書くので、同じ鍵のまま既定を差し替えても保存済みの値に届かない。
  新しい鍵なら `undefined` が既定に落ちるので移行が要らない
  - **真偽値を 1 つ足す形（`tabAddDirect` ＋ `tabAddAction`）は採らない。** 「直接開かないのに
    開く種別を持っている」という**観測できない状態**ができ、永続化の触り所と設定画面の行が 2 つずつになる
- どちらを呼ぶかの判定は `TabBar.vue` の `onTabAdd` 1 か所（メニューの開閉は TabBar の
  ローカルな状態なので、`useAppActions` へ持ち込まない）
- **メニューを開くボタンには `@mousedown.stop` が要る**（`.tab-add` / 2 つの `.tab-add-arrow`）。
  開くときに `window` の `mousedown` へ「外を押したら閉じる」を 1 回だけ張るので、止めないと
  押し直したときに mousedown で閉じ → click で開き直し、となって**永久に閉じない**

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
- **分割を開くときは、見ているタブだけを右へ送る**（`toggleSplit`）。今のプロジェクトの
  タブ（`visibleTabs`）に残っている「右」を先に左へ戻す。右に置いたままのタブを拾い直すと、
  見ているタブではなくそちらが右に出る（置き場は画面から見えないので、利用者には理由が分からない）
- **右のタブが無くなったら分割を畳む（#361）が、見るのは「空でない → 空」の遷移**
  （`collapseIfRightEmptied`。閉じる・左へ移す経路が、消す直前の `rightHasTabs()` を渡す）。
  「右が空なら畳む」という状態の watcher にしないこと: 送るタブが無いときの分割ボタンと、
  右のタブを持たないプロジェクトへの切り替えも空の右ペインを作り、どちらも畳んではいけない
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

## タブバーへの OS ファイルドロップ
- エクスプローラーからタブバーへの D&D。ファイル → `useCliOpen` の `openFileTarget`（export 済み。画像→Preview / pdf→Pdf / 他→Editor の拡張子ルーティング）、ディレクトリ → `addTerminalTab({ cwd, shell })`。**Windows プロジェクトとグローバルモードのみ有効**（WSL プロジェクトはエディタ I/O・ターミナル cwd の Windows→WSL パス変換が要るため無効）。ディレクトリの shell はプロジェクト default / グローバルは `globalShell`（WSL なら `defaultWindowsShellKind()` にフォールバック。Windows パスの cwd が WSL シェルでは捨てられるため）
- **実パス解決**（`dragDropEnabled: false` のため DOM の File にパスが無い）: `lib/dropPaths.ts` が WebView2 の `postMessageWithAdditionalObjects`（`pike:drop-paths:{id}` + File 群）で host に渡し、Rust `drop_paths.rs` の `WebMessageReceived` ハンドラが `ICoreWebView2File::Path` + `is_dir` を解決して `drop_paths` イベント（`{id, entries}`、window-scoped）で返す。ハンドラの attach は `build_window` と setup の main ウィンドウの 2 箇所（`with_webview`）。wry の IPC も同じ WebMessageReceived を使うが COM イベントは多重購読できるため共存
- **依存の注意**: `webview2-com` 0.38 の COM 型は windows-core **0.61** 系で、本体の `windows` 0.62 とは別インスタンス。`drop_paths.rs` では `windows_core`（0.61、直接依存に追加済み）の `Interface`/`PWSTR` を使うこと
- App.vue に未処理ドロップの window レベル preventDefault ガードあり（未処理の OS ファイルドロップは WebView がファイルへナビゲートし、アプリごと置き換わる＝全 PTY 破棄のため）
