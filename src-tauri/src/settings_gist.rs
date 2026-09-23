//! 設定の同期の同期先としての GitHub Gist（#403 の段階 4）。
//!
//! **認証は `gh` に任せる**（`issues` と同じ）。Pike はトークンに触らず、`gh api` に
//! Gist の REST API を叩かせる。本文は**標準入力**で渡す（`--input -`）。コマンド行に
//! 載せると、Windows の `cmd /C` の引用で壊れるうえ、長さの上限にも当たる。
//!
//! **どこの `gh` を使うかは利用者が選ぶ**（`GhPlace`）。既定はホスト（Windows なら
//! `gh.exe`）で、WSL にしか入れていない人は distro を選ぶ。どちらにしても同期は
//! プロジェクトに属さないので、プロジェクトのシェルは使わない。
//!
//! 失敗は種類で返す（`GistError`）。画面で言い分けたいもの（`gh` が無い・ログインして
//! いない）の文言はフロントの i18n が持つ。**文字列の綴りを Rust と TS で取り決めない**
//! （`FileReadResult.too_large` と同じ判断）。

use crate::types::{bash_quote, first_line, run_with_stdin, silent_command, RunError, ShellConfig};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;

/// Gist の中のファイル名。**同期ファイルの形はファイルの同期先と同じ**（`lib/syncFormat.ts`）。
const FILE_NAME: &str = "pike-settings.json";
/// Pike が作る Gist の説明。既存の Gist から選ぶときの目印にもする。
const DESCRIPTION: &str = "Pike settings sync";
/// API の呼び出し 1 回の上限。冷えた WSL の起動と、遅い回線を見込む。
const TIMEOUT: Duration = Duration::from_secs(60);

/// どこの `gh` を使うか。
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum GhPlace {
    Host,
    Wsl { distro: String },
}

/// 失敗の種類。フロントは `kind` で言い分ける（`GhMissing` / `GhAuth` は i18n の文言、
/// `Other` はそのまま出す）。
#[derive(Debug, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum GistError {
    /// `gh` が見つからない。
    GhMissing,
    /// `gh` はあるがログインしていない。
    GhAuth,
    Other {
        message: String,
    },
}

impl From<String> for GistError {
    fn from(message: String) -> Self {
        GistError::Other { message }
    }
}

/// 1 つの Gist（選ぶための一覧の 1 行）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GistInfo {
    id: String,
    description: String,
    updated_at: String,
}

/// 読んだ中身。`revision` は Gist の版（`history[0].version`）で、書く前にこれが
/// 変わっていないかを確かめる（読んでから書くまでに他のマシンが書いていないか）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GistContent {
    /// Gist に同期ファイルがまだ無ければ `None`。
    content: Option<String>,
    revision: String,
    /// 最新の版を作った時刻（`history[0].committed_at`、ISO 8601）。**読み込みが古い版を
    /// 返していないか**を確かめるのに使う（このマシンが最後に書いた時刻より前なら、書く前の
    /// 版を読んでいる）。版の一覧で確かめないのは、一覧が長いと切り詰められうるため。
    revised_at: String,
}

/// Gist の id は 16 進（REST API の形）。コマンド行に入るので、ここで絞る。
fn check_id(id: &str) -> Result<(), GistError> {
    if !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric()) {
        Ok(())
    } else {
        Err(format!("invalid gist id: {id}").into())
    }
}

/// `gh` を走らせて stdout を返す。`args` は固定の語か検証済みの値だけ。入力が無ければ `""`
/// （空の標準入力をすぐ閉じるのは、入力を渡さないのと同じ）。
fn run_gh(place: &GhPlace, args: &[&str], input: &str) -> Result<String, GistError> {
    let shell = match place {
        GhPlace::Wsl { distro } => ShellConfig::Wsl {
            distro: distro.clone(),
        },
        GhPlace::Host => ShellConfig::host_default(),
    };
    let (code, stdout, stderr) = if shell.is_posix() {
        // POSIX のシェル越しでは引用する（`gists?per_page=100` の `?` は bash のグロブ）。
        // macOS / Linux のホストもこちら（`gh` が Homebrew の PATH にいる）。
        let quoted: Vec<String> = args.iter().map(|a| bash_quote(a)).collect();
        let line = format!("gh {}", quoted.join(" "));
        shell.run_posix_line_stdin("/", &line, input, TIMEOUT)?
    } else {
        // Windows のホストは `gh.exe` を直に起こす（`cmd /C` を通すと標準入力の扱いと
        // 引用が余計に絡む）。
        let mut cmd = silent_command("gh");
        cmd.args(args);
        match run_with_stdin(cmd, input, TIMEOUT, "gh") {
            Ok(out) => out,
            Err(RunError::Spawn(e)) if e.kind() == std::io::ErrorKind::NotFound => {
                return Err(GistError::GhMissing)
            }
            Err(e) => return Err(e.to_string().into()),
        }
    };
    if code == 0 {
        return Ok(stdout);
    }
    Err(classify_failure(code, &stderr))
}

