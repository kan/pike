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

- **出力寸法は固定**：`prepare()` が `setWindowSize(1280, 832)` で外形を固定するため、
  `saveScreenshot()` が撮る WebView 内は全撮影で同一の **1259×777**（ネイティブ枠を差し引いた
  内寸）になる。全 110 枚が寸法一致することを確認済み（`magick identify` で検証）。
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

## 画像 / 差分 / ファイル履歴

`e2e/specs/media.ts`。ファイル系タブは store の add メソッドに直接データを渡せるため、
画像と差分は invoke モックすら不要。

- **画像ビューワ（PreviewTab）**：`addPreviewTab({ path, dataUrl })` に data URL を直接渡す
  （`fs_read_file_base64` 不要）。`openImage()` から呼ぶ。待機は `.preview-tab img`。
- **差分タブ（DiffTab）**：`addDiffTab({ filePath, diff })` に unified diff 文字列を直接渡す
  （invoke 不要。`parseDiff` が解釈）。`openDiff()` から呼ぶ。待機は `.diff-row`。
- **ファイル履歴（HistoryTab）**：`onMounted` で `git_log_file` を叩くのでモックする。
  `openHistory({ filePath })` から呼ぶ。待機は `.commit-row`。
- **PDF（PdfTab）**：`onMounted` で `fs_read_file_base64` を叩き `data:application/pdf` を
  iframe に流す。`openPdf({ path })` から呼び、`fs_read_file_base64` を最小 PDF の base64
  （`support/pdfFixture.ts`）でモックする。待機は `.pdf-frame` + 内蔵ビューワ描画の pause。
  **WebView2 内蔵 PDF ビューワの描画は `saveScreenshot` に写る**（ネイティブ面で空白になる懸念は
  杞憂だった）。
- これらの media ヘルパーは開く前に `closeContentTabs()`（editor/preview/diff/history/pdf）で
  既存のファイル系タブを閉じ、タブバーを 1 枚に保つ。

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

### エージェントチャット（Codex / Claude Code）

エージェントチャットは `agent_start_session` 等で実プロセスを起動し `agent://` イベントで
描画するが、撮影では実セッションを立てず **agent store の session 状態を決定的な会話で
直接構築**する（media 系と同じ「store へ直接データ」方式）。

- `__pikeE2E.openAgentChat(fixture)`：agent-chat タブを 1 枚開き、`getSession` の状態を
  `connected=true` / `capabilities` / `authState=authenticated` / `messages` などで埋める。
  `connected=true` を mount 前に立てるため `AgentChatTab.onMounted` の `ensureConnected` は
  スキップされ、`agent_*` invoke を一切呼ばない（backend 非依存）。
- 会話は `messages`（`ChatMessage[]`）で与える。agent メッセージは `segments` に text と
  item（`commandExecution` / `fileChange` / `reasoning`）を時系列で並べる。完了状態
  （`completed:true`）だとコマンド出力・reasoning の `<details>` は畳まれた状態で写る。
- `capabilities` で UI が分岐する：Codex は sandbox / approval / model 選択 / 認証メールが
  出る。Claude Code（ACP）は `supportsSandboxConfig` 等が false なので info-bar が最小
  （displayName とセッションタイトルと instructions ファイルのみ）。
- 待機は `.msg-agent`。実装例は `e2e/specs/agent.ts`（`agent-codex` / `agent-claude`、
  ja/en で会話文面を出し分け）。

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

## ウィンドウ枠の合成（外枠合成）

`saveScreenshot()` は WebView 内しか撮れず、ネイティブのタイトルバー・角丸・影は写らない。
Store やサイトのヒーロー画像はウィンドウ枠込みを求められるため、撮影済み PNG に後処理で
Windows 11 風の枠を合成する。

- `scripts/frame-screenshot.sh <input.png> [output.png]`（単体）/ `--all`
  （`artifacts/screenshots/*.png` を一括 → `artifacts/framed/`）。
- タイトルバー（アイコン + "Pike" + 最小化/最大化/閉じるのキャプションボタン）を上に足し、
  四隅を角丸にマスクし、1px のヘアラインとドロップシャドウを重ねる。テーマはファイル名の
  `-dark` / `-light` サフィックスから判定（`THEME=` で明示指定も可）。
- 既定は透過背景（任意の下地に載せられる）。`BG='#c8ccd2'` で単色背景に flatten。
- 依存は ImageMagick 7（`magick`）と Windows の Segoe UI フォント。`artifacts/` は
  `.gitignore` 済みだが、**ヒーロー画像はコミット対象**（`docs/screenshot-*.png` /
  `docs/manual/img/overview.png`）なので `<input>` の dark/light を各サフィックスの
  出力へ明示的に合成する（後述の手順を参照）。

現在のヒーローは 3 枚:

- `docs/screenshot-editor.png`（README「エディタとファイルツリー」← `hero-editor`）
- `docs/screenshot-git.png`（README「Git パネルと Claude Code」← `hero-git`）
- `docs/manual/img/overview.png`（マニュアル TOP ← `overview`）

いずれも dark（`{名}.png`）と light（`{名}-light.png`）を対で持つ。

## マニュアル画像への同期

