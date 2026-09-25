---
paths:
  - "src/components/tabs/SettingsTab.vue"
  - "src/components/settings/**"
  - "src/composables/useSettingsSearch.ts"
  - "src/stores/settings.ts"
  - "src/lib/fontDetection.ts"
  - "src-tauri/src/font.rs"
---

# 設定画面の実装ルール

- サイドバー下部の歯車アイコンからシングルトンタブとして開く
- 設定は `localStorage` (`pike:settings`) に永続化
- **分類と絞り込み（#314）**: 節は 8 つ（全般 / 外観 / ターミナル / エージェント / エディタ / 外部との通信 / 設定の同期 / バージョン情報）で、長い節は小見出しで分ける。器は `components/settings/`（`SettingSection` / `SettingGroup` / `SettingItem` / `SettingToggle` / `HighlightText`）、絞り込みの状態は `composables/useSettingsSearch.ts`
  - **判断の実体は `useSettingsSearch.ts` の doc コメントが正本**（項目の表を別に持たない理由・一致の当て方・`v-show` にする理由）。ここに写しを置くと必ず片方が古くなるので、方針だけ残す
  - **項目は「名前 → 説明 → 操作」の縦並び 1 つだけ**（#365。VS Code と同じ）。横並び（名前の右端に操作）にしない: 幅の広い画面で名前と操作が離れて対応が読めない。操作は既定で中身の幅、一覧・並び・入力欄は `wide` で行幅に広げる
  - **項目を足すときは `SettingItem`、選択肢は `SettingToggle`。** 文言は i18n キーで渡し、テンプレートに `t()` の結果を書かない（描く側と検索に当てる側が同じキーになる）
  - **`v-if` を書いてよいのは 2 つだけ。** 部品のルート要素（コンポーネント自体はマウントされたまま残る）と、**存在しない / いま効かない項目**（`isWindowsHost` の背景、`autoSave` が off のときの待ち時間）。後者は消えているあいだ検索にも出ないが、前提になる項目（背景・自動保存）のほうは当たるので迷子にならない
  - **節の一覧（`SECTIONS`）は左ナビと各節の props の両方が読む**。見出しとマニュアルの飛び先を 2 箇所に書かないため。**スクロール追従（`onSettingsScroll`）は消えた節を飛ばす**: `v-show` の要素は矩形が 0 になるので、数えると必ず先頭が選ばれる
  - **外部との通信の節はエディタから切り出したもの**（URL のタイトル取得 #241・画像のホスト #239・リンクのホスト #311）。3 つとも「外のホストへ出て行くか」の設定で、どの機能で使うかより、そちらの軸で探されるため
  - 検索欄の見た目は `theme.css` の `.filter-row` / `.filter-icon` / `.filter-input`（プロジェクトパネルの絞り込みと共有）。一致部分の強調に `v-html` を使わないこと（入力欄の文字が HTML として評価される経路を作らない）
