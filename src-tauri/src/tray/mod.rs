//! Windows システムトレイ（タスクトレイ）アイコン（issue #161）。
//!
//! Pike をトレイに常駐させ、ウィンドウを閉じても（main は破棄せず hide する）
//! アイコンから復帰できるようにする。提供するもの:
//!   - 左クリック: main ウィンドウの表示/非表示トグル（復帰）
//!   - 右クリックメニュー: 表示 / 新しいターミナルウィンドウ / 最近のプロジェクト
//!     （サブメニュー）/ プロジェクトを開く…（スイッチャー）/ 終了
//!   - ツールチップ: フロントが usage（Claude 5h レート等）を push して表示
//!
//! メニューの「動作」は lib.rs の pub(crate) ヘルパー（`crate::tray_menu_action`
//! / `crate::toggle_main_window`）に委譲する。ウィンドウ生成・フォーカス系の
//! private ヘルパーが lib.rs 側にあるため、ここは presentation（アイコン・
//! メニュー・ツールチップの構築）に徹する。
//!
//! メニュー内容はプロジェクト集合とロケールに依存するので、jump list と同じく
//! フロントが起動時・プロジェクト変更時に `tray_refresh(locale)` で作り直す。

use tauri::menu::{Menu, MenuBuilder, MenuEvent, SubmenuBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Wry};

use crate::project;

/// トレイ ID（`app.tray_by_id` で後から取得してメニュー/ツールチップを更新）。
const TRAY_ID: &str = "main";

/// サブメニューに載せる最近プロジェクトの最大件数。
const MAX_PROJECTS: usize = 8;

struct Labels {
    show: &'static str,
    new_terminal: &'static str,
    recent_projects: &'static str,
    open_project: &'static str,
    quit: &'static str,
}

fn labels(lang: &str) -> Labels {
    if lang.starts_with("ja") {
        Labels {
            show: "Pike を表示",
            new_terminal: "新しいターミナルウィンドウ",
            recent_projects: "最近のプロジェクト",
            open_project: "プロジェクトを開く…",
            quit: "終了",
        }
    } else {
        Labels {
            show: "Show Pike",
            new_terminal: "New Terminal Window",
            recent_projects: "Recent Projects",
            open_project: "Open Project…",
            quit: "Quit",
        }
    }
}

/// トレイアイコンを作成する（setup で 1 回）。最近プロジェクトのサブメニューは
/// 空（静的項目のみ）で作り、mount 後のフロントの `menus_refresh(locale)` が
/// 一覧つきで作り直す（起動時のプロジェクト読み込みを 1 回に抑える）。
pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let menu = build_menu(app, "en", &[])?;
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("Pike")
        .menu(&menu)
        // 左クリックはウィンドウ復帰に使うので、メニューは右クリックのみ。
        .show_menu_on_left_click(false)
        .on_menu_event(on_menu_event)
        .on_tray_icon_event(on_tray_event);
    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }
    builder.build(app)?;
    Ok(())
}

/// メニューを作り直す（プロジェクト集合・ロケール変更時）。プロジェクト一覧は
/// 呼び出し側（`menus_refresh`）が 1 回だけ読んで渡す。
pub fn refresh(app: &AppHandle, lang: &str, projects: &[project::ProjectConfig]) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        match build_menu(app, lang, projects) {
            Ok(menu) => {
                let _ = tray.set_menu(Some(menu));
            }
            Err(e) => log::warn!("[tray] rebuild menu failed: {e}"),
        }
    }
}

/// ツールチップを更新する（フロントが usage を整形して渡す）。
pub fn set_tooltip(app: &AppHandle, text: &str) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_tooltip(Some(text));
    }
}

fn on_menu_event(app: &AppHandle, event: MenuEvent) {
    crate::tray_menu_action(app, event.id().as_ref());
}

fn on_tray_event(tray: &TrayIcon, event: TrayIconEvent) {
    if let TrayIconEvent::Click {
        button: MouseButton::Left,
        button_state: MouseButtonState::Up,
        ..
    } = event
    {
        crate::toggle_main_window(tray.app_handle());
    }
}

fn build_menu(
    app: &AppHandle,
    lang: &str,
    projects: &[project::ProjectConfig],
) -> tauri::Result<Menu<Wry>> {
    let l = labels(lang);
    let mut builder = MenuBuilder::new(app)
        .text("tray:show", l.show)
        .separator()
        .text("tray:new-terminal", l.new_terminal);

    if !projects.is_empty() {
        let mut sub = SubmenuBuilder::new(app, l.recent_projects);
        for p in projects.iter().take(MAX_PROJECTS) {
            sub = sub.text(format!("tray:proj:{}", p.id), &p.name);
        }
        let submenu = sub.build()?;
        builder = builder.item(&submenu);
    }

    builder
        .text("tray:switcher", l.open_project)
        .separator()
        .text("tray:quit", l.quit)
        .build()
}
