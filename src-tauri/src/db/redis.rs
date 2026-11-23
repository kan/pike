//! Redis ビューワ（#647）。キーの一覧（`SCAN`）と、型に合わせた値（string / list / hash / set /
//! zset / stream）を見る。**書き込むコマンドは送らない**（読むだけ）。
//!
//! DB ビューワ（`db/mod.rs`）と同じく、**ドライバのクレートは入れず、接続先の環境にある `redis-cli`
//! を起こす**。経路（コンテナの exec・シェル）とクライアントの解決は `Route::run` を共有する。
//! 判断の記録は `.claude/rules/db.md` の「Redis（#647）」。
//!
//! - 出力は `redis-cli --json`（7.0 から）。応答が 1 行に 1 つの JSON で届き、値の中の改行も逃がされる。
//!   **エラーも終了コード 0 のまま `error:"..."` の行で届く**（実測）ので、行ごとに見る（`parse_reply`）
//! - パスワードは `REDISCLI_AUTH` の環境変数で渡し、引数に載せない（`--no-auth-warning` で注意書きを消す）
//! - コマンドとキーは argv の 1 語ずつか、標準入力の 1 行に `"\xHH"` で全部のバイトを逃がして並べる
//!   （`quote_arg`。`redis-cli` の行の読み方は `\xHH` を戻す。実測）。どちらもキーの中身でコマンドが
//!   変わることはない

use super::{
    ContainerDefaults, DbResult, DbVia, ROW_LIMIT, Route, Sink, clip_cell, container_env,
    env_value, given,
};
use crate::docker::{DockerState, get_docker};
use crate::types::DEFAULT_TIMEOUT;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;

use super::ClientCall;
use super::sql::{Cell, RecordReader};

/// 試すクライアントの順（Valkey のイメージには `valkey-cli` がある）。
const CLIENTS: &[&str] = &["redis-cli", "valkey-cli"];

/// パスワードを渡す環境変数（`redis-cli` が読む）。
const PASSWORD_ENV: &str = "REDISCLI_AUTH";

/// キーの一覧で持つ上限。超えたら `truncated` を立てて止める（パターンで絞ってもらう）。
const KEY_LIMIT: usize = 5000;

/// キーの一覧で `SCAN` を呼ぶ回数の上限。パターンに合うキーが少ない大きな DB では、1 回の `SCAN` が
/// ほとんど何も返さないまま全体を歩くので、回数でも止める。
const SCAN_CALLS_MAX: usize = 50;

/// 1 回の `SCAN` の `COUNT`（目安。Redis は前後した数を返す）。
const SCAN_COUNT: &str = "1000";

/// string の値として読む上限（バイト）。超えたぶんは読まない（`GETRANGE` で先頭だけ）。
const STRING_MAX_BYTES: usize = 256 * 1024;

/// `redis-cli` が `--json` を知らない（7.0 より古い）ときのエラー（フロントが文言にする）。
const REDIS_CLI_NO_JSON: &str = "db-redis-cli-no-json";

/// 応答をまとめて持つ上限（バイト）。超えたら読み捨ててエラーにする（値の大きさは問い合わせで
/// 絞っているので、ふつうは届かない）。**1 行にも効かせる**: 応答は 1 行に 1 つなので、list の要素の
/// 数を絞っても、要素の 1 つが大きければ 1 行が巨大になる。
const OUTPUT_MAX_BYTES: usize = 64 * 1024 * 1024;

/// 1 行を溜める上限。`OUTPUT_MAX_BYTES` より 4 バイト大きくする（`RecordReader` は切ったあと文字の境界まで
/// 最大 3 バイト戻すので、切った行が必ず `Lines` の上限を超え、溢れとして扱われる）。
const LINE_CAP: usize = OUTPUT_MAX_BYTES + 4;

/// 標準入力でまとめて送る 1 回ぶんの上限（バイト）。コンテナの経路は標準入力を環境変数で渡すので
/// `CONTAINER_SQL_MAX`（1 MiB）までしか送れない。`quote_arg` で 1 バイトが 4 バイトになるので、キーが
/// 多いと `TYPE` の並びがすぐ届く。超えるぶんは分けて送る。
const BATCH_MAX_BYTES: usize = 512 * 1024;

/// DB の番号が数でないときのエラー（フロントが文言にする）。
const REDIS_BAD_DATABASE: &str = "db-redis-bad-database";

/// 接続先。DB ビューワの `DbTarget` と同じ形で、`engine` は読まない（`redis` だけが来る）。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedisTarget {
    via: DbVia,
    #[serde(default)]
    host: Option<String>,
    #[serde(default)]
    port: Option<u16>,
    #[serde(default)]
    user: Option<String>,
    #[serde(default)]
    password: Option<String>,
    /// DB の番号（`-n`）。空なら 0。
    #[serde(default)]
    database: Option<String>,
}

/// 出力の行を集める。
#[derive(Default)]
struct Lines {
    lines: Vec<String>,
    bytes: usize,
    overflow: bool,
}

impl Sink for Lines {
    fn record(&mut self, cells: Vec<Cell>) -> std::io::Result<()> {
        let line = cells.into_iter().next().flatten().unwrap_or_default();
        self.bytes += line.len();
        if self.bytes > OUTPUT_MAX_BYTES {
            self.overflow = true;
        } else if !line.is_empty() {
            self.lines.push(line);
        }
        Ok(())
    }
}

