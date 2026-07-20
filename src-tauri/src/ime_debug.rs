//! 一時的な調査用ログ（TODO「謎のバックスペース」）。
//!
//! SKK で入力した文字がときどき 1 文字消える件を切り分けるため、ターミナルの
//! 入力イベント（composition / input / onData / dedup で捨てた分）を
//! `%APPDATA%\com.pike.dev\ime-debug.log` に追記する。
//!
//! **原因が判明したら、このモジュールとフロントの `lib/imeDebugLog.ts`、
//! `lib/tauri.ts` のラッパー、TerminalTab.vue の呼び出しをまとめて削除する。**
//! 恒久機能ではないので、設定項目も UI も持たせない。
//!
//! **ターミナルに打った内容がそのまま平文でディスクに残る**ため、既定では何も
//! 記録しない。同ディレクトリに空ファイル `ime-debug.on` を置いたときだけ有効に
//! なる。リリースに含めても、マーカーを置いていない利用者には完全に無効。
//! 判定はプロセス起動ごとに 1 回だけ行う（打鍵ごとに stat しない）。

use std::io::Write;
use std::sync::OnceLock;

use tauri::{AppHandle, Manager};

const LOG_FILE: &str = "ime-debug.log";
/// これを置いたときだけ記録する。中身は見ない。
const ENABLE_MARKER: &str = "ime-debug.on";

/// 記録が有効か。マーカーの有無をプロセス内で 1 回だけ確かめる。
fn enabled(app: &AppHandle) -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| {
        app.path()
            .app_data_dir()
            .map(|d| d.join(ENABLE_MARKER).exists())
            .unwrap_or(false)
    })
}

/// フロントは起動時にこれを 1 回だけ呼び、false なら以後まったく送らない
/// （無効な利用者に打鍵ごとの IPC を負わせないため）。
#[tauri::command]
pub async fn ime_debug_enabled(app: AppHandle) -> Result<bool, String> {
    Ok(enabled(&app))
}

/// フロントが溜めた行をまとめて追記する。行の組み立てはフロント側
/// (`lib/imeDebugLog.ts`) が行い、ここは書き出しに徹する。
#[tauri::command]
pub async fn ime_debug_log(app: AppHandle, lines: Vec<String>) -> Result<(), String> {
    // フロント側でも止めているが、単一の真実として最終判断はここで行う。
    if lines.is_empty() || !enabled(&app) {
        return Ok(());
    }
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join(LOG_FILE))
            .map_err(|e| e.to_string())?;
        let mut buf = String::new();
        for l in &lines {
            buf.push_str(l);
            buf.push('\n');
        }
        f.write_all(buf.as_bytes()).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