- ダーク/ライト/システム追従（#310）: `data-theme` 属性で CSS Variables を切り替え
  - **保存する値と解決した値を分ける。** 永続化・同期・ブロードキャストの対象は `themeMode`（`dark` / `light` / `system`）だけで、`darkMode` は**解決結果の computed**。読み手（`data-theme` の適用・カラースキームとエディタテーマの Auto・`window_set_backdrop` の再適用・`ManualTab` の初期値）はどれも解決結果を見たいので、名前はそのまま。**解決結果は配らない**（OS の設定が違うマシンで食い違う）ので、追従のときは各ウィンドウが自分で OS に聞く
  - **外から来た設定は `sanitize` が唯一の入口**（既定とのマージもスキーマ移行もあの中）。理由と、追従のあいだ `setTheme(null)` を渡す理由は、それぞれ `stores/settings.ts` と `lib/window.ts` の doc コメントが正本
  - **ステータスバーのボタンは `THEME_MODES` を順に巡る**（#407。`cycleThemeMode`）。2 状態（ダークとライトの往復）にしないのは、追従を選んでいる人が一度押すと設定画面まで行かないと戻せなくなるため。アイコンとツールチップは設定画面と同じ i18n キー（`settings.darkMode` など）を読む
  - **OS のテーマを別経路で聞く形は採れない。** Tauri の JS API に独立した情報源が無く、`matchMedia` も `window.theme()` も**自分が呼んだ `setTheme` に汚染される**（だから `lib/window.ts` は pin 中の `onThemeChanged` を捨て、初期値にだけ `matchMedia` を使う）。`frontend.md` の「フォーカスはネイティブの信号を見る」の例外に見えるが、こちらは web 層の API を**初期値としてのみ**使っている
    - 本当に独立させるなら Rust 側（Windows の `AppsUseLightTheme` ＋ `WM_SETTINGCHANGE`、macOS の `effectiveAppearance`）をコマンドとイベントにすることになる。**pin 中に古くなるだけで、解除時に読み直せば閉じる**ので、OS ごとのコードを足す価値が無いと判断した
  - **書き出しの `darkMode` は後方互換**（同期ファイルは古い版の Pike も読む）。落としてよいのは、**同期ファイルを共有する全マシンが `themeMode` を知る版になったとき**。cross-version の経路は同期ファイル 1 本だけ（localStorage は同一インストール、broadcast は同一プロセス）なので、そこだけ見れば判断できる。目安は v0.48.0 以降しか相手にしなくてよくなった時点で、消すのは `withThemeMode` と `snapshot()` の 1 行
- ターミナルフォント: `font-kit` クレートでシステムのモノスペースフォントを列挙（`spawn_blocking` で非同期実行）
- フォントスキャンは Settings タブを開いた時に遅延ロード（起動時には実行しない）
- カラースキーム: 6種（Default Dark, Solarized Dark/Light, Monokai, Dracula, Nord）
- フォント・サイズ変更は既存ターミナルにライブ反映、カラースキーム変更は `terminal.refresh()` + PTY resize nudge で TUI 再描画
- 設定タブにターミナルプレビュー表示（選択中のフォント・サイズ・カラースキームを即時反映）
- Editor セクション: ミニマップ ON/OFF、ワードラップ ON/OFF、タブサイズ（2/4/8）。CM6 Compartment でライブ反映
- settings タブはセッション永続化の対象外（`snapshotSession` は terminal / editor / browser のみフィルタ）

## シェルプロファイル（#129）

ターミナル追加の ▾ プルダウンと各シェル選択肢の並び順・表示/非表示を管理する。実体は `stores/settings.ts`、UI は SettingsTab「シェル一覧」（↑↓・目トグル・デフォルトバッジ。行は `ProfileRow.vue`）。

- `ShellProfile { id, shell, hidden? }` の配列を `pike:shell-profiles` キーにマシンローカル永続化（`globalShell` と同じく**同期ファイルの対象外**。マシンの WSL distro に依存するため）
- ただし**クロスウィンドウ broadcast はする**（`pike://shell-profiles-changed`、#240）: マシンローカルでも同じマシンのウィンドウ同士では揃っている必要がある。ジャンプリストとトレイはプロセスに 1 つの資源で、どのウィンドウからでも張り直されるため、起動時のコピーを持ったままのウィンドウが「別のウィンドウが検出した WSL の distro が無い」「今隠したシェルがまだ居る」一覧を publish してしまう。**publish の直前に localStorage を読み直す形は採らない**（同じ変更で走る永続化 watcher と読みが競合する）
- `syncShellProfiles(distros)` が `detect_wsl_distros` の結果と照合する（新規 distro は先頭に追加・消えた distro は除去・既存の順序と hidden は維持）。**空検出は過渡状態とみなし reconcile しない**（カスタマイズの消失を防ぐ）
- `windowsShellOptions(currentKind?)` / `visibleWslDistros(detected, currentDistro?)` が hidden を除いた選択肢を返す（現在値は hidden でも残す）。`defaultWindowsShellKind()` は作成フォームの既定（powershell 優先）
- `ensureVisiblePerCategory` で WSL/Windows の各カテゴリに最低 1 つは可視を保証する（UI の `canHideShellProfile` と二重ガード）。既定シェルは ▾ で hidden でも一覧に残す
