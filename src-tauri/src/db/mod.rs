//! 簡易 DB ビューワ（#632）。MySQL / PostgreSQL のテーブルの一覧・中身・列の定義を見て、
//! テーブルを CSV / TSV に書き出す。
//!
//! **DB ドライバのクレートは入れず、接続先の環境にある `mysql` / `psql` を起こす**（Rust は
//! コマンドを組んで出力を読むだけ）。経路は 2 つ:
//!
//! - **コンテナ**: bollard の exec（`docker exec` と同じ）でコンテナの中のクライアントを使う。
//!   ホストにクライアントも Docker の CLI も要らない。ユーザー名・パスワード・DB 名は
//!   コンテナの環境変数（`MYSQL_*` / `MARIADB_*` / `POSTGRES_*`）から読む
//! - **シェル**: プロジェクトのシェルの環境（ホスト・WSL）でクライアントを起こす。WSL は
//!   `wsl.exe -d <distro>` 経由なので、WSL の中の DB に Windows から TCP で届くかを考えなくてよい
//!
//! パスワードは引数に載せず、`MYSQL_PWD` / `PGPASSWORD` で渡す。一覧・スキーマ・レコードで
//! 発行する SQL は `sql.rs` にある固定のもので、外から入るテーブル名は一覧に有ることを確かめてから
//! 引用して埋める。利用者が入力した SQL は `db_execute`（#646）だけが受ける。
//! 判断の記録は `.claude/rules/db.md`。

pub mod sql;

use crate::docker::{DockerState, get_docker};
use crate::types::{
    DEFAULT_TIMEOUT, STDERR_KEEP_MAX, ShellConfig, WSL_EXTRA_PATH, drain_stderr, truncate_chars,
    wait_with_timeout,
};
use bollard::Docker;
use bollard::container::LogOutput;
use bollard::exec::{CreateExecOptions, StartExecResults};
use bollard::query_parameters::InspectContainerOptions;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sql::{Cell, ConnArgs, DumpFormat, Engine, OutputMode, RecordReader, SqlInput, UserSql};
use std::io::{Read, Write};
use std::process::Stdio;
use std::time::Duration;
use tauri::State;

/// 中身の表示で読む行数の上限。**全件は持ってこない**（`LIMIT` で切る）。全体は書き出しで得る。
const ROW_LIMIT: usize = 2000;

/// 表示する 1 つの値の上限（文字数）。巨大な TEXT や BLOB で表が重くならないように切る。
/// 書き出しでは切らない。
const CELL_MAX_CHARS: usize = 1000;

/// 書き出しに待てる時間。表示（`DEFAULT_TIMEOUT` の 30 秒）では大きなテーブルが切れるので別に持つ。
const DUMP_TIMEOUT: Duration = Duration::from_secs(600);

/// 入力された SQL（#646）に待てる時間。大きなテーブルの `ALTER` や重い集計は 30 秒を超えうるので、
/// 書き出しと同じだけ待つ。
const EXEC_TIMEOUT: Duration = DUMP_TIMEOUT;

/// 入力された SQL のログ（`OutputMode::Log`）で持ち帰る上限（バイト）。超えたぶんは捨てて
/// `truncated` を立てる（巨大な結果を整列した表で流されても webview が重くならないように）。
const LOG_MAX_BYTES: usize = 1024 * 1024;

/// クライアントが見つからないときのエラーの接頭辞。フロント（`lib/dbViewer.ts`）がこれを見て
/// 「`mysql` が見つからない」と出す。
const CLIENT_NOT_FOUND: &str = "db-client-not-found:";

/// コンテナの経路で、標準入力へ流す SQL を渡す環境変数の接頭辞（`run_container`。`PIKE_SQL_0` ...）。
const STDIN_ENV: &str = "PIKE_SQL";

/// 環境変数 1 つに入れる SQL の大きさ（バイト）。Linux の上限（1 つ 128 KiB）の半分。
const STDIN_CHUNK: usize = 64 * 1024;

/// コンテナの経路で渡せる SQL の大きさ（バイト）。execve の引数と環境変数の合計（2 MiB ほど）に収める。
const CONTAINER_SQL_MAX: usize = 1024 * 1024;

/// SQL が長すぎるときのエラーの接頭辞（後ろに上限のバイト数）。フロント（`lib/dbViewer.ts`）が文言にする。
const SQL_TOO_LONG: &str = "db-sql-too-long:";

/// 入力した SQL にクライアントのコマンドがあったときのエラーの接頭辞（後ろにコマンド）。
const CLIENT_COMMAND: &str = "db-client-command:";

/// psql が古く、`\restrict` が無いので入力した SQL を実行しなかったときのエラー（`sql::restricted_script`）。
const PSQL_NO_RESTRICT: &str = "db-psql-no-restrict";

/// コンテナに `sh` が無く、入力した SQL を流し込めなかったときのエラー（`run_container`）。
const CONTAINER_SH_NOT_FOUND: &str = "db-container-sh-not-found";

/// `s` を `max` バイト以下の塊に分ける（文字の途中では切らない）。
fn split_at_char_boundaries(s: &str, max: usize) -> Vec<&str> {
    let mut out = Vec::new();
    let mut rest = s;
    while !rest.is_empty() {
        let mut end = rest.len().min(max);
        while !rest.is_char_boundary(end) {
            end -= 1;
        }
        let (head, tail) = rest.split_at(end);
        out.push(head);
        rest = tail;
    }
    out
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DbVia {
    #[serde(rename_all = "camelCase")]
    Container {
        container_id: String,
    },
    Shell {
        shell: ShellConfig,
    },
}

/// 接続先。空文字の欄は「指定なし」（コンテナなら環境変数の値、シェルならクライアントの既定）。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbTarget {
    engine: Engine,
    via: DbVia,
    #[serde(default)]
    host: Option<String>,
    #[serde(default)]
    port: Option<u16>,
    #[serde(default)]
    user: Option<String>,
    #[serde(default)]
    password: Option<String>,
    #[serde(default)]
    database: Option<String>,
}

/// 結果の表。`truncated` は `ROW_LIMIT` で切ったか。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbResult {
    columns: Vec<String>,
    rows: Vec<Vec<Cell>>,
    truncated: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbTable {
    name: String,
    kind: String,
    approx_rows: Option<u64>,
    /// PostgreSQL のスキーマ（中身を引くときに修飾する。`sql::rows_sql`）。MySQL は持たない。
    #[serde(skip)]
    schema: Option<String>,
}