/// 1 回のコマンドのあいだ使い回す接続（`Session` と同じく、コンテナの inspect とクライアントの解決は 1 回）。
struct RedisSession {
    route: Route,
    /// 毎回付ける引数（`--json` と接続先）。
    base: Vec<String>,
    env: Vec<(&'static str, String)>,
    client: Option<usize>,
}

impl RedisSession {
    async fn open(docker_state: &DockerState, target: &RedisTarget) -> Result<Self, String> {
        let (route, env) = Route::open(docker_state, &target.via).await?;
        let user = given(&target.user);
        // 既定のパスワードは既定のユーザー（`default`）のもの。ユーザーを指定したなら渡さない。
        let password = given(&target.password).or_else(|| {
            user.is_none()
                .then(|| env.as_deref().and_then(container_password))
                .flatten()
        });
        // **RESP2（`-2`）で話す。** `--json` は既定で RESP3 にし、zset の score を double のまま出すので、
        // `-inf` / `inf` が JSON として読めない（`[["a",-inf]]`。実測）。RESP2 なら文字列で届く。
        // **`--json` ではなく `--quoted-json`**: `--json` は UTF-8 でないバイトを生のまま行に入れ（`\377`。実測）、
        // 行を文字列にした時点で置換文字に化けて元のバイトが失われる。`--quoted-json` は文字列を redis-cli の
        // 表記（`"a\xff\x01\n"`）で返すので、`unquote` でバイト列に戻せる。
        let mut base = vec![
            "-2".to_owned(),
            "--quoted-json".to_owned(),
            "--no-auth-warning".to_owned(),
        ];
        if let Some(h) = given(&target.host) {
            base.extend(["-h".to_owned(), h]);
        }
        if let Some(p) = target.port {
            base.extend(["-p".to_owned(), p.to_string()]);
        }
        if let Some(u) = user {
            base.extend(["--user".to_owned(), u]);
        }
        base.extend([
            "-n".to_owned(),
            database_index(target.database.as_deref())?.to_string(),
        ]);
        Ok(RedisSession {
            route,
            base,
            env: password
                .map(|p| vec![(PASSWORD_ENV, p)])
                .unwrap_or_default(),
            client: None,
        })
    }

    /// `redis-cli` を起こし、出力の行を返す。`args` は引数で渡すコマンド、`stdin` は標準入力の行。
    async fn lines(&mut self, args: &[&str], stdin: Option<String>) -> Result<Vec<String>, String> {
        let mut all = self.base.clone();
        all.extend(args.iter().map(|s| (*s).to_owned()));
        let call = ClientCall {
            clients: CLIENTS,
            args: &all,
            env: &self.env,
            stdin,
            timeout: DEFAULT_TIMEOUT,
        };
        let (sink, result) = self
            .route
            .run(
                call,
                &mut self.client,
                || RecordReader::lines(LINE_CAP),
                Lines::default(),
            )
            .await?;
        match result {
            // 失敗のエラーは stderr から。stderr が空なら、stdout の `error:` の行（応答のエラー）を使う。
            Err(e) => {
                return Err(if e.trim().is_empty() {
                    sink.lines
                        .iter()
                        .find_map(|l| parse_reply(l).err())
                        .unwrap_or_else(|| "redis-cli failed".to_owned())
                } else {
                    client_error(&e)
                });
            }
            // **標準入力で送ると、つながらなくても終了コードは 0 のまま、出力が空で stderr にだけ
            // `Could not connect ...` が出る**（実測）。応答の数が合わないとだけ言わずに、その理由を返す。
            Ok(stderr) if sink.lines.is_empty() && !stderr.trim().is_empty() => {
                return Err(client_error(&stderr));
            }
            Ok(_) => {}
        }
        if sink.overflow {
            return Err(format!(
                "redis-cli output exceeded {OUTPUT_MAX_BYTES} bytes"
            ));
        }
        Ok(sink.lines)
    }

    /// 1 つのコマンドを引数で送り、1 つの応答を返す。
    async fn call(&mut self, command: &[&str]) -> Result<Value, String> {
        let lines = self.lines(command, None).await?;
        let first = lines
            .first()
            .ok_or_else(|| "redis-cli returned nothing".to_owned())?;
        parse_reply(first)
    }

    /// いくつかのコマンドを標準入力で送り、応答を順に返す（コマンドごとのエラーは中の `Err`）。
    /// 並びが `BATCH_MAX_BYTES` を超えるときは分けて送る（`batch_scripts`）。
    async fn batch(
        &mut self,
        commands: &[Vec<&[u8]>],
    ) -> Result<Vec<Result<Value, String>>, String> {
        let mut replies = Vec::with_capacity(commands.len());
        for (script, count) in batch_scripts(commands) {
            let lines = self.lines(&[], Some(script)).await?;
            if lines.len() != count {
                return Err(format!(
                    "redis-cli returned {} replies for {count} commands",
                    lines.len()
                ));
            }
            replies.extend(lines.iter().map(|l| parse_reply(l)));
        }
        Ok(replies)
    }

