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
//! パスワードは引数に載せず、`MYSQL_PWD` / `PGPASSWORD` で渡す。発行する SQL は `sql.rs` に
//! ある固定のものだけで、外から入るテーブル名は一覧に有ることを確かめてから引用して埋める。
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
use sql::{Cell, ConnArgs, DumpFormat, Engine, RecordReader};
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

/// クライアントが見つからないときのエラーの接頭辞。フロント（`lib/dbViewer.ts`）がこれを見て
/// 「`mysql` が見つからない」と出す。
const CLIENT_NOT_FOUND: &str = "db-client-not-found:";

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
#[derive(Default)]
struct Collect {
    columns: Option<Vec<String>>,
    rows: Vec<Vec<Cell>>,
}

impl Sink for Collect {
    fn record(&mut self, cells: Vec<Cell>) -> std::io::Result<()> {
        if self.columns.is_none() {
            self.columns = Some(cells.into_iter().map(Option::unwrap_or_default).collect());
        } else {
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
    /// `limit` は表示する行数。SQL では 1 行多く取り、超えたかで切ったことを知る。
    fn into_result(self, limit: Option<usize>) -> DbResult {
        let mut rows = self.rows;
        let truncated = limit.is_some_and(|n| rows.len() > n);
        if let Some(n) = limit {
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

/// 1 回の実行の結果。どちらも sink を持ち帰る（次の候補を試すときに使い回す）。
enum Outcome<S> {
    Done(S),
    /// そのクライアントが無い（次の候補を試す）。
    Missing(S),
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
        return Err(if msg.is_empty() {
            format!("exit code {code}")
        } else {
            msg.to_owned()
        });
    }
    Ok(Outcome::Done(sink))
}

/// 出力を読んで sink へ渡す。sink の失敗（書き込めない）は覚えておき、出力は最後まで読む
/// （途中で読むのをやめると、子がパイプに書けずに止まる）。
struct Feeder<S> {
    reader: RecordReader,
    sink: S,
    err: Option<std::io::Error>,
}

impl<S: Sink> Feeder<S> {
    fn new(engine: Engine, sink: S) -> Self {
        Feeder {
            reader: RecordReader::new(engine),
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

    /// `sql` を実行し、出力を `sink` へ流す。クライアントが決まっていなければ候補を順に試す。
    async fn run<S: Sink>(
        &mut self,
        sql: &str,
        timeout: Duration,
        mut sink: S,
    ) -> Result<S, String> {
        let conn = ConnArgs {
            host: self.host.as_deref(),
            port: self.port,
            user: self.user.as_deref(),
            database: self.database.as_deref(),
        };
        let args = sql::client_args(self.engine, &conn, sql);
        let all = self.engine.clients();
        let (start, candidates) = match self.client {
            Some(i) => (i, &all[i..=i]),
            None => (0, all),
        };
        let probe = self.client.is_none();
        for (i, &client) in candidates.iter().enumerate() {
            let outcome = match &self.route {
                Route::Container { docker, id } => {
                    let call = ExecCall {
                        client,
                        args: &args,
                        env: &self.env,
                        probe,
                    };
                    run_container(docker, id, call, self.engine, timeout, sink).await?
                }
                Route::Shell(shell) => {
                    let (shell, args, env, engine) =
                        (shell.clone(), args.clone(), self.env.clone(), self.engine);
                    tokio::task::spawn_blocking(move || {
                        run_shell(&shell, client, &args, &env, engine, timeout, sink)
                    })
                    .await
                    .map_err(|e| e.to_string())??
                }
            };
            match outcome {
                Outcome::Done(s) => {
                    self.client = Some(start + i);
                    return Ok(s);
                }
                Outcome::Missing(s) => sink = s,
            }
        }
        Err(format!(
            "{CLIENT_NOT_FOUND}{}",
            self.engine.clients().join(",")
        ))
    }

    async fn query(&mut self, sql: &str, limit: Option<usize>) -> Result<DbResult, String> {
        Ok(self
            .run(sql, DEFAULT_TIMEOUT, Collect::default())
            .await?
            .into_result(limit))
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
    engine: Engine,
    timeout: Duration,
    sink: S,
) -> Result<Outcome<S>, String> {
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
        .stdin(Stdio::null());
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
        let mut feeder = Feeder::new(engine, sink);
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
    probe: bool,
}

async fn run_container<S: Sink>(
    docker: &Docker,
    container_id: &str,
    call: ExecCall<'_>,
    engine: Engine,
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
    let mut cmd = vec![client.to_owned()];
    cmd.extend(call.args.iter().cloned());
    let env: Vec<String> = call.env.iter().map(|(k, v)| format!("{k}={v}")).collect();
    let exec = exec_create(docker, container_id, cmd, env).await?;
    let mut feeder = Feeder::new(engine, sink);
    let (code, stderr) = exec_drain(docker, &exec, timeout, |bytes| {
        // ファイルへ書く sink は同期の I/O なので、async のワーカーを塞がないよう逃がす。
        if S::BLOCKING {
            tokio::task::block_in_place(|| feeder.push(bytes));
        } else {
            feeder.push(bytes);
        }
    })
    .await?;
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
        let row = &c.into_result(None).rows[0];
        let clipped = row[0].as_deref().unwrap();
        assert_eq!(clipped.chars().count(), CELL_MAX_CHARS + 1);
        assert!(clipped.ends_with('…'));
        assert_eq!(row[1], None);
    }

    #[test]
    fn collect_reports_truncation() {
        let mut c = Collect::default();
        for r in [["h"], ["1"], ["2"], ["3"]] {
            c.record(r.iter().map(|s| Some((*s).to_owned())).collect())
                .unwrap();
        }
        let result = c.into_result(Some(2));
        assert_eq!(result.columns, vec!["h"]);
        assert_eq!(result.rows.len(), 2);
        assert!(result.truncated);
    }

    #[test]
    fn missing_clients_are_told_apart_from_failures() {
        assert!(matches!(
            conclude((), 127, "", None),
            Ok(Outcome::Missing(()))
        ));
        assert!(matches!(conclude((), 0, "", None), Ok(Outcome::Done(()))));
        assert_eq!(
            conclude((), 1, "ERROR 1045 (28000): Access denied\n", None).err(),
            Some("ERROR 1045 (28000): Access denied".to_owned())
        );
    }
}