/// コンテナの環境変数から読んだ既定。**パスワードそのものはフロントへ返さない**（実行の
/// たびに Rust が読み直して環境変数で渡す）。
#[derive(Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerDefaults {
    user: Option<String>,
    database: Option<String>,
    has_password: bool,
    #[serde(skip)]
    password: Option<String>,
}

/// 環境変数（`NAME=value` の並び）から接続の既定を読む。MariaDB の公式イメージは
/// `MARIADB_*` を正とし、`MYSQL_*` も受ける。**アプリ用のユーザーがあればそちらを使う**
/// （root のパスワードが乱数のこともある）。無ければ root。
fn container_defaults(env: &[String], engine: Engine) -> ContainerDefaults {
    let get = |names: &[&str]| {
        names.iter().find_map(|n| {
            env.iter()
                .find_map(|kv| kv.strip_prefix(n)?.strip_prefix('='))
                .filter(|v| !v.is_empty())
                .map(str::to_owned)
        })
    };
    let (user, password, database) = match engine {
        Engine::Mysql => {
            let database = get(&["MARIADB_DATABASE", "MYSQL_DATABASE"]);
            match get(&["MARIADB_USER", "MYSQL_USER"]) {
                Some(user) => (user, get(&["MARIADB_PASSWORD", "MYSQL_PASSWORD"]), database),
                None => (
                    "root".to_owned(),
                    get(&["MARIADB_ROOT_PASSWORD", "MYSQL_ROOT_PASSWORD"]),
                    database,
                ),
            }
        }
        Engine::Postgres => {
            let user = get(&["POSTGRES_USER"]).unwrap_or_else(|| "postgres".to_owned());
            // `POSTGRES_DB` を省くとユーザー名と同じ名前の DB が作られる（公式イメージ）。
            let database = get(&["POSTGRES_DB"]).or_else(|| Some(user.clone()));
            (user, get(&["POSTGRES_PASSWORD"]), database)
        }
    };
    ContainerDefaults {
        user: Some(user),
        database,
        has_password: password.is_some(),
        password,
    }
}

/// 受け取った行の行き先。表示は集めて返し、書き出しはファイルへ流す（フロントを経由させない）。
trait Sink: Send + 'static {
    /// `record` が同期の I/O をするか（async のワーカーから呼ぶときに逃がす）。
    const BLOCKING: bool = false;
    fn record(&mut self, cells: Vec<Cell>) -> std::io::Result<()>;
}

/// 表示用に集める。1 行目が見出し。値は `CELL_MAX_CHARS` で切る。
///
/// `limit` は表示する行数で、**持つのは 1 行多くまで**（超えたかで切ったことを知る）。テーブルの
/// レコードは SQL の `LIMIT` で絞るが、入力された SQL（#646）は絞れないので、ここで持たずに読み捨てる。
#[derive(Default)]
struct Collect {
    limit: Option<usize>,
    columns: Option<Vec<String>>,
    rows: Vec<Vec<Cell>>,
}

impl Sink for Collect {
    fn record(&mut self, cells: Vec<Cell>) -> std::io::Result<()> {
        if self.columns.is_none() {
            self.columns = Some(cells.into_iter().map(Option::unwrap_or_default).collect());
        } else if self.limit.is_none_or(|n| self.rows.len() <= n) {
            let clipped = cells.into_iter().map(|c| {
                c.map(|v| {
                    if v.len() > CELL_MAX_CHARS {
                        truncate_chars(&v, CELL_MAX_CHARS)
                    } else {
                        v
                    }
                })
            });
            self.rows.push(clipped.collect());
        }
        Ok(())
    }
}

impl Collect {
    fn new(limit: Option<usize>) -> Self {
        Collect {
            limit,
            ..Default::default()
        }
    }

    fn into_result(self) -> DbResult {
        let mut rows = self.rows;
        let truncated = self.limit.is_some_and(|n| rows.len() > n);
        if let Some(n) = self.limit {
            rows.truncate(n);
        }
        DbResult {
            columns: self.columns.unwrap_or_default(),
            rows,
            truncated,
        }
    }
}

/// ファイルへ書く。見出しも 1 行目に書く。
struct FileSink {
    out: std::io::BufWriter<std::fs::File>,
    format: DumpFormat,
    records: u64,
}

impl Sink for FileSink {
    const BLOCKING: bool = true;

    fn record(&mut self, cells: Vec<Cell>) -> std::io::Result<()> {
        self.records += 1;
        self.out
            .write_all(sql::format_record(self.format, &cells).as_bytes())
    }
}

/// ログ（`OutputMode::Log`）を集める。1 行が 1 つの値のレコードで届く（`RecordReader`）。
#[derive(Default)]
struct LogSink {
    text: String,
    truncated: bool,
}

impl Sink for LogSink {
    fn record(&mut self, cells: Vec<Cell>) -> std::io::Result<()> {
        if self.truncated {
            return Ok(());
        }
        let line = cells.into_iter().next().flatten().unwrap_or_default();
        // 改行も含めて比べる（空の行でも 1 バイト足すので、上限に達したら打ち切る）。
        let room = LOG_MAX_BYTES.saturating_sub(self.text.len());
        if line.len() < room {
            self.text.push_str(&line);
            self.text.push('\n');
        } else {
            // 入り切らない行は、入るぶんだけ（文字の途中で切らずに）残す。捨てると、最初の行が長いだけで
            // ログが空になり「出力はありません」と見える。
            let mut end = room.saturating_sub(1).min(line.len());
            while !line.is_char_boundary(end) {
                end -= 1;
            }
            self.text.push_str(&line[..end]);
            self.truncated = true;
        }
        Ok(())
    }
}

impl LogSink {
    /// 末尾の空行と、`mysql -vv` が最後に出す `Bye` の行を落とす（実測）。落とすのは MySQL で、
    /// 最後の行がちょうど `Bye` のときだけ（PostgreSQL の表の値が `Bye` で終わっても削らない）。
    fn into_text(self, engine: Engine) -> (String, bool) {
        let text = self.text.trim_end();
        let text = match (engine, text.rsplit_once('\n')) {
            (Engine::Mysql, Some((rest, "Bye"))) => rest.trim_end(),
            (Engine::Mysql, None) if text == "Bye" => "",
            _ => text,
        };
        (text.to_owned(), self.truncated)
    }
}

