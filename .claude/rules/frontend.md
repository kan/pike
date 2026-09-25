---
paths:
  - "src/**/*.{vue,ts}"
  - "src/assets/theme.css"
  - "index.html"
---

# フロント実装ルール

どの画面にも当てはまる規則だけをここに置く。タブと作業領域は `tabs.md`、設定画面は
`settings-ui.md`、各機能は領域別のファイル（索引は CLAUDE.md）。

## 基本方針
- Vue 3 Composition API + `<script setup>` で統一
- 状態管理は Pinia、ストアは `src/stores/` に置く
- Tauri invoke は `src/lib/tauri.ts` に型付きラッパーを作って使う（直接 invoke しない）。**あそこに置くのはラッパーだけ**で、ダイアログ・i18n・ストアを読む流れは別ファイルに出す
- **`lib/` はストアを import してよい**（`openFile.ts` / `openUrl.ts` は「〜を開く唯一の入口」としてストアを読む）。**例外は、ストアから import される `lib/`**（`shortcuts.ts` / `projectPaths.ts` / `paths.ts`）で、そこからストアを読むと循環する。値が要るなら設定側から流し込む（`setShortcutPreset`）。不変条件は「純粋かどうか」ではなく**向き**
- コンポーネントは `src/components/{category}/XxxYyy.vue` の命名

## 外部ブラウザで URL を開く（#311）

- **入口は `lib/openUrl.ts`**。外へ出て行く URL は全部このファイルを通る（確認つきの `openUrlWithConfirm` と、Docker のトンネル用の `openLocalTunnel`）。**素の `openUrl` を呼ぶ経路を増やさないこと**: `check-docs` はシンボルの実在しか見ないので、この不変条件が破れても検出されない
- **開けるのは http(s) と `mailto:` だけ**（同ファイルの `isExternalLink` が述語。プレビューはこれでリンクを振り分ける）。`mailto:` は毎回確認する（承認の鍵はホスト名で、あれは持たないため）
  - **開けないスキームはリンクにしない。** DOMPurify の既定は `ftp` / `tel` / `sms` / `cid` / `xmpp` も通すので、絞らないと「押せるのに何も起きないリンク」ができる。許可の正本は `lib/sanitizeHtml.ts` の `ALLOWED_URI_REGEXP` で、**4 つのプレビュー（Markdown / rst / issue / マニュアル）が全部これを渡す**。`isExternalLink` と対で、片方だけ広げると同じ状態が戻る
- 確認ダイアログのチェックボックスでホストを承認すると、以後そのホストは確認なしで開く（`settings.allowedUrlHosts`。マシン非依存なので同期の対象）。**承認の対象はこの関数を通る全経路**で、ターミナルと Docker ログの `WebLinksAddon` が拾った URL も含む
- **`lib/tauri.ts` に置けない理由・ホスト名を完全一致にした理由・トンネルを別関数にした理由は、あのファイルの doc コメントが正本。** 画像ホストの一覧（#239）と分けてある理由は `stores/settings.ts` の宣言の隣
- **「どこから来たリンクか」で経路を分けない**（#311 で見送った）。分けないと、`github.com` を承認すれば issue の本文や Markdown の `[説明](別の宛先)` も確認なしで開き、表示文字列と宛先が食い違いうる経路で唯一の開示の場（ダイアログ）が消える。それでも分けないのは、開く先がブラウザ自身の保護層を持つこと、承認が設定画面から取り消せる明示的なオプトインであること、経路ごとに挙動が変わると説明できなくなることによる。**分けるなら Markdown プレビューと issue タブの 2 か所**（ターミナルは生の URL が画面に出ており、ボタン類は Pike 自身が URL を組み立てるので危険側に入らない）
- 承認済みホストの一覧の UI は `components/panels/AllowedHostList.vue`（画像とリンクで共有）。**2 つのリスト自体は畳まない**: 承認したことの意味が違うので、`ref` を 1 本にすると型からもコメントからもその違いが消える。畳んでよいのは政策を持たない部分（正規化の `withHost` / 一覧の markup / 空表示の文言）だけ