    /// キーの一覧（`SCAN` を `MATCH pattern` で回し、型を `TYPE` でまとめて引く）。
    async fn keys(&mut self, pattern: &str) -> Result<RedisKeyList, String> {
        let pattern = if pattern.is_empty() { "*" } else { pattern };
        let mut names: Vec<Vec<u8>> = Vec::new();
        let mut cursor = "0".to_owned();
        let mut truncated = false;
        for n in 0.. {
            if n == SCAN_CALLS_MAX || names.len() >= KEY_LIMIT {
                truncated = true;
                break;
            }
            let reply = self
                .call(&["SCAN", &cursor, "MATCH", pattern, "COUNT", SCAN_COUNT])
                .await?;
            let (next, batch) = scan_reply(&reply)?;
            names.extend(batch);
            if next == "0" {
                break;
            }
            cursor = next;
        }
        names.sort();
        names.dedup();
        if names.len() > KEY_LIMIT {
            names.truncate(KEY_LIMIT);
            truncated = true;
        }
        // `quote_arg` で 1 バイトが 4 バイトになるので、1 行で `BATCH_MAX_BYTES` を超える長いキーは型を引かない
        // （コンテナの経路は標準入力の上限で断られ、そのキー 1 つで一覧ごと読めなくなる）。型は空のまま出す。
        let fits = |k: &[u8]| k.len() * 4 + 16 <= BATCH_MAX_BYTES;
        let commands: Vec<Vec<&[u8]>> = names
            .iter()
            .filter(|k| fits(k))
            .map(|k| vec![b"TYPE".as_slice(), k.as_slice()])
            .collect();
        let mut kinds = self.batch(&commands).await?.into_iter();
        let keys = names
            .into_iter()
            .map(|name| {
                let kind = if fits(&name) { kinds.next() } else { None };
                let kind = kind
                    .and_then(Result::ok)
                    .and_then(|v| v.as_str().map(str::to_owned))
                    .unwrap_or_default();
                RedisKey::new(name, kind)
            })
            .collect();
        Ok(RedisKeyList { keys, truncated })
    }

    /// DB ごとのキーの数（`INFO keyspace`）。**`--json` でも INFO は生の行で届き、エラーも `error:` の印の
    /// 無い生の行（`NOAUTH Authentication required.`）で届く**（実測）。
    async fn keyspace(&mut self) -> Result<Vec<RedisDatabase>, String> {
        let lines = self.lines(&["INFO", "keyspace"], None).await?;
        keyspace_reply(&lines)
    }
}

/// コンテナの環境変数のパスワード。Redis の公式イメージはパスワードを環境変数に持たない
/// （`--requirepass` を起動の引数で渡す）が、Bitnami のイメージは `REDIS_PASSWORD`、Valkey は
/// `VALKEY_PASSWORD` を持つ。ユーザーと DB は持たない。
fn container_password(env: &[String]) -> Option<String> {
    env_value(env, &["REDIS_PASSWORD", "VALKEY_PASSWORD"])
}

fn container_defaults(env: &[String]) -> ContainerDefaults {
    let password = container_password(env);
    ContainerDefaults {
        user: None,
        database: None,
        has_password: password.is_some(),
        password,
    }
}

/// DB の番号。数字でなければ 0。
fn database_index(database: Option<&str>) -> Result<u32, String> {
    match database.map(str::trim) {
        None | Some("") => Ok(0),
        // 数でない値を 0 に読み替えない（別の DB を見ていると気付けない）。
        Some(d) => d.parse().map_err(|_| format!("{REDIS_BAD_DATABASE}:{d}")),
    }
}

/// クライアントのエラー（stderr）を見せる形にする。`-2` か `--quoted-json` を知らない古い `redis-cli`
/// （`Unrecognized option or bad number of args for: '--quoted-json'`。実測の形）は印に置き換える。**その形だけを
/// 見る**: `-json` の綴りだけで見ると、ホスト名に `-json` を含む接続先の接続のエラーまで古いと言う。
fn client_error(stderr: &str) -> String {
    let old = ["'--quoted-json'", "'-2'"].iter().any(|o| {
        stderr.contains(&format!(
            "Unrecognized option or bad number of args for: {o}"
        ))
    });
    if old {
        return REDIS_CLI_NO_JSON.to_owned();
    }
    stderr.trim().to_owned()
}

/// `--quoted-json` の文字列（redis-cli の表記）をバイト列に戻す。redis-cli は `\` と `"` を `\\` と `\"`、
/// 改行などを `\n` `\r` `\t` `\a` `\b`、そのほかの表示できないバイトと 0x7e を超えるバイトを `\xHH` で書く。
fn unquote(s: &str) -> Vec<u8> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] != b'\\' || i + 1 == b.len() {
            out.push(b[i]);
            i += 1;
            continue;
        }
        let hex = |at: usize| {
            b.get(at..at + 2)
                .and_then(|h| std::str::from_utf8(h).ok())
                .and_then(|h| u8::from_str_radix(h, 16).ok())
        };
        let (byte, used) = match b[i + 1] {
            b'n' => (b'\n', 2),
            b'r' => (b'\r', 2),
            b't' => (b'\t', 2),
            b'a' => (0x07, 2),
            b'b' => (0x08, 2),
            b'x' => match hex(i + 2) {
                Some(v) => (v, 4),
                None => (b'x', 2),
            },
            other => (other, 2),
        };
        out.push(byte);
        i += used;
    }
    out
}

/// バイト列を文字として見せられるか。UTF-8 として読め、制御文字を含まないもの（`breaks` なら改行とタブは
/// 許す。値は複数行になりうるが、キー名は一覧の 1 行）。そうでなければバイト列を返す（バイナリ）。
/// そのまま見せると、読めないバイトは置換文字に、制御文字は豆腐か何も無いように見える。
fn as_text(bytes: Vec<u8>, breaks: bool) -> Result<String, Vec<u8>> {
    let allowed = |c: char| !c.is_control() || (breaks && matches!(c, '\t' | '\n' | '\r'));
    match String::from_utf8(bytes) {
        Ok(s) if s.chars().all(allowed) => Ok(s),
        Ok(s) => Err(s.into_bytes()),
        Err(e) => Err(e.into_bytes()),
    }
}

