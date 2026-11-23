//! DB ビューワ（#632）の純粋な部分: 発行する SQL、識別子と文字列の引用、クライアントの
//! 引数、出力の読み方、書き出しの整形、入力された SQL の形の判定。**外部プロセスに触らない**ので
//! 単体テストを置く。
//!
//! **一覧・スキーマ・レコードで発行する SQL はここにある固定のものだけ。** そこへ外から入る
//! 文字列はテーブル名だけで、それも呼び出し側（`mod.rs`）が一覧に有ることを確かめてから
//! `quote_ident` / `string_literal` を通して埋める。利用者が入力した SQL（#646）は別の口
//! （`db_execute`）で、加工せずにクライアントの引数の 1 語として渡す（`plan_user_sql`）。

use serde::{Deserialize, Serialize};

/// 対応する DB の種類。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Engine {
    Mysql,
    Postgres,
}

impl Engine {
    /// 試すクライアントの順。**MariaDB 11 の公式イメージには `mysql` が無く `mariadb` だけ**
    /// （実測）なので、`mysql` が見つからなければ `mariadb` を試す。
    pub fn clients(self) -> &'static [&'static str] {
        match self {
            Engine::Mysql => &["mysql", "mariadb"],
            Engine::Postgres => &["psql"],
        }
    }

    /// パスワードを渡す環境変数。**引数には載せない**（`ps` で見える）。
    pub fn password_env(self) -> &'static str {
        match self {
            Engine::Mysql => "MYSQL_PWD",
            Engine::Postgres => "PGPASSWORD",
        }
    }
}

/// 接続の指定（パスワードは環境変数で渡すのでここに無い）。空文字は呼び出し側（`Session::open`）が
/// `None` に直してから渡す。
#[derive(Debug, Default, Clone)]
pub struct ConnArgs<'a> {
    pub host: Option<&'a str>,
    pub port: Option<u16>,
    pub user: Option<&'a str>,
    pub database: Option<&'a str>,
}

/// クライアントに出させる形。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutputMode {
    /// 機械で読む表（MySQL は `--batch`、PostgreSQL は `COPY ... CSV` を呼び出し側が組む）。
    Records,
    /// 人が読むログ（#646。表を返さない文と、複数の文をまとめて流すとき）。MySQL は
    /// `--table -vv` で、文ごとに文そのもの・枠付きの表・`Query OK, N rows affected` を出す。
    /// PostgreSQL は `-q` を外し、整列した表とコマンドの結果（`UPDATE 2` / `CREATE TABLE`）を出す
    /// （どちらも実測。`-q` を付けるとコマンドの結果が出ない）。
    Log,
}

/// SQL の渡し方。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SqlInput<'a> {
    /// 引数の 1 語（`--execute=` / `--command=`）。固定の SQL（一覧・スキーマ・レコード）。
    Arg(&'a str),
    /// 標準入力（呼び出し側が流し込む）。**入力した SQL はこちら**（`db_execute`）:
    ///
    /// - psql の `--command` に複数の文を渡すと 1 回の問い合わせになり、サーバーは 1 つの暗黙の
    ///   トランザクションで実行する。途中の文が失敗すると前の文も取り消されるのに、ログには前の文の結果
    ///   （`INSERT 0 1`）が残る。`CREATE INDEX CONCURRENTLY` のようなトランザクションの中で実行できない文も
    ///   通らない。標準入力（`--file=-`）なら psql が文ごとに送るので、文ごとに確定し、`ON_ERROR_STOP=1` で
    ///   失敗した文の前までが残る（エラーに `psql:<stdin>:4:` と行も付く。どれも実測）
    /// - 引数の長さには上限がある（Linux は 1 語 128 KiB、Windows はコマンドライン全体で 32,767 文字）。
    ///   長い INSERT は引数では渡らない
    /// - MySQL は標準入力から読んでも `--batch` と `--table -vv` の出力の形が変わらない（実測）
    Stdin,
}

/// クライアントの引数（プログラム名は含めない）。値は `--name=value` の 1 語で渡す
/// （`-` で始まる値を別のオプションと読ませない）。シェルを挟まずに argv で渡るので、
/// 値の中身による注入は起きない。
pub fn client_args(
    engine: Engine,
    conn: &ConnArgs,
    sql: SqlInput,
    mode: OutputMode,
) -> Vec<String> {
    let mut args: Vec<&str> = match engine {
        // `--batch` はタブ区切り・1 行目が見出し。値の中のタブ・改行・`\` は `\t` / `\n` /
        // `\\` に置き換わり、NULL は `NULL` になる（`--raw` は付けない。付けると値の中の
        // 改行で行が割れる）。文字コードは付けないとクライアントの既定（古い版は latin1）で
        // 読み、日本語が化ける（実測）。
        // `--quick` は結果を溜めずに 1 行ずつ出す（付けないとクライアントが全件をメモリに
        // 持ってから出すので、書き出しが流れず、大きなテーブルでメモリを使い切る）。
        Engine::Mysql => vec![
            "--batch",
            "--quick",
            "--default-character-set=utf8mb4",
            "--connect-timeout=10",
        ],
        // `-X` は `.psqlrc` を読まない（利用者の設定で出力の形が変わらないように）、
        // `-w` はパスワードを聞かない（標準入力は閉じてあるか SQL を流し込むので、聞かれても
        // 答えられない。待たずに失敗で返る）。`VERBOSITY=verbose` はエラーに SQLSTATE と出どころの関数名
        // （`LOCATION:` の行）を付ける。`copy_rejected` が見る手がかりで、どちらもサーバーの
        // `lc_messages` で翻訳されない（本文は翻訳される）。行は `tidy_error` が見せる前に落とす。
        Engine::Postgres => vec![
            "-X",
            "-w",
            "-v",
            "ON_ERROR_STOP=1",
            "-v",
            "VERBOSITY=verbose",
        ],
    };
    match (engine, mode) {
        (Engine::Mysql, OutputMode::Log) => args.extend(["--table", "-vv"]),
        (Engine::Postgres, OutputMode::Records) => args.push("-q"),
        _ => {}
    }
    // **標準入力から読む MySQL は `--binary-mode` で、クライアントのコマンドを止める**（`charset` と
    // `delimiter` 以外。`\!` は `Unknown command` に、行頭の `system` はサーバーへ送られて構文エラーになる。
    // 付けないと `system id` は OS のコマンドとして動く。どれも mariadb 11.8 で実測）。字句で探す
    // `client_command` は、MySQL では文字列の読み方が `sql_mode`（`NO_BACKSLASH_ESCAPES` など）や実行される
    // コメント（`/*! ... */`）で変わるので追い切れない。あちらは断る理由を見せるためのもので、止めるのはこれ。
    // 副作用は `\r\n` を `\n` に直さないことと `\0` を文の終わりと見なさないことで、どちらも困らない。
    // **`--local-infile=0` も付ける。** `--binary-mode` は `LOAD DATA LOCAL INFILE` を止めないので、LOCAL を
    // 許すサーバーでは、DB の FILE 権限なしにクライアントの環境（ホスト・WSL・コンテナ）のファイルを読んで
    // 送れてしまう。クライアントの側で LOCAL を切れば、サーバーの設定に依らず読まない。
    if engine == Engine::Mysql && sql == SqlInput::Stdin {
        args.extend(["--binary-mode", "--local-infile=0"]);
    }
    let mut args: Vec<String> = args.into_iter().map(str::to_owned).collect();
    if let Some(h) = conn.host {
        args.push(format!("--host={h}"));
    }
    if let Some(p) = conn.port {
        args.push(format!("--port={p}"));
    }
    if let Some(u) = conn.user {
        let flag = match engine {
            Engine::Mysql => "user",
            Engine::Postgres => "username",
        };
        args.push(format!("--{flag}={u}"));
    }
    match engine {
        Engine::Mysql => {
            if let Some(d) = conn.database {
                args.push(format!("--database={d}"));
            }
            // 標準入力なら引数は要らない（`--batch` のまま標準入力から読む）。
            if let SqlInput::Arg(sql) = sql {
                args.push(format!("--execute={sql}"));
            }
        }
        Engine::Postgres => {
            // DB 名を省くと psql はユーザー名と同じ DB へつなぐ。DB の一覧を取るときなど、
            // 名前が決まっていないときは必ずある `postgres` へつなぐ。
            let db = conn.database.unwrap_or("postgres");
            args.push(format!("--dbname={db}"));
            args.push(match sql {
                SqlInput::Arg(sql) => format!("--command={sql}"),
                SqlInput::Stdin => "--file=-".to_owned(),
            });
        }
    }
    args
}

