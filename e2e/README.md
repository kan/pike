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
- `shell-dropdown`：ターミナル追加の ▾ プルダウン（globalMode 文脈で撮影）

固定・切替の要点:

- 言語・テーマ・ウィンドウサイズは `support/prepare.ts` の `prepare()` で固定。
- 言語・テーマの切替は e2e ビルド限定の `window.__pikeE2E`（`setLanguage` /
  `setDarkMode`）でリロードなしに行う。
- 画面遷移は data-testid（`project-switcher` / `switcher-new-project` /
  `new-project-form` / `settings-screen` / `settings-shells` / `tab-add-arrow` /
  `shell-menu`）と、`__pikeE2E` の `openSwitcher` / `closeSwitcher` /
  `openSettings` / `enterGlobalMode` で行う。
- ▾ プルダウンは globalMode（または Windows プロジェクト）のときだけ出るため、
  `enterGlobalMode`（WSL 検出でシェルプロファイルを揃えてから globalMode に入る）で撮る。

## invoke 駆動パネルの撮影（invoke モック）

Git / Docker / ファイルツリー等は Rust への invoke でデータを得る。決定的な
ダミーデータを与えて撮るには invoke モックを使う。

- **モックの適用先**: Tauri v2 は `__TAURI_INTERNALS__.invoke` を凍結していて
  monkey-patch できず、`@wdio/tauri-service` の invoke モックはアプリ自身の invoke に
  効かない。そこで **`src/lib/tauri.ts`（唯一の invoke チョークポイント）** が e2e
  ビルドで `window.__wdio_mocks__` を参照し、モックがあればそれを返す（`__PIKE_E2E__`
  分岐なので本番はツリーシェイクで除去）。
- **手順**: `mockInvoke(command, value)` でコマンド別に値を設定 → `setFakeProject()`
  で擬似プロジェクトを差して `activeRoot` を確定 → `openPanel('git')` 等でパネルを
  開く。パネルは開いた時に invoke でフェッチするので、モックは開く前に設定する。
- 実装例は `e2e/specs/panels.ts`。同ファイルで撮影する invoke モックパネル:
  - `git-panel`：`git_status` / `git_log` / `git_branch_list` / `git_remote_url` / `git_worktree_list`
  - `docker-panel`：`docker_ping` / `docker_compose_services` / `docker_list_containers`
    （`composeProject` は root 名由来の `demoapp` に揃える）
  - `files-panel`：`fs_list_dir`（path 引数によらず同値を返すためルート直下のみ展開）
  - `tasks-panel`：`task_discover`（npm / cargo グループ）
  - `search-panel`：`search_detect_backend` / `search_execute`。検索はユーザー入力駆動
    なので `data-testid="search-input"` に打鍵し Enter で実行する
- パネルは `activePanel` の watch でロードされる（tasks / docker / files）か、開いた時に
  フェッチするので、モックは `openPanel` の前に設定する。データ描画の完了は代表要素
  （`.container-item` / `.tree-item` / `.task-item` / `.result-item`）の表示待ちで確認する。
- 擬似 root では実ファイル監視の起動が失敗し FileTreePanel に警告バナーが出るため、
  `prepare()` が `fs_watch_start` をモックして初回起動から成功扱いにしている。

## エディタ / プレビュー / アウトラインの撮影

エディタ系は invoke モックすら不要。`addEditorTab({ initialContent })` を渡すと
EditorTab は `fs_read_file` を読まずその内容で描画するため、決定的な内容を直接与えられる。

- `__pikeE2E.openEditor({ path, content, viewMode })`（`support/prepare.ts` の
  `openEditor()` から呼ぶ）で、既存エディタタブを閉じてから 1 枚開く。`viewMode`
  （`edit` / `split` / `preview`）は markdown 等プレビュー可能な拡張子でのみ効く。
- **アウトライン**は EditorTab が登録する CodeMirror View（`useOutlineSource`）から
  抽出するため、`edit` モード（View が生きている）で開いてから `openPanel('outline')`
  する。プレビュー専用モードでは View が無く抽出できない。
- 描画完了は `.cm-editor`（エディタ）/ `.preview-pane`（プレビュー）/
  `[data-testid="outline-panel"] .tree-item`（アウトライン）の表示待ちで確認する。
- 実装例は `e2e/specs/editor.ts`（`editor` / `markdown-preview` / `outline-panel`）。
- **プレビュー派生**：`viewMode:'preview'` で拡張子ごとの描画に分岐する。CSV/TSV は表、
  JSON/JSONL は色分け、SVG はサニタイズ描画、Mermaid はライブラリ遅延 import + 非同期
  render。待機は `.csv-preview table` / `.json-preview` / `.svg-preview svg` /
  `.mermaid-preview svg`（mermaid は render 完了まで長めに待つ）。実装例は
  `e2e/specs/preview.ts`（`csv-preview` / `json-preview` / `mermaid-preview` / `svg-preview`）。

## worktree セレクタ / QuickOpen / TODO

`e2e/specs/navigation.ts`。いずれも簡単な invoke モック + `__pikeE2E` ヘルパーで撮る。

- **worktree セレクタ**：`git_worktree_list` を 2 件以上でモック → `loadWorktrees()`
  （`worktreeStore.loadWorktrees`）で一覧を入れると `hasMultiple=true` になり StatusBar に
  セレクタ（`data-testid="worktree-selector"`）が出る。クリックで `.branch-dropdown` を開く。
- **QuickOpen**：`list_project_files` をモック → `openQuickOpen()`（`showQuickOpen=true`）。
  `data-testid="quickopen"` のモーダルに `.quickopen-item` が並ぶ。
- **TODO**：TODO store は `.pike/todo.md` を `fs_read_file` で読む。擬似プロジェクト id が
  全 spec で同一のため、最初の `setFakeProject`（モック未設定時）の失敗結果が残り
  project watch が再発火しない。`fs_read_file` モック後に `reloadTodo()`
  （`todoStore.load`）で明示再ロードしてから `openPanel('todo')` する。
- **overlay の後始末**：`prepare()` は毎回 `closeOverlays()`（ProjectSwitcher / QuickOpen を
  閉じ、window mousedown で worktree ドロップダウン等の popover を畳む）を呼び、前の it の
  開いた overlay が次の撮影へ写り込むのを防ぐ。

## Phase 2: 実プロセス依存画面（ターミナル）

ターミナルは実 PTY を起動し `pty_output` の emit イベントで xterm に描画するため、
invoke モックだけでは再現できない。実プロセスなしに決定的に撮るため次の方式を使う。

- `pty_spawn` をモックして実シェルを起動させない（`mockPtySpawnUniqueIds()`。
  呼ぶたびユニークな id を返す。id 固定だと閉じたタブの unregister が新タブの
  ハンドラを消すため）。`pty_resize` / `pty_write` / `pty_kill` も no-op モック。
- `ptyRouter.feed(ptyId, data)` で `pty_output` と同じ経路に合成出力（ANSI 付き）を
  流す。`__pikeE2E.openTerminal()`（既存ターミナルを閉じて 1 枚開く）と
  `feedActiveTerminal(data)`（アクティブタブの ptyId へ feed）で操作する。
- 実装例は `e2e/specs/terminal.ts`（npm run dev 相当の擬似セッションを描画）。

エージェントチャットも実セッション依存で Phase 2 の対象（未対応）。

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
