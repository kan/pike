# E2E スクリーンショット自動化（issue #142・Phase 0）

WebdriverIO と Tauri 向け WebDriver 連携で、Pike の画面を自動操作して撮影する仕組み。
現状は **Phase 0（実現性スパイク）** まで。起動・WebView 操作・撮影・invoke モックが
動くことを確認済み。

## 構成

- **`@wdio/tauri-service`**：WebdriverIO サービス。`driverProvider: 'embedded'` で
  アプリ内 WebDriver サーバに接続する。Windows では外部 `tauri-driver` プロセス不要。
- **`tauri-plugin-wdio-webdriver`**（Rust）：WebView2 内に W3C WebDriver サーバを立てる。
  `e2e` feature でのみ組み込む。
- **`@wdio/tauri-plugin`**（フロント guest）：`window.__TAURI__.core.invoke` をラップして
  invoke モックを可能にする。撮影ビルドでのみ `main.ts` が読み込む。
- **`wdio.conf.ts` / `specs/`**：撮影シナリオ。

## 本番ビルドを汚さない仕組み

撮影用コードは通常ビルド・リリースビルドに一切含めない。

- **Rust**：`e2e` Cargo feature（既定 OFF）でプラグインと `tauri/dynamic-acl` を切り替える。
  `#[cfg(feature = "e2e")]` でプラグイン登録と `add_capability` を囲む。
  `cfg(debug_assertions)` の target 依存はプロファイルを追従せず release に混入するため使わない。
- **capability**：`wdio-webdriver:default` は静的な `capabilities/` に置かず、
  `capabilities-runtime/wdio.json` を実行時に `add_capability` で登録する
  （静的に置くとプラグイン非搭載の本番ビルドが未知 permission で壊れる）。
- **フロント**：vite define `__PIKE_E2E__`（`PIKE_E2E=1` のときだけ true）で guest 読み込みを
  分岐する。通常ビルドでは定数 false になり Rollup が分岐ごと除去する。
- **identifier**：`tauri.e2e.conf.json` で `com.pike.e2e` に上書きする。既存 Pike との
  single-instance 衝突を避け、撮影対象ウィンドウを確実に制御する。

## 実行

```bash
# 1. 撮影用バイナリをビルド（e2e feature + PIKE_E2E=1 + com.pike.e2e identifier）
npm run e2e:build

# 2. 撮影シナリオを実行
npm run e2e
```

出力は `artifacts/screenshots/` に保存する（git 管理外）。

## 撮影済み画面（Phase 1）

`e2e/specs/screenshots.ts` が ja/en × light/dark の 4 バリアントで撮る。
命名規則は `{画面}-{lang}-{theme}.png`。

- `project-switcher`：プロジェクト切替モーダル
- `new-project`：新規プロジェクト作成フォーム
- `settings`：設定画面（外観セクション）
- `settings-shells`：設定のシェル一覧

未対応の手撮り backlog: `shell-dropdown`（ターミナル追加の ▾ プルダウン）。
これは globalMode か Windows プロジェクトのときだけ ▾ が出るため、別ウィンドウ
文脈が必要で Phase 1 の残タスク。

固定・切替の要点:

- 言語・テーマ・ウィンドウサイズは `support/prepare.ts` の `prepare()` で固定。
- 言語・テーマの切替は e2e ビルド限定の `window.__pikeE2E`（`setLanguage` /
  `setDarkMode`）でリロードなしに行う。
- 画面遷移は data-testid（`project-switcher` / `switcher-new-project` /
  `new-project-form` / `settings-screen` / `settings-shells`）と、`__pikeE2E` の
  `openSwitcher` / `closeSwitcher` / `openSettings` で行う。

## シナリオの追加

`e2e/specs/*.ts` に mocha の `describe` / `it` で書く。要素は `data-testid` で特定し、
`browser.saveScreenshot()` で撮影する。invoke 駆動パネルは `browser.tauri.mock()` で
決定的データを与える。

```ts
describe('settings', () => {
  it('captures the settings screen', async () => {
    await $('[data-testid="open-settings"]').click()
    await $('[data-testid="settings-screen"]').waitForDisplayed()
    await browser.saveScreenshot('./artifacts/screenshots/settings.png')
  })
})
```

## 制約（Pike 固有）

- `saveScreenshot()` は WebView 内のみ。ネイティブのウィンドウ枠は写らない。
- ターミナルは実 PTY、エージェントチャットは実セッション依存のため invoke モックだけでは
  再現できない（Phase 2 で扱う）。
- WebDriver セッションは 1 WebView 単位。複数ウィンドウ制御は追加工数。
