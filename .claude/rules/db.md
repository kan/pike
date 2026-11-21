---
paths:
  - "src-tauri/src/db/**"
  - "src/components/tabs/DbTab.vue"
  - "src/lib/dbViewer.ts"
  - "src/types/db.ts"
  - "src/composables/useCsvTable.ts"
  - "src/assets/csvTable.css"
---

# 簡易 DB ビューワ（#632）実装ルール

MySQL / PostgreSQL のテーブルの一覧・中身・スキーマを表で見て、CSV / TSV でコピー・保存する。
接続先はローカル（ホスト）・WSL・Docker コンテナだけ。実体は `src-tauri/src/db/`（`mod.rs` が
実行、`sql.rs` が SQL と出力の読み方）、`src/components/tabs/DbTab.vue`、`src/lib/dbViewer.ts`。

## やらないこと（広げるときは issue から）

- **任意の SQL を受けない**（入力欄を持たない）。書き込み系（INSERT / UPDATE / DELETE / DDL）も無い
- SSH 踏み台・リモートホスト（musql の領分）、MySQL / PostgreSQL 以外（SQLite など）
- 接続情報の保存・管理画面。**パスワードはタブのコンポーネントの中にだけ持つ**（タブの欄・セッション・
  設定に書かない）。DB のタブはセッションにも残さない（`snapshotSession` の対象外のまま）

## DB ドライバのクレートを入れない

`sqlx` / `mysql_async` / `tokio-postgres` は入れない。**接続先の環境にある `mysql` / `psql` を起こして
出力を読む**（musql が SSH を `ssh` コマンドで済ませているのと同じ考え方）。`Cargo.toml` に DB の依存を
足さないこと。

- **コンテナは bollard の exec**（`docker exec` と同じ。ホストに Docker の CLI もクライアントも要らない）。
  CLI の `docker exec` にしなかったのは、Windows のホストには `docker` コマンドが無いことが普通にある
  （WSL の dockerd を TCP で使う構成。Docker パネルが bollard で繋がっているのと同じ前提に揃える）
- **シェルはプロジェクトのシェル**（`projectStore.shellForIO`）。WSL は `wsl.exe -d <distro>` 越しに
  distro の中で起こすので、WSL の中の DB に Windows から TCP で届くかを考えなくてよい
  - **WSL は `sh -c 'PATH="$WSL_EXTRA_PATH:$PATH" exec "$0" "$@"' <client> <args...>` を挟む**（`run_shell`）。
    `wsl.exe -e mysql` で直に起こすと、無いときに終了コード 1 と `execvpe(mysql) failed` しか返らず、
    接続の失敗と区別できない（実測）。挟めば `sh` が 127 を返す。値は `"$@"` で渡るので `sh` は読み直さない
  - ホスト（Windows / macOS）は直に起こし、無ければ spawn が `NotFound` で失敗する
- **1 回のコマンドの中では接続を使い回す**（`Session`）。テーブル名の確認と本番のクエリで 2 回流すので、
  コンテナの inspect と、どのクライアントがあるかの解決（下の `--version` の検査）は最初の 1 回だけにする。
  コマンドをまたいでは覚えない（Rust はステートレスに保つ）
- コンテナの exec の出力をファイルへ書く書き出しは、同期の I/O を `block_in_place` で async のワーカーから
  逃がす（`Sink::BLOCKING`）
- **クライアントが無ければ「`mysql` が見つからない」と出して止まる**（rg と同じく外部依存は明示する）。
  Rust は `db-client-not-found:mysql,mariadb` の形で返し、フロント（`missingClients`）が文言にする

## 発行する SQL は `sql.rs` の固定のものだけ

DB の一覧・テーブルの一覧・スキーマ・中身の 4 種類。**外から入る文字列はテーブル名だけ**で、

- **一覧に有るものだけを受ける**（`ensure_table`。実行のたびにテーブルの一覧を取り直して確かめる）。
  往復が 1 回増えるが、引用に漏れがあっても届く名前が無い形にしておく