/// 失敗の理由を、画面で言い分けたいものだけ種類にする。
fn classify_failure(code: i32, stderr: &str) -> GistError {
    let lower = stderr.to_ascii_lowercase();
    // シェル越しでは「見つからない」は終了コード 127 か、その文言で来る。
    if code == 127 || lower.contains("command not found") || lower.contains("not recognized") {
        return GistError::GhMissing;
    }
    if lower.contains("gh auth login") || lower.contains("not logged") || lower.contains("http 401")
    {
        return GistError::GhAuth;
    }
    first_line(stderr)
        .unwrap_or_else(|| format!("gh exited with code {code}"))
        .into()
}

fn parse(stdout: &str) -> Result<Value, GistError> {
    serde_json::from_str(stdout).map_err(|e| format!("unexpected gh output: {e}").into())
}

/// `gh api --paginate` の出力。ページごとの JSON が**区切り無しで並んで**出てくるので、
/// 1 つずつ読む（`--slurp` は新しい版の `gh` にしか無い）。
fn parse_pages(stdout: &str) -> Result<Vec<Value>, GistError> {
    serde_json::Deserializer::from_str(stdout)
        .into_iter::<Value>()
        .collect::<Result<_, _>>()
        .map_err(|e| format!("unexpected gh output: {e}").into())
}

/// Gist の API の応答から、同期ファイルの中身と版を取り出す。
fn read_content(gist: &Value) -> Result<GistContent, GistError> {
    // 最新の版（`history[0]`）のフィールド。無ければ `updated_at` に落とす。
    let latest = |field: &str| {
        gist["history"][0][field]
            .as_str()
            .or_else(|| gist["updated_at"].as_str())
            .unwrap_or_default()
            .to_owned()
    };
    let revision = latest("version");
    let revised_at = latest("committed_at");
    let file = &gist["files"][FILE_NAME];
    if file.is_null() {
        return Ok(GistContent {
            content: None,
            revision,
            revised_at,
        });
    }
    // 1MB を超えると本文が切り詰められる。同期ファイルがそこまで育つことは想定していない
    // ので、読めたふりをせずに止める（切れた本文で書き戻すと中身を失う）。
    if file["truncated"].as_bool() == Some(true) {
        return Err("the sync file in the gist is too large to read"
            .to_owned()
            .into());
    }
    Ok(GistContent {
        content: Some(file["content"].as_str().unwrap_or_default().to_owned()),
        revision,
        revised_at,
    })
}

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, GistError> + Send + 'static,
) -> Result<T, GistError> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| GistError::from(e.to_string()))?
}

/// 自分の Gist のうち、同期ファイルを持つものの一覧（新しい順）。ログインの確認も兼ねる。
#[tauri::command]
pub async fn sync_gist_list(place: GhPlace) -> Result<Vec<GistInfo>, GistError> {
    blocking(move || {
        // **全ページを読む**（`--paginate`）。Gist が 100 件を超える人で、同期用の Gist が
        // 2 ページ目にあると「見つからない」と出て、2 つ目を作らせてしまう。
        let out = run_gh(&place, &["api", "--paginate", "gists?per_page=100"], "")?;
        let pages = parse_pages(&out)?;
        Ok(pages
            .iter()
            .flat_map(|page| page.as_array().map(|a| a.as_slice()).unwrap_or_default())
            .filter(|g| !g["files"][FILE_NAME].is_null())
            .map(|g| GistInfo {
                id: g["id"].as_str().unwrap_or_default().to_owned(),
                description: g["description"].as_str().unwrap_or_default().to_owned(),
                updated_at: g["updated_at"].as_str().unwrap_or_default().to_owned(),
            })
            .collect())
    })
    .await
}

