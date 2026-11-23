---
paths:
  - "src-tauri/src/db/**"
  - "src/components/tabs/DbTab.vue"
  - "src/components/tabs/RedisTab.vue"
  - "src/components/panels/DbPanel.vue"
  - "src/components/DbConnectDialog.vue"
  - "src/stores/db.ts"
  - "src/lib/dbViewer.ts"
  - "src/types/db.ts"
  - "src/composables/useCsvTable.ts"
  - "src/assets/csvTable.css"
---

# 簡易 DB ビューワ（#632）実装ルール

MySQL / PostgreSQL のテーブルの一覧・レコード・スキーマを表で見て、CSV / TSV でコピー・保存する。
入力した SQL も実行する（#646。下の「入力した SQL」）。Redis のキーと値も見る（#647。下の「Redis」）。
接続先はローカル（ホスト）・WSL・Docker コンテナだけ。実体は `src-tauri/src/db/`（`mod.rs` が
実行、`sql.rs` が SQL と出力の読み方、`redis.rs` が Redis）、`src/components/tabs/DbTab.vue` と
`RedisTab.vue`、`src/lib/dbViewer.ts`。
UI の「レコード」はコードでは `rows`（`db_rows` / `view === 'rows'`）のまま。

## やらないこと（広げるときは issue から）

- **テーブルの一覧・スキーマ・レコードのクエリに、入力した文字列を混ぜない**（下の「発行する SQL」）。
  入力した SQL は `db_execute` の 1 つの口だけが受ける
- 入力した SQL の実行の中止、書き込み系の文の確認ダイアログ、全件の書き出し（SQL の結果の保存は表示した行だけ）
- Redis への書き込み（`SET` / `DEL` / `EXPIRE` など）と、任意のコマンドの実行。Redis は読むだけ（下の「Redis」）
- SSH 踏み台・リモートホスト（musql の領分）、MySQL / PostgreSQL / Redis 以外（SQLite など）。Redis の TLS（`rediss://`）
- 接続情報の管理画面（保存した接続はパネルの行から消せるだけ。下の「接続の保存」）。**パスワードは保存
  しない**（localStorage・セッション・設定のどれにも書かない）。DB のタブはセッションにも残さない
  （`snapshotSession` の対象外のまま）

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

## 一覧・スキーマ・レコードで発行する SQL は `sql.rs` の固定のものだけ

DB の一覧・テーブルの一覧・スキーマ・レコードの 4 種類。**外から入る文字列はテーブル名だけ**で、

- **一覧に有るものだけを受ける**（`ensure_table`。実行のたびにテーブルの一覧を取り直して確かめる）。
  往復が 1 回増えるが、引用に漏れがあっても届く名前が無い形にしておく
- 識別子は MySQL がバッククォート、PostgreSQL が二重引用符で、中の引用符は二重化する（`quote_ident`）
- スキーマの問い合わせに要る文字列リテラルは、**MySQL は `_utf8mb4 X'..'`**（16 進。`NO_BACKSLASH_ESCAPES`
  に左右されず、どんな文字列も引用を破れない。`CONVERT(... USING)` にしないのは照合順序の強さが変わり、
  information_schema の列と比べたときに照合順序の混在で落ちうるため）、**PostgreSQL は `E'...'`**（`\` と `'`
  を二重化。`E` を付ければ `standard_conforming_strings` に依らない）
- PostgreSQL の一覧とスキーマは `current_schema()` のものだけ。**レコードは一覧が返したスキーマで修飾する**
  （`"public"."t"`。修飾しないと search_path で解決され、暗黙に先に探される `pg_catalog` と `pg_temp` に
  同じ名前があると、一覧で確かめたのとは別のテーブルを読む）。MySQL は今の DB の中でしか探さないので修飾しない
- 値は argv の 1 語ずつで渡す（`--user=...` の形。`-` で始まる値を別のオプションと読ませない）。シェルを
  挟まない（WSL の `sh` も `"$@"` で受けるだけ）ので、値の中身による注入は起きない

## 入力した SQL（#646）

DB タブの「SQL」で入力した SQL を、**加工せずに標準入力で**クライアントへ渡す（`db_execute`、`sql::SqlInput::Stdin`）。
DDL も書き込みも受け、確認は挟まない（issue の方針。権限は接続したユーザーのもの）。SQL の中身がシェルに読まれることは
無い（シェルを挟まないか、挟むコンテナの `sh` も変数を展開して渡すだけ）。