/// 1 回の実行の結果。どれも sink を持ち帰る（次の候補を試すときと、失敗までのログを見せるときに使う）。
enum Outcome<S> {
    /// 成功。stderr も持ち帰る（psql の NOTICE / WARNING は成功しても stderr に出る）。
    Done(S, String),
    /// そのクライアントが無い（次の候補を試す）。
    Missing(S),
    /// クライアントがエラーで終わった（stderr か終了コード）。
    Failed(S, String),
}

/// 126 / 127 は「実行できない / 見つからない」（コンテナの exec と、WSL で挟む `sh` が返す。
/// mariadb:11 の `mysql` で 127 を実測）。
fn is_missing(code: i64) -> bool {
    code == 126 || code == 127
}

/// 終了コードと stderr から結果を決める。
fn conclude<S>(
    sink: S,
    code: i64,
    stderr: &str,
    sink_err: Option<std::io::Error>,
) -> Result<Outcome<S>, String> {
    if is_missing(code) {
        return Ok(Outcome::Missing(sink));
    }
    if let Some(e) = sink_err {
        return Err(e.to_string());
    }
    if code != 0 {
        let msg = stderr.trim();
        let msg = if msg.is_empty() {
            format!("exit code {code}")
        } else {
            msg.to_owned()
        };
        return Ok(Outcome::Failed(sink, msg));
    }
    Ok(Outcome::Done(sink, stderr.trim().to_owned()))
}

/// 出力を読んで sink へ渡す。sink の失敗（書き込めない）は覚えておき、出力は最後まで読む
/// （途中で読むのをやめると、子がパイプに書けずに止まる）。
struct Feeder<S> {
    reader: RecordReader,
    sink: S,
    err: Option<std::io::Error>,
}

impl<S: Sink> Feeder<S> {
    fn new(reader: RecordReader, sink: S) -> Self {
        Feeder {
            reader,
            sink,
            err: None,
        }
    }

    fn push(&mut self, bytes: &[u8]) {
        let (sink, err) = (&mut self.sink, &mut self.err);
        self.reader.push(bytes, &mut |r| deliver(sink, err, r));
    }

    fn finish(mut self) -> (S, Option<std::io::Error>) {
        let (sink, err) = (&mut self.sink, &mut self.err);
        self.reader.finish(&mut |r| deliver(sink, err, r));
        (self.sink, self.err)
    }
}

fn deliver<S: Sink>(sink: &mut S, err: &mut Option<std::io::Error>, r: Vec<Cell>) {
    if err.is_none()
        && let Err(e) = sink.record(r)
    {
        *err = Some(e);
    }
}

/// クライアントを起こす場所。
enum Route {
    Container { docker: Docker, id: String },
    Shell(ShellConfig),
}

/// 1 回のコマンドのあいだ使い回す接続。**コンテナの inspect とクライアントの解決は 1 回で済ませる**
/// （テーブル名を一覧で確かめてから本番を流すので、1 回のコマンドで 2 回クエリを流す）。
struct Session {
    engine: Engine,
    route: Route,
    host: Option<String>,
    port: Option<u16>,
    user: Option<String>,
    database: Option<String>,
    /// パスワードの環境変数（`MYSQL_PWD` / `PGPASSWORD`）。
    env: Vec<(&'static str, String)>,
    /// 見つかったクライアント（`Engine::clients` の位置）。最初の実行で決まり、以後は試し直さない。
    client: Option<usize>,
}

impl Session {
    /// 接続先から組む。コンテナは環境変数の既定を読む（パスワードはここで読み、フロントへ返さない）。
    async fn open(docker_state: &DockerState, target: &DbTarget) -> Result<Self, String> {
        let engine = target.engine;
        let (route, defaults) = match &target.via {
            DbVia::Container { container_id } => {
                let docker = get_docker(docker_state).await?;
                let env = container_env(&docker, container_id).await?;
                let route = Route::Container {
                    docker,
                    id: container_id.clone(),
                };
                (route, container_defaults(&env, engine))
            }
            DbVia::Shell { shell } => (Route::Shell(shell.clone()), ContainerDefaults::default()),
        };
        let given = |v: &Option<String>| v.clone().filter(|s| !s.is_empty());
        let user = given(&target.user).or(defaults.user.clone());
        // 既定のパスワードは既定のユーザーのもの。ユーザーを変えたなら渡さない。
        let password = given(&target.password).or_else(|| {
            (user == defaults.user)
                .then(|| defaults.password.clone())
                .flatten()
        });
        Ok(Session {
            engine,
            route,
            host: given(&target.host),
            port: target.port,
            user,
            database: given(&target.database).or(defaults.database),
            env: password
                .map(|p| vec![(engine.password_env(), p)])
                .unwrap_or_default(),
            client: None,
        })
    }

    /// `sql` を実行し、出力を `sink` へ流す。クライアントのエラーは `Err` にする。
    async fn run<S: Sink>(&mut self, sql: &str, timeout: Duration, sink: S) -> Result<S, String> {
        match self
            .run_mode(sql, false, OutputMode::Records, timeout, sink)
            .await?
        {
            (s, Ok(_)) => Ok(s),
            (_, Err(e)) => Err(sql::tidy_error(&e)),
        }
    }