/// バイナリを redis-cli の表記で見せる（musql と同じ規則）。`\` と `"` は `\\` と `\"`、改行などは `\n` など、
/// そのほかの制御文字と UTF-8 でないバイトは `\xHH`。**日本語などの読める文字はそのまま残す**（redis-cli は
/// 0x7e を超えるバイトを全部 `\xHH` にする）。
fn escape(bytes: &[u8]) -> String {
    use std::fmt::Write;
    let mut out = String::with_capacity(bytes.len());
    for chunk in bytes.utf8_chunks() {
        for c in chunk.valid().chars() {
            match c {
                '\\' => out.push_str("\\\\"),
                '"' => out.push_str("\\\""),
                '\n' => out.push_str("\\n"),
                '\r' => out.push_str("\\r"),
                '\t' => out.push_str("\\t"),
                '\u{7}' => out.push_str("\\a"),
                '\u{8}' => out.push_str("\\b"),
                c if c.is_control() => {
                    for b in c.encode_utf8(&mut [0; 4]).bytes() {
                        let _ = write!(out, "\\x{b:02x}");
                    }
                }
                c => out.push(c),
            }
        }
        for b in chunk.invalid() {
            let _ = write!(out, "\\x{b:02x}");
        }
    }
    out
}

/// 値を見せる文字と、バイナリだったか。
fn shown(bytes: Vec<u8>) -> (String, bool) {
    match as_text(bytes, true) {
        Ok(text) => (text, false),
        Err(bytes) => (escape(&bytes), true),
    }
}

/// `STRING_MAX_BYTES` で切ったときに割れた UTF-8 の文字の残りを落とす（見せる文字の末尾が `\xHH` に
/// ならないように）。UTF-8 でないバイトはそのまま残す。
fn trim_cut_character(bytes: &mut Vec<u8>) {
    // UTF-8 の文字は 4 バイトまでなので、割れた文字は末尾の 3 バイトの中で始まる。
    for start in bytes.len().saturating_sub(3)..bytes.len() {
        // `error_len` が None になるのは、入力の末尾で切れた並びだけ。
        if let Err(e) = std::str::from_utf8(&bytes[start..])
            && e.valid_up_to() == 0
            && e.error_len().is_none()
        {
            bytes.truncate(start);
            return;
        }
    }
}

/// フロントが渡すキーのバイト列。バイナリのキーは `raw`（16 進）、それ以外は名前の UTF-8。
fn key_bytes(name: &str, raw: Option<&str>) -> Result<Vec<u8>, String> {
    let Some(hex) = raw else {
        return Ok(name.as_bytes().to_vec());
    };
    if hex.len() % 2 != 0 {
        return Err("Invalid key bytes.".to_owned());
    }
    (0..hex.len())
        .step_by(2)
        .map(|i| {
            hex.get(i..i + 2)
                .and_then(|h| u8::from_str_radix(h, 16).ok())
                .ok_or_else(|| "Invalid key bytes.".to_owned())
        })
        .collect()
}

/// コマンドの並びを標準入力の行にし、`BATCH_MAX_BYTES` までずつに分ける（中身とコマンドの数の組）。
/// 1 行で上限を超えるコマンドも、それだけで 1 回に送る（`run_container` が長すぎると断る）。
fn batch_scripts(commands: &[Vec<&[u8]>]) -> Vec<(String, usize)> {
    let mut out: Vec<(String, usize)> = Vec::new();
    for c in commands {
        // 語はバイト列のまま逃がす（バイナリのキーもそのまま届く）。
        let words: Vec<String> = c.iter().map(|w| quote_arg(w)).collect();
        let line = format!("{}\n", words.join(" "));
        match out.last_mut() {
            Some((script, n)) if script.len() + line.len() <= BATCH_MAX_BYTES => {
                script.push_str(&line);
                *n += 1;
            }
            _ => out.push((line, 1)),
        }
    }
    out
}

/// 標準入力の 1 語。**全部のバイトを `\xHH` で逃がして `"..."` で囲む**（空白・引用符・改行を含むキーでも
/// 1 語のまま届き、次のコマンドを始められない）。
fn quote_arg(s: &[u8]) -> String {
    let hex: String = s.iter().map(|b| format!("\\x{b:02x}")).collect();
    format!("\"{hex}\"")
}

/// `--quoted-json` の 1 行。`error:"..."` はエラー、それ以外は JSON（文字列は redis-cli の表記のまま。
/// バイト列に戻すのは `unquote`）。
fn parse_reply(line: &str) -> Result<Value, String> {
    if let Some(e) = line.strip_prefix("error:") {
        return Err(decode_error(e));
    }
    serde_json::from_str(line).map_err(|e| format!("{e}: {line}"))
}

/// `error:` の後ろ（JSON の文字列）を戻す。
fn decode_error(e: &str) -> String {
    serde_json::from_str::<String>(e).unwrap_or_else(|_| e.to_owned())
}

/// `SCAN` の応答（`["次の cursor", ["key", ...]]`）。キーはバイト列に戻して返す。
fn scan_reply(v: &Value) -> Result<(String, Vec<Vec<u8>>), String> {
    let parts = v.as_array().filter(|a| a.len() == 2);
    let Some([cursor, keys]) = parts.map(|a| [&a[0], &a[1]]) else {
        return Err(format!("unexpected SCAN reply: {v}"));
    };
    let cursor = cursor.as_str().unwrap_or("0").to_owned();
    let keys = keys
        .as_array()
        .map(|ks| ks.iter().filter_map(|k| k.as_str().map(unquote)).collect())
        .unwrap_or_default();
    Ok((cursor, keys))
}