- **標準入力で渡す理由は 2 つ**（`SqlInput::Stdin` の doc が正本）。psql の `--command` に複数の文を渡すと 1 回の
  問い合わせになり、サーバーは 1 つの暗黙のトランザクションで実行する。途中で失敗すると前の文も取り消されるのに、
  ログには前の文の結果が残る（実測。`CREATE TABLE` と `INSERT` のあとの失敗で、テーブルごと無くなる）。標準入力
  （`--file=-`）なら psql が文ごとに送るので文ごとに確定し、エラーに `psql:<stdin>:4:` と行も付く。もう 1 つは引数の
  長さの上限（Linux は 1 語 128 KiB、Windows はコマンドライン全体で 32,767 文字）。MySQL は標準入力でも `--batch` と
  `--table -vv` の出力の形が変わらない（実測）
  - シェルの経路はパイプで書く（`ShellIo`。書き込みは別のスレッドで、出力を読みながら）
  - **コンテナの経路は、SQL を exec の環境変数（`STDIN_ENV`）で渡し、コンテナの `sh` で流し込む**
    （`printf '%s' "$PIKE_SQL_0" "$PIKE_SQL_1" | exec "$0" "$@"`）。bollard の exec に `attach_stdin` で書いて書き込み側を
    閉じると、接続ごと閉じて出力も終了コードも取れない（実測。終了コードが -1 のまま返る）。コンテナに `sh` が要る
  - 環境変数は 1 つ 128 KiB まで、引数と合わせて全体で 2 MiB ほどまで（execve。超えると exec が起動せず、終了コード
    126 で「クライアントが無い」に見える）。`STDIN_CHUNK`（64 KiB）ずつの変数に分け、全体は `CONTAINER_SQL_MAX`
    （1 MiB）までにして、超えたら起こす前に `db-sql-too-long:` で断る（200 KiB の SQL が通ることを実測）