    /// `sql` を `mode` の形で実行し、出力を `sink` へ流す。クライアントが決まっていなければ候補を
    /// 順に試す。**クライアントの結果は sink と一緒に返す**: 成功なら `Ok(stderr)`（psql の NOTICE など）、
    /// 失敗なら `Err(stderr)`（入力された SQL のログは、失敗した文までの出力も見せる）。外側の `Err` は
    /// 起こせなかったとき（クライアントが無い・exec の失敗）。`via_stdin` なら SQL を標準入力で渡す
    /// （入力した SQL。`sql::SqlInput::Stdin` の doc）。
    async fn run_mode<S: Sink>(
        &mut self,
        sql: &str,
        via_stdin: bool,
        mode: OutputMode,
        timeout: Duration,
        mut sink: S,
    ) -> Result<(S, Result<String, String>), String> {
        let conn = ConnArgs {
            host: self.host.as_deref(),
            port: self.port,
            user: self.user.as_deref(),
            database: self.database.as_deref(),
        };
        let input = if via_stdin {
            SqlInput::Stdin
        } else {
            SqlInput::Arg(sql)
        };
        let args = sql::client_args(self.engine, &conn, input, mode);
        let stdin = via_stdin.then(|| match self.engine {
            Engine::Postgres => {
                sql::restricted_script(sql, &uuid::Uuid::new_v4().simple().to_string())
            }
            Engine::Mysql => sql.to_owned(),
        });
        let all = self.engine.clients();
        let (start, candidates) = match self.client {
            Some(i) => (i, &all[i..=i]),
            None => (0, all),
        };
        let probe = self.client.is_none();
        for (i, &client) in candidates.iter().enumerate() {
            let reader = RecordReader::new(self.engine, mode);
            let outcome = match &self.route {
                Route::Container { docker, id } => {
                    let call = ExecCall {
                        client,
                        args: &args,
                        env: &self.env,
                        stdin: stdin.as_deref(),
                        probe,
                    };
                    run_container(docker, id, call, reader, timeout, sink).await?
                }
                Route::Shell(shell) => {
                    let (shell, args, env) = (shell.clone(), args.clone(), self.env.clone());
                    let stdin = stdin.clone();
                    tokio::task::spawn_blocking(move || {
                        let io = ShellIo { reader, stdin };
                        run_shell(&shell, client, &args, &env, io, timeout, sink)
                    })
                    .await
                    .map_err(|e| e.to_string())??
                }
            };
            let done = match outcome {
                Outcome::Done(s, notices) => (s, Ok(notices)),
                Outcome::Failed(s, e) => (s, Err(e)),
                Outcome::Missing(s) => {
                    sink = s;
                    continue;
                }
            };
            self.client = Some(start + i);
            return Ok(done);
        }
        Err(format!(
            "{CLIENT_NOT_FOUND}{}",
            self.engine.clients().join(",")
        ))
    }

    async fn query(&mut self, sql: &str, limit: Option<usize>) -> Result<DbResult, String> {
        Ok(self
            .run(sql, DEFAULT_TIMEOUT, Collect::new(limit))
            .await?
            .into_result())
    }

    async fn tables(&mut self) -> Result<Vec<DbTable>, String> {
        let result = self.query(&sql::tables_sql(self.engine), None).await?;
        Ok(result
            .rows
            .into_iter()
            .filter_map(|r| {
                let mut it = r.into_iter();
                Some(DbTable {
                    name: it.next().flatten()?,
                    kind: it.next().flatten().unwrap_or_default(),
                    approx_rows: it.next().flatten().and_then(|n| n.parse().ok()),
                    schema: it.next().flatten(),
                })
            })
            .collect())
    }

    /// 見られる DB の一覧（システムの DB を除く。`sql::databases_sql`）。
    async fn databases(&mut self) -> Result<Vec<String>, String> {
        let result = self.query(&sql::databases_sql(self.engine), None).await?;
        Ok(result
            .rows
            .into_iter()
            .filter_map(|r| r.into_iter().next().flatten())
            .collect())
    }

    /// **テーブル名は一覧に有るものだけを受ける**（フロントから任意の文字列を SQL に混ぜる経路を
    /// 作らない）。引用（`sql::quote_ident` / `string_literal`）だけでも破れないが、受け口を一覧に
    /// 限っておけば、引用の漏れがあっても届く名前が無い。返すのは修飾に使うスキーマ。
    async fn ensure_table(&mut self, table: &str) -> Result<Option<String>, String> {
        match self.tables().await?.into_iter().find(|t| t.name == table) {
            Some(t) => Ok(t.schema),
            None => Err(format!("Table not found: {table}")),
        }
    }

    /// 列名（スキーマの 1 列目）。**MySQL は行が 0 件だと `--batch` が見出しも出さない**ので、
    /// 空のテーブルの見出しはここから補う。PostgreSQL の `COPY ... HEADER` は常に見出しを出す。
    async fn column_names(&mut self, table: &str) -> Result<Vec<String>, String> {
        let schema = self
            .query(&sql::schema_sql(self.engine, table), None)
            .await?;
        Ok(schema
            .rows
            .into_iter()
            .filter_map(|r| r.into_iter().next().flatten())
            .collect())
    }
}

async fn container_env(docker: &Docker, container_id: &str) -> Result<Vec<String>, String> {
    let info = docker
        .inspect_container(container_id, None::<InspectContainerOptions>)
        .await
        .map_err(|e| e.to_string())?;
    Ok(info.config.and_then(|c| c.env).unwrap_or_default())
}

/// シェルの経路の入出力。`stdin` は標準入力へ流し込む SQL（`sql::SqlInput::Stdin`。psql なら
/// `sql::restricted_script` を通したもの。無ければ閉じる）。
struct ShellIo {
    reader: RecordReader,
    stdin: Option<String>,
}

/// シェルの環境で起こす。**WSL は `sh -c 'PATH=… exec "$0" "$@"'` を挟む**: `wsl.exe -e` で
/// 直に起こすと、見つからないときに終了コード 1 と `execvpe(...) failed` しか返らず、接続の
/// 失敗と区別できない（実測）。挟めば `sh` が 127 を返し、`~/.local/bin` なども探せる。
/// 値は `"$@"` で渡るので、`sh` が SQL やユーザー名を読み直すことはない。
/// ホスト（Windows / macOS）は直に起こし、見つからなければ spawn が `NotFound` で失敗する。
fn run_shell<S: Sink>(
    shell: &ShellConfig,
    client: &str,
    args: &[String],
    env: &[(&str, String)],
    io: ShellIo,
    timeout: Duration,
    sink: S,
) -> Result<Outcome<S>, String> {
    let ShellIo { reader, stdin } = io;
    let script = format!("PATH=\"{WSL_EXTRA_PATH}:$PATH\" exec \"$0\" \"$@\"");
    let mut argv: Vec<&str> = Vec::new();
    let program = if matches!(shell, ShellConfig::Wsl { .. }) {
        argv.extend(["-c", &script, client]);
        "sh"
    } else {
        client
    };
    argv.extend(args.iter().map(String::as_str));
    let mut cmd = shell.command_env(program, &argv, env);
    cmd.stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        });
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Outcome::Missing(sink)),
        Err(e) => return Err(format!("Failed to run {client}: {e}")),
    };
    let pid = child.id();
    let (code, stderr, sink, sink_err) = wait_with_timeout(pid, timeout, client, move || {
        let stderr = child.stderr.take();
        let stderr_thread =
            std::thread::spawn(move || stderr.map(drain_stderr).unwrap_or_default());
        // 書き込みは別のスレッドで（stdout を読まずに書き続けると、出力のパイプが詰まった子が
        // 標準入力を読まなくなって互いに止まる）。書き終えたら閉じて EOF を知らせる。失敗（子が先に
        // 終わった）は子の終了コードと stderr が言うので捨てる。
        if let (Some(mut pipe), Some(sql)) = (child.stdin.take(), stdin) {
            std::thread::spawn(move || {
                let _ = pipe.write_all(sql.as_bytes());
            });
        }
        let mut feeder = Feeder::new(reader, sink);
        if let Some(mut stdout) = child.stdout.take() {
            let mut buf = vec![0u8; 64 * 1024];
            loop {
                let n = stdout.read(&mut buf)?;
                if n == 0 {
                    break;
                }
                feeder.push(&buf[..n]);
            }
        }
        let (sink, sink_err) = feeder.finish();
        let status = child.wait()?;
        let stderr = stderr_thread.join().unwrap_or_default();
        Ok((
            i64::from(status.code().unwrap_or(-1)),
            stderr,
            sink,
            sink_err,
        ))
    })?;
    conclude(sink, code, &stderr, sink_err)
}