/// 識別子の引用（MySQL はバッククォート、PostgreSQL は二重引用符。中の引用符は二重化）。
pub fn quote_ident(engine: Engine, name: &str) -> String {
    match engine {
        Engine::Mysql => format!("`{}`", name.replace('`', "``")),
        Engine::Postgres => format!("\"{}\"", name.replace('"', "\"\"")),
    }
}

/// 文字列リテラル。**MySQL は 16 進のリテラルに introducer を付ける**（`_utf8mb4 X'..'`）。
/// `'` と `\` の扱いが `NO_BACKSLASH_ESCAPES` で変わるのを気にしなくてよく、どんな文字列も
/// 引用を破れない。introducer を付けるのは、文字コードを決めつつリテラルのままにするため
/// （`CONVERT(... USING)` にすると照合順序の強さが変わり、information_schema の列と比べたときに
/// 照合順序の混在で落ちうる）。PostgreSQL は `E'...'` で、`\` と `'` を二重化する（`E` を
/// 付ければ `standard_conforming_strings` の設定に依らず `\` は常にエスケープとして読まれる）。
pub fn string_literal(engine: Engine, s: &str) -> String {
    match engine {
        Engine::Mysql => {
            let hex: String = s.bytes().map(|b| format!("{b:02X}")).collect();
            format!("_utf8mb4 X'{hex}'")
        }
        Engine::Postgres => format!("E'{}'", s.replace('\\', "\\\\").replace('\'', "''")),
    }
}

/// PostgreSQL の問い合わせは全部 `COPY (...) TO STDOUT` の CSV で受ける。`FORCE_QUOTE *` で
/// NULL 以外の値が必ず引用符で囲まれるので、**NULL（引用符の無い空）と空文字（`""`）が
/// 区別できる**。psql の非整列出力（`-A`）は値の中のタブ・改行を区別できない。
fn pg_copy(select: &str) -> String {
    format!("COPY ({select}) TO STDOUT WITH (FORMAT csv, HEADER, FORCE_QUOTE *)")
}

/// 今つながっている DB の名前（1 行 1 列）。MySQL は DB を選ばずにつなぐと NULL になる
/// （DB 名の指定が無く、コンテナの環境変数にも `MYSQL_DATABASE` が無いとき）。
pub fn current_database_sql(engine: Engine) -> String {
    match engine {
        Engine::Mysql => "SELECT DATABASE() AS name".to_owned(),
        Engine::Postgres => pg_copy("SELECT current_database() AS name"),
    }
}

/// DB の一覧。MySQL のシステムの DB（`information_schema` / `mysql` / `performance_schema` / `sys`）と、
/// PostgreSQL のテンプレートの DB は出さない。
pub fn databases_sql(engine: Engine) -> String {
    match engine {
        Engine::Mysql => "SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA \
             WHERE SCHEMA_NAME NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys') \
             ORDER BY SCHEMA_NAME"
            .to_owned(),
        Engine::Postgres => pg_copy(
            "SELECT datname AS name FROM pg_database \
             WHERE NOT datistemplate AND datallowconn ORDER BY datname",
        ),
    }
}

/// テーブルの一覧（名前・種類・おおよその行数）。PostgreSQL は `current_schema()` のものだけ。
pub fn tables_sql(engine: Engine) -> String {
    match engine {
        Engine::Mysql => {
            "SELECT TABLE_NAME AS name, TABLE_TYPE AS type, TABLE_ROWS AS approx_rows \
             FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME"
                .to_owned()
        }
        // `reltuples` は統計の推定で、一度も ANALYZE していなければ -1（PostgreSQL 14 以降）。
        Engine::Postgres => pg_copy(
            "SELECT t.table_name AS name, t.table_type AS type, \
             (SELECT CASE WHEN c.reltuples < 0 THEN NULL ELSE c.reltuples::bigint END \
              FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
              WHERE n.nspname = t.table_schema AND c.relname = t.table_name) AS approx_rows, \
             t.table_schema AS schema \
             FROM information_schema.tables t WHERE t.table_schema = current_schema() \
             ORDER BY t.table_name",
        ),
    }
}

/// 列の定義（列名・型・NULL 可否・既定値・キー・補足）。
pub fn schema_sql(engine: Engine, table: &str) -> String {
    let lit = string_literal(engine, table);
    match engine {
        Engine::Mysql => format!(
            "SELECT COLUMN_NAME AS `column`, COLUMN_TYPE AS `type`, IS_NULLABLE AS `nullable`, \
             COLUMN_DEFAULT AS `default`, COLUMN_KEY AS `key`, EXTRA AS `extra` \
             FROM information_schema.COLUMNS \
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = {lit} ORDER BY ORDINAL_POSITION"
        ),
        // information_schema.columns の型は長さや精度を別の列に分けて持つので、`format_type`
        // で `character varying(50)` の形にする。キーは主キー・一意・外部キーの制約から拾う。
        Engine::Postgres => pg_copy(&format!(
            "SELECT a.attname AS \"column\", format_type(a.atttypid, a.atttypmod) AS \"type\", \
             CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END AS \"nullable\", \
             pg_get_expr(d.adbin, d.adrelid) AS \"default\", \
             (SELECT string_agg(CASE con.contype WHEN 'p' THEN 'PRI' WHEN 'u' THEN 'UNI' \
               ELSE 'FK' END, ',' ORDER BY con.contype) FROM pg_constraint con \
              WHERE con.conrelid = a.attrelid AND a.attnum = ANY (con.conkey) \
              AND con.contype IN ('p', 'u', 'f')) AS \"key\", \
             CASE WHEN a.attidentity <> '' THEN 'identity' ELSE '' END AS \"extra\" \
             FROM pg_attribute a LEFT JOIN pg_attrdef d \
               ON d.adrelid = a.attrelid AND d.adnum = a.attnum \
             WHERE a.attrelid = (SELECT c.oid FROM pg_class c \
               JOIN pg_namespace n ON n.oid = c.relnamespace \
               WHERE n.nspname = current_schema() AND c.relname = {lit}) \
             AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum"
        )),
    }
}

/// テーブルの中身。`limit` が `None` なら全件（書き出し）。
///
/// **PostgreSQL はスキーマで修飾する**（`schema` は一覧が返した `current_schema()`）。修飾しないと
/// search_path で解決され、暗黙に先に探される `pg_catalog` と `pg_temp` に同じ名前があると、一覧で
/// 確かめたのとは別のテーブル（`public.pg_class` のつもりが `pg_catalog.pg_class`）を読む。
/// MySQL は今の DB の中でしか探さないので修飾しない。
pub fn rows_sql(engine: Engine, schema: Option<&str>, table: &str, limit: Option<usize>) -> String {
    let ident = match schema {
        Some(s) => format!("{}.{}", quote_ident(engine, s), quote_ident(engine, table)),
        None => quote_ident(engine, table),
    };
    let select = match limit {
        Some(n) => format!("SELECT * FROM {ident} LIMIT {n}"),
        None => format!("SELECT * FROM {ident}"),
    };
    match engine {
        Engine::Mysql => select,
        Engine::Postgres => pg_copy(&select),
    }
}

/// 入力された SQL（#646）の流し方。
#[derive(Debug, PartialEq, Eq)]
pub enum UserSql {
    /// 表を返す 1 つの文。`OutputMode::Records` で流し、表で見せる（PostgreSQL は `COPY` で包んだもの）。
    Query(String),
    /// それ以外（DDL・書き込み・複数の文）。入力をそのまま `OutputMode::Log` で流す。
    Script,
}