## 手前に浮くものの数（#396）

**ブラウザのタブ（#368）の子 webview は Pike の DOM より手前に描かれる**ので、メニューや
ドロップダウンが開いているあいだは隠さないとその下に埋もれる。開閉の出典は
`lib/overlay.ts` の 1 か所。

- **新しいポップアップを足したら `useOverlay` に登録する**（`.popup-surface` を付けるのと
  対の作法。あちらは `window.md` の背景透過の節）。登録は開閉の ref を返す関数を渡す
  1 行で、閉じ忘れは `onScopeDispose` が拾う
- **入れ子のサブメニューは登録しない。** 親を開いた時点で数えられているので、二重に数えても
  動きはするが、対応が取れているかを読み手が確かめられなくなる
- **`.popup-surface` を DOM から探す形は採らない。** 規約としては全部のポップアップに
  付いているので一見まとめて拾えるが、見張るには `document.body` の subtree に
  MutationObserver を張ることになる。ターミナルは xterm の DOM レンダラーなので、出力の
  たびに大量の childList の変化とそのレコードが出る
- **モーダルの 4 つ（確認ダイアログ・QuickOpen・プロジェクトスイッチャー・ショートカット
  一覧）もここへ登録する。** どれも専用の ref を持つので `BrowserTab.vue` から名前で見る
  こともできるが、それだと 5 つ目のモーダルを足す人が「向こうに書くのか、登録するのか」を
  選ぶことになる
- **例外は Git パネル**（#396）。あそこはコミットの行をなぞるだけでツールチップがパネルの
  横＝タブの領域に出るので、登録すると行をなぞるたびにページが出入りして点滅する。
  `BrowserTab.vue` の `shown` が**パネルが開いているあいだずっと隠す**ことで覆っているので、
  `GitPanel.vue` は右クリックメニューも含めて 1 つも登録しない。**他のパネルは対象外**:
  ツールチップを出すのはここだけで、押したときにしか出ないメニューはレジストリで足りる
- **隠しているあいだは、その場に理由を出す**（`BrowserTab.vue` の `hiddenNotice`）。
  ページが消えるのは Pike の都合なので、書いておかないと読み込みに失敗したように見える。
  **文言は理由で分ける**: Git パネルは開けっぱなしにできるので、閉じれば戻ることを言わないと
  戻し方が分からない
- スクリーンショットを貼って隠す案（WebView2 の `CapturePreview`）は未実装。撮影が非同期なので
  開いた瞬間の空白は残るため、まず隠す側で塞いである

## ウィンドウのフォーカス
- 「このウィンドウがアクティブか」の出典は **`lib/window.ts` の `windowFocused`** ただ 1 つ。元は Rust の `WindowEvent::Focused`（`onFocusChanged`）で、アクリルの付け外し（#277）と同じ信号
- **`document.hasFocus()` で代用しないこと**。タイトルバーだけをクリックしてウィンドウがアクティブになったときは webview にフォーカスが入らないので、そのあいだ止まったままになる
- 「アクティブなあいだだけポーリングし、戻ってきたら 1 回取り直す」は **`composables/useFocusPolling.ts`**。`{ every, tick }` の配列を渡すだけで、`git` / `docker` / `worktree` / `usageStore` が共有する
  - **タイマーも composable が持つ**。フォーカス側だけ畳むと「張る前に必ず消す」が呼び出し側に 4 つ残り、5 つ目を書く人が落とせる
  - 復帰時に撃つのは**先頭の interval だけ**。どのストアもそれが主ポーリングで、後ろに続くのは自前の間隔ガードを持つ重い処理（git の `fetchInBackground`）
  - **ストアの setup 直下で呼ぶこと**。監視をそこで 1 回だけ張るので持ち主が Pinia のストアの scope になる。`start()` の中で張ると、`onMounted` から呼ばれたときにコンポーネントの scope に入ってマウント解除で黙って止まる