/// `INFO keyspace` の応答。中身は `# Keyspace` の見出しと `dbN:...` の行だけなので、どちらでもない
/// 行はエラー（`error:` が付いていれば戻す）。
fn keyspace_reply(lines: &[String]) -> Result<Vec<RedisDatabase>, String> {
    let is_db = |l: &str| l.starts_with("db") && l.contains(':');
    if let Some(e) = lines.iter().find(|l| !l.starts_with('#') && !is_db(l)) {
        return Err(e
            .strip_prefix("error:")
            .map_or_else(|| e.trim().to_owned(), decode_error));
    }
    Ok(parse_keyspace(lines))
}

/// `INFO keyspace` の `db0:keys=10,expires=2,...` の行から、DB の番号とキーの数を読む。
fn parse_keyspace(lines: &[String]) -> Vec<RedisDatabase> {
    lines
        .iter()
        .filter_map(|l| {
            let (db, rest) = l.trim().split_once(':')?;
            let index = db.strip_prefix("db")?.parse().ok()?;
            let keys = rest
                .split(',')
                .find_map(|kv| kv.strip_prefix("keys="))?
                .parse()
                .ok()?;
            Some(RedisDatabase { index, keys })
        })
        .collect()
}

/// JSON の値を表のセルにする（文字列はバイト列に戻して `shown` の形、数は文字列に、null は NULL、
/// ほかは JSON の文字列）。
fn cell(v: &Value) -> Cell {
    let s = match v {
        Value::Null => return None,
        Value::String(s) => shown(unquote(s)).0,
        Value::Number(n) => n.to_string(),
        other => other.to_string(),
    };
    Some(clip_cell(s))
}

/// 配列の中身（配列でなければ空）。
fn items(v: &Value) -> &[Value] {
    v.as_array().map(Vec::as_slice).unwrap_or(&[])
}