/// 入力された SQL の流し方を決める。**表で見せるのは、表を返す文が 1 つだけのとき**:
/// MySQL の `--batch` は複数の結果を見出しの区切りなしに続けて出し、PostgreSQL の `COPY` は
/// 1 つの文しか包めない。空（空白とコメントだけ）なら `None`。
///
/// PostgreSQL の `WITH ... UPDATE`（`RETURNING` なし）や `SELECT ... INTO` は `COPY` が拒むので、
/// 呼び出し側が `copy_rejected` を見て `Script` で流し直す（拒まれた文は実行されていない）。
pub fn plan_user_sql(engine: Engine, sql: &str) -> Option<UserSql> {
    let shape = sql_shape(engine, sql);
    if shape.statements == 0 {
        return None;
    }
    let queries: &[&str] = match engine {
        Engine::Mysql => &[
            "SELECT", "WITH", "VALUES", "TABLE", "SHOW", "DESCRIBE", "DESC", "EXPLAIN",
        ],
        // `SHOW` / `EXPLAIN` は `COPY` で包めないので、ログ（整列した表）で見せる。
        Engine::Postgres => &["SELECT", "WITH", "VALUES", "TABLE"],
    };
    // MySQL の `WITH ... UPDATE` と `SELECT ... INTO @v` は先頭の語が問い合わせでも書き込みで、結果の表を
    // 返さない。表の形で流すと件数が出ないので、ログで流す（流したあとで切り替えると 2 回実行する）。
    if shape.statements > 1 || shape.writes || !queries.contains(&shape.first_word.as_str()) {
        return Some(UserSql::Script);
    }
    // 前後の `;` とコメントは落とす（`COPY (...)` の中に `;` は書けず、行末のコメントは閉じ括弧を
    // 隠す。先頭の空の文は MySQL が `No query specified` で拒む）。後ろに改行を挟むのは、行末の
    // `--` のコメントが包んだ側を食わないように。文の最初の行は `COPY (` と同じ 1 行目に置き、エラーの
    // `LINE n:` を文の中の行番号（文の 1 行目が 1）にする。落とした先頭の行のぶんは数に残せない
    // （psql は空白だけの行を送らない。実測）。
    let body = &sql[shape.body_start..shape.body_end];
    Some(UserSql::Query(match engine {
        Engine::Mysql => body.to_owned(),
        Engine::Postgres => pg_copy(&format!("{body}\n")),
    }))
}

/// `COPY (...)` で包んだせいで PostgreSQL が拒んだか（`plan_user_sql`）。拒むのは解析の段階なので、
/// 包んだ文は実行されていない。
///
/// **見るのは SQLSTATE（`0A000`＝feature_not_supported）と、出どころの関数名**（`BeginCopyTo`。
/// PostgreSQL 13 までは `BeginCopy`）。本文（`COPY query must have a RETURNING clause` など）は
/// サーバーの `lc_messages` で翻訳されるので照合しない。`VERBOSITY=verbose`（`client_args`）が要る。
pub fn copy_rejected(engine: Engine, stderr: &str) -> bool {
    engine == Engine::Postgres && stderr.contains("0A000") && stderr.contains("BeginCopy")
}

/// 入力された SQL に含まれる、クライアント（`mysql` / `psql`）が自分で実行するコマンド。あれば
/// その綴りを返す（呼び出し側が実行を断る）。
///
/// **クライアントのコマンドは SQL ではなく、DB の権限の外で動く**: `\! id` と MySQL の行頭の
/// `system id` はクライアントを起こした環境（ホスト・WSL・コンテナ）の OS のコマンドを走らせる
/// （どちらも実測）。`source` / `tee` / `pager` / `edit` もファイルや別のプログラムに触る。
/// 文字列・引用した識別子・コメントの外の `\` はどれもクライアントのコマンドの始まりなので全部断り、
/// MySQL の名前の付いたコマンドは文の頭のものを断る（クライアントが読みかけの文を持たないときだけ
/// コマンドと見なす。文の途中の行頭の `source` は列名）。
///
/// **ここは実行の前に断って理由を見せるためのもので、守りではない。** 止めるのはクライアントの側で、
/// psql は `\restrict`（`restricted_script`）、MySQL は `--binary-mode`（`client_args`）。字句では
/// 追い切れない: psql は `COPY ... FROM STDIN` のデータと `standard_conforming_strings`、MySQL は
/// `sql_mode` と実行されるコメント（`/*! ... */`）で、文字列の読み方がここと食い違う。
pub fn client_command(engine: Engine, sql: &str) -> Option<String> {
    sql_shape(engine, sql).client_command
}

/// psql へ標準入力で流すスクリプト。**先頭で `\restrict <key>` し、メタコマンドを psql の側で止める**
/// （`\unrestrict <key>` 以外の `\` のコマンドが `backslash commands are restricted` で失敗し、
/// `ON_ERROR_STOP=1` で止まる。`key` は呼び出しごとの乱数で、利用者は抜けられない）。
///
/// 字句で探す `client_command` だけでは守れない: `COPY ... FROM STDIN` のデータの中や、
/// `SET standard_conforming_strings = off` で読み方を変えた文字列の陰に `\!` を隠せる（どちらも、
/// `\restrict` 無しでは OS のコマンドが動き、有りでは止まることを psql 18 で実測）。`\restrict` は
/// 2025-08 の修正版（18 / 17.6 / 16.10 / 15.14 / 14.19 / 13.22）から。それより古い psql は 1 行目で
/// `invalid command` になって何も実行しない（`restrict_unsupported`）。
pub fn restricted_script(sql: &str, key: &str) -> String {
    format!("\\restrict {key}\n{sql}")
}

/// psql が `\restrict` を知らない（古い）ために、スクリプトを始められなかったか。見るのは psql 自身が
/// 1 行目（`restricted_script` が足した行）について出したエラーだけ。**綴りだけで見ないこと**: 利用者の
/// 文字列の中の `\restrict` は、サーバーのエラー（`LINE 1:` や `Failing row contains`）に写って出てくる。
/// 本文（`invalid command`）は翻訳されるので照合しない。
pub fn restrict_unsupported(engine: Engine, stderr: &str) -> bool {
    engine == Engine::Postgres
        && stderr
            .lines()
            .any(|l| l.starts_with("psql:<stdin>:1:") && l.contains("\\restrict"))
}

/// psql のエラーの `psql:<stdin>:N:` の行番号を、`restricted_script` が足した 1 行ぶん戻す
/// （利用者が入力した SQL の行番号にする）。
pub fn unshift_stdin_lines(msg: &str) -> String {
    const MARK: &str = "psql:<stdin>:";
    let mut out = String::with_capacity(msg.len());
    let mut rest = msg;
    while let Some(at) = rest.find(MARK) {
        let (head, tail) = rest.split_at(at + MARK.len());
        out.push_str(head);
        let digits = tail.bytes().take_while(u8::is_ascii_digit).count();
        match tail[..digits].parse::<u64>() {
            Ok(n) if n > 1 => out.push_str(&(n - 1).to_string()),
            _ => out.push_str(&tail[..digits]),
        }
        rest = &tail[digits..];
    }
    out.push_str(rest);
    out
}