- **クライアントのコマンドを含む SQL は実行しない**（`sql::client_command`、`db-client-command:`）。psql の `\! id` と
  MySQL の `\! id` / 文の頭の `system id` は、クライアントを起こした環境（ホスト・WSL・コンテナ）の OS のコマンドを走らせる
  （どれも実測。`-X` は起動時のファイルを読まないだけで、これは止めない）。DB の権限の外で動くので、SQL の欄からは断る
  - 文字列・引用した識別子・コメントの外の `\` は全部断る（どちらのクライアントでもコマンドの始まり）
  - MySQL の名前の付いたコマンドは、OS やファイルに触る `MYSQL_CLIENT_COMMANDS`（`system` / `source` / `tee` /
    `pager` / `edit`）を、文の頭のものだけ断る（クライアントは読みかけの文を持たないときだけコマンドと見なす。
    文の途中の行頭の `source` は列名なので通す）
  - **字句での検出は理由を見せるための補助で、守りはクライアントの側に置く**（`sql::client_command` の doc）。
    **字句だけで守る形に戻さないこと。** Copilot のレビューで、どちらのクライアントにも字句をすり抜ける例が出た。
    psql は `COPY ... FROM STDIN` のデータの中（`\.` でデータを終えたあとの `\!`）と、
    `SET standard_conforming_strings = off` で `\'` を逃がしに変えた文字列の陰。MySQL は `sql_mode`
    （`NO_BACKSLASH_ESCAPES` / `ANSI_QUOTES`）と実行されるコメント（`/*! \! id */`）
  - **psql はスクリプトの先頭で `\restrict <鍵>` する**（`sql::restricted_script`。鍵は実行ごとの乱数）。以後は
    `\unrestrict <鍵>` 以外の `\` のコマンドが `backslash commands are restricted` で失敗し、`ON_ERROR_STOP=1` で止まる。
    上の迂回の例が、無しでは OS のコマンドを動かし、有りでは止まることを psql 18 で実測した。ふつうのスクリプトと
    `COPY ... TO STDOUT` はそのまま動く。足した 1 行ぶん、エラーの `psql:<stdin>:N:` を戻す（`unshift_stdin_lines`）
    - `\restrict` は 2025-08 の修正版（18 / 17.6 / 16.10 / 15.14 / 14.19 / 13.22）から。古い psql は 1 行目で
      `invalid command \restrict` になり、何も実行しない（守りの無いまま流さない）。そのときは
      `db-psql-no-restrict` で更新を促す（`restrict_unsupported`）。**見分けるのは `psql:<stdin>:1:` の行だけ**
      （利用者の文字列の `\restrict` がサーバーのエラーの `LINE 1:` や `Failing row contains` に写るので、綴りだけで
      見ると本当のエラーを隠す）
  - エラーの行番号（`user_sql_error`）。ログの形は `psql:<stdin>:N:` を、足した 1 行ぶん戻して入力した SQL の行にする。
    表の形は `psql:<stdin>:N:`（包んだ文の終わりの行）を外し、文の最初の行を `COPY (` と同じ行に置いて、`LINE n:` を
    文の中の行番号（文の 1 行目が 1）にする（`plan_user_sql`）。先頭で落としたコメントや空の行のぶんは数に残せない:
    psql は空白だけの行を送らないので、改行を足しても `LINE n:` は変わらない（実測）
  - 成功しても psql が stderr に出す NOTICE / WARNING は、ログの後ろに添える（`Outcome::Done` が stderr を持ち帰る。
    `DROP TABLE IF EXISTS` の `skipping` など。捨てるとテーブルが無かったことが分からない）
  - **MySQL は標準入力から読むときに `--binary-mode` を付ける**（`client_args`）。`charset` と `delimiter` 以外の
    クライアントのコマンドを止める（`\!` は `Unknown command`、`system` はサーバーへ送られて構文エラー。上の迂回の例も
    含めて mariadb 11.8 で実測）。MySQL 5.6.3 からある
  - **MySQL は `--local-infile=0` も付ける。** `--binary-mode` は `LOAD DATA LOCAL INFILE` を止めない。LOCAL を許す
    サーバーでは、DB の FILE 権限なしにクライアントの環境のファイルを読んで送れる（Copilot のレビュー）。クライアントの
    側で切れば、サーバーの設定に依らず読まない
  - MariaDB の `--sandbox` も同じことをするが、MySQL と古い MariaDB のクライアントには無い（知らないオプションで
    起動しない）ので使わない
  - **コンテナに `sh` が無いと SQL を渡せない**（`db-container-sh-not-found`）。`sh` を挟んだ exec の 126 / 127 は
    「クライアントが無い」にしない（クライアントは `--version` で確かめてあり、一覧とレコードは見られるのに SQL だけ
    失敗する理由が分からなくなる）
  - 実行の前に断ったとき（クライアントのコマンド、長すぎる SQL、空の SQL＝`db-sql-empty`、古い psql、`sh` の無い
    コンテナ）はテーブルの一覧を読み直さない（`rejectedBeforeRun`）
  - **stderr は先頭と末尾を残す**（`StderrKeep`。上限は `STDERR_KEEP_MAX`）。成功時の NOTICE も stderr から拾うので、
    先頭だけを残す `types::drain_stderr` だと、NOTICE が上限を埋めたあとに出る肝心の ERROR が消える

- **流し方は `sql::plan_user_sql` が決める。** 結果を返す文が 1 つだけ（MySQL は `SELECT` / `WITH` / `VALUES` /
  `TABLE` / `SHOW` / `DESCRIBE` / `DESC` / `EXPLAIN`、PostgreSQL は `SELECT` / `WITH` / `VALUES` / `TABLE`）なら
  表（`UserSql::Query`）、それ以外はクライアントの人向けの出力（`UserSql::Script`、`OutputMode::Log`）
  - **表にするのは 1 文だけ。** MySQL の `--batch` は複数の結果を見出しの区切り無しに続けて出し、PostgreSQL の
    `COPY` は 1 文しか包めない（`COPY (SELECT 1; SELECT 2)` は構文エラー。実測）
  - 文の数と最初の語は `sql_shape` が字句で数える（文字列・引用した識別子・コメント・PostgreSQL のドル引用を
    飛ばす）。**構文は解析しない**。読み違えると流し方が変わる（包んだ文がエラーで返る）。送る SQL から落とすのは
    前後の空白・コメント・`;` だけ
  - **MySQL の実行されるコメント（`/*! ... */`、MariaDB の `/*M! ... */`）は中身として数える。** 落とすと
    `SELECT * FROM t /*!50000 WHERE id = 1 */` の WHERE が消える（実測）
  - MySQL の `--` は後ろに空白か制御文字が要る（`1--1` は引き算）。`#` も行末までのコメント
  - **閉じていないブロックコメントは中身として残す**（`block_comment_end` が `None`）。落とすと、構文エラーになる
    はずの `SELECT nextval('seq') /* unfinished` が `COPY (SELECT nextval('seq'))` として実行される
  - PostgreSQL のブロックコメントは入れ子になる（`block_comment_end`）。`E'...'` の `E` と、ドル引用の `$` は、
    識別子の続き（`LIKE'..'` の `E`、`a$b$`）なら接頭辞と見なさない（`is_ident_byte`）
  - 表にするときは前後の `;` とコメントを落とし（`body_start..body_end`。先頭の空の文は MySQL が
    `No query specified` で拒む）、PostgreSQL は前後に改行を挟んで `COPY (...)` で包む（行末の `--` のコメントが
    閉じ括弧を隠さないように）
  - **MySQL の最初の文が、括弧の外に `UPDATE` / `DELETE` / `INSERT` / `REPLACE` / `INTO` を持てばログの形にする**
    （`SqlShape::writes`。`WITH ... UPDATE` と `SELECT ... INTO @v` は先頭の語が問い合わせでも結果の表を返さず、表の形では
    件数が出ない）。直後が `(` の語は関数の呼び出し（`REPLACE(s, ...)`）なので、直前が `FOR` の `UPDATE` は
    行のロック（`SELECT ... FOR UPDATE`。行を返す）なので数えない。流したあとで空の結果を見て
    切り替える形にしないこと（書き込みが 2 回走る）
  - それでも結果の表が無ければ「返った行はありません」と出す（行数の 0 とは言わない）
- **PostgreSQL は `COPY` が拒む文がある**（`WITH ... UPDATE` で `RETURNING` が無いもの＝`COPY query must have a
  RETURNING clause`、`SELECT ... INTO`＝`COPY (SELECT INTO) is not supported`。どちらも実測）。拒むのは解析の段階で
  文は実行されていないので、`copy_rejected` を見てログの形で流し直す
  - **見分けるのは SQLSTATE（`0A000`）と出どころの関数名（`BeginCopyTo`）で、本文は照合しない。** 本文はサーバーの
    `lc_messages` で翻訳される。どちらも psql の `-v VERBOSITY=verbose`（`client_args`）が付ける（`ERROR:  0A000: ...` と
    `LOCATION:  BeginCopyTo, copyto.c:792`。実測）。`LOCATION:` の行は見せる前に `tidy_error` が落とす（見出しの語も
    翻訳されるので、`関数名, ファイル.c:行` の形で見分ける）
- **ログの形（`OutputMode::Log`）**: MySQL は `--batch --table -vv`。文ごとに文そのもの・枠付きの表・
  `Query OK, N rows affected` を出し、最後に `Bye` の行を出す（`LogSink::into_text` が MySQL のときだけ、ちょうど
  `Bye` の最後の行を落とす。mariadb 11.8 で実測）。PostgreSQL は `-q` を外す。`-q` だと `UPDATE 2` / `CREATE TABLE`
  のコマンドの結果が出ない（postgres 18 で実測）
  - 1 行を 1 つの値のレコードとして読み（`RecordReader` の `OutputMode::Log`）、`LOG_MAX_BYTES`（1MB）で切る。
    入り切らない行は入るぶんだけ（文字の途中で切らずに）残す（捨てると、最初の行が長いだけでログが空になる）
  - **改行の来ていない 1 行も `LOG_LINE_CAP` までしか溜めない**（`RecordReader::append_pending`。超えたぶんは読み捨て、
    出力は最後まで読む）。`LOG_LINE_CAP` は `LOG_MAX_BYTES` より 4 バイト大きい: 切ったあと文字の境界まで最大 3 バイト
    戻すので、同じ値だと残る行が上限より短くなり、`LogSink` が `truncated` を立てない（Copilot のレビュー）。
    上限が `LogSink` だけだと、改行が来るまで 1 行を丸ごと持つ（`repeat('x', 268435456)` の 1 行で 256 MiB）。**表の形の行は切らない**（PostgreSQL の CSV は引用符の中の行が崩れ、書き出しは値を丸ごと要る）
  - **エラーのときは、それまでのログを前に付けて返す**（`Outcome::Failed` が sink を持ち帰る）。複数の文は失敗した
    文の前まで実行されて確定している（MySQL は `--force` を付けないので止まる、PostgreSQL は `ON_ERROR_STOP=1`）
- **表は `ROW_LIMIT` 行まで持つ**（`Collect` の `limit`。SQL に `LIMIT` を足せないので、超えた行は読み捨てる）。
  値の切り詰め（`CELL_MAX_CHARS`）はレコードと同じ。保存は表示している行だけ（全件の書き出しは持たない）
- 待つのは `EXEC_TIMEOUT`（書き出しと同じ 10 分）。中止はできない。コンテナの exec は待ち切れても中で走り続ける
  （書き出しと同じ既知の制約）
- ログの形で流したあとは、**同じ `Session` でテーブルの一覧を読み直して結果に添える**（`DbExec::Log` の `tables`。
  DDL で増減するので。別のコマンドで `db_probe` を流し直すと、inspect とクライアントの解決と 3 回の問い合わせが
  余分にかかる）。エラーのときは一覧が添わないので、フロントが `db_probe` で読み直す（`DbTab.vue` の `refreshTables`）。
  選んでいたテーブルが一覧から消えたら選択を外す（`setTables`）。読み直しを待つあいだに次の実行が始まったら、届いた
  一覧は捨てる（`execSeq`。次の実行が添える新しい一覧を古い一覧で上書きしない）。接続先が変わったら SQL の結果は
  捨て、入力は残す
- 範囲を選んでいれば、その部分だけを実行する。**選択の有無は範囲（`selectionStart` と `selectionEnd`）で決める**。
  中身で決めると、空白だけを選んだときに全体へ戻り、選んでいない文まで実行する（空白だけの選択は何もしない）。
  キーは `Mod+Enter`（`matchChord`。`KeyboardShortcuts.vue` とマニュアルの DB ビューワの節）

## Redis（#647）

キーの一覧と、型に合わせた値を見る。**読むだけで、書き込むコマンドも任意のコマンドも送らない。**
実体は `src-tauri/src/db/redis.rs` と `src/components/tabs/RedisTab.vue`。

- **ドライバのクレートは入れず、接続先の環境にある `redis-cli`（無ければ `valkey-cli`）を起こす。** 経路（コンテナの
  exec・シェル）とクライアントの解決は SQL の DB と同じ `Route::run`（`ClientCall`）を通す。経路ごとの事情（WSL の `sh`、
  コンテナの `--version` の確認、標準入力を環境変数で流し込む形）は上の節のまま当てはまる
- **SQL の `Engine` に `Redis` を足さない。** フロントの `DbEngine` は `'redis'` を持つ（パネルの候補・接続のダイアログ・
  保存した接続・`.env` をそのまま使い回すため）が、Rust の `sql::Engine` は SQL の DB だけで、Redis は別のコマンド
  （`redis_probe` / `redis_keys` / `redis_value` / `redis_container_defaults`）を通る。足すと `sql.rs` の分岐が
  全部 Redis の腕を要求する。接続先は `DbTarget` と同じ形の `RedisTarget`（`engine` は読まない）
- **タブの種別は `db` のまま、中身だけ替える**（`TabPane.vue` の `componentOf`）。接続・同じ接続先を前に出す・
  「接続先を変える」・DB の切り替えは SQL の DB と同じ `dbStore.open` を通る。「接続先を変える」で種類が変わりうるので、
  `v-memo` の鍵にも `componentOf` の答えを入れてある。つないだときに読んだものは `takeRedisPrefetched` で受ける
- **出力は `redis-cli -2 --quoted-json`**（7.0 から）。応答が 1 行に 1 つの JSON で届く（実測）
  - **RESP2（`-2`）で話す。** RESP3 だと zset の score を double のまま出すので、`-inf` / `inf` が JSON として読めない
    （`[["a",-inf]]`。実測）。RESP2 では文字列で届き、ほかのコマンドの形は変わらない（実測）
  - **`--json` ではなく `--quoted-json`。** `--json` は UTF-8 でないバイトを生のまま行に入れ（実測）、行を文字列にした
    時点で置換文字に化けて元のバイトが失われる（値は文字化けし、バイナリのキーは引き直せない）。`--quoted-json` は
    文字列を redis-cli の表記（`a\xff\x01\n\xe3\x81\x82`。日本語も `\xHH`）で返すので、`unquote` でバイト列に戻す
  - **エラーは終了コード 0 のまま `error:"..."` の行で届く**（実測。認証の失敗も `NOAUTH` の行）。行ごとに見る
    （`parse_reply`）
  - `INFO` は `--json` でも生の行で届き、**エラーも `error:` の印の無い生の行**（`NOAUTH Authentication required.`）で
    届く（どちらも実測）。`INFO keyspace` は別に呼んで行として読み、見出しと `dbN:` 以外の行をエラーにする（`keyspace_reply`）
  - 接続を確かめる `PING` は送らない。`redis_probe` は先にキーの一覧（`SCAN`）を読み、そこで接続と認証の失敗を返す
  - **DB の一覧（`INFO keyspace`）が読めなくても止めない。** `INFO` は ACL の `@dangerous` に入るので、`-@dangerous` の
    ユーザーは `NOPERM` になる（実測）が、キーは読める。そのときは今の DB だけを選択欄に出す
  - 1 行が 1 つの JSON なので、切った行は読めない。1 行も全体も `OUTPUT_MAX_BYTES`（64 MiB）までにして、超えたら
    溢れのエラーにする（`RecordReader::lines(LINE_CAP)`）。要素の数は問い合わせで絞る（下）が、list の要素の 1 つが
    大きければ 1 行は大きくなる
  - **標準入力で送ると、つながらなくても終了コードは 0 のまま、出力が空で stderr にだけ `Could not connect ...` が出る**
    （実測）。出力が空で stderr があれば、それをエラーにする（`lines`）。失敗して stderr が空なら stdout の `error:` の行を使う
  - `-2` か `--quoted-json` を知らない古い `redis-cli` は `db-redis-cli-no-json` で更新を促す（`client_error`）。
    見るのは `Unrecognized option or bad number of args for: '--quoted-json'` の形だけ（`-json` の綴りだけで見ると、
    ホスト名に `-json` を含む接続先の接続のエラーまで古いと言う）
- **バイナリは musql と同じ規則で見せる**（`as_text` / `escape`）。UTF-8 として読めて制御文字を含まなければ文字のまま
  （値は改行とタブも許す）。そうでなければ `\` `"` 改行などと、制御文字・UTF-8 でないバイトだけを redis-cli の表記
  （`\\` `\"` `\n` `\xHH`）にし、日本語などの読める文字は残す。string の値には「バイナリ」の帯を出す（`RedisValue::binary`）。
  表のセル（hash の値など）も同じ規則で書く。画像のプレビューは持たない（musql は持つ）
  - **キー名はバイト列で持つ。** キー名は一覧の 1 行なので改行やタブもバイナリとして表記にし、バイト列を 16 進で
    フロントへ渡す（`RedisKey::raw`）。値はそのバイト列で引く（`key_bytes`）。表記からは引き直せない（文字どおり
    `a\xff` という名前のキーと区別できない）ので、フロントの同一性も `raw` で見る（`RedisTab.vue` の `keyId`）
  - `GETRANGE` で切った値の末尾の割れた文字は落とす（`trim_cut_character`。表記の末尾が `\xHH` にならないように）
- **パスワードは `REDISCLI_AUTH` の環境変数で渡す**（引数の `-a` に載せない。`--no-auth-warning` で注意書きを消す）。
  コンテナの既定は `REDIS_PASSWORD`（Bitnami）と `VALKEY_PASSWORD`。公式イメージは環境変数に持たない
  （`--requirepass` を起動の引数で渡す）ので、押すと認証に失敗して接続のダイアログが出る
- **キーとパターンの渡し方**: 1 つのコマンドは argv の 1 語ずつ（`call`）。いくつかをまとめるときは標準入力の 1 行ずつで、
  **全部のバイトを `"\xHH"` で逃がす**（`quote_arg`。`redis-cli` の行の読み方は `\xHH` を戻す。空白・引用符・改行を
  含むキーで実測）。どちらもキーの中身でコマンドが変わることはない。**キーは必ず標準入力で渡す**（argv は文字列
  なので、バイナリのキーを載せられない。argv で渡すのはパターンと `SCAN` の cursor だけ）
- **キーの一覧は `SCAN ... MATCH pattern COUNT 1000` を回す**（`keys`）。`KEY_LIMIT`（5,000 件）か `SCAN_CALLS_MAX`
  （50 回）で止めて `truncated`（パターンに合うキーが少ない大きな DB では、1 回の `SCAN` がほとんど返さないまま全体を
  歩くので、回数でも止める）。型は `TYPE` を標準入力でまとめて引く。`KEYS` は使わない（サーバーを止める）
  - **まとめて送る標準入力は `BATCH_MAX_BYTES`（512 KiB）ずつに分ける**（`batch_scripts`）。コンテナの経路は標準入力を
    環境変数で渡すので `CONTAINER_SQL_MAX`（1 MiB）までで、`quote_arg` で 1 バイトが 4 バイトになる。5,000 件の
    長いキー（Laravel のキャッシュなど）の `TYPE` は 1 回では届かない。1 行で上限を超える長いキー（約 128 KiB 超）は
    型を引かずに空のまま出す（そのキー 1 つで一覧ごと読めなくならないように）
- **値は型ごとに先頭だけを読む**（`redis_value`。`TYPE` と `TTL` を 1 回、長さと中身を 1 回）。string は
  `GETRANGE` で `STRING_MAX_BYTES`（256 KiB）、list は `LRANGE`、zset は `ZRANGE ... WITHSCORES`、stream は
  `XRANGE ... COUNT` で `ROW_LIMIT`（2,000）まで。hash と set は `HSCAN` / `SSCAN` を 1 回（`COUNT` は目安なので
  前後した数を返す。cursor が 0 でなければ `truncated`）。`HGETALL` / `SMEMBERS` は全件を返すので使わない
  - `COUNT` は目安なので、小さい hash や set（listpack / intset）は 1 回で全部が返り、`ROW_LIMIT` を超えうる。見せるのは
    `ROW_LIMIT` 行までで、超えたぶんは切って `truncated`（`shape_value`）
  - zset は RESP2 の平らな `[member, score, ...]` で来る（`shape_value`）
  - string の `truncated` は長さ（`STRLEN`）が `STRING_MAX_BYTES` を超えたかで決める。読んだ文字の長さと比べると、
    `GETRANGE` が文字の途中で切ったぶんや UTF-8 でないバイトが置換文字（3 バイト）に化けて長くなり、切ったのに気付けない
  - モジュールの型（`ReJSON-RL` など）は種類だけを見せる
- 表は SQL の DB と同じ CSV プレビューの部品。コピーと保存は表示している値だけ（string は本文、ほかは CSV / TSV）
- 入口は SQL の DB と同じ DB パネル。コンテナはイメージ名で選ぶ。**リポジトリ名の全体で当てる**（`redis` / `valkey` /
  `keydb` と、その `-stack` / `-stack-server` / `-cluster`）。部分一致だと `redisinsight` や `redis_exporter` のような
  道具も拾い、押すと `redis-cli` が無いと出る。`.env` は名前が `REDIS_URL` で終わるものと Laravel の `REDIS_HOST` /
  `REDIS_PORT` / `REDIS_USERNAME` / `REDIS_PASSWORD` / `REDIS_DB`（**Laravel の `env()` は文字の `null` / `(null)` を
  null に読む**。既定の `.env` は `REDIS_PASSWORD=null`。どの欄も空として読む）。TLS の `rediss://` は読まない
- DB は番号で選ぶ（接続のダイアログの欄は「DB 番号」、空なら 0）。**数でない値を 0 に読み替えない**
  （`db-redis-bad-database:`。読み替えると、別の DB を見ていると気付けない）

## パスワード

- **引数に載せない**（`ps` で見える）。`MYSQL_PWD` / `PGPASSWORD`（Redis は `REDISCLI_AUTH`）の環境変数で渡す。WSL へは
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
- **レコードは先頭 `ROW_LIMIT`（2,000）行だけを読む**（SQL で 1 行多く取り、超えたら `truncated` で帯を出す）。
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

- **入口は DB パネル**（`components/panels/DbPanel.vue`。パレットの `panelDb` でも開く）。並べるのは
  動いている DB のコンテナ・保存した接続・`.env` の候補で、末尾に「新しい接続…」。Docker パネルの DB
  コンテナの行の「DB を見る」も残してあり、パネルの行と同じ `dbStore.open` を呼ぶ
- **候補の組み立ては `lib/dbViewer.ts` の `buildDbCandidates` 1 つ**（`stores/db.ts` の `candidates`）。
  パネルとダイアログは同じものを読み、別々に一覧を組まない。`.env` の候補と同じ接続先の保存した接続は
  1 行にまとめ、その行に `.env` のパスワードを持たせる（押せばそのままつながる。保存はしない）
- **同じ接続先の DB タブが既にあれば、前に出すだけ**（`tabStore.focusDbTab`。つなぎ直さない）。そのタブには
  入れたパスワードや切り替えた DB が残っているので、行の接続先（パスワードを持たない）で差し替えると消える
- **押したら、まずつないでみる**（`dbStore.open`）。つなげたら DB タブを開き、つなげなければ（パスワードが
  要る・接続先が違う・クライアントが無い）エラーを添えて接続のダイアログ（`components/DbConnectDialog.vue`）を
  画面の中央に出す。パネルの候補・ダイアログ・DB タブの「接続先を変える」・DB の切り替えが全部ここを通る
  - **つないでみるのは `db_probe` の 1 回**（今の DB・DB の一覧・テーブルの一覧を返す）。**つながっても DB を
    選んでいなければタブを開かない**（`judgeProbe`）。DB 名の指定が無く、コンテナにも `MYSQL_DATABASE` が無いと
    MySQL は `DATABASE()` が NULL のままつながる（実測）。そのまま開くと、テーブルも DB の選択肢も無い空のタブになる。
    見られる DB がちょうど 1 つならそれを選んでつなぎ直し（選び方が 1 通りなので聞かない。つなぎ直すのは
    1 回だけで、それでも選ばれていなければ聞く）、2 つ以上ならダイアログの DB 名の欄に候補（`datalist`）を
    出して聞き、0 なら「見られる DB が無い」と出す。**欄は選択欄にしない**（一覧に出さないシステムの DB も
    打ち込めるように）。候補は経路を変えたときと接続に失敗したときに消す。**DB の一覧が取れないことと、
    DB が無いことを分ける**（`DbProbe.databases` が null か空か。失敗を空に畳むと、権限が無いだけの環境で
    「DB が無い」と誤って言う）。DB を選んだうえでテーブルが無いのは正しい状態なので、タブを開く
  - PostgreSQL は DB 名の指定が無くても必ず何かの DB（既定は `postgres`）につながるので、この判定には当たらない
    （DB はタブの中で切り替えられる）
  - DB タブの読み直しも `db_probe` を通す（`DbTab.vue` の `loadTables`。開いた直後はストアが読んだものを
    `takePrefetched` で受ける）。テーブルの一覧が取れなくなった（接続が切れた・DB が消えた）ときは、
    ダイアログを勝手に出さず、タブの中にエラーを出す。見ている最中に画面を奪わないため。直すときは
    「接続先を変える」から。DB の一覧だけが取れないときは、切り替えの欄に今の DB だけを出してタブは止めない
  - システムの DB は一覧に出さない（`sql::databases_sql`。MySQL は `information_schema` / `mysql` /
    `performance_schema` / `sys`、PostgreSQL はテンプレートの DB）
  - **ダイアログを閉じたりエラーを書いたりするのは、そのダイアログから出した接続だけ**（`fromDialog`）。
    行の接続を待つあいだに別のダイアログを開かれても、待っていた接続の結果がそちらへ混ざらない
    （待っているあいだはパネルの「新しい接続…」も押せない）
  - 保存した接続から開いたダイアログは、その接続のシェルで試し直す（`DbDialogState.shell`。プロジェクトの
    シェルを後から変えていても、行が指していたシェルを使う）
- **接続のフォームはダイアログ 1 つ。DB タブには置かない**（タブはつなげた接続先しか受け取らない。
  `tabStore.addDbTab` / `retargetDbTab`）。タブの中にもフォームがあると、同じ欄と経路の選び方を 2 か所に
  持つことになり、片方だけ直す事故が起きる。つないだときに読んだテーブルの一覧はタブへ渡して使い回す
  （`takePrefetched`。同じ問い合わせを 2 回流さない）
- DB のコンテナかは**イメージ名で決める**（`dbEngineOfImage`。リポジトリ名の最後の部分に `mysql` /
  `mariadb` / `percona` / `postgres` / `postgis` / `timescaledb` / `pgvector`。Redis の当て方は上の「Redis」）。
  compose に属さないコンテナも出す（`dockerStore.containers` 全体から選ぶ）
- `.env` はプロジェクトのルートの `*DATABASE_URL` / `DB_URL` と Laravel の `DB_*` を読む（Redis の `*REDIS_URL` と
  `REDIS_*` は上の「Redis」）。読むのはパネルを開いたときと、ルートが変わったとき（`loadEnv`）

## 接続の保存

- **つなげたローカル / WSL の接続先を保存する**（`targetToSaved` / `upsertSaved`。新しいものが先頭、
  `DB_SAVED_MAX` 件まで）。保存するのは種類・シェル・ホスト・ポート・ユーザー・DB 名で、**パスワードは
  保存しない**（issue の方針）。パスワードの要る DB は、押すと接続に失敗してダイアログが出るので、そこで入れる。
  入れたパスワードは DB タブの欄（`DbTab.target`）にだけ残り、タブはセッションに残さない
- **DB タブの中で DB を切り替えただけでは保存しない**（`open` の `save: false`）。同一性に DB 名を含むので、
  保存すると DB ごとに行が増え、上限で本当に保存した接続を押し出す
- 読むときは形を検める（`parseSavedConnections`。シェルは `shellId` と `shellFromId` の往復で見る。
  `stores/settings.ts` の `sanitizeShell` と同じ）
- **コンテナの接続は保存しない**（動いているものを毎回一覧に出し、ユーザー名などはコンテナの環境変数から
  読むので、覚えておくものが無い）
- **置き場はプロジェクトごとの localStorage**（`pike:db-connections:<プロジェクト id>`。鍵は
  `lib/projectStorage.ts` の表から作る）。接続先のホストやポートはマシンに依存するので、設定の同期にも
  `project.json` にも入れない。プロジェクトの id の付け替え（#463）では表に載っているので一緒に移る
- 接続先の同一性は `connectionKey`（パスワードを含めない。空の欄と未指定は同じ）。同じ接続先の DB タブが
  今のプロジェクトにあれば、それを前に出す（`findDbTab`）
- 保存した接続はパネルの行のごみ箱のボタンで消す（`forget`）。コンテナと `.env` の候補には出さない
  （出所が別にあり、消しても次に読めば戻る）
- macOS はホストのシェルで直に起こす。Homebrew の `/opt/homebrew/bin` は `augment_process_path` が PATH に
  足すが、keg-only の `libpq` / `mysql-client` は PATH に無いので「見つからない」になる。**macOS の実機では
  確かめていない**