- 識別子は MySQL がバッククォート、PostgreSQL が二重引用符で、中の引用符は二重化する（`quote_ident`）
- スキーマの問い合わせに要る文字列リテラルは、**MySQL は `_utf8mb4 X'..'`**（16 進。`NO_BACKSLASH_ESCAPES`
  に左右されず、どんな文字列も引用を破れない。`CONVERT(... USING)` にしないのは照合順序の強さが変わり、
  information_schema の列と比べたときに照合順序の混在で落ちうるため）、**PostgreSQL は `E'...'`**（`\` と `'`
  を二重化。`E` を付ければ `standard_conforming_strings` に依らない）
- PostgreSQL の一覧とスキーマは `current_schema()` のものだけ。**中身は一覧が返したスキーマで修飾する**
  （`"public"."t"`。修飾しないと search_path で解決され、暗黙に先に探される `pg_catalog` と `pg_temp` に
  同じ名前があると、一覧で確かめたのとは別のテーブルを読む）。MySQL は今の DB の中でしか探さないので修飾しない
- 値は argv の 1 語ずつで渡す（`--user=...` の形。`-` で始まる値を別のオプションと読ませない）。シェルを
  挟まない（WSL の `sh` も `"$@"` で受けるだけ）ので、値の中身による注入は起きない

## パスワード

- **引数に載せない**（`ps` で見える）。`MYSQL_PWD` / `PGPASSWORD` の環境変数で渡す。WSL へは
  `ShellConfig::command_env` が `WSLENV` を足して届ける。コンテナは exec の `env`
  - `MYSQL_PWD` は MySQL 8.0 で非推奨と告知されているが、8.x と MariaDB の `mariadb` では動く（実測）。
    消えたら `--defaults-extra-file` に一時ファイルを渡す形に替える
- **コンテナのパスワードはフロントへ返さない。** `db_container_defaults` が返すのはユーザー名・DB 名・
  パスワードの有無だけで、実行のたびに Rust が inspect して環境変数から読む。ユーザー名を変えたら
  既定のパスワードは渡さない（別のユーザーのパスワードなので）
- 環境変数の既定の読み方（`container_defaults`）: MySQL はアプリ用のユーザー（`MYSQL_USER` / `MARIADB_USER`）が
  あればそれ、無ければ root（root のパスワードが乱数のこともある）。PostgreSQL は `POSTGRES_USER`（既定
  `postgres`）と `POSTGRES_DB`（既定はユーザー名。公式イメージの規則）
- psql は `-w`（聞かない）、mysql は `-p` を付けない。標準入力は閉じてあるので、聞かれても待たずに失敗で返る

## 出力の読み方（`RecordReader`）

