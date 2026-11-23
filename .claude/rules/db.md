---
paths:
  - "src-tauri/src/db/**"
  - "src/components/tabs/DbTab.vue"
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
入力した SQL も実行する（#646。下の「入力した SQL」）。
接続先はローカル（ホスト）・WSL・Docker コンテナだけ。実体は `src-tauri/src/db/`（`mod.rs` が
実行、`sql.rs` が SQL と出力の読み方）、`src/components/tabs/DbTab.vue`、`src/lib/dbViewer.ts`。
UI の「レコード」はコードでは `rows`（`db_rows` / `view === 'rows'`）のまま。

## やらないこと（広げるときは issue から）

- **テーブルの一覧・スキーマ・レコードのクエリに、入力した文字列を混ぜない**（下の「発行する SQL」）。
  入力した SQL は `db_execute` の 1 つの口だけが受ける
- 入力した SQL の実行の中止、書き込み系の文の確認ダイアログ、全件の書き出し（SQL の結果の保存は表示した行だけ）
- Redis などほかの DB は別の issue（Redis は #647）
- SSH 踏み台・リモートホスト（musql の領分）、MySQL / PostgreSQL 以外（SQLite など）
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

DB タブの「SQL」で入力した SQL を、**加工せずに**クライアントへ渡す（`db_execute`）。MySQL は引数の 1 語
（`--execute=`）、PostgreSQL は表の形なら `--command=`、ログの形なら標準入力（下の「ログの形」）。DDL も書き込みも
受け、確認は挟まない（issue の方針。権限は接続したユーザーのもの）。SQL の中身がシェルに読まれることは無い
（シェルを挟まないか、挟むコンテナの `sh` も変数を展開して渡すだけ）。

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
  - PostgreSQL のブロックコメントは入れ子になる（`block_comment_end`）。`E'...'` の `E` と、ドル引用の `$` は、
    識別子の続き（`LIKE'..'` の `E`、`a$b$`）なら接頭辞と見なさない（`is_ident_byte`）
  - 表にするときは前後の `;` とコメントを落とし（`body_start..body_end`。先頭の空の文は MySQL が
    `No query specified` で拒む）、PostgreSQL は前後に改行を挟んで `COPY (...)` で包む（行末の `--` のコメントが
    閉じ括弧を隠さないように）
  - 表の形でも書き換える文は通りうる（MySQL の `WITH ... DELETE`、`SELECT ... INTO @v`）。結果の表が無ければ
    「返った行はありません」と出す（行数の 0 とは言わない）
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
  - **PostgreSQL は SQL を標準入力（`--file=-`）で渡す**（`sql::sql_on_stdin`）。`--command` に複数の文を渡すと
    1 回の問い合わせになり、サーバーは 1 つの暗黙のトランザクションで実行する。途中で失敗すると前の文も取り消される
    のに、ログには前の文の結果が残る（実測。`CREATE TABLE` と `INSERT` のあとの失敗で、テーブルごと無くなる）。
    標準入力なら psql が文ごとに送るので文ごとに確定し、エラーに `psql:<stdin>:4:` と行も付く
    - シェルの経路はパイプで書く（`ShellIo`。書き込みは別のスレッドで、出力を読みながら）
    - **コンテナの経路は、SQL を exec の環境変数（`STDIN_ENV`）で渡し、コンテナの `sh` で流し込む**
      （`printf '%s' "$PIKE_SQL" | exec "$0" "$@"`）。bollard の exec に `attach_stdin` で書いて書き込み側を閉じると、
      接続ごと閉じて出力も終了コードも取れない（実測。終了コードが -1 のまま返る）。コンテナに `sh` が要る
  - 1 行を 1 つの値のレコードとして読み（`RecordReader` の `OutputMode::Log`）、`LOG_MAX_BYTES`（1MB）で切る
  - **エラーのときは、それまでのログを前に付けて返す**（`Outcome::Failed` が sink を持ち帰る）。複数の文は失敗した
    文の前まで実行されて確定している（MySQL は `--force` を付けないので止まる、PostgreSQL は `ON_ERROR_STOP=1`）
- **表は `ROW_LIMIT` 行まで持つ**（`Collect` の `limit`。SQL に `LIMIT` を足せないので、超えた行は読み捨てる）。
  値の切り詰め（`CELL_MAX_CHARS`）はレコードと同じ。保存は表示している行だけ（全件の書き出しは持たない）
- 待つのは `EXEC_TIMEOUT`（書き出しと同じ 10 分）。中止はできない。コンテナの exec は待ち切れても中で走り続ける
  （書き出しと同じ既知の制約）
- ログの形で流したあとは、**同じ `Session` でテーブルの一覧を読み直して結果に添える**（`DbExec::Log` の `tables`。
  DDL で増減するので。別のコマンドで `db_probe` を流し直すと、inspect とクライアントの解決と 3 回の問い合わせが
  余分にかかる）。エラーのときは一覧が添わないので、フロントが `db_probe` で読み直す（`DbTab.vue` の `refreshTables`）。
  選んでいたテーブルが一覧から消えたら選択を外す（`setTables`）。接続先が変わったら SQL の結果は捨て、入力は残す
- 範囲を選んでいれば、その部分だけを実行する。キーは `Mod+Enter`（`matchChord`。`KeyboardShortcuts.vue` と
  マニュアルの DB ビューワの節）

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
  `mariadb` / `percona` / `postgres` / `postgis` / `timescaledb` / `pgvector`）。compose に属さない
  コンテナも出す（`dockerStore.containers` 全体から選ぶ）
- `.env` はプロジェクトのルートの `*DATABASE_URL` / `DB_URL` と Laravel の `DB_*` を読む。読むのはパネルを
  開いたときと、ルートが変わったとき（`loadEnv`）

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