/// psql のエラーの行頭の `psql:<stdin>:N: ` を外す（表の形のエラー。`user_sql_error` の doc）。
pub fn strip_stdin_lines(msg: &str) -> String {
    const MARK: &str = "psql:<stdin>:";
    msg.lines()
        .map(|line| {
            line.strip_prefix(MARK)
                .and_then(|rest| {
                    let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
                    (digits > 0)
                        .then(|| rest[digits..].strip_prefix(": "))
                        .flatten()
                })
                .unwrap_or(line)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// MySQL のクライアントのコマンドのうち、OS やファイルに触るもの（`client_command`）。
const MYSQL_CLIENT_COMMANDS: &[&str] = &["SYSTEM", "SOURCE", "TEE", "PAGER", "EDIT"];

/// エラーを見せる形にする。PostgreSQL の `VERBOSITY=verbose` が足す `LOCATION:` の行（サーバーの
/// ソースの位置）を落とす。見出しの語は翻訳されるので、`関数名, ファイル.拡張子:行` の形で見分ける
/// （`parse_relation.c:1498` のほか、字句と構文の `scan.l:1429` や `gram.y` もある）。
pub fn tidy_error(msg: &str) -> String {
    let is_location = |line: &str| {
        line.rsplit_once(", ").is_some_and(|(_, at)| {
            at.rsplit_once(':').is_some_and(|(file, n)| {
                let ext = file.rsplit_once('.').map(|(_, e)| e);
                !n.is_empty()
                    && n.bytes().all(|b| b.is_ascii_digit())
                    && ext.is_some_and(|e| matches!(e, "c" | "l" | "y" | "h"))
                    && !file.contains(' ')
            })
        })
    };
    msg.lines()
        .filter(|l| !is_location(l))
        .collect::<Vec<_>>()
        .join("\n")
}

/// 入力された SQL を字句で読んだ結果。
#[derive(Debug, PartialEq, Eq)]
struct SqlShape {
    /// 中身のある文の数（空白とコメントだけの文は数えない）。
    statements: usize,
    /// 最初の文の最初の語（大文字。先頭の `(` は飛ばす）。
    first_word: String,
    /// 最初の意味のある文字の位置（先頭の空白・コメント・空の文を除く）。
    body_start: usize,
    /// 最後の意味のある文字の直後（末尾の `;`・空白・コメントを除いた長さ）。
    body_end: usize,
    /// MySQL の最初の文が、括弧の外に書き込みの語（`UPDATE` / `DELETE` / `INSERT` / `REPLACE` / `INTO`）を
    /// 持つか（`WITH ... UPDATE`、`SELECT ... INTO @v`）。
    writes: bool,
    /// クライアントのコマンド（`client_command`）。
    client_command: Option<String>,
}

/// 識別子の一部になりうるバイトか（ASCII の英数字と `_`、と UTF-8 の多バイト文字）。
fn is_ident_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b >= 0x80
}

/// 文字列・引用した識別子・コメントを飛ばしながら、文の数と最初の語を数える。**SQL の構文は
/// 解析しない**（流し方を決めるだけ。読み違えると、表ではなくログで見せるか、包んだ文をクライアントが
/// エラーで返す）。送る SQL は前後の空白・コメント・`;` しか落とさないので、コメントの読み違いで
/// 文の中身が欠けないよう、MySQL の実行されるコメント（`/*! ... */`）は中身として数える。
fn sql_shape(engine: Engine, sql: &str) -> SqlShape {
    let bytes = sql.as_bytes();
    let mut shape = SqlShape {
        statements: 0,
        first_word: String::new(),
        body_start: 0,
        body_end: 0,
        writes: false,
        client_command: None,
    };
    let mut in_statement = false;
    // 括弧の深さ（`writes` は括弧の外の語だけを見る）。
    let mut depth = 0usize;
    // 直前の語（`FOR UPDATE` の `UPDATE` を書き込みと数えないため）。
    let mut prev_word = String::new();
    let mut i = 0;
    // 意味のある字句を 1 つ読んだ（`start..end`）。
    let mark = |shape: &mut SqlShape, in_statement: &mut bool, start: usize, end: usize| {
        if !*in_statement {
            *in_statement = true;
            shape.statements += 1;
            if shape.statements == 1 {
                shape.body_start = start;
            }
        }
        if shape.statements == 1 && shape.first_word.is_empty() {
            let word: String = sql[start..]
                .chars()
                .take_while(|c| c.is_ascii_alphabetic() || *c == '_')
                .collect();
            shape.first_word = word.to_ascii_uppercase();
        }
        shape.body_end = end;
    };
    while i < bytes.len() {
        let b = bytes[i];
        let next = bytes.get(i + 1).copied();
        match b {
            b if b.is_ascii_whitespace() => i += 1,
            b';' => {
                in_statement = false;
                depth = 0;
                i += 1;
            }
            // `(SELECT ...) UNION ...` の最初の語を拾うため、括弧は語の前で飛ばす（中身として数える）。
            // （`(` の位置から語を取ると空なので、最初の語は次の字句で決まる）。
            b'(' | b')' => {
                depth = if b == b'(' {
                    depth + 1
                } else {
                    depth.saturating_sub(1)
                };
                mark(&mut shape, &mut in_statement, i, i + 1);
                i += 1;
            }
            // 文字列・引用・コメントの外の `\` は、クライアントのコマンド（`\!` `\.` `\g` ...）。
            b'\\' => {
                let len = sql[i + 1..].chars().next().map_or(0, char::len_utf8);
                shape
                    .client_command
                    .get_or_insert_with(|| sql[i..i + 1 + len].to_owned());
                mark(&mut shape, &mut in_statement, i, i + 1 + len);
                i += 1 + len;
            }
            b'-' if next == Some(b'-')
                && (engine == Engine::Postgres
                    || bytes
                        .get(i + 2)
                        .is_none_or(|c| c.is_ascii_whitespace() || c.is_ascii_control())) =>
            {
                i = line_end(bytes, i);
            }
            b'#' if engine == Engine::Mysql => i = line_end(bytes, i),
            b'/' if next == Some(b'*') => {
                // MySQL の `/*! ... */` と MariaDB の `/*M! ... */` はサーバーが実行する。
                let executed = engine == Engine::Mysql
                    && (bytes[i + 2..].starts_with(b"!") || bytes[i + 2..].starts_with(b"M!"));
                // **閉じていないコメントは中身として残す**（落とすと、構文エラーになるはずの
                // `SELECT nextval('seq') /* unfinished` が `COPY (SELECT nextval('seq'))` として実行される）。
                let (end, keep) = match block_comment_end(engine, bytes, i) {
                    Some(end) => (end, executed),
                    None => (bytes.len(), true),
                };
                if keep {
                    mark(&mut shape, &mut in_statement, i, end);
                }
                i = end;
            }
            b'\'' | b'"' | b'`' if b != b'`' || engine == Engine::Mysql => {
                // MySQL の文字列は `\` でも逃がす。PostgreSQL は `E'...'` のときだけ（`E` が
                // 識別子の末尾でないこと。`LIKE'a\'` の `E` は接頭辞ではない）。
                let backslash = match engine {
                    Engine::Mysql => b != b'`',
                    Engine::Postgres => {
                        b == b'\''
                            && i > 0
                            && matches!(bytes[i - 1], b'E' | b'e')
                            && (i < 2 || !(is_ident_byte(bytes[i - 2]) || bytes[i - 2] == b'$'))
                    }
                };
                let end = quoted_end(bytes, i, b, backslash);
                mark(&mut shape, &mut in_statement, i, end);
                i = end;
            }
            // 識別子の中の `$`（`a$b`）はドル引用の始まりではない。
            b'$' if engine == Engine::Postgres && (i == 0 || !is_ident_byte(bytes[i - 1])) => {
                let end = dollar_end(sql, i).unwrap_or(i + 1);
                mark(&mut shape, &mut in_statement, i, end);
                i = end;
            }
            // 語（識別子・キーワード）。`$` は識別子の続きになりうる。
            b if b.is_ascii_alphabetic() || b == b'_' || b >= 0x80 => {
                let len = bytes[i..]
                    .iter()
                    .position(|&c| !(is_ident_byte(c) || c == b'$'))
                    .unwrap_or(bytes.len() - i);
                let word = sql[i..i + len].to_ascii_uppercase();
                let statement_start = !in_statement;
                mark(&mut shape, &mut in_statement, i, i + len);
                if engine == Engine::Mysql {
                    // 名前の付いたコマンドは文の頭だけ（文の途中の行頭の `source` は列名）。
                    if statement_start && MYSQL_CLIENT_COMMANDS.contains(&word.as_str()) {
                        shape
                            .client_command
                            .get_or_insert(word.to_ascii_lowercase());
                    }
                    // 直後が `(` なら関数の呼び出し（`REPLACE(s, 'a', 'b')`）で、書き込みではない。
                    let call = bytes[i + len..]
                        .iter()
                        .find(|c| !c.is_ascii_whitespace())
                        .is_some_and(|&c| c == b'(');
                    let write_word = matches!(
                        word.as_str(),
                        "UPDATE" | "DELETE" | "INSERT" | "REPLACE" | "INTO"
                    );
                    // `SELECT ... FOR UPDATE` は行を返す（ロックを取るだけ）。
                    let locking = word == "UPDATE" && prev_word == "FOR";
                    if shape.statements == 1 && depth == 0 && write_word && !call && !locking {
                        shape.writes = true;
                    }
                }
                prev_word = word;
                i += len;
            }
            _ => {
                let len = sql[i..].chars().next().map_or(1, char::len_utf8);
                mark(&mut shape, &mut in_statement, i, i + len);
                i += len;
            }
        }
    }
    shape
}

fn line_end(bytes: &[u8], from: usize) -> usize {
    memchr::memchr(b'\n', &bytes[from..]).map_or(bytes.len(), |p| from + p + 1)
}

/// `/*` で始まるコメントの直後の位置。**PostgreSQL のブロックコメントは入れ子になる**
/// （`/* /* */ ; */` は 1 つのコメント）。MySQL は入れ子にしない。閉じていなければ `None`。
fn block_comment_end(engine: Engine, bytes: &[u8], start: usize) -> Option<usize> {
    let mut depth = 0usize;
    let mut i = start;
    while i + 1 < bytes.len() {
        match (bytes[i], bytes[i + 1]) {
            (b'/', b'*') if depth == 0 || engine == Engine::Postgres => {
                depth += 1;
                i += 2;
            }
            (b'*', b'/') => {
                depth -= 1;
                i += 2;
                if depth == 0 {
                    return Some(i);
                }
            }
            _ => i += 1,
        }
    }
    None
}

/// `quote` で始まる引用の直後の位置。引用符の二重化（`''`）を中身として読む。閉じていなければ末尾。
fn quoted_end(bytes: &[u8], start: usize, quote: u8, backslash: bool) -> usize {
    let mut i = start + 1;
    while i < bytes.len() {
        match bytes[i] {
            b'\\' if backslash => i += 2,
            c if c == quote => {
                if bytes.get(i + 1) == Some(&quote) {
                    i += 2;
                } else {
                    return i + 1;
                }
            }
            _ => i += 1,
        }
    }
    bytes.len()
}

/// PostgreSQL のドル引用（`$$...$$` / `$tag$...$tag$`）の直後の位置。`$1` のような引数は引用ではない
/// （`None`）。
fn dollar_end(sql: &str, start: usize) -> Option<usize> {
    let rest = &sql[start + 1..];
    let tag_len = rest
        .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
        .unwrap_or(rest.len());
    let tag = &rest[..tag_len];
    if !rest[tag_len..].starts_with('$') || tag.starts_with(|c: char| c.is_ascii_digit()) {
        return None;
    }
    let open = &sql[start..start + tag_len + 2];
    let body = start + open.len();
    Some(
        sql[body..]
            .find(open)
            .map_or(sql.len(), |p| body + p + open.len()),
    )
}

/// 1 つの値。`None` が NULL。
pub type Cell = Option<String>;

/// 入力された SQL のログ（`OutputMode::Log`）で持ち帰る上限（バイト）。超えたぶんは捨てて
/// `truncated` を立てる（巨大な結果を整列した表で流されても webview が重くならないように）。
/// 改行の来ていない 1 行を溜める上限（`RecordReader::append_pending`）も同じ値。
pub const LOG_MAX_BYTES: usize = 1024 * 1024;

/// クライアントの出力を 1 レコードずつに読む。**行の途中で区切られたバイト列を受けてよい**
/// （コンテナの exec は出力を任意の塊で返す）。改行のバイトは UTF-8 の多バイト文字の途中に
/// 現れないので、改行で切ってから文字列にする。
pub struct RecordReader {
    format: LineFormat,
    pending: Vec<u8>,
    csv: CsvState,
}

/// 出力の読み方（`RecordReader::new` が種類と形から決める）。
#[derive(Clone, Copy)]
enum LineFormat {
    /// `mysql --batch` のタブ区切り。
    MysqlBatch,
    /// PostgreSQL の `COPY ... CSV`。
    PgCsv,
    /// ログ（`OutputMode::Log`）。1 行を 1 つの値のレコードにする。
    Lines,
}

impl RecordReader {
    pub fn new(engine: Engine, mode: OutputMode) -> Self {
        let format = match (mode, engine) {
            (OutputMode::Log, _) => LineFormat::Lines,
            (OutputMode::Records, Engine::Mysql) => LineFormat::MysqlBatch,
            (OutputMode::Records, Engine::Postgres) => LineFormat::PgCsv,
        };
        RecordReader {
            format,
            pending: Vec::new(),
            csv: CsvState::default(),
        }
    }

    pub fn push(&mut self, bytes: &[u8], out: &mut impl FnMut(Vec<Cell>)) {
        // **探すのは届いた塊だけ。** 溜めてある `pending` には改行が残っていないので、溜めたぶんまで
        // 毎回探すと、改行の無い巨大な値（長い TEXT や BLOB）で塊の数の二乗に比例して遅くなる。
        let Some(at) = bytes.iter().rposition(|&b| b == b'\n') else {
            self.append_pending(bytes);
            return;
        };
        self.pending.extend_from_slice(&bytes[..=at]);
        let complete = std::mem::take(&mut self.pending);
        self.append_pending(&bytes[at + 1..]);
        let text = String::from_utf8_lossy(&complete);
        self.feed(&text, out);
    }

    /// 改行の来ていない続きを溜める。**ログの形は 1 行を `LOG_MAX_BYTES` までしか溜めない**（超えたぶんは
    /// 読み捨てる。出力そのものは最後まで読むので、子がパイプに書けずに止まることはない）。ログは
    /// `LogSink` がその上限で切るので、それより先を持っていても見せない。溜めずにいると、
    /// `COPY (SELECT repeat('x', 268435456)) TO STDOUT` の 1 行で 256 MiB を持つ。
    /// **表の形は切らない**（PostgreSQL の CSV は引用符の中の行が崩れ、書き出しは値を丸ごと要る）。
    fn append_pending(&mut self, bytes: &[u8]) {
        let take = match self.format {
            LineFormat::Lines => LOG_MAX_BYTES
                .saturating_sub(self.pending.len())
                .min(bytes.len()),
            LineFormat::MysqlBatch | LineFormat::PgCsv => bytes.len(),
        };
        self.pending.extend_from_slice(&bytes[..take]);
        // 切ったのが文字の途中なら、その文字ごと落とす（残りが U+FFFD に化けないように）。
        // 続きのバイト（`10xxxxxx`）が切った先にあれば、溜めた末尾の文字は欠けている。
        if bytes.get(take).is_some_and(|&b| b & 0xC0 == 0x80) {
            while self.pending.last().is_some_and(|&b| b & 0xC0 == 0x80) {
                self.pending.pop();
            }
            self.pending.pop();
        }
    }

    /// 出力の終わり。最後の行が改行で終わっていなくても読む。
    pub fn finish(&mut self, out: &mut impl FnMut(Vec<Cell>)) {
        if !self.pending.is_empty() {
            let mut text = String::from_utf8_lossy(&std::mem::take(&mut self.pending)).into_owned();
            text.push('\n');
            self.feed(&text, out);
        }
    }

    fn feed(&mut self, text: &str, out: &mut impl FnMut(Vec<Cell>)) {
        // **空の行も 1 行として渡す。** 1 列のテーブルの空文字の値は空の行で出る。
        // 行はどれも改行で終わるので、末尾に余分な空の行はできない。
        let lines = || {
            text.split_inclusive('\n')
                .map(|l| l.trim_end_matches('\n').trim_end_matches('\r'))
        };
        match self.format {
            LineFormat::MysqlBatch => lines().for_each(|l| out(mysql_batch_line(l))),
            LineFormat::PgCsv => self.csv.feed(text, out),
            LineFormat::Lines => lines().for_each(|l| out(vec![Some(l.to_owned())])),
        }
    }
}

/// `mysql --batch` の 1 行。値の `\0` `\t` `\n` `\r` `\\` を戻し、`NULL` を NULL にする。
///
/// **文字列の `'NULL'` も NULL に見える**（batch の出力では区別できない）。`--xml` なら区別
/// できるが、読むのに XML の解析が要るので採らない（`.claude/rules/db.md`）。
pub fn mysql_batch_line(line: &str) -> Vec<Cell> {
    line.split('\t')
        .map(|f| {
            if f == "NULL" {
                return None;
            }
            if !f.contains('\\') {
                return Some(f.to_owned());
            }
            let mut s = String::with_capacity(f.len());
            let mut chars = f.chars();
            while let Some(c) = chars.next() {
                if c != '\\' {
                    s.push(c);
                    continue;
                }
                match chars.next() {
                    Some('0') => s.push('\0'),
                    Some('t') => s.push('\t'),
                    Some('n') => s.push('\n'),
                    Some('r') => s.push('\r'),
                    Some('b') => s.push('\u{8}'),
                    Some(other) => s.push(other),
                    None => s.push('\\'),
                }
            }
            Some(s)
        })
        .collect()
}

/// RFC 4180 の CSV を 1 文字ずつ読む状態。引用符の中の改行は値の一部なので、行をまたいで
/// 続きを持つ。**引用符の無い空の欄が NULL**（`FORCE_QUOTE *` の出力で、空文字は `""`）。
#[derive(Default)]
struct CsvState {
    record: Vec<Cell>,
    field: String,
    /// 今の欄が引用符で始まったか（NULL と空文字の区別）。
    quoted: bool,
    in_quotes: bool,
    /// 引用符の中で `"` を読んだ直後（`""` の 1 つ目か、閉じる引用符か）。
    quote_pending: bool,
}

impl CsvState {
    fn end_field(&mut self) {
        let field = std::mem::take(&mut self.field);
        self.record.push(if self.quoted || !field.is_empty() {
            Some(field)
        } else {
            None
        });
        self.quoted = false;
    }

    fn feed(&mut self, text: &str, out: &mut impl FnMut(Vec<Cell>)) {
        for c in text.chars() {
            if self.in_quotes {
                if self.quote_pending {
                    self.quote_pending = false;
                    if c == '"' {
                        self.field.push('"');
                        continue;
                    }
                    self.in_quotes = false;
                    // 閉じたあとの文字は引用符の外として読む（下へ落とす）。
                } else if c == '"' {
                    self.quote_pending = true;
                    continue;
                } else {
                    self.field.push(c);
                    continue;
                }
            }
            match c {
                ',' => self.end_field(),
                '\n' => {
                    self.end_field();
                    // 空の行も捨てない（1 列のテーブルの NULL は空の行で出る）。
                    out(std::mem::take(&mut self.record));
                }
                '\r' => {}
                '"' if self.field.is_empty() && !self.quoted => {
                    self.in_quotes = true;
                    self.quoted = true;
                }
                _ => self.field.push(c),
            }
        }
    }
}

/// 書き出しの形式。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DumpFormat {
    Csv,
    Tsv,
}

/// 書き出しの 1 行（改行を含む）。**NULL は空の欄**で、CSV では空文字を `""` にして NULL と
/// 区別する（PostgreSQL の `COPY ... CSV` と同じ規則）。引用は CSV プレビューのコピー
/// （`lib/text.ts` の `joinTsv`）と同じで、区切り・引用符・改行を含む値を `"` で囲み、
/// 中の `"` を 2 つ重ねる。
pub fn format_record(format: DumpFormat, cells: &[Cell]) -> String {
    let delim = match format {
        DumpFormat::Csv => ',',
        DumpFormat::Tsv => '\t',
    };
    let mut line = String::new();
    for (i, cell) in cells.iter().enumerate() {
        if i > 0 {
            line.push(delim);
        }
        let Some(v) = cell else { continue };
        let needs_quote =
            v.contains([delim, '"', '\n', '\r']) || (format == DumpFormat::Csv && v.is_empty());
        if needs_quote {
            line.push('"');
            line.push_str(&v.replace('"', "\"\""));
            line.push('"');
        } else {
            line.push_str(v);
        }
    }
    line.push('\n');
    line
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read_all(engine: Engine, chunks: &[&[u8]]) -> Vec<Vec<Cell>> {
        let mut reader = RecordReader::new(engine, OutputMode::Records);
        let mut out = Vec::new();
        for c in chunks {
            reader.push(c, &mut |r| out.push(r));
        }
        reader.finish(&mut |r| out.push(r));
        out
    }

    fn s(v: &str) -> Cell {
        Some(v.to_owned())
    }

    #[test]
    fn idents_double_their_own_quote() {
        assert_eq!(quote_ident(Engine::Mysql, "we`ird"), "`we``ird`");
        assert_eq!(quote_ident(Engine::Postgres, "we\"ird"), "\"we\"\"ird\"");
        // 相手の引用符はそのまま（引用を破れない）。
        assert_eq!(quote_ident(Engine::Mysql, "a\"b"), "`a\"b`");
        assert_eq!(quote_ident(Engine::Postgres, "a`b"), "\"a`b\"");
    }

    #[test]
    fn mysql_literals_are_hex() {
        assert_eq!(string_literal(Engine::Mysql, "t1"), "_utf8mb4 X'7431'");
        assert_eq!(string_literal(Engine::Mysql, "' OR 1=1 -- \\"), {
            let hex: String = "' OR 1=1 -- \\"
                .bytes()
                .map(|b| format!("{b:02X}"))
                .collect();
            format!("_utf8mb4 X'{hex}'")
        });
        assert_eq!(string_literal(Engine::Mysql, ""), "_utf8mb4 X''");
    }

    #[test]
    fn pg_literals_escape_quote_and_backslash() {
        assert_eq!(string_literal(Engine::Postgres, "a'b\\c"), "E'a''b\\\\c'");
    }

    #[test]
    fn current_database_reads_one_cell() {
        // MySQL は DB を選ばずにつなぐと NULL を返す（batch の出力では `NULL`、読むと None）。
        assert_eq!(
            current_database_sql(Engine::Mysql),
            "SELECT DATABASE() AS name"
        );
        let out = read_all(Engine::Mysql, &[b"name\nNULL\n"]);
        assert_eq!(out, vec![vec![s("name")], vec![None]]);
        assert!(
            current_database_sql(Engine::Postgres).starts_with("COPY (SELECT current_database()")
        );
    }

    #[test]
    fn rows_sql_quotes_the_table() {
        assert_eq!(
            rows_sql(Engine::Mysql, None, "a`b", Some(10)),
            "SELECT * FROM `a``b` LIMIT 10"
        );
        assert_eq!(
            rows_sql(Engine::Postgres, Some("public"), "a\"b", None),
            "COPY (SELECT * FROM \"public\".\"a\"\"b\") TO STDOUT WITH (FORMAT csv, HEADER, FORCE_QUOTE *)"
        );
    }

    #[test]
    fn single_column_rows_keep_empty_and_null_values() {
        // 1 列のテーブルの空文字（MySQL）と NULL（PostgreSQL）は空の行で出る。
        let out = read_all(Engine::Mysql, &[b"c\n\na\nNULL\n"]);
        assert_eq!(
            out,
            vec![vec![s("c")], vec![s("")], vec![s("a")], vec![None]]
        );
        let out = read_all(Engine::Postgres, &[b"c\n\"\"\n\n\"a\"\n"]);
        assert_eq!(
            out,
            vec![vec![s("c")], vec![s("")], vec![None], vec![s("a")]]
        );
    }

    #[test]
    fn schema_sql_embeds_the_literal_once() {
        let sql = schema_sql(Engine::Postgres, "x'y");
        assert_eq!(sql.matches("E'x''y'").count(), 1);
        let sql = schema_sql(Engine::Mysql, "t1");
        assert!(sql.contains("TABLE_NAME = _utf8mb4 X'7431'"));
    }

    #[test]
    fn client_args_use_single_words_and_no_password() {
        let conn = ConnArgs {
            host: Some("127.0.0.1"),
            port: Some(3306),
            user: Some("-root"),
            database: None,
        };
        let sql = SqlInput::Arg("SELECT 1");
        let args = client_args(Engine::Mysql, &conn, sql, OutputMode::Records);
        assert!(args.contains(&"--user=-root".to_owned()));
        assert!(args.contains(&"--port=3306".to_owned()));
        assert!(!args.iter().any(|a| a.starts_with("--database")));
        assert_eq!(args.last().unwrap(), "--execute=SELECT 1");

        let pg = |sql, mode| client_args(Engine::Postgres, &ConnArgs::default(), sql, mode);
        let args = pg(sql, OutputMode::Records);
        assert!(args.contains(&"--dbname=postgres".to_owned()));
        assert!(!args.iter().any(|a| a.contains("password")));
        assert_eq!(args.last().unwrap(), "--command=SELECT 1");
        // ログは `-q` を外す（付けるとコマンドの結果が出ない）。MySQL は表と結果を文ごとに出させる。
        assert!(args.contains(&"-q".to_owned()));
        assert!(!pg(sql, OutputMode::Log).contains(&"-q".to_owned()));
        let args = client_args(Engine::Mysql, &conn, sql, OutputMode::Log);
        assert!(args.contains(&"--table".to_owned()) && args.contains(&"-vv".to_owned()));
        // 標準入力なら SQL を引数に載せない（psql は `--file=-` で読む）。
        let args = client_args(Engine::Mysql, &conn, SqlInput::Stdin, OutputMode::Log);
        assert!(!args.iter().any(|a| a.starts_with("--execute")));
        // 標準入力から読む MySQL はクライアントのコマンドを止める。固定の SQL（引数）には付けない。
        assert!(args.contains(&"--binary-mode".to_owned()));
        assert!(args.contains(&"--local-infile=0".to_owned()));
        assert!(
            !client_args(Engine::Mysql, &conn, sql, OutputMode::Log)
                .contains(&"--binary-mode".to_owned())
        );
        assert_eq!(
            pg(SqlInput::Stdin, OutputMode::Log).last().unwrap(),
            "--file=-"
        );
    }

    #[test]
    fn client_commands_are_found_outside_literals() {
        let cmd = |e, s| client_command(e, s);
        // psql のメタコマンド（`\!` はシェルを起こす）。
        assert_eq!(
            cmd(Engine::Postgres, "SELECT 1;\n\\! whoami"),
            Some("\\!".to_owned())
        );
        assert_eq!(
            cmd(Engine::Postgres, "SELECT 1 \\gexec"),
            Some("\\g".to_owned())
        );
        // 文字列・引用・コメントの中の `\` は SQL の一部。
        assert_eq!(
            cmd(Engine::Postgres, r"SELECT E'\n', '\', $$\!$$ -- \!"),
            None
        );
        assert_eq!(
            cmd(Engine::Mysql, r"SELECT 'a\'b', `x\y` /* \! */ # \!"),
            None
        );
        // MySQL の名前の付いたコマンドは文の頭だけ（文の途中の行頭は列名）。
        assert_eq!(
            cmd(Engine::Mysql, "SELECT id,\n  source\nFROM events"),
            None
        );
        assert_eq!(
            cmd(Engine::Mysql, "SELECT 1;\nsystem id"),
            Some("system".to_owned())
        );
        assert_eq!(
            cmd(Engine::Mysql, "SELECT 1; SOURCE /etc/x.sql"),
            Some("source".to_owned())
        );
        assert_eq!(cmd(Engine::Mysql, "\\! id"), Some("\\!".to_owned()));
        assert_eq!(cmd(Engine::Mysql, "SELECT system, source FROM t"), None);
        assert_eq!(cmd(Engine::Postgres, "system id"), None);
    }

    #[test]
    fn psql_scripts_start_restricted() {
        assert_eq!(
            restricted_script("SELECT 1;", "k1"),
            "\\restrict k1\nSELECT 1;"
        );
        // 古い psql は 1 行目で失敗する（実行されない）。
        let old = "psql:<stdin>:1: error: invalid command \\restrict";
        assert!(restrict_unsupported(Engine::Postgres, old));
        assert!(!restrict_unsupported(
            Engine::Postgres,
            "psql:<stdin>:4: error: backslash commands are restricted; only \\unrestrict is allowed"
        ));
        // 利用者の文字列がサーバーのエラーに写っても、古い psql とは見なさない。
        assert!(!restrict_unsupported(
            Engine::Postgres,
            "psql:<stdin>:2: ERROR:  23514: new row violates check constraint\nDETAIL:  Failing row contains (\\restrict)."
        ));
        // 行番号は足した 1 行ぶん戻す。
        assert_eq!(
            unshift_stdin_lines("psql:<stdin>:4: ERROR:  x\npsql:<stdin>:12: ERROR:  y"),
            "psql:<stdin>:3: ERROR:  x\npsql:<stdin>:11: ERROR:  y"
        );
        assert_eq!(unshift_stdin_lines("ERROR 1064"), "ERROR 1064");
        // 表の形では外す（`LINE n:` が入力どおりの行を言う）。
        assert_eq!(
            strip_stdin_lines("psql:<stdin>:4: ERROR:  x\nLINE 3: SELECT"),
            "ERROR:  x\nLINE 3: SELECT"
        );
    }

    #[test]
    fn pg_e_prefix_needs_a_word_boundary() {
        // `foo$E'...'` の `E` は識別子の続きで、`\` を逃がさない（閉じたあとの `\!` を見つける）。
        assert_eq!(
            client_command(Engine::Postgres, "SELECT foo$E'\\'\n\\! echo pike\n'"),
            Some("\\!".to_owned())
        );
    }

    #[test]
    fn mysql_writes_behind_a_select_word_are_scripts() {
        use UserSql::{Query, Script};
        let plan = |s| plan_user_sql(Engine::Mysql, s);
        assert_eq!(
            plan("WITH c AS (SELECT 1 AS id) UPDATE t SET f = 1 WHERE id IN (SELECT id FROM c)"),
            Some(Script)
        );
        assert_eq!(plan("SELECT COUNT(*) INTO @n FROM t"), Some(Script));
        // `FOR UPDATE` は行を返す。
        let q = "SELECT * FROM t WHERE id = 1 FOR UPDATE";
        assert_eq!(plan(q), Some(Query(q.to_owned())));
        // 括弧の中と関数の呼び出しは書き込みではない。
        let q = "WITH c AS (SELECT 1) SELECT REPLACE(name, 'a', 'b') FROM c";
        assert_eq!(plan(q), Some(Query(q.to_owned())));
        // PostgreSQL は `COPY` が拒んだら流し直すので、ここでは見分けない。
        assert!(matches!(
            plan_user_sql(Engine::Postgres, "WITH c AS (SELECT 1) UPDATE t SET f = 1"),
            Some(Query(_))
        ));
    }

    #[test]
    fn user_sql_shows_a_single_query_as_a_table() {
        use UserSql::{Query, Script};
        let plan = |e, s| plan_user_sql(e, s);
        assert_eq!(plan(Engine::Mysql, " \n-- c\n"), None);
        assert_eq!(plan(Engine::Mysql, ";;"), None);
        // 末尾の `;` とコメントは落とす。
        assert_eq!(
            plan(Engine::Mysql, "select * from t; -- all\n"),
            Some(Query("select * from t".to_owned()))
        );
        assert_eq!(
            plan(Engine::Mysql, "(SELECT 1) UNION (SELECT 2)"),
            Some(Query("(SELECT 1) UNION (SELECT 2)".to_owned()))
        );
        assert_eq!(
            plan(Engine::Postgres, "/* x */ SELECT 1 -- one"),
            Some(Query(pg_copy("SELECT 1\n")))
        );
        assert_eq!(
            plan(Engine::Mysql, "SHOW TABLES"),
            Some(Query("SHOW TABLES".to_owned()))
        );
        // PostgreSQL の SHOW は COPY で包めない。
        assert_eq!(plan(Engine::Postgres, "SHOW TimeZone"), Some(Script));
        assert_eq!(plan(Engine::Mysql, "CREATE TABLE t (a int)"), Some(Script));
        assert_eq!(plan(Engine::Mysql, "SELECT 1; SELECT 2"), Some(Script));
    }

    #[test]
    fn user_sql_skips_semicolons_in_strings_and_comments() {
        let shape = |e, s| sql_shape(e, s).statements;
        assert_eq!(
            shape(Engine::Mysql, "SELECT ';' , `a;b`, \"c;\" /* ; */ # ;\n"),
            1
        );
        assert_eq!(shape(Engine::Mysql, r"SELECT 'it\'s;'"), 1);
        assert_eq!(shape(Engine::Postgres, "SELECT 'it''s;', \"a;\" -- ;"), 1);
        assert_eq!(shape(Engine::Postgres, r"SELECT E'\';'"), 1);
        // 標準の文字列では `\` は逃がさない（`'\'` で閉じる）。
        assert_eq!(shape(Engine::Postgres, r"SELECT '\'; SELECT 2"), 2);
        assert_eq!(
            shape(
                Engine::Postgres,
                "CREATE FUNCTION f() RETURNS int AS $b$ SELECT 1; $b$ LANGUAGE sql; SELECT $1"
            ),
            2
        );
        // MySQL の `--` は後ろに空白が要る（`1--1` は引き算）。
        let s = sql_shape(Engine::Mysql, "SELECT 1--1");
        assert_eq!(s.body_end, "SELECT 1--1".len());
        assert_eq!(
            sql_shape(Engine::Postgres, "SELECT 1--1").body_end,
            "SELECT 1".len()
        );
    }

    #[test]
    fn user_sql_keeps_the_text_the_server_runs() {
        use UserSql::{Query, Script};
        // 先頭の空の文は落とす（MySQL は `No query specified` で拒み、COPY の中では構文エラー）。
        assert_eq!(
            plan_user_sql(Engine::Mysql, ";\n SELECT 1"),
            Some(Query("SELECT 1".to_owned()))
        );
        // 文の最初の行は `COPY (` と同じ行（`LINE n:` を文の中の行番号にする）。
        assert_eq!(
            plan_user_sql(Engine::Postgres, "; SELECT 1;"),
            Some(Query(pg_copy("SELECT 1\n")))
        );
        // MySQL の実行されるコメントは中身（落とすと WHERE が消える）。
        let sql = "SELECT * FROM t /*!50000 WHERE id = 1 */";
        assert_eq!(
            plan_user_sql(Engine::Mysql, sql),
            Some(Query(sql.to_owned()))
        );
        assert_eq!(
            plan_user_sql(Engine::Mysql, "/*!40101 SET NAMES utf8 */;"),
            Some(Script)
        );
        assert_eq!(
            plan_user_sql(Engine::Mysql, "/*M!100100 SET a=1 */"),
            Some(Script)
        );
        // ただのコメントは落とす。
        assert_eq!(plan_user_sql(Engine::Mysql, "/* c */"), None);
        // 閉じていないコメントは中身として残す（クライアントが構文エラーで返す）。
        let sql = "SELECT nextval('seq') /* unfinished";
        assert_eq!(
            plan_user_sql(Engine::Postgres, sql),
            Some(Query(pg_copy(&format!("{sql}\n"))))
        );
        assert_eq!(
            plan_user_sql(Engine::Postgres, "/* /* */ SELECT 1"),
            Some(Script)
        );
    }

    #[test]
    fn pg_lexer_follows_identifiers_and_nested_comments() {
        let count = |s| sql_shape(Engine::Postgres, s).statements;
        // 識別子の中の `$` はドル引用ではない。
        assert_eq!(count("SELECT foo$x$ FROM t; DROP TABLE u"), 2);
        // 識別子の末尾の `E` は `E'...'` の接頭辞ではない（`\` で逃がさない）。
        assert_eq!(count(r"SELECT 1 WHERE a LIKE'x\'; SELECT 2"), 2);
        // ブロックコメントは入れ子になる。
        assert_eq!(count("/* /* */ ; */ SELECT 1"), 1);
        // MySQL は入れ子にしない（最初の `*/` で閉じる）。
        assert_eq!(sql_shape(Engine::Mysql, "/* /* */ SELECT 1").statements, 1);
    }

    #[test]
    fn copy_rejections_are_recognized() {
        // `VERBOSITY=verbose` の実際の出力（postgres 18 で取ったもの）。
        let err = "ERROR:  0A000: COPY query must have a RETURNING clause\nLOCATION:  BeginCopyTo, copyto.c:792";
        assert!(copy_rejected(Engine::Postgres, err));
        assert!(!copy_rejected(Engine::Mysql, err));
        // 本文が翻訳されていても、SQLSTATE と関数名で分かる。
        assert!(copy_rejected(
            Engine::Postgres,
            "ERROR:  0A000: (翻訳された本文)\n場所:  BeginCopyTo, copyto.c:792"
        ));
        let other = "ERROR:  42P01: relation \"nope\" does not exist\nLOCATION:  parserOpenTable, parse_relation.c:1498";
        assert!(!copy_rejected(Engine::Postgres, other));
    }

    #[test]
    fn tidy_error_drops_the_source_location() {
        let err = "ERROR:  42P01: relation \"nope\" does not exist\nLINE 2: SELECT * FROM nope\n                      ^\nLOCATION:  parserOpenTable, parse_relation.c:1498";
        assert_eq!(
            tidy_error(err),
            "ERROR:  42P01: relation \"nope\" does not exist\nLINE 2: SELECT * FROM nope\n                      ^"
        );
        // 字句の段階の警告は `scan.l` から来る。
        assert_eq!(
            tidy_error("WARNING:  22P06: x\nLOCATION:  check_string_escape_warning, scan.l:1429"),
            "WARNING:  22P06: x"
        );
        // MySQL のエラーはそのまま。
        let my =
            "ERROR 1064 (42000) at line 1: You have an error in your SQL syntax near 'a, b.c:1'";
        assert_eq!(tidy_error(my), my);
    }

    #[test]
    fn log_mode_reads_one_line_per_record() {
        let mut reader = RecordReader::new(Engine::Postgres, OutputMode::Log);
        let mut out = Vec::new();
        reader.push(b"UPDATE 2\n a, b \n\nCREATE", &mut |r| out.push(r));
        reader.finish(&mut |r| out.push(r));
        assert_eq!(
            out,
            vec![
                vec![s("UPDATE 2")],
                vec![s(" a, b ")],
                vec![s("")],
                vec![s("CREATE")]
            ]
        );
    }

    #[test]
    fn log_mode_caps_a_long_line_before_buffering() {
        // 改行の無い 3 MiB を 64 KiB ずつ渡しても、溜めるのは上限まで。次の行は読む。
        let mut reader = RecordReader::new(Engine::Postgres, OutputMode::Log);
        let chunk = vec![b'x'; 64 * 1024];
        for _ in 0..48 {
            reader.push(&chunk, &mut |_| {});
        }
        assert_eq!(reader.pending.len(), LOG_MAX_BYTES);
        let mut out = Vec::new();
        reader.push(b"\nnext\n", &mut |r| out.push(r));
        assert_eq!(out.len(), 2);
        assert_eq!(out[0][0].as_deref().map(str::len), Some(LOG_MAX_BYTES));
        assert_eq!(out[1], vec![s("next")]);
        // 上限が文字の途中に当たったら、その文字ごと落とす（置換文字に化けない）。
        let mut reader = RecordReader::new(Engine::Postgres, OutputMode::Log);
        let jp = "あ".repeat(LOG_MAX_BYTES / 3 + 1);
        reader.push(jp.as_bytes(), &mut |_| {});
        let mut out = Vec::new();
        reader.push(b"\n", &mut |r| out.push(r));
        let line = out[0][0].as_deref().unwrap();
        assert!(line.chars().all(|c| c == 'あ') && line.len() <= LOG_MAX_BYTES);
        // 表の形は切らない（値を丸ごと要る）。
        let mut reader = RecordReader::new(Engine::Mysql, OutputMode::Records);
        for _ in 0..48 {
            reader.push(&chunk, &mut |_| {});
        }
        assert_eq!(reader.pending.len(), 48 * 64 * 1024);
    }

    #[test]
    fn mysql_batch_unescapes_and_reads_null() {
        // `mysql --batch` の実際の出力（mysql:8 で取ったもの）。
        let out = read_all(
            Engine::Mysql,
            &[b"id\tname\tnote\n1\ta\tNULL\n2\ttab\\there\tline1\\nline2\n3\tNULL\t\n4\tba\\\\ck\t\\0x\n"],
        );
        assert_eq!(out[0], vec![s("id"), s("name"), s("note")]);
        assert_eq!(out[1], vec![s("1"), s("a"), None]);
        assert_eq!(out[2], vec![s("2"), s("tab\there"), s("line1\nline2")]);
        assert_eq!(out[3], vec![s("3"), None, s("")]);
        assert_eq!(out[4], vec![s("4"), s("ba\\ck"), s("\0x")]);
    }

    #[test]
    fn a_long_line_without_newlines_is_read_once() {
        // 改行の無い 8MB の値を 64KB ずつ渡す（コンテナの exec と同じ届き方）。改行を探すのは届いた
        // 塊だけなので、溜めた値の途中で行を割ったり、塊をまたぐ改行を取りこぼしたりしない。
        let value = "x".repeat(8 * 1024 * 1024);
        let body = format!("c\n{value}\nend\n");
        let chunks: Vec<&[u8]> = body.as_bytes().chunks(64 * 1024).collect();
        let out = read_all(Engine::Mysql, &chunks);
        assert_eq!(out.len(), 3);
        assert_eq!(out[0], vec![s("c")]);
        assert_eq!(out[1][0].as_deref().map(str::len), Some(value.len()));
        assert_eq!(out[2], vec![s("end")]);
    }

    #[test]
    fn mysql_lines_split_across_chunks() {
        let out = read_all(
            Engine::Mysql,
            &[
                b"a\tb\r\n1\t",
                "日".as_bytes()[..2].as_ref(),
                &"日".as_bytes()[2..],
                b"\n2\tx",
            ],
        );
        assert_eq!(
            out,
            vec![
                vec![s("a"), s("b")],
                vec![s("1"), s("日")],
                vec![s("2"), s("x")]
            ]
        );
    }

    #[test]
    fn pg_csv_tells_null_from_empty_and_keeps_newlines() {
        // `COPY ... (FORMAT csv, HEADER, FORCE_QUOTE *)` の実際の出力（postgres:16 で取ったもの）。
        let text = "id,name,note,bin\n\"1\",\"a\",,\n\"2\",\"tab\there\",\"line1\nline2\",\"\\x00ff41\"\n\"3\",\"NULL\",\"\",\n\"4\",\"quo\"\"te,comma\",\"x\",\n";
        // 引用符の中の改行をまたぐ位置で割って渡す。
        let bytes = text.as_bytes();
        let cut = text.find("line1").unwrap() + 6;
        let out = read_all(Engine::Postgres, &[&bytes[..cut], &bytes[cut..]]);
        assert_eq!(out[0], vec![s("id"), s("name"), s("note"), s("bin")]);
        assert_eq!(out[1], vec![s("1"), s("a"), None, None]);
        assert_eq!(
            out[2],
            vec![s("2"), s("tab\there"), s("line1\nline2"), s("\\x00ff41")]
        );
        assert_eq!(out[3], vec![s("3"), s("NULL"), s(""), None]);
        assert_eq!(out[4], vec![s("4"), s("quo\"te,comma"), s("x"), None]);
        assert_eq!(out.len(), 5);
    }

    #[test]
    fn records_format_for_csv_and_tsv() {
        let cells = vec![s("1"), None, s(""), s("a,b"), s("q\"t"), s("t\tx")];
        assert_eq!(
            format_record(DumpFormat::Csv, &cells),
            "1,,\"\",\"a,b\",\"q\"\"t\",t\tx\n"
        );
        assert_eq!(
            format_record(DumpFormat::Tsv, &cells),
            "1\t\t\ta,b\t\"q\"\"t\"\t\"t\tx\"\n"
        );
    }
}