/// 同期用の Gist を作る（**secret**）。中身は `content`。作った Gist の id を返す。
#[tauri::command]
pub async fn sync_gist_create(place: GhPlace, content: String) -> Result<String, GistError> {
    blocking(move || {
        let body = json!({
            "description": DESCRIPTION,
            "public": false,
            "files": { FILE_NAME: { "content": content } },
        });
        let out = run_gh(
            &place,
            &["api", "-X", "POST", "gists", "--input", "-"],
            &body.to_string(),
        )?;
        parse(&out)?["id"]
            .as_str()
            .map(str::to_owned)
            .ok_or_else(|| "gh did not return a gist id".to_owned().into())
    })
    .await
}

/// Gist の同期ファイルを読む。
#[tauri::command]
pub async fn sync_gist_read(place: GhPlace, id: String) -> Result<GistContent, GistError> {
    blocking(move || {
        check_id(&id)?;
        let out = run_gh(&place, &["api", &format!("gists/{id}")], "")?;
        read_content(&parse(&out)?)
    })
    .await
}

/// Gist の最新の版だけを聞く（書く直前の確かめ）。**本文を取らない**: 版の一覧の先頭 1 件
/// （`commits?per_page=1`）だけなので、中身ごと読み直すより応答が小さい。
#[tauri::command]
pub async fn sync_gist_revision(place: GhPlace, id: String) -> Result<String, GistError> {
    blocking(move || {
        check_id(&id)?;
        let out = run_gh(
            &place,
            &["api", &format!("gists/{id}/commits?per_page=1")],
            "",
        )?;
        Ok(parse(&out)?[0]["version"]
            .as_str()
            .unwrap_or_default()
            .to_owned())
    })
    .await
}

/// Gist の同期ファイルを書き換える（他のファイルには触らない）。書いた版の時刻を返す
/// （次の読み込みがこれより古い版を返していないかを、呼び出し側が確かめる）。
#[tauri::command]
pub async fn sync_gist_write(
    place: GhPlace,
    id: String,
    content: String,
) -> Result<String, GistError> {
    blocking(move || {
        check_id(&id)?;
        let body = json!({ "files": { FILE_NAME: { "content": content } } });
        let out = run_gh(
            &place,
            &["api", "-X", "PATCH", &format!("gists/{id}"), "--input", "-"],
            &body.to_string(),
        )?;
        Ok(read_content(&parse(&out)?)?.revised_at)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_alphanumeric() {
        assert!(check_id("aa5a315d61ae9438b18d").is_ok());
        assert!(check_id("").is_err());
        assert!(check_id("abc; rm -rf /").is_err());
        assert!(check_id("../x").is_err());
    }

    #[test]
    fn reads_content_and_revision() {
        let gist = json!({
            "updated_at": "2026-09-23T00:00:00Z",
            "history": [{ "version": "abc123", "committed_at": "2026-09-23T01:00:00Z" }],
            "files": { FILE_NAME: { "content": "{\"a\":1}", "truncated": false } },
        });
        let c = read_content(&gist).unwrap();
        assert_eq!(c.content.as_deref(), Some("{\"a\":1}"));
        assert_eq!(c.revision, "abc123");
        assert_eq!(c.revised_at, "2026-09-23T01:00:00Z");
        // 同期ファイルがまだ無い Gist。
        let empty = json!({ "history": [{ "version": "v" }], "files": {} });
        assert_eq!(read_content(&empty).unwrap().content, None);
        // 切り詰められた本文は読まない。
        let big = json!({ "files": { FILE_NAME: { "content": "x", "truncated": true } } });
        assert!(read_content(&big).is_err());
    }

    #[test]
    fn reads_concatenated_pages() {
        let pages = parse_pages("[{\"id\":\"a\"}]\n[{\"id\":\"b\"}][]").unwrap();
        assert_eq!(pages.len(), 3);
        assert_eq!(pages[1][0]["id"], "b");
    }

    #[test]
    fn classifies_missing_and_auth() {
        assert_eq!(
            classify_failure(127, "bash: gh: command not found"),
            GistError::GhMissing
        );
        assert_eq!(
            classify_failure(
                4,
                "To get started with GitHub CLI, please run:  gh auth login"
            ),
            GistError::GhAuth
        );
        assert_eq!(
            classify_failure(1, "\nHTTP 404: Not Found\n"),
            GistError::Other {
                message: "HTTP 404: Not Found".to_owned()
            }
        );
    }
}