/// コンテナの中で起こす（bollard の exec）。パスワードは exec の環境変数で渡すので、
/// コンテナの中の `ps` にも引数としては出ない。
///
/// **クライアントが決まる前は、先に `<client> --version` で有無を確かめる**（`probe`）。無い
/// クライアントを exec すると、`OCI runtime exec failed: ... executable file not found` が
/// **stdout に**届く（実測）ので、そのまま読むとエラー文が見出しの行になり、書き出しならファイルに
/// 書かれる。
struct ExecCall<'a> {
    client: &'a str,
    args: &'a [String],
    env: &'a [(&'static str, String)],
    /// 標準入力へ流し込む SQL（`sql::SqlInput::Stdin`）。
    stdin: Option<&'a str>,
    probe: bool,
}

async fn run_container<S: Sink>(
    docker: &Docker,
    container_id: &str,
    call: ExecCall<'_>,
    reader: RecordReader,
    timeout: Duration,
    sink: S,
) -> Result<Outcome<S>, String> {
    let client = call.client;
    if call.probe {
        let cmd = vec![client.to_owned(), "--version".to_owned()];
        let probe = exec_create(docker, container_id, cmd, vec![]).await?;
        let (code, _) = exec_drain(docker, &probe, Duration::from_secs(10), |_| {}).await?;
        if is_missing(code) {
            return Ok(Outcome::Missing(sink));
        }
    }
    let mut env: Vec<String> = call.env.iter().map(|(k, v)| format!("{k}={v}")).collect();
    // **標準入力へ流す SQL は、exec の標準入力ではなく環境変数で渡し、コンテナの中の `sh` で流し込む。**
    // bollard の exec に `attach_stdin` で書き、EOF を知らせるために書き込み側を閉じると、接続ごと
    // 閉じて出力も終了コードも取れなくなる（実測。終了コードが -1 のまま返る）。値は `"$PIKE_SQL_0"` の
    // ように展開するだけで、`sh` が SQL を読み直すことはない。
    //
    // **環境変数は 1 つ 128 KiB までで、全体も 2 MiB ほどで頭打ちになる**（Linux の execve。超えると exec が
    // `argument list too long` で起動せず、終了コード 126 で「クライアントが無い」に見える）。そこで
    // `STDIN_CHUNK` ずつの変数に分け、全体は `CONTAINER_SQL_MAX` までにして、超えたら起こす前に断る。
    let mut cmd = match call.stdin {
        Some(sql) if sql.len() > CONTAINER_SQL_MAX => {
            return Err(format!("{SQL_TOO_LONG}{CONTAINER_SQL_MAX}"));
        }
        Some(sql) => {
            let chunks = split_at_char_boundaries(sql, STDIN_CHUNK);
            let mut refs = Vec::with_capacity(chunks.len());
            for (n, chunk) in chunks.iter().enumerate() {
                env.push(format!("{STDIN_ENV}_{n}={chunk}"));
                refs.push(format!("\"${STDIN_ENV}_{n}\""));
            }
            let script = format!("printf '%s' {} | exec \"$0\" \"$@\"", refs.join(" "));
            vec!["sh".to_owned(), "-c".to_owned(), script, client.to_owned()]
        }
        None => vec![client.to_owned()],
    };
    cmd.extend(call.args.iter().cloned());
    let exec = exec_create(docker, container_id, cmd, env).await?;
    let mut feeder = Feeder::new(reader, sink);
    let (code, stderr) = exec_drain(docker, &exec, timeout, |bytes| {
        // ファイルへ書く sink は同期の I/O なので、async のワーカーを塞がないよう逃がす。
        if S::BLOCKING {
            tokio::task::block_in_place(|| feeder.push(bytes));
        } else {
            feeder.push(bytes);
        }
    })
    .await?;
    // `sh` を挟んだ経路の 126 / 127 は `sh` が無いということ（クライアントは `--version` で確かめてある）。
    // 「クライアントが無い」にすると、一覧とレコードは見られるのに SQL だけ失敗する理由が分からない。
    if call.stdin.is_some() && is_missing(code) {
        return Err(CONTAINER_SH_NOT_FOUND.to_owned());
    }
    let (sink, sink_err) = feeder.finish();
    conclude(sink, code, &stderr, sink_err)
}

async fn exec_create(
    docker: &Docker,
    container_id: &str,
    cmd: Vec<String>,
    env: Vec<String>,
) -> Result<String, String> {
    docker
        .create_exec(
            container_id,
            CreateExecOptions::<String> {
                cmd: Some(cmd),
                env: Some(env),
                attach_stdout: Some(true),
                attach_stderr: Some(true),
                ..Default::default()
            },
        )
        .await
        .map(|e| e.id)
        .map_err(|e| e.to_string())
}

