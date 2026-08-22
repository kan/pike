//! Windows システムトレイ（タスクトレイ）アイコン（issue #161）。
//!
//! Pike をトレイに常駐させ、ウィンドウを閉じても（main は破棄せず hide する）
//! アイコンから復帰できるようにする。提供するもの:
//!   - 左クリック: main ウィンドウの表示/非表示トグル（復帰）
//!   - 右クリックメニュー: 表示 / 新しいターミナルウィンドウ（シェルごとの
//!     サブメニュー、#240）/ 最近のプロジェクト（サブメニュー）/
//!     プロジェクトを開く…（スイッチャー）/ 終了
//!   - ツールチップ: フロントが usage（Claude 5h レート等）を push して表示
//!
//! メニューの「動作」は lib.rs の pub(crate) ヘルパー（`crate::tray_menu_action`
//! / `crate::toggle_main_window`）に委譲する。ウィンドウ生成・フォーカス系の
//! private ヘルパーが lib.rs 側にあるため、ここは presentation（アイコン・
//! メニュー・ツールチップの構築）に徹する。
//!
//! メニュー内容はプロジェクト集合・ロケール・シェル一覧に依存するので、jump list
//! と同じくフロントが `menus_refresh` で作り直す（`types::MenuShell` を参照）。

use tauri::menu::{Menu, MenuBuilder, MenuEvent, MenuItemBuilder, SubmenuBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Wry};

use crate::project;
use crate::types::MenuShell;

/// トレイ ID（`app.tray_by_id` で後から取得してメニュー/ツールチップを更新）。
const TRAY_ID: &str = "main";

/// サブメニューに載せる最近プロジェクトの最大件数。
const MAX_PROJECTS: usize = 8;

/// このビルドが開発版か。インストール版と開発版は identifier が別で single-instance
/// も別扱いなので同時に常駐でき、トレイにアイコンが 2 つ並ぶ。アイコンは同じものを
/// 流用しているため、どちらがどちらか区別する手がかりが要る。
///
/// `debug_assertions` は `npm run tauri:dev` を、identifier の `.debug` 接尾辞は
/// `tauri build --config tauri.dev.conf.json`（本番ビルドの挙動を検証する用途、
/// CLAUDE.md の CSP の項）を拾う。後者は release プロファイルなので前者だけでは
/// 素通りする。
fn is_debug_build(app: &AppHandle) -> bool {
    cfg!(debug_assertions) || app.config().identifier.ends_with(".debug")
}

/// トレイに出すアプリ名。開発版だけ目印が付く（App.vue がウィンドウタイトルに
/// 付ける `[DEBUG]` と同じ表記）。
fn app_label(app: &AppHandle) -> &'static str {
    if is_debug_build(app) {
        "Pike [DEBUG]"
    } else {
        "Pike"
    }
}

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
    let menu = build_menu(app, "en", &[], &[])?;
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip(app_label(app))
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
pub fn refresh(
    app: &AppHandle,
    lang: &str,
    projects: &[project::ProjectConfig],
    shells: &[MenuShell],
) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        match build_menu(app, lang, projects, shells) {
            Ok(menu) => {
                let _ = tray.set_menu(Some(menu));
            }
            Err(e) => log::warn!("[tray] rebuild menu failed: {e}"),
        }
    }
}

/// ツールチップを更新する。フロントは usage の要約（`detail`）だけを渡し、
/// アプリ名はここで前置する。開発版の目印を 1 箇所に閉じ込めるため。
pub fn set_tooltip(app: &AppHandle, detail: &str) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return;
    };
    let label = app_label(app);
    let text = if detail.is_empty() {
        label.to_string()
    } else {
        format!("{label} · {detail}")
    };
    let _ = tray.set_tooltip(Some(text));
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
    shells: &[MenuShell],
) -> tauri::Result<Menu<Wry>> {
    let l = labels(lang);
    // 開発版だけ、操作できない見出しとしてアプリ名を先頭に置く。ツールチップは
    // ホバーしないと出ないので、メニューを開いた時点でも分かるようにする。
    let debug_header = if is_debug_build(app) {
        Some(MenuItemBuilder::new(app_label(app)).enabled(false).build(app)?)
    } else {
        None
    };
    let mut builder = MenuBuilder::new(app);
    if let Some(header) = &debug_header {
        builder = builder.item(header).separator();
    }
    builder = builder.text("tray:show", l.show).separator();

    // シェルごとの起動はサブメニューに畳む（最近のプロジェクトと同じ形、#240）。
    // 一覧が空なのはフロントがまだ menus_refresh を呼んでいないときだけなので、
    // 従来どおり globalShell で開く 1 項目に落とす。
    if shells.is_empty() {
        builder = builder.text("tray:new-terminal", l.new_terminal);
    } else {
        let mut sub = SubmenuBuilder::new(app, l.new_terminal);
        for s in shells {
            sub = sub.text(format!("tray:new-terminal:{}", s.id), &s.label);
        }
        let submenu = sub.build()?;
        builder = builder.item(&submenu);
    }

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
