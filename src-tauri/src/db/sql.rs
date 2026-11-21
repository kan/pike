//! DB ビューワ（#632）の純粋な部分: 発行する SQL、識別子と文字列の引用、クライアントの
//! 引数、出力の読み方、書き出しの整形。**外部プロセスに触らない**ので単体テストを置く。
//!
//! **発行する SQL はここにある固定のものだけ。** 任意の SQL を受ける口は無く、外から入る
//! 文字列はテーブル名だけで、それも呼び出し側（`mod.rs`）が一覧に有ることを確かめてから
//! `quote_ident` / `string_literal` を通して埋める。

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

/// クライアントの引数（プログラム名は含めない）。値は `--name=value` の 1 語で渡す
/// （`-` で始まる値を別のオプションと読ませない）。シェルを挟まずに argv で渡るので、
/// 値の中身による注入は起きない。
pub fn client_args(engine: Engine, conn: &ConnArgs, sql: &str) -> Vec<String> {
    let mut args: Vec<String> = match engine {
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
        // `-w` はパスワードを聞かない（標準入力は閉じてあるので、聞かれると失敗で返る
        // だけだが、待たずに済む）。
        Engine::Postgres => vec!["-X", "-q", "-w", "-v", "ON_ERROR_STOP=1"],
    }
    .into_iter()
    .map(str::to_owned)
    .collect();
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
            args.push(format!("--execute={sql}"));
        }
        Engine::Postgres => {
            // DB 名を省くと psql はユーザー名と同じ DB へつなぐ。DB の一覧を取るときなど、
            // 名前が決まっていないときは必ずある `postgres` へつなぐ。
            let db = conn.database.unwrap_or("postgres");
            args.push(format!("--dbname={db}"));
            args.push(format!("--command={sql}"));
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

/// 1 つの値。`None` が NULL。
pub type Cell = Option<String>;

/// クライアントの出力を 1 レコードずつに読む。**行の途中で区切られたバイト列を受けてよい**
/// （コンテナの exec は出力を任意の塊で返す）。改行のバイトは UTF-8 の多バイト文字の途中に
/// 現れないので、改行で切ってから文字列にする。
pub struct RecordReader {
    engine: Engine,
    pending: Vec<u8>,
    csv: CsvState,
}

impl RecordReader {
    pub fn new(engine: Engine) -> Self {
        RecordReader {
            engine,
            pending: Vec::new(),
            csv: CsvState::default(),
        }
    }

    pub fn push(&mut self, bytes: &[u8], out: &mut impl FnMut(Vec<Cell>)) {
        // **探すのは届いた塊だけ。** 溜めてある `pending` には改行が残っていないので、溜めたぶんまで
        // 毎回探すと、改行の無い巨大な値（長い TEXT や BLOB）で塊の数の二乗に比例して遅くなる。
        let Some(at) = bytes.iter().rposition(|&b| b == b'\n') else {
            self.pending.extend_from_slice(bytes);
            return;
        };
        let last_nl = self.pending.len() + at;
        self.pending.extend_from_slice(bytes);
        let rest = self.pending.split_off(last_nl + 1);
        let complete = std::mem::replace(&mut self.pending, rest);
        let text = String::from_utf8_lossy(&complete);
        self.feed(&text, out);
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
        match self.engine {
            Engine::Mysql => {
                // **空の行も 1 行として渡す。** 1 列のテーブルの空文字の値は空の行で出る。
                // 行はどれも改行で終わるので、末尾に余分な空の行はできない。
                for line in text.split_inclusive('\n') {
                    let line = line.trim_end_matches('\n').trim_end_matches('\r');
                    out(mysql_batch_line(line));
                }
            }
            Engine::Postgres => self.csv.feed(text, out),
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
        let mut reader = RecordReader::new(engine);
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
        let args = client_args(Engine::Mysql, &conn, "SELECT 1");
        assert!(args.contains(&"--user=-root".to_owned()));
        assert!(args.contains(&"--port=3306".to_owned()));
        assert!(!args.iter().any(|a| a.starts_with("--database")));
        assert_eq!(args.last().unwrap(), "--execute=SELECT 1");

        let args = client_args(Engine::Postgres, &ConnArgs::default(), "SELECT 1");
        assert!(args.contains(&"--dbname=postgres".to_owned()));
        assert!(!args.iter().any(|a| a.contains("password")));
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