/// exec を走らせて stdout を `on_stdout` へ渡し、終了コードと stderr を返す。
async fn exec_drain(
    docker: &Docker,
    exec_id: &str,
    timeout: Duration,
    mut on_stdout: impl FnMut(&[u8]),
) -> Result<(i64, String), String> {
    let mut stderr = String::new();
    if let StartExecResults::Attached { mut output, .. } = docker
        .start_exec(exec_id, None)
        .await
        .map_err(|e| e.to_string())?
    {
        let read = tokio::time::timeout(timeout, async {
            while let Some(msg) = output.next().await {
                match msg.map_err(|e| e.to_string())? {
                    LogOutput::StdOut { message } => on_stdout(&message),
                    LogOutput::StdErr { message } if stderr.len() < STDERR_KEEP_MAX => {
                        stderr.push_str(&String::from_utf8_lossy(&message));
                    }
                    _ => {}
                }
            }
            Ok::<(), String>(())
        })
        .await;
        match read {
            Ok(r) => r?,
            Err(_) => return Err(format!("exec timed out after {}s", timeout.as_secs())),
        }
    }
    let code = docker
        .inspect_exec(exec_id)
        .await
        .map_err(|e| e.to_string())?
        .exit_code
        .unwrap_or(-1);
    Ok((code, stderr))
}

/// コンテナの環境変数から読んだ接続の既定（ユーザー名・DB 名・パスワードの有無）。
#[tauri::command]
pub async fn db_container_defaults(
    container_id: String,
    engine: Engine,
    state: State<'_, DockerState>,
) -> Result<ContainerDefaults, String> {
    let docker = get_docker(&state).await?;
    let env = container_env(&docker, &container_id).await?;
    Ok(container_defaults(&env, engine))
}

/// つないでみた結果（`db_probe`）。フロントはこれで「つながったが見るものが無い」を見分ける
/// （`lib/dbViewer.ts` の `judgeProbe`）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbProbe {
    /// 今の DB。MySQL で DB を選ばずにつないだときは None。
    current: Option<String>,
    /// 見られる DB の一覧（システムの DB を除く）。**取れなかったときは None**（権限が無いなど）。
    /// 空の一覧（DB が無い）と区別するため、失敗を空に畳まない。
    databases: Option<Vec<String>>,
    tables: Vec<DbTable>,
}

/// 接続を確かめ、今の DB・DB の一覧・テーブルの一覧を 1 つの `Session` で返す（コンテナの inspect と
/// クライアントの解決は 1 回。問い合わせはクライアントを起こし直すので最大 3 回流れる）。
/// 今の DB の問い合わせが接続の確認を兼ね、失敗すれば接続の失敗として返す。今の DB が無ければ
/// テーブルの一覧は問い合わせない（空になるだけなので）。
#[tauri::command]
pub async fn db_probe(target: DbTarget, state: State<'_, DockerState>) -> Result<DbProbe, String> {
    let mut session = Session::open(&state, &target).await?;
    let current = session
        .query(&sql::current_database_sql(target.engine), None)
        .await?
        .rows
        .into_iter()
        .next()
        .and_then(|r| r.into_iter().next().flatten())
        .filter(|s| !s.is_empty());
    let tables = if current.is_some() {
        session.tables().await?
    } else {
        Vec::new()
    };
    let databases = session.databases().await.ok();
    Ok(DbProbe {
        current,
        databases,
        tables,
    })
}

#[tauri::command]
pub async fn db_schema(
    target: DbTarget,
    table: String,
    state: State<'_, DockerState>,
) -> Result<DbResult, String> {
    let mut session = Session::open(&state, &target).await?;
    session.ensure_table(&table).await?;
    session
        .query(&sql::schema_sql(target.engine, &table), None)
        .await
}

/// テーブルの先頭 `ROW_LIMIT` 行。1 行多く取って、切ったかを `truncated` で返す。
#[tauri::command]
pub async fn db_rows(
    target: DbTarget,
    table: String,
    state: State<'_, DockerState>,
) -> Result<DbResult, String> {
    let mut session = Session::open(&state, &target).await?;
    let schema = session.ensure_table(&table).await?;
    let sql = sql::rows_sql(
        target.engine,
        schema.as_deref(),
        &table,
        Some(ROW_LIMIT + 1),
    );
    let mut result = session.query(&sql, Some(ROW_LIMIT)).await?;
    if result.columns.is_empty() {
        result.columns = session.column_names(&table).await?;
    }
    Ok(result)
}

/// テーブル全体を `path` へ書き出し、書いた行数（見出しを除く）を返す。**出力はフロントを
/// 経由させず**、クライアントの出力を読みながらファイルへ書く。
#[tauri::command]
pub async fn db_dump(
    target: DbTarget,
    table: String,
    format: DumpFormat,
    path: String,
    state: State<'_, DockerState>,
) -> Result<u64, String> {
    let mut session = Session::open(&state, &target).await?;
    let schema = session.ensure_table(&table).await?;
    let dest = std::path::PathBuf::from(&path);
    let tmp = temp_path_for(&dest);
    let file = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
    let sink = FileSink {
        out: std::io::BufWriter::new(file),
        format,
        records: 0,
    };
    let sql = sql::rows_sql(target.engine, schema.as_deref(), &table, None);
    let written = async {
        let mut sink = session.run(&sql, DUMP_TIMEOUT, sink).await?;
        if sink.records == 0 {
            // 行が 0 件の MySQL は見出しも出さない（`Session::column_names`）。
            let header = session.column_names(&table).await?;
            sink.record(header.into_iter().map(Some).collect())
                .map_err(|e| e.to_string())?;
        }
        sink.out.flush().map_err(|e| e.to_string())?;
        Ok::<u64, String>(sink.records.saturating_sub(1))
    }
    .await;
    finish_temp(&tmp, &dest, written)
}

/// 入力された SQL の結果（`db_execute`）。
#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DbExec {
    /// 表を返す 1 つの文（`UserSql::Query`）。
    Rows { result: DbResult },
    /// それ以外。クライアントが人向けに出したもの（文ごとの結果・影響した行数・整列した表）。
    /// `tables` は実行のあとのテーブルの一覧（DDL で増減するので、同じ `Session` で読み直す。
    /// 取れなければ None）。
    Log {
        text: String,
        truncated: bool,
        tables: Option<Vec<DbTable>>,
    },
}