- **MySQL は `mysql --batch`（`--raw` は付けない）**。タブ区切り・1 行目が見出しで、値の中のタブ・改行・
  `\`・NUL は `\t` / `\n` / `\\` / `\0` に置き換わる（実測）。`--raw` を付けると値の中の改行で行が割れる
  - **NULL は `NULL` と出るので、文字列の `'NULL'` と区別できない**（実測）。`--xml` なら区別できるが、
    XML を読むことになるので採っていない。既知の制約としてマニュアルに書いた
  - `--default-character-set=utf8mb4` を必ず付ける（付けないと古いクライアントの既定で読み、日本語が化ける）
  - `--quick` を付ける（付けないとクライアントが結果を全部メモリに持ってから出すので、書き出しが流れない）
  - **行が 0 件だと見出しも出ない。** 空のテーブルの列名はスキーマの問い合わせから補う（`Session::column_names`）
- **どちらも空の行を捨てない。** 1 列のテーブルでは、MySQL の空文字と PostgreSQL の NULL が空の行で出る
- **PostgreSQL は全部 `COPY (SELECT ...) TO STDOUT WITH (FORMAT csv, HEADER, FORCE_QUOTE *)`**。
  `FORCE_QUOTE *` で NULL 以外が必ず引用符に囲まれるので、**NULL（引用符の無い空）と空文字（`""`）が
  区別できる**（実測）。psql の非整列出力（`-A -F`）は値の中のタブ・改行を区別できないので使わない。
  引用符の中の改行は値の一部なので、CSV の状態は行をまたいで持つ
- **出力は任意の塊で届く**（コンテナの exec）。改行のバイトで切ってから文字列にする（改行は UTF-8 の
  多バイト文字の途中に現れない）
- **コンテナはクライアントの有無を先に `--version` で確かめる。** 無いクライアントを exec すると
  `OCI runtime exec failed: ... executable file not found` が **stdout に**届き（実測）、そのまま読むと
  エラー文が見出しになり、書き出しならファイルに入る。終了コードは 126 / 127
- **MariaDB 11 の公式イメージには `mysql` が無く `mariadb` だけ**（実測）。MySQL は `mysql` → `mariadb` の順に試す

## 表示と書き出し

- **表はエディタの CSV プレビューの部品を使う**（`composables/useCsvTable.ts` と `assets/csvTable.css`。
  `preview.md` の CSV の節）。ページ送り・表示件数・並べ替え・列と行の選択とコピーは DB 側にコードを
  持たない。結果は `dbResultToCsv` がタブ区切りの行に戻して渡す
- **結果はセルに分けたまま表に渡す**（`lib/csvPreview.ts` の `CsvRow` の `cells`）。タブ区切りの 1 行に
  戻して `splitDelimited` で分け直す往復はしない。**NULL は `null` のセル**で、文字列の印（番兵）にしない。
  描くときは `csv-null` の class の空のセル（`NULL` の文字は CSS の `::after` で描くので、文字選択の
  コピーに入らない）、並べ替えでは空と同じく末尾、選択のコピーでは空の欄
- **中身は先頭 `ROW_LIMIT`（2,000）行だけを読む**（SQL で 1 行多く取り、超えたら `truncated` で帯を出す）。
  値は表示用に `CELL_MAX_CHARS`（1,000 文字）で切る（巨大な TEXT / BLOB で表が重くならないように）
- **BLOB はバイト列のまま**来る。MySQL は UTF-8 として読めないバイトが置換文字になり、PostgreSQL の `bytea`
  は `\x...` の 16 進で来る。表示を作り込まない
- **「保存」はテーブル全体を書き出す**（`db_dump`。上限で切らない）。Rust がクライアントの出力を読みながら
  ファイルへ書き、**フロントを経由させない**。待つのは `DUMP_TIMEOUT`（10 分）で、表示の 30 秒
  （`DEFAULT_TIMEOUT`）とは分けてある。スキーマの保存は表示している表をそのまま書く。
  **書き出しは同じディレクトリの一時ファイルへ書き、終わってから保存先を rename で置き換える**
  （`finish_temp`）。保存先へ直に書くと開いた時点で切り詰めるので、既存のファイルを選んで途中で
  落ちると前の中身が消える。失敗したら一時ファイルだけを消す
  - **コンテナの exec は、待ち切れなくてもコンテナの中では止まらない**（既知の制約）。bollard の exec を
    外から止める API は無く、`inspect_exec` の pid はホストの名前空間のもので、Windows の Pike からは止めら
    れない。シェルの経路は `wait_with_timeout` がプロセスごと止める
- CSV / TSV の規則は書き出し（`sql::format_record`）とコピー（`formatDbResult`）で同じ: **NULL は空の欄で、
  CSV では空文字を `""` にして区別する**（PostgreSQL の `COPY ... CSV` と同じ）。区切り・引用符・改行を含む値は
  `"` で囲み、中の `"` を二重化する。MySQL の BLOB の生のバイト（NUL を含む）はそのまま書かれる

## 入口と接続先の決め方

- **入口は 2 つ**: Docker パネルの DB コンテナの行の「DB を見る」と、パレットの `openDbViewer`。
  サイドバーのパネルは足していない（この 2 つで足りている）
- DB のコンテナかは**イメージ名で決める**（`dbEngineOfImage`。リポジトリ名の最後の部分に `mysql` /
  `mariadb` / `percona` / `postgres` / `postgis` / `timescaledb` / `pgvector`）。タブの接続先の一覧は
  compose に属さないコンテナも出す（`dockerStore.containers` 全体から選ぶ）
- ローカル / WSL はホスト・ポート・ユーザー・DB 名を入れる。「`.env` から読む」でプロジェクトのルートの
  `.env` の `*DATABASE_URL` / `DB_URL` と Laravel の `DB_*` を候補にする（押したときだけ読む）
- macOS はホストのシェルで直に起こす。Homebrew の `/opt/homebrew/bin` は `augment_process_path` が PATH に
  足すが、keg-only の `libpq` / `mysql-client` は PATH に無いので「見つからない」になる。**macOS の実機では
  確かめていない**