- 例外は「webview に DOM フォーカスがあるか」そのものを問うている箇所だけ（`TerminalTab` の IME 周り。blur の完了前に退避する必要があり、focus 側は WebView2 のフォーカス受け渡しに紐付いている）。**「ユーザーがこのウィンドウを見ているか」を聞きたいところは `windowFocused`**（`document.hasFocus()` のままだと、タイトルバーをクリックして前に出したときに「見ていない」と誤判定する）

## サイドバーのアイコン列（#364）

- **並びと非表示は設定の `sidebarIcons`**（1 本の配列。同期の対象）。`sanitizeSidebarIcons` が「全パネルがちょうど 1 回ずつ」を保証し、知らないパネルは落とし、無いパネルは末尾に表示で足す（版を上げてパネルが増えたとき、黙って見えないままにしない）
- **非表示はアイコン列から外すだけ**で、パネルは使える（パレット・`Ctrl+Shift+F`）。「使えるか」は `usePanelAvailability` のままで、**非表示をそこへ混ぜないこと**: あちらは開いているパネルを逃がす判断にも使われるので、隠しただけで検索のキーが効かなくなる
- 隠したものを戻す入口は右クリックのメニューだけなので、**アイコンの無い空いたところでも開く**（全部隠しても戻せる）
- 並べ替えの計算は `lib/reorder.ts`（プロジェクト一覧と共有）
- **パネルの中身は `overflow-y: scroll`（`auto` ではない、#396）。** `auto` だと、
  スクロールバーが出た瞬間に右の余白がレールぶん増えて「右だけ太い」状態になる。
  常にレールを確保して右の padding からそのぶんを引けば、出ていても出ていなくても本文の
  右端からパネルの端までは変わらない（トラックは透明なので、スクロールしない一覧で
  レールは見えない）。`.diff-tab` の横スクロールの帯が `scroll` なのと同じ事情
  - **寸法は `theme.css` の `--panel-scrollbar-size` / `--panel-pad` で組む。** パネルの
    レールは幅が狭いぶん他の面（`--scrollbar-size`＝`::-webkit-scrollbar` とターミナルの溝）の
    半分の 3px で、`theme.css` の `.panel-content ::-webkit-scrollbar` がパネルの中の入れ子の
    スクロール領域ごと細くする。リテラルで散らすと片方だけ変えたときに戻る。
    **`OutlinePanel` はこの padding を負の margin で打ち消して端まで使う**ので、同じ変数で
    引くこと（値がずれると、その差がそのまま横スクロールバーになる）
  - **パネルのルートに `height: 100%` + `overflow-y: auto` を付けない。** `.panel-content` と
    二重のスクロール領域になり、ルートの縦 padding のぶんあふれていないのにレールが出る
    （issue・ブラウザ・タスクのパネルで踏んだ）

## xterm.js
- `Terminal` インスタンスはタブごとに生成し、コンポーネントの `onUnmounted` で `.dispose()`
- `FitAddon` で初期サイズを確定してから `pty_spawn` を invoke する
- ResizeObserver でコンテナサイズ変化を検知 → `FitAddon.fit()` → `pty_resize` invoke
- フォントは設定の `fontFamily`（`settingsStore.fontFamily`）を渡し、変更は既存のターミナルへライブ反映する