/// **利用者が入力した SQL をそのまま流す**（#646。DDL と書き込みも受ける）。表を返す 1 つの文は
/// 表で、それ以外はクライアントのログで返す（`sql::plan_user_sql`）。SQL は標準入力で渡す
/// （`sql::SqlInput::Stdin`）。接続先はつないだタブのもので、権限はその DB ユーザーのものになる。
///
/// **クライアントのコマンド（`\!` や MySQL の `system`）を含む SQL は実行しない**（`sql::client_command`）。
/// DB の権限の外で、クライアントを起こした環境の OS のコマンドが動くため。
///
/// エラーのときは、それまでに流れた文のログを前に付けて返す（どこまで通ったかが分かるように）。
#[tauri::command]
pub async fn db_execute(
    target: DbTarget,
    sql: String,
    state: State<'_, DockerState>,
) -> Result<DbExec, String> {
    let engine = target.engine;
    if let Some(cmd) = sql::client_command(engine, &sql) {
        return Err(format!("{CLIENT_COMMAND}{cmd}"));
    }
    let plan = sql::plan_user_sql(engine, &sql).ok_or_else(|| "SQL is empty".to_owned())?;
    let mut session = Session::open(&state, &target).await?;
    if let UserSql::Query(query) = plan {
        let collect = Collect::new(Some(ROW_LIMIT));
        match session
            .run_mode(&query, true, OutputMode::Records, EXEC_TIMEOUT, collect)
            .await?
        {
            (c, Ok(_)) => {
                return Ok(DbExec::Rows {
                    result: c.into_result(),
                });
            }
            // `COPY` で包めなかった文は、ログで流し直す（拒まれた時点では実行されていない）。
            (_, Err(e)) if sql::copy_rejected(engine, &e) => {}
            (_, Err(e)) => return Err(user_sql_error(engine, &e, true)),
        }
    }
    let (log, err) = session
        .run_mode(
            &sql,
            true,
            OutputMode::Log,
            EXEC_TIMEOUT,
            LogSink::default(),
        )
        .await?;
    let (text, truncated) = log.into_text(engine);
    match err {
        // 成功しても psql は NOTICE / WARNING を stderr に出す（`DROP TABLE IF EXISTS` の skipping など）。
        // 出力のあとに添える（捨てると、テーブルが無かったことが分からない）。
        Ok(notices) => {
            let notices = user_sql_error(engine, &notices, false);
            let text = match (text.is_empty(), notices.is_empty()) {
                (_, true) => text,
                (true, false) => notices,
                (false, false) => format!("{text}\n\n{notices}"),
            };
            Ok(DbExec::Log {
                text,
                truncated,
                tables: session.tables().await.ok(),
            })
        }
        // 古い psql は 1 行目で止まるので、出力を前に付けない（接頭辞のまま返してフロントが文言にする）。
        Err(e) if sql::restrict_unsupported(engine, &e) => Err(PSQL_NO_RESTRICT.to_owned()),
        Err(e) if text.is_empty() => Err(user_sql_error(engine, &e, false)),
        Err(e) => Err(format!("{text}\n\n{}", user_sql_error(engine, &e, false))),
    }
}

/// 入力した SQL のエラー（と NOTICE）を見せる形にする。psql が `\restrict` を知らないなら（古い）
/// その旨の接頭辞に、そうでなければ `LOCATION:` の行を落とし、`psql:<stdin>:N:` を直す。`query`
/// （表の形。`COPY (...)` で包んだ 1 文）のときは `psql:<stdin>:N:` を外す（包んだ文の終わりの行を
/// 指していて、入力の行と合わない。行は `LINE n:` が入力どおりに言う）。ログの形では、`restricted_script`
/// が足した 1 行ぶん戻す。
fn user_sql_error(engine: Engine, stderr: &str, query: bool) -> String {
    if sql::restrict_unsupported(engine, stderr) {
        return PSQL_NO_RESTRICT.to_owned();
    }
    let msg = sql::tidy_error(stderr);
    match (engine, query) {
        (Engine::Postgres, true) => sql::strip_stdin_lines(&msg),
        (Engine::Postgres, false) => sql::unshift_stdin_lines(&msg),
        (Engine::Mysql, _) => msg,
    }
}

/// 書き出しの一時ファイル（保存先と同じディレクトリ。同じボリュームなので rename で置き換えられる）。
fn temp_path_for(dest: &std::path::Path) -> std::path::PathBuf {
    let name = dest
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    dest.with_file_name(format!(".{name}.pike-{}.tmp", uuid::Uuid::new_v4()))
}

