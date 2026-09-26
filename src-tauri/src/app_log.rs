//! アプリのログファイル（#415）。
//!
//! **インストール版でも書く。** 以前は開発版だけでプラグインを登録していたので、インストール版の
//! `log::warn!` は捨てられ、フロントの JS エラーもどこにも残らなかった（#411 は再現できず、
//! 手がかりも無かった）。リリースビルドは DevTools も開けないので、起きたあとで読めるものが要る。
//!
//! - 置き場は OS のログディレクトリ（`app_log_dir`。Windows は
//!   `%LOCALAPPDATA%\{identifier}\logs`）。開発版とインストール版は identifier が違うので混ざらない
//! - 標準出力にも出すのは開発版だけ（`just dev` の端末で読む従来の使い方を残す）
//! - フロントのエラーは `log_frontend` で同じファイルへ流す。**間引きはフロント側**
//!   （`lib/errorLog.ts`。同じエラーが描画のたびに出てもファイルが膨らまないように）

use tauri::{AppHandle, Manager, Runtime, Window};
use tauri_plugin_log::{Builder, RotationStrategy, Target, TargetKind, TimezoneStrategy};

/// 1 ファイルの上限。超えたら日付付きの名前へ退避して新しいファイルに書く。
/// プラグインの既定（40KB）では、スタックトレースを数件書いただけで回ってしまう。
const MAX_FILE_SIZE: u128 = 1_000_000;

/// 退避したファイルを何世代残すか。合計はおよそ `MAX_FILE_SIZE × (1 + KEEP_ROTATED)`。
/// 既定の `KeepOne` は回った瞬間に直前のログを消すので、起きた直後に回ると手がかりが消える。
const KEEP_ROTATED: usize = 2;

/// ログファイルの名前（拡張子 `.log` はプラグインが付ける）。
const FILE_NAME: &str = "Pike";
/// `--new-instance`（管理者として開き直したプロセス、#138）が書くファイル。single-instance を
/// 通らず元のプロセスと並んで動くので、同じファイルに書くと互いのサイズの数え方がずれ、
/// 片方のローテーション（rename と古いファイルの削除）がもう片方の書いているファイルを動かす。
const STANDALONE_FILE_NAME: &str = "Pike-elevated";

/// ログプラグインを登録する。`setup` の先頭で呼ぶ。
///
/// **失敗しても起動を止めない。** プラグインはフォルダを作れない・ファイルを開けない・
/// 起動時のローテーションで rename できない、のどれでも `Err` を返す。Builder に載せると
/// それが `run` の `expect` まで届き、手がかりを残すための機能のせいで Pike が起動しなくなる。
///
/// `setup` で呼ぶのは、single-instance の初期化より後だから（2 つ目に起動したプロセスは
/// あそこで引数を渡して終わるので、ログファイルを開かずに済む）。
pub fn init<R: Runtime>(app: &AppHandle<R>, standalone: bool) {
    if let Err(e) = app.plugin(plugin(standalone)) {
        eprintln!("[app_log] logging disabled: {e}");
        return;
    }
    log_panics();
}

/// panic もログへ書く。**コマンドの中で panic すると、フロントの invoke は戻らないまま残る**
/// ので、`inOrder` の「戻らない」の行（`lib/tauri.ts` の `checkStall`）だけが残って原因が
/// 分からない。標準エラー出力はインストール版では誰も読まないので、ここで拾う。既定の hook
/// （標準エラー出力へ書く）はそのまま後ろに繋ぐ。
fn log_panics() {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        log::error!("panic: {info}");
        default_hook(info);
    }));
}

fn plugin<R: Runtime>(standalone: bool) -> tauri::plugin::TauriPlugin<R> {
    let file_name = if standalone {
        STANDALONE_FILE_NAME
    } else {
        FILE_NAME
    };
    let mut targets = vec![Target::new(TargetKind::LogDir {
        file_name: Some(file_name.to_owned()),
    })];
    if cfg!(debug_assertions) {
        targets.push(Target::new(TargetKind::Stdout));
    }
    Builder::new()
        .targets(targets)
        // 依存クレート（tauri / wry / reqwest など）は警告から。Info まで書くと、インストール版で
        // 何も起きていないときもファイルが伸びる。Pike 自身の `log::info!` は残す。
        .level(log::LevelFilter::Warn)
        .level_for("app_lib", log::LevelFilter::Info)
        .max_file_size(MAX_FILE_SIZE)
        .rotation_strategy(RotationStrategy::KeepSome(KEEP_ROTATED))
        // 既定は UTC。利用者が「何時ごろ起きたか」と突き合わせるのでローカル時刻にする。
        .timezone_strategy(TimezoneStrategy::UseLocal)
        .build()
}

/// フロントのエラーと警告をログファイルへ書く。どのウィンドウで起きたかを先頭に付ける。
#[tauri::command]
pub fn log_frontend(window: Window, level: String, message: String) {
    let level = match level.as_str() {
        "error" => log::Level::Error,
        "warn" => log::Level::Warn,
        _ => log::Level::Info,
    };
    log::log!(target: "webview", level, "[{}] {message}", window.label());
}

/// ログのフォルダを開く（設定画面のボタン）。まだ 1 行も書いていなくても開けるよう作っておく。
#[tauri::command]
pub async fn log_open_dir(app: AppHandle) -> Result<(), String> {
    let dir = app.path().app_log_dir().map_err(|e| e.to_string())?;
    tokio::task::spawn_blocking(move || {
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        crate::types::os_open(&dir.to_string_lossy())
    })
    .await
    .map_err(|e| e.to_string())?
}