/// `[a, b, c, d, ...]` を `[a, b]`, `[c, d]` の組にする（hash のフィールドと値、RESP2 の zset、stream の項目）。
fn pairs(flat: &[Value]) -> impl Iterator<Item = [Cell; 2]> + '_ {
    flat.chunks(2)
        .map(|p| [cell(&p[0]), p.get(1).and_then(cell)])
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RedisDatabase {
    index: u32,
    keys: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RedisKey {
    /// 見せる名前。バイナリの名前（UTF-8 でない・制御文字や改行を含む）は redis-cli の表記（`escape`）。
    name: String,
    /// バイナリの名前のバイト列（16 進）。フロントはこれを返して値を開く（表記からは引き直せない）。
    raw: Option<String>,
    /// `TYPE` の答え（`string` / `list` / `hash` / `set` / `zset` / `stream` など）。引けなければ空。
    kind: String,
}

impl RedisKey {
    fn new(bytes: Vec<u8>, kind: String) -> Self {
        match as_text(bytes, false) {
            Ok(name) => RedisKey {
                name,
                raw: None,
                kind,
            },
            Err(bytes) => RedisKey {
                name: escape(&bytes),
                raw: Some(bytes.iter().map(|b| format!("{b:02x}")).collect()),
                kind,
            },
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RedisKeyList {
    keys: Vec<RedisKey>,
    /// `KEY_LIMIT` か `SCAN_CALLS_MAX` で止めたか。
    truncated: bool,
}

/// つないでみた結果（`redis_probe`）。今の DB のキーの一覧も持つ（タブが最初に要る）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RedisProbe {
    current: u32,
    /// キーのある DB（`INFO keyspace`）。今の DB は空でも入れる。
    databases: Vec<RedisDatabase>,
    keys: RedisKeyList,
}

/// 1 つのキーの値（`redis_value`）。string は `text`、ほかの型は `result`（表）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RedisValue {
    kind: String,
    /// 残りの秒（`TTL`）。期限が無ければ -1。
    ttl: i64,
    /// 要素の数（string はバイト数）。
    length: Option<u64>,
    text: Option<String>,
    result: Option<DbResult>,
    /// 先頭だけを読んだか（string は `STRING_MAX_BYTES`、ほかは `ROW_LIMIT`）。
    truncated: bool,
    /// string の値がバイナリで、`text` を redis-cli の表記（`escape`）で書いたか。
    binary: bool,
}

/// 接続を確かめ、DB の一覧と今の DB のキーの一覧を返す。接続と認証の失敗は最初の問い合わせが返す
/// （`PING` を別に送らない）。
#[tauri::command]
pub async fn redis_probe(
    target: RedisTarget,
    state: State<'_, DockerState>,
) -> Result<RedisProbe, String> {
    let mut session = RedisSession::open(&state, &target).await?;
    let current = database_index(target.database.as_deref())?;
    // キーの一覧を先に読む（接続と認証の失敗はここで返る）。
    let keys = session.keys("*").await?;
    // **DB の一覧が読めなくても止めない。** `INFO` は ACL の `@dangerous` に入るので、`-@dangerous` の
    // ユーザーは `NOPERM` になる（実測）が、キーは読める。そのときは今の DB だけを出す。
    let mut databases = session.keyspace().await.unwrap_or_default();
    if !databases.iter().any(|d| d.index == current) {
        databases.push(RedisDatabase {
            index: current,
            keys: 0,
        });
        databases.sort_by_key(|d| d.index);
    }
    Ok(RedisProbe {
        current,
        databases,
        keys,
    })
}

/// パターン（`SCAN` の `MATCH`。`*` と `?` と `[...]`）に合うキーの一覧。
#[tauri::command]
pub async fn redis_keys(
    target: RedisTarget,
    pattern: String,
    state: State<'_, DockerState>,
) -> Result<RedisKeyList, String> {
    let mut session = RedisSession::open(&state, &target).await?;
    session.keys(&pattern).await
}

/// 1 つのキーの値を、型に合わせて読む（先頭だけ）。`key` は一覧の名前、`raw` はバイナリの名前のバイト列
/// （`RedisKey::raw`）。
#[tauri::command]
pub async fn redis_value(
    target: RedisTarget,
    key: String,
    raw: Option<String>,
    state: State<'_, DockerState>,
) -> Result<RedisValue, String> {
    let bytes = key_bytes(&key, raw.as_deref())?;
    let mut session = RedisSession::open(&state, &target).await?;
    let k = bytes.as_slice();
    let head = session.batch(&[vec![b"TYPE", k], vec![b"TTL", k]]).await?;
    let kind = head[0]
        .as_ref()
        .map_err(Clone::clone)?
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let ttl = head[1].as_ref().ok().and_then(Value::as_i64).unwrap_or(-1);
    let limit = ROW_LIMIT.to_string();
    let last = (ROW_LIMIT - 1).to_string();
    let string_last = (STRING_MAX_BYTES - 1).to_string();
    let (limit, last, string_last) = (limit.as_bytes(), last.as_bytes(), string_last.as_bytes());
    let commands: Vec<Vec<&[u8]>> = match kind.as_str() {
        "none" => return Err(format!("Key not found: {key}")),
        "string" => vec![vec![b"STRLEN", k], vec![b"GETRANGE", k, b"0", string_last]],
        "list" => vec![vec![b"LLEN", k], vec![b"LRANGE", k, b"0", last]],
        "hash" => vec![vec![b"HLEN", k], vec![b"HSCAN", k, b"0", b"COUNT", limit]],
        "set" => vec![vec![b"SCARD", k], vec![b"SSCAN", k, b"0", b"COUNT", limit]],
        "zset" => vec![
            vec![b"ZCARD", k],
            vec![b"ZRANGE", k, b"0", last, b"WITHSCORES"],
        ],
        "stream" => vec![
            vec![b"XLEN", k],
            vec![b"XRANGE", k, b"-", b"+", b"COUNT", limit],
        ],
        // ほかの型（モジュールの型など）は種類だけを見せる（`shape_value` の残りの腕）。
        _ => return Ok(shape_value(kind, ttl, None, &Value::Null)),
    };
    let replies = session.batch(&commands).await?;
    let length = replies[0].as_ref().ok().and_then(Value::as_u64);
    let body = replies[1].as_ref().map_err(Clone::clone)?;
    Ok(shape_value(kind, ttl, length, body))
}

/// 型ごとの応答を、見せる形（string の文字、ほかの表）にする。
fn shape_value(kind: String, ttl: i64, length: Option<u64>, body: &Value) -> RedisValue {
    // 見せた数が要素の数に届かなければ、先頭だけを見せている。
    let cut = |n: usize| length.is_some_and(|len| (n as u64) < len);
    let base = RedisValue {
        kind: kind.clone(),
        ttl,
        length,
        text: None,
        result: None,
        truncated: false,
        binary: false,
    };
    // `HSCAN` / `SSCAN` は `["cursor", [...]]`。cursor が 0 でなければ続きがある。
    fn scanned(v: &Value) -> (&[Value], bool) {
        let a = items(v);
        let more = a.first().and_then(Value::as_str).is_some_and(|c| c != "0");
        (a.get(1).map(items).unwrap_or(&[]), more)
    }
    let (columns, rows, more): (&[&str], Vec<Vec<Cell>>, bool) = match kind.as_str() {
        "string" => {
            let truncated = length.is_some_and(|len| len > STRING_MAX_BYTES as u64);
            let mut bytes = unquote(body.as_str().unwrap_or_default());
            if truncated {
                trim_cut_character(&mut bytes);
            }
            let (text, binary) = shown(bytes);
            // 切ったかは長さ（`STRLEN`）で決める。見せる文字の長さと比べると、バイナリを `\xHH` で書いたぶん
            // 長くなり、切ったのに気付けない。
            return RedisValue {
                truncated,
                text: Some(text),
                binary,
                ..base
            };
        }
        "list" => {
            let rows = items(body)
                .iter()
                .enumerate()
                .map(|(i, v)| vec![Some(i.to_string()), cell(v)])
                .collect();
            (&["index", "value"], rows, false)
        }
        "hash" => {
            let (flat, more) = scanned(body);
            (
                &["field", "value"],
                pairs(flat).map(Vec::from).collect(),
                more,
            )
        }
        "set" => {
            let (members, more) = scanned(body);
            let rows = members.iter().map(|m| vec![cell(m)]).collect();
            (&["member"], rows, more)
        }
        "zset" => {
            // RESP2 で話すので `[member, score, ...]` の平らな形（score は文字列）。
            (
                &["member", "score"],
                pairs(items(body)).map(Vec::from).collect(),
                false,
            )
        }
        "stream" => {
            // `[[id, [field, value, ...]], ...]`。項目は `field=value` を改行でつないで 1 つのセルにする。
            let rows = items(body)
                .iter()
                .map(|entry| {
                    let e = items(entry);
                    let text = pairs(e.get(1).map(items).unwrap_or(&[]))
                        .map(|[f, v]| {
                            format!("{}={}", f.unwrap_or_default(), v.unwrap_or_default())
                        })
                        .collect::<Vec<_>>()
                        .join("\n");
                    vec![e.first().and_then(cell), Some(clip_cell(text))]
                })
                .collect();
            (&["id", "fields"], rows, false)
        }
        // ほかの型（モジュールの型など）は種類だけを見せる。
        _ => return base,
    };
    // `HSCAN` / `SSCAN` の `COUNT` は目安なので、小さい hash や set（listpack / intset）は 1 回で全部が返り、
    // `ROW_LIMIT` を超えうる。見せるのは `ROW_LIMIT` 行まで。
    let mut rows = rows;
    let over = rows.len() > ROW_LIMIT;
    rows.truncate(ROW_LIMIT);
    let truncated = more || over || cut(rows.len());
    RedisValue {
        result: Some(DbResult {
            columns: columns.iter().map(|c| (*c).to_owned()).collect(),
            rows,
            truncated,
        }),
        truncated,
        ..base
    }
}

/// コンテナの環境変数から読んだ既定（パスワードの有無だけ。パスワードそのものは返さない）。
#[tauri::command]
pub async fn redis_container_defaults(
    container_id: String,
    state: State<'_, DockerState>,
) -> Result<ContainerDefaults, String> {
    let docker = get_docker(&state).await?;
    let env = container_env(&docker, &container_id).await?;
    Ok(container_defaults(&env))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &str) -> Cell {
        Some(v.to_owned())
    }

    #[test]
    fn args_are_hex_quoted_for_stdin() {
        assert_eq!(quote_arg(b"a b"), "\"\\x61\\x20\\x62\"");
        // 引用符と改行も逃がす（次のコマンドを始められない）。
        assert_eq!(quote_arg(b"\"\n"), "\"\\x22\\x0a\"");
        assert_eq!(quote_arg("日".as_bytes()), "\"\\xe6\\x97\\xa5\"");
        // UTF-8 でないバイトもそのまま 1 バイトずつ。
        assert_eq!(quote_arg(&[0xff, 0x01]), "\"\\xff\\x01\"");
    }

    #[test]
    fn quoted_strings_come_back_as_bytes() {
        // `redis-cli -2 --quoted-json` の実際の出力（redis 7.4。`printf 'a\377\001\nあ'` を SET した値と、
        // `a\b"c<タブ>d`）を JSON として読んだあとの文字列。
        assert_eq!(
            unquote(r"a\xff\x01\n\xe3\x81\x82"),
            [b"a".as_slice(), &[0xff, 0x01, b'\n'], "あ".as_bytes()].concat()
        );
        assert_eq!(unquote(r#"a\\b\"c\td"#), b"a\\b\"c\td");
        assert_eq!(unquote(r"\a\b\r"), [0x07, 0x08, b'\r']);
        // 2 桁の 16 進でない `\x` は `x` のまま（redis-cli の読み方と同じ）。
        assert_eq!(unquote(r"\x4"), b"x4");
    }

    #[test]
    fn text_keeps_text_and_escapes_binary() {
        // 日本語・タブ・改行は文字のまま（値は複数行になりうる）。
        assert_eq!(
            shown("日本\tA\r\n\\".as_bytes().to_vec()),
            ("日本\tA\r\n\\".to_owned(), false)
        );
        // UTF-8 でないバイトか制御文字があればバイナリ。読める文字は残し、ほかを redis-cli の表記にする。
        let bytes = [b"a".as_slice(), &[0xff, 0x01, b'\n'], "あ\"".as_bytes()].concat();
        assert_eq!(shown(bytes), ("a\\xff\\x01\\nあ\\\"".to_owned(), true));
        // キー名は 1 行なので、改行を含むだけでバイナリにし、バイト列で引き直す。
        let key = RedisKey::new(b"a\nb".to_vec(), "string".to_owned());
        assert_eq!(key.name, "a\\nb");
        assert_eq!(key.raw.as_deref(), Some("610a62"));
        assert_eq!(key_bytes(&key.name, key.raw.as_deref()).unwrap(), b"a\nb");
        let plain = RedisKey::new(b"user:1".to_vec(), "hash".to_owned());
        assert_eq!((plain.name.as_str(), plain.raw), ("user:1", None));
        assert!(key_bytes("k", Some("f")).is_err());
        assert!(key_bytes("k", Some("zz")).is_err());
    }

    #[test]
    fn a_cut_character_is_dropped() {
        let mut cut = [b"ab".as_slice(), &"あ".as_bytes()[..2]].concat();
        trim_cut_character(&mut cut);
        assert_eq!(cut, b"ab");
        // 揃った文字と、UTF-8 でないバイトは残す。
        let mut whole = "abあ".as_bytes().to_vec();
        trim_cut_character(&mut whole);
        assert_eq!(whole, "abあ".as_bytes());
        let mut binary = vec![b'a', 0xff, b'b'];
        trim_cut_character(&mut binary);
        assert_eq!(binary, [b'a', 0xff, b'b']);
    }

    #[test]
    fn replies_tell_errors_from_values() {
        // `redis-cli --quoted-json` の実際の出力（redis 7.4 で取ったもの）。
        assert_eq!(
            parse_reply("\"PONG\""),
            Ok(Value::String("PONG".to_owned()))
        );
        assert_eq!(
            parse_reply("error:\"NOAUTH Authentication required.\""),
            Err("NOAUTH Authentication required.".to_owned())
        );
        let (cursor, keys) =
            scan_reply(&serde_json::from_str(r#"["10",["a","s\\x01k\\xff"]]"#).unwrap()).unwrap();
        assert_eq!(
            (cursor.as_str(), keys),
            ("10", vec![b"a".to_vec(), vec![b's', 0x01, b'k', 0xff]])
        );
    }

    #[test]
    fn keyspace_lines_give_databases() {
        let lines = [
            "# Keyspace".to_owned(),
            "db0:keys=10,expires=10,avg_ttl=279708121,subexpiry=0".to_owned(),
            "db1:keys=11,expires=9,avg_ttl=1936621646,subexpiry=0".to_owned(),
        ];
        let dbs = keyspace_reply(&lines).unwrap();
        assert_eq!(dbs.len(), 2);
        assert_eq!((dbs[1].index, dbs[1].keys), (1, 11));
        // 認証の失敗は印の無い生の行で届く（redis 7.4 で実測）。
        let denied = ["NOAUTH Authentication required.".to_owned()];
        assert_eq!(
            keyspace_reply(&denied).err().as_deref(),
            Some("NOAUTH Authentication required.")
        );
    }

    #[test]
    fn values_are_shaped_by_type() {
        let v = |j: &str| serde_json::from_str::<Value>(j).unwrap();
        let hash = shape_value(
            "hash".to_owned(),
            -1,
            Some(2),
            &v(r#"["0",["f1","v1","f2","s\\x01k\\xff"]]"#),
        );
        let r = hash.result.unwrap();
        assert_eq!(r.columns, vec!["field", "value"]);
        // 表のセルもバイナリは redis-cli の表記で見せる。
        assert_eq!(r.rows[1], vec![s("f2"), s("s\\x01k\\xff")]);
        assert!(!hash.truncated);
        // 続きがある（cursor が 0 でない）ときは先頭だけ。
        let more = shape_value("set".to_owned(), -1, Some(5), &v("[\"7\",[\"x\"]]"));
        assert!(more.truncated);
        // RESP2 の zset（`redis-cli -2 --quoted-json` の実際の出力。無限大の score も文字列で来る）。
        let z = shape_value(
            "zset".to_owned(),
            -1,
            Some(2),
            &v("[\"a\",\"-inf\",\"c\",\"inf\"]"),
        );
        assert_eq!(z.result.unwrap().rows[1], vec![s("c"), s("inf")]);
        let x = shape_value(
            "stream".to_owned(),
            -1,
            Some(1),
            &v("[[\"1-0\",[\"k\",\"v\",\"k2\",\"v2\"]]]"),
        );
        assert_eq!(x.result.unwrap().rows[0], vec![s("1-0"), s("k=v\nk2=v2")]);
        let st = shape_value("string".to_owned(), 30, Some(10), &v(r#""line1\\nline""#));
        assert_eq!(st.text.as_deref(), Some("line1\nline"));
        assert!(!st.truncated && !st.binary);
        let bin = shape_value("string".to_owned(), -1, Some(3), &v(r#""a\\xff\\x01""#));
        assert_eq!(
            (bin.text.as_deref(), bin.binary),
            (Some("a\\xff\\x01"), true)
        );
        let long = shape_value("string".to_owned(), -1, Some(1_000_000), &v(r#""abc""#));
        assert!(long.truncated);
        // 見せる文字が `\xHH` で長くなっても、長さが上限を超えていれば先頭だけ。切った文字の残りは落とす。
        let at = STRING_MAX_BYTES as u64 + 1;
        let body = Value::String(format!("{}\\xe3\\x81", r"\xff".repeat(10)));
        let cut = shape_value("string".to_owned(), -1, Some(at), &body);
        assert!(cut.truncated);
        assert_eq!(cut.text.as_deref(), Some(r"\xff".repeat(10).as_str()));
    }

    #[test]
    fn batches_are_split_under_the_limit() {
        let key = "k".repeat(1000);
        let commands: Vec<Vec<&[u8]>> = (0..1000)
            .map(|_| vec![b"TYPE".as_slice(), key.as_bytes()])
            .collect();
        let scripts = batch_scripts(&commands);
        assert!(scripts.len() > 1);
        assert!(scripts.iter().all(|(s, _)| s.len() <= BATCH_MAX_BYTES));
        assert_eq!(scripts.iter().map(|(_, n)| n).sum::<usize>(), 1000);
    }

    #[test]
    fn database_number_must_be_a_number() {
        assert_eq!(database_index(None), Ok(0));
        assert_eq!(database_index(Some(" ")), Ok(0));
        assert_eq!(database_index(Some("3")), Ok(3));
        assert_eq!(
            database_index(Some("1a")),
            Err(format!("{REDIS_BAD_DATABASE}:1a"))
        );
    }

    #[test]
    fn container_password_is_read_from_known_names() {
        let env = vec!["REDIS_PASSWORD=pw".to_owned(), "PATH=/bin".to_owned()];
        assert_eq!(container_defaults(&env).password.as_deref(), Some("pw"));
        assert!(!container_defaults(&["REDIS_PASSWORD=".to_owned()]).has_password);
    }

    #[test]
    fn old_redis_cli_is_recognized() {
        assert_eq!(
            client_error("Unrecognized option or bad number of args for: '--quoted-json'"),
            REDIS_CLI_NO_JSON
        );
        // 6 より古い redis-cli は先に `-2` で止まる。
        assert_eq!(
            client_error("Unrecognized option or bad number of args for: '-2'"),
            REDIS_CLI_NO_JSON
        );
        assert_eq!(client_error(" Could not connect \n"), "Could not connect");
        // ホスト名に `-json` を含む接続先の接続のエラーは、そのまま見せる。
        let refused = "Could not connect to Redis at my-json-redis:6379: Connection refused";
        assert_eq!(client_error(refused), refused);
    }
}
