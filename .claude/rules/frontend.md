# フロント実装ルール

## 基本方針
- Vue 3 Composition API + `<script setup>` で統一
- 状態管理は Pinia、ストアは `src/stores/` に置く
- Tauri invoke は `src/lib/tauri.ts` に型付きラッパーを作って使う（直接 invoke しない）
- コンポーネントは `src/components/{category}/XxxYyy.vue` の命名

## ウィンドウのフォーカス
- 「このウィンドウがアクティブか」の出典は **`lib/window.ts` の `windowFocused`** ただ 1 つ。元は Rust の `WindowEvent::Focused`（`onFocusChanged`）で、アクリルの付け外し（#277）と同じ信号
- **`document.hasFocus()` で代用しないこと**。タイトルバーだけをクリックしてウィンドウがアクティブになったときは webview にフォーカスが入らないので、そのあいだ止まったままになる。以前は 4 ストアがこれを各自で見ていて、2 つは `windowFocused` という同名のローカル変数まで持っていた
- 「アクティブなあいだだけポーリングし、戻ってきたら 1 回取り直す」は **`composables/useFocusPolling.ts`**。`{ every, tick }` の配列を渡すだけで、`git` / `docker` / `worktree` / `usageStore` が共有する
  - **タイマーも composable が持つ**。フォーカス側だけ畳むと「張る前に必ず消す」が呼び出し側に 4 つ残り、5 つ目を書く人が落とせる
  - 復帰時に撃つのは**先頭の interval だけ**。どのストアもそれが主ポーリングで、後ろに続くのは自前の間隔ガードを持つ重い処理（git の `fetchInBackground`）
  - **ストアの setup 直下で呼ぶこと**。監視をそこで 1 回だけ張るので持ち主が Pinia のストアの scope になる。`start()` の中で張ると、`onMounted` から呼ばれたときにコンポーネントの scope に入ってマウント解除で黙って止まる
- 例外は「webview に DOM フォーカスがあるか」そのものを問うている箇所だけ（`TerminalTab` の IME 周り。blur の完了前に退避する必要があり、focus 側は WebView2 のフォーカス受け渡しに紐付いている）。**「ユーザーがこのウィンドウを見ているか」を聞きたいところは `windowFocused`**（`useAgentRouter` の通知抑制がそれで、`document.hasFocus()` のままだとタイトルバーをクリックして前に出したときに目の前のタブへ通知が飛ぶ）

## タブ管理
- タブの状態は `src/stores/tabs.ts` で一元管理
- **`Tab` 型の正本は `src/types/tab.ts`**（判別キーは `kind`）。現在の種別は `terminal` / `editor` / `preview` / `pdf` / `diff` / `history` / `docker-logs` / `agent-chat` / `settings` / `agent-status` / `manual`。種別を増やすときは Union に足し、`TabPane.vue` の描画分岐と `snapshotSession`（永続化対象の絞り込み）の両方を更新する
- **タブ名を画面に出すときは `lib/tabTitle.ts` の `tabDisplayTitle(tab)` を通す**。シングルトンタブ（`settings` / `agent-status` / `manual`）は自分固有の名前を持たないので、`tab.title` に焼き込んだ英語リテラルではなく `SINGLETON_TITLE_KEYS` 経由で i18n を引く。`tab.title` を直接描くと、開いたときの言語のまま固定されて言語切替に追従しない（`types/tab.ts` は値 import を持たない方針なので、`t()` を呼ぶこの関数は `lib/` に置く）
- ファイルを開く操作は `lib/openFile.ts` の `openPathInTab` を通す（拡張子で editor / preview / pdf を振り分ける唯一の入口。`addEditorTab` を直接呼ぶと画像や PDF が化ける）
- pinned タブは ✕ ボタン非表示、Ctrl+W のハンドラで早期リターン
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

## アイコン
- UI アイコンは `lucide-vue-next` で統一（サイドバー・タブ・パネルボタン等）
- ファイルアイコンは `material-file-icons` の SVG（`getIcon(name).svg`）
- `src/lib/fileIcons.ts` でファイル名 → SVG のキャッシュ付きラッパーを提供
- SVG は `v-html` で注入、`:deep(svg) { width: 16px; height: 16px }` でサイズ制御

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
- ダーク/ライトモード切替: `data-theme` 属性で CSS Variables を切り替え
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
