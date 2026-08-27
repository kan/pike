# Docker 実装ルール

bollard 経由の Docker API 連携、compose の探索、ログストリーム、ポートフォワード。
実体は `src-tauri/src/docker/`、`src/stores/docker.ts`、`src/components/panels/DockerPanel.vue`、`src/components/tabs/DockerLogsTab.vue`。

## Docker 統合
- `bollard` クレートで Docker API に接続（named pipe → TCP:2375 → TCP:2376 フォールバック）
- クライアントは `OnceCell` でキャッシュし、毎コマンドの再接続を回避
- compose ファイルは `serde_yaml` でパースしてサービス一覧表示
- **compose の探索範囲（#221）**: `docker_compose_discover` がプロジェクト直下＋サブディレクトリ 2 階層（`MAX_DEPTH`=3。walker は root 直下のファイルを深さ 1 と数える）を走査し、compose ファイルごとに `ComposeProject { dir, file, name, services }` を返す。探索は `fs::walk_files_by_name`、読み込みは `fs::batch_read_files`（WSL は 1 往復）と、タスク検出と同じ共有ヘルパーを使う。1 ディレクトリにつき 1 ファイル（`COMPOSE_FILE_NAMES` の順＝Compose 自身の優先順）に畳み、`MAX_COMPOSE_FILES`=50 で打ち切る。**タスク検出と違い rg 経由の `.gitignore` 尊重はしない**（`SearchState` を持ち込むほどの深さではないため）ので、`vendor/` の除外だけタスク側と同じ方法で明示的にやっている
- コンテナとサービスのマッチは **`com.docker.compose.project.working_dir` ラベルと `ComposeProject.dir` の一致が第一候補**（Compose 自身が記録した事実なので、`-p` / 環境変数や `.env` の `COMPOSE_PROJECT_NAME` でプロジェクト名を変えていても効く）。ラベルが無い古い Compose 由来のコンテナ向けに、`com.docker.compose.project` と**ディレクトリから導いた名前**の比較をフォールバックに残してある。導出は Compose の `NormalizeProjectName` と同じ（小文字化 → `[a-z0-9_-]` 以外を除去 → 先頭の `_`/`-` を落とす）で、compose ファイルに top-level `name:` があればそちらが優先。以前はフロントで `[^a-z0-9]` を全部落としていたため、`my-app` のようにハイフンを含むディレクトリのプロジェクトが 1 つもマッチしなかった（実コンテナのラベルで確認済み: `screenshot-com-440-…` はハイフンが残る）
- グループ見出しのパスをクリックすると compose ファイルをエディタで開く（Tasks パネルの `openSourceFile`（#159）と同じ操作感に揃えてある）
- start / stop / restart / refresh を UI から実行、5秒ポーリングで状態更新
- compose up / down（#157、#221 でグループ単位へ）: DockerPanel の**グループ見出し**（Play / Square）→ confirm 後に `docker compose up -d` / `docker compose down` をターミナルタブで実行（`dockerStore.composeUp/composeDown(target)`、cwd=**その compose ファイルのディレクトリ**・closeOnExit。タスク実行と同じパターン）。compose が複数あると対象が一意に決まらないため、SideBar ヘッダーの 2 ボタンは廃止した
- ログストリーミングは 50ms バッファリング + Tauri イベント emit
- DockerLogsTab は xterm.js ベース（読み取り専用、`convertEol: true`）
- `docker exec` シェル: bollard exec API でコンテナ内シェルを検出（bash → sh フォールバック）、プロジェクトのシェル内で `docker exec -it` を autoStart 実行
- ポートフォワード（#120）: `docker/tunnel.rs`。未公開ポートへ `alpine/socat` 一時コンテナ（`auto_remove` + `pike.tunnel*` ラベル、対象と同一ネットワーク優先=非 bridge）で `127.0.0.1` から転送。**owner ラベル**（`pike.tunnel.owner`=アプリ identifier、setup で `DockerState.instance_id` に設定）でインスタンススコープ化し、共存する installed/dev が互いのトンネルを掃除しない。**ローカルポートはデーモン割当**（`host_port=""` → start 後 inspect で取得。ホスト側プローブは TOCTOU と WSL2 名前空間不一致があるため不使用）。**接続先はカスタムネットワークならコンテナ名**（Docker 内蔵 DNS。restart/recreate の IP 変化に追従）、bridge のみ IP。start 失敗時は手動ロールバック削除（auto_remove は start 前に効かない）。作成後に TCP 接続プローブで readiness 確認（best-effort ~1s）。トンネル一覧は `docker_list_containers` が 1 回の list を `{ containers, tunnels }`（`ContainerListResult`）に分配して返す（running + 自 owner のみ。専用 list コマンドなし、ポーリングの API 往復も 1 回）。掃除は初回 Docker 接続時（自 owner のクラッシュ残骸をラベル sweep、`join_all` 並列）と `RunEvent::Exit`（このセッションで作成した場合のみ=`tunnels_created` フラグ、3 秒 timeout 付き `block_on`。Exit コールバックは Tauri の teardown 前に走りランタイムは生存）。停止は remove 失敗を伝搬（auto_remove 競合で消滅済みなら成功扱い）。ポート候補は inspect の `exposed_ports`（EXPOSE / compose expose 由来、`/tcp` のみ）。UI は DockerPanel 実行中サービス行の Cable ボタン → `promptDialog` でポート入力 → サービス行直下にトンネル行（`open_url` で開く / 停止）。対象コンテナが消えた/再作成されたトンネルは「その他のフォワード」セクションに表示して停止可能にする。作成中ガードは `tunnelBusy: string[]`（コンテナ別）

## 接続（bollard のフォールバック）
- フォールバック戦略で接続（musql と同一パターン）:
  1. `Docker::connect_with_local_defaults()` — named pipe / DOCKER_HOST 環境変数
  2. `Docker::connect_with_http("tcp://127.0.0.1:2375")` — WSL2 dockerd (unencrypted)
  3. `Docker::connect_with_http("tcp://127.0.0.1:2376")` — WSL2 dockerd (encrypted)
- macOS では 1 の `connect_with_local_defaults()` が Unix ソケット（`/var/run/docker.sock`）を掴むので、2 と 3 の TCP フォールバックは Windows のためだけに残っている
- 各接続で `ping()` して到達確認、最初に成功したものを使う
- Docker Desktop なしでも WSL2 の dockerd が TCP を公開していれば接続可能