## スタイル
- CSS フレームワークは使わない（Tauri アプリなので外部 CDN 不要、軽量が正義）
- CSS Variables でテーマ変数を管理 (`--bg-primary`, `--text-primary` 等)
- **`--accent` / `--danger` の地に載せる文字は `--on-accent`**（#365）。`--text-active` は「強調した文字」で、ライトテーマでは黒になり、青地に黒は読めない。**選択中の行（`.selected` に `--accent` を塗るもの）の子要素も同じ**（アイコン・キーの表記・バッジ）。パスやキーの表記のような副文字は `--on-accent-muted`。`#fff` を直書きしないこと（値を変えたときに取り残される）
- レイアウトは CSS Grid / Flexbox のみ
- **scoped CSS は子コンポーネントのルート要素までしか届かない。** 親にしかないクラスを子で使うと、ルート要素だけ効いて**中の要素が素の見た目に戻る**。コンポーネントを切り出すときに踏みやすい
  - **共有クラスへ上げるか、子に書き写すかは「同じ名前の別物があるか」で決める。** 無ければ `theme.css` へ上げる（`.row-icon`、`.setting-label` / `.setting-hint`）。あれば子で持つ（`.icon-btn` は `panels/IconSelect.vue` が幅 100%・枠あり・テキスト付きの別物を定義しているので上げられない）
- **共有している形に、消費者の一方の名前を付けない。** 一方の名前が付いていると、その消費者を切り出したときに、同じ形を使っていた他の消費者が定義を失う。設定画面の一覧の器は `setting-list` / `setting-list-row` / `setting-list-name`

## アイコン
- UI アイコンは `lucide-vue-next` で統一（サイドバー・タブ・パネルボタン等）
- ファイルアイコンは `material-file-icons` の SVG（`getIcon(name).svg`）
- `src/lib/fileIcons.ts` でファイル名 → SVG のキャッシュ付きラッパーを提供
- SVG は `v-html` で注入する
- **行の先頭に置く 16px のアイコン枠は `theme.css` の `.row-icon`**（タブ・Git パネル・ファイルツリー・アウトラインが共有）。各コンポーネントの scoped CSS に写さない。色や不透明度（フォルダの accent、gitignore の淡色）は消費者側に残す
  - **`v-html` した SVG の寸法合わせは `.row-icon-svg` を併記する**（`svg { 16px }`）。`v-html` の中身は scope 属性を持たないので scoped CSS では当てられず、共有クラスにしてある（置いた側で書くなら `:deep()` が要る）
  - **lucide のアイコンには `.row-icon-svg` を付けない。** あちらの寸法は `:size` で決まるので、付けると 14px で置いている消費者（アウトライン）が太る

## カスタム確認ダイアログ
- `window.confirm()` は WebView のオリジン URL がタイトルに表示されるため使わない
- `src/composables/useConfirmDialog.ts` が `confirmDialog(msg): Promise<boolean>` を提供
- **チェックボックスを 1 つ添えたいときは `confirmWithOption(msg, label): Promise<{ ok, checked }>`**（#286 の「今後は確認しない」）。文言が空ならチェックボックスは出ないので、`confirmDialog` はこれに委譲した薄い包みで、起動の手順は 1 箇所にある。**`confirmDialog` の戻り値は真偽値のまま変えないこと**（呼び出しが 20 箇所以上あり、どれもチェックの状態を要らない）
- ダイアログの状態はモジュール単位のシングルトン。**モードごとにしか使わないフィールド（`inputValue` / `optionLabel`）の後始末は `dismiss()` に置く**。ここが「次のダイアログを開く直前に前の状態を捨てる」唯一の場所で、開く側の関数それぞれに書くと、消し忘れたフィールドが無関係なダイアログに出る
- `src/components/ConfirmDialog.vue` を `App.vue` に配置（Teleport で body 直下に描画）
- Enter で OK、Escape / オーバーレイクリックでキャンセル

## 国際化（i18n）
- `src/i18n/`: `index.ts` が `useI18n()` / 標準関数 `t` / `locale` ref（デフォルト `en`）を提供、`en.ts` / `ja.ts` がメッセージ辞書
- `messages` は `locale` に対する `computed` でリアクティブ（locale 切替で即時反映）。ストア等コンポーネント外では `t` を直接 import
- `{name}` プレースホルダを `replaceAll` で展開。言語切替は Settings タブ

## 禁止事項
- Monaco Editor（重い）
- 不要な npm パッケージの追加（都度相談）
- `any` 型（型定義を作ること）