E2E は `{画面}-{lang}-{theme}.png` で撮る（`artifacts/` は gitignore）。マニュアルは
`docs/manual/img/{別名}.png` を参照し、両者は名前が違う。`scripts/sync-manual-images.sh` が
対応表（マニュアル名 ← E2E ベース名）に沿って ja の dark/light をコピーする。

- 各画面を `{別名}.png`（dark・`<img>` フォールバック）と `{別名}-light.png`（light 上書き）の
  2 枚で出力する（light/dark 切替のため。後述）。
- `scripts/sync-manual-images.sh --check`：ドライラン（更新予定 / ソース欠落を表示）。
- 引数なしで実行すると `docs/manual/img` へ実コピー。`LANG_=` / `OUTDIR=` で変更可。
- 外枠付きヒーロー（`overview` / README の `screenshot-*`）は `frame-screenshot.sh` で別途
  生成するため MAP には含めない。

## light/dark 切替（`<picture>`）とテーマ

README とマニュアルは、閲覧テーマに追従して画像を切り替える。

- **Markdown 側**：画像は `<picture>` で持つ。dark を `<img>` フォールバック、light を
  `prefers-color-scheme: light` の `<source srcset>` で上書きする。

  ```html
  <picture>
    <source media="(prefers-color-scheme: light)" srcset="img/docker-light.png">
    <img alt="Docker パネル" src="img/docker.png">
  </picture>
  ```

- **撮影側**：`prepare({ theme })` の light 撮影では、エディタ（`Default Light`）とターミナル
  （`Solarized Light`）のテーマも light に揃え、画面全体を light 系で統一する（`__pikeE2E`
  の `setDarkMode` が editor/terminal のテーマも app モードに合わせる。撮影限定で、Pike 本体の
  既定挙動は未変更）。
- **GitHub 表示**：`<picture>` + `prefers-color-scheme` は GitHub 公式サポートで、閲覧者の
  GitHub テーマに追従する。
- **Pike 内プレビュー**：`ManualTab` は WebView の `prefers-color-scheme` に依らず、右上トグルの
  `manualDark` で `<picture>` を dark/light の `<img>` に畳んで選び、コンテナの `data-theme` で
  chrome も切り替える（マニュアル表示のみに効く）。加えて `settings` の `applyDarkMode` が
  `setWebviewTheme` で WebView の `prefers-color-scheme` とタイトルバーを app テーマへ同期する。

## 撮影〜合成〜差し替えの手順

画面変更後にマニュアル画像を更新する一連の流れ。

```bash
# 1. 撮影バイナリをビルド（フロント変更時のみ必要。spec だけの変更なら不要）
npm run e2e:build

# 2. 全シナリオを撮影（ja/en × light/dark を artifacts/screenshots へ）
npm run e2e
#    セッション teardown が稀に ECONNREFUSED で落ちるが撮影は完了している。
#    その spec だけ npx wdio run e2e/wdio.conf.ts --spec e2e/specs/<name>.ts で撮り直す。

# 3. frameless 内枠をマニュアルへ同期（dark + light）
bash scripts/sync-manual-images.sh --check   # まず差分確認
bash scripts/sync-manual-images.sh           # docs/manual/img へコピー

# 4. 外枠ヒーローを dark/light で合成（コミット対象）
bash scripts/frame-screenshot.sh artifacts/screenshots/hero-editor-ja-dark.png  docs/screenshot-editor.png
bash scripts/frame-screenshot.sh artifacts/screenshots/hero-editor-ja-light.png docs/screenshot-editor-light.png
bash scripts/frame-screenshot.sh artifacts/screenshots/hero-git-ja-dark.png     docs/screenshot-git.png
bash scripts/frame-screenshot.sh artifacts/screenshots/hero-git-ja-light.png    docs/screenshot-git-light.png
bash scripts/frame-screenshot.sh artifacts/screenshots/overview-ja-dark.png     docs/manual/img/overview.png
bash scripts/frame-screenshot.sh artifacts/screenshots/overview-ja-light.png    docs/manual/img/overview-light.png
```

新しい画面をマニュアルに載せるときは、(a) E2E に撮影シナリオを追加、(b) `sync-manual-images.sh`
の MAP に「マニュアル名 ← E2E ベース名」を追加、(c) 対象ページの Markdown を `<picture>` で
記述（dark/light 両参照）する。相対参照（`../screenshot-*.png` 等）も `<picture>` 化を忘れない。

**校正**：マニュアル（`docs/manual/`）・README を変更したら、コミット前に textlint
（ai-writing 指摘 0）と `japanese-tech-writing` スキルで点検し、見出しアンカーの整合も確認する
（プロジェクト CLAUDE.md の「ドキュメント校正ルール」に従う）。

## 制約（Pike 固有）

- `saveScreenshot()` は WebView 内のみ。ネイティブのウィンドウ枠は写らないため、枠込みが
  要るショットは上記の外枠合成で後付けする（実ウィンドウのネイティブキャプチャは別手段）。
- ターミナル・エージェントチャットは実プロセス／実セッション依存で invoke モックだけでは
  再現できないため、Phase 2 の合成出力注入・store 直接構築で撮る。
- WebDriver セッションは 1 WebView 単位。複数ウィンドウ制御は追加工数。