/// **書き終えてから保存先を置き換える。** 既にあるファイルを保存先に選んだとき、書き出しが途中で
/// 落ちても前の中身を残すため（保存先へ直に書くと、開いた時点で切り詰めてしまう）。失敗したら
/// 一時ファイルだけを消す。`rename` は Windows でも既存のファイルを置き換える。
fn finish_temp<T>(
    tmp: &std::path::Path,
    dest: &std::path::Path,
    written: Result<T, String>,
) -> Result<T, String> {
    let result = written.and_then(|v| {
        std::fs::rename(tmp, dest)
            .map(|()| v)
            .map_err(|e| e.to_string())
    });
    if result.is_err() {
        let _ = std::fs::remove_file(tmp);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(vars: &[&str]) -> Vec<String> {
        vars.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn a_failed_dump_keeps_the_previous_file() {
        let dir = std::env::temp_dir().join(format!("pike-db-dump-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let dest = dir.join("t.csv");
        std::fs::write(&dest, "old").unwrap();

        // 失敗：保存先は前の中身のまま、一時ファイルは残らない。
        let tmp = temp_path_for(&dest);
        std::fs::write(&tmp, "half").unwrap();
        assert!(finish_temp::<u64>(&tmp, &dest, Err("timed out".to_owned())).is_err());
        assert_eq!(std::fs::read_to_string(&dest).unwrap(), "old");
        assert!(!tmp.exists());

        // 成功：既にあるファイルを置き換える。
        let tmp = temp_path_for(&dest);
        std::fs::write(&tmp, "new").unwrap();
        assert_eq!(finish_temp(&tmp, &dest, Ok(3u64)), Ok(3));
        assert_eq!(std::fs::read_to_string(&dest).unwrap(), "new");
        assert!(!tmp.exists());
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn mysql_prefers_the_app_user() {
        let d = container_defaults(
            &env(&[
                "MYSQL_ROOT_PASSWORD=rootpw",
                "MYSQL_USER=app",
                "MYSQL_PASSWORD=apppw",
                "MYSQL_DATABASE=appdb",
                "PATH=/usr/bin",
            ]),
            Engine::Mysql,
        );
        assert_eq!(d.user.as_deref(), Some("app"));
        assert_eq!(d.password.as_deref(), Some("apppw"));
        assert_eq!(d.database.as_deref(), Some("appdb"));
        assert!(d.has_password);
    }

    #[test]
    fn mysql_falls_back_to_root_and_reads_mariadb_names() {
        let d = container_defaults(
            &env(&["MARIADB_ROOT_PASSWORD=rootpw", "MARIADB_DATABASE=app"]),
            Engine::Mysql,
        );
        assert_eq!(d.user.as_deref(), Some("root"));
        assert_eq!(d.password.as_deref(), Some("rootpw"));
        assert_eq!(d.database.as_deref(), Some("app"));
        // 名前の前方一致で別の変数を拾わない（`MYSQL_USER_X` は `MYSQL_USER` ではない）。
        let d = container_defaults(&env(&["MYSQL_USER_X=nope"]), Engine::Mysql);
        assert_eq!(d.user.as_deref(), Some("root"));
        assert!(!d.has_password);
    }

    #[test]
    fn postgres_defaults_follow_the_official_image() {
        let d = container_defaults(&env(&["POSTGRES_PASSWORD=pw"]), Engine::Postgres);
        assert_eq!(d.user.as_deref(), Some("postgres"));
        assert_eq!(d.database.as_deref(), Some("postgres"));
        let d = container_defaults(&env(&["POSTGRES_USER=u", "POSTGRES_DB="]), Engine::Postgres);
        assert_eq!(d.database.as_deref(), Some("u"));
        assert!(!d.has_password);
    }

    #[test]
    fn long_cells_are_clipped_for_display() {
        let mut c = Collect::default();
        let long = "あ".repeat(CELL_MAX_CHARS + 5);
        c.record(vec![Some("h".to_owned()), Some("i".to_owned())])
            .unwrap();
        c.record(vec![Some(long), None]).unwrap();
        let row = &c.into_result().rows[0];
        let clipped = row[0].as_deref().unwrap();
        assert_eq!(clipped.chars().count(), CELL_MAX_CHARS + 1);
        assert!(clipped.ends_with('…'));
        assert_eq!(row[1], None);
    }

    #[test]
    fn collect_reports_truncation() {
        let mut c = Collect::new(Some(2));
        for r in [["h"], ["1"], ["2"], ["3"], ["4"]] {
            c.record(r.iter().map(|s| Some((*s).to_owned())).collect())
                .unwrap();
        }
        // 上限を 1 行超えたところからは持たない（入力された SQL は `LIMIT` で絞れない）。
        assert_eq!(c.rows.len(), 3);
        let result = c.into_result();
        assert_eq!(result.columns, vec!["h"]);
        assert_eq!(result.rows.len(), 2);
        assert!(result.truncated);
    }

    #[test]
    fn log_sink_caps_and_trims_the_mysql_farewell() {
        let log_of = |lines: &[&str]| {
            let mut log = LogSink::default();
            for line in lines {
                log.record(vec![Some((*line).to_owned())]).unwrap();
            }
            log
        };
        let farewell = ["Query OK, 2 rows affected", "", "Bye", ""];
        assert_eq!(
            log_of(&farewell).into_text(Engine::Mysql),
            ("Query OK, 2 rows affected".to_owned(), false)
        );
        // 落とすのは MySQL の、ちょうど `Bye` の行だけ。
        assert_eq!(
            log_of(&[" a", " Goodbye"]).into_text(Engine::Mysql).0,
            " a\n Goodbye"
        );
        assert_eq!(
            log_of(&farewell).into_text(Engine::Postgres).0,
            "Query OK, 2 rows affected\n\nBye"
        );
        // 上限を超えたら、入るぶんまで残して切る（改行を含めて上限の 1 バイト手前まで）。
        let line = "x".repeat(LOG_MAX_BYTES / 2);
        let (text, truncated) = log_of(&[&line, &line, &line]).into_text(Engine::Mysql);
        assert!(truncated);
        assert_eq!(text.len(), LOG_MAX_BYTES - 1);
        // 最初の行が上限より長くても空にしない。多バイト文字の途中では切らない。
        let long = "あ".repeat(LOG_MAX_BYTES);
        let (text, truncated) = log_of(&[&long]).into_text(Engine::Postgres);
        assert!(truncated);
        assert!(!text.is_empty() && text.len() < LOG_MAX_BYTES);
        assert!(text.chars().all(|c| c == 'あ'));
        // 上限に達したあとの空の行も足さない。
        let mut log = LogSink::default();
        log.record(vec![Some("x".repeat(LOG_MAX_BYTES - 2))])
            .unwrap();
        for _ in 0..5 {
            log.record(vec![Some(String::new())]).unwrap();
        }
        assert!(log.truncated && log.text.len() <= LOG_MAX_BYTES);
    }

    #[test]
    fn long_sql_is_split_for_the_container() {
        let sql = format!("SELECT '{}'", "日".repeat(STDIN_CHUNK));
        let chunks = split_at_char_boundaries(&sql, STDIN_CHUNK);
        assert!(chunks.len() > 1 && chunks.iter().all(|c| c.len() <= STDIN_CHUNK));
        assert_eq!(chunks.concat(), sql);
    }

    #[test]
    fn missing_clients_are_told_apart_from_failures() {
        assert!(matches!(
            conclude((), 127, "", None),
            Ok(Outcome::Missing(()))
        ));
        assert!(matches!(
            conclude((), 0, "NOTICE:  x\n", None),
            Ok(Outcome::Done((), n)) if n == "NOTICE:  x"
        ));
        assert!(matches!(
            conclude((), 1, "ERROR 1045 (28000): Access denied\n", None),
            Ok(Outcome::Failed((), e)) if e == "ERROR 1045 (28000): Access denied"
        ));
    }
}
