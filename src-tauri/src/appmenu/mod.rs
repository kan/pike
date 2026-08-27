//! macOS のアプリケーションメニュー（#254）。
//!
//! **これが無いと `Cmd+W` がタブではなくウィンドウを閉じる。** メニューを設定しない
//! アプリには Tauri の既定メニューが付き、その Window メニューの `Close Window ⌘W`
//! が効くためである。ネイティブメニューの key equivalent は AppKit が WebView へ
//! 渡す前に処理するので、`useKeyboardShortcuts.ts` 側では拾えない。**`Cmd` 付きの
//! ショートカットを Pike のものにする唯一の方法がここ。**
//!
//! ## 何をメニューに載せるか
//!
//! **載せた項目のアクセラレータは WebView に届かなくなる**ので、載せるのは
//! 「ウィンドウ／タブの操作」と「AppKit から奪い返す必要があるもの」だけにする。
//! 逆に、WebView 側の層が既に処理しているキーは**載せてはいけない**:
//!
//!   - `Cmd+S` / `Cmd+F` … CodeMirror の `Mod-s` / `Mod-f`
//!   - `Cmd+K` … Markdown のリンク挿入（#241）とショートカット一覧の取り合い
//!   - `Cmd+1`〜`Cmd+9` … `useKeyboardShortcuts.ts`（メニューを 9 項目太らせない）
//!
//! **Edit メニューの predefined 項目は必ず入れる。** WebView 内のテキスト入力の
//! `Cmd+C` / `Cmd+V` / `Cmd+X` / `Cmd+A` は、対応するメニュー項目が無いと macOS では
//! 動かない（コミットメッセージ欄・検索欄・設定画面が全滅する）。既定メニューが
//! やっていたことなので、自前に差し替えるここが引き継ぐ。
//!
//! ## 動作
//!
//! Pike 固有の項目は動作を持たず、**フォーカス中のウィンドウへ `pike://menu` を
//! emit するだけ**。実体はフロントの `useAppActions` にあり、キーボード側と同じ
//! 1 つの実装を通る。メニューはアプリに 1 つの資源なので（トレイ・ジャンプリストと
//! 同じ）、宛先はラベルで指定する。
//!
//! **id は `AppActionId` の綴りをそのまま使う**（`newTerminal` のような camelCase）。
//! Rust 側の慣習に寄せて kebab-case にすると、フロントの表を引けずに黙って
//! 何も起きない。しかもアクセラレータは AppKit が先に食うので、**キーを押しても
//! 何も起きない**という、メニューを足す前より悪い状態になる。

use std::sync::Mutex;

use tauri::menu::{
    AboutMetadata, Menu, MenuBuilder, MenuEvent, MenuItemBuilder, PredefinedMenuItem,
    SubmenuBuilder,
};
use tauri::{AppHandle, Emitter, Manager, Wry};

/// Pike 固有の項目に付ける id の接頭辞。グローバルの menu-event リスナには
/// **トレイのメニュー項目も届く**ので、これで自分のぶんだけを拾う。
const PREFIX: &str = "menu:";

/// フロントへ動作を伝えるイベント。ウィンドウ宛てなので、受け側は
/// `getCurrentWindow().listen()` で受けること（素の `listen()` は全ウィンドウで
/// 発火する。`.claude/rules/project.md` の「マルチウィンドウ」）。
const EVENT: &str = "pike://menu";

/// 最後に組んだメニューの UI 言語。**メニューは `lang` にしか依存しない**のに、
/// `menus_refresh` はプロジェクト集合・`lastOpened`・シェル一覧の変化でも呼ばれる
/// （ウィンドウの枚数だけ独立に）。素直に作り直すと、プロジェクトを切り替えるたびに
/// メニューバー全体を組み直して main スレッドで `NSMenu` を差し替えることになる。
/// jump list が署名を比べて `CommitList` を省くのと同じ考え方。
static LAST_LANG: Mutex<Option<String>> = Mutex::new(None);

struct Labels {
    file: &'static str,
    edit: &'static str,
    view: &'static str,
    window: &'static str,
    help: &'static str,
    settings: &'static str,
    new_terminal: &'static str,
    new_file: &'static str,
    close_tab: &'static str,
    close_window: &'static str,
    quick_open: &'static str,
    project_switcher: &'static str,
    next_tab: &'static str,
    prev_tab: &'static str,
    manual: &'static str,
    shortcuts: &'static str,
}

fn labels(lang: &str) -> Labels {
    if lang.starts_with("ja") {
        Labels {
            file: "ファイル",
            edit: "編集",
            view: "表示",
            window: "ウィンドウ",
            help: "ヘルプ",
            settings: "設定…",
            new_terminal: "新規ターミナル",
            new_file: "新規ファイル",
            close_tab: "タブを閉じる",
            close_window: "ウィンドウを閉じる",
            quick_open: "コマンドパレット",
            project_switcher: "プロジェクトスイッチャー",
            next_tab: "次のタブ",
            prev_tab: "前のタブ",
            manual: "マニュアル",
            shortcuts: "キーボードショートカット",
        }
    } else {
        Labels {
            file: "File",
            edit: "Edit",
            view: "View",
            window: "Window",
            help: "Help",
            settings: "Settings…",
            new_terminal: "New Terminal",
            new_file: "New File",
            close_tab: "Close Tab",
            close_window: "Close Window",
            quick_open: "Command Palette",
            project_switcher: "Project Switcher",
            next_tab: "Next Tab",
            prev_tab: "Previous Tab",
            manual: "Manual",
            shortcuts: "Keyboard Shortcuts",
        }
    }
}

/// メニューを作って設定する。setup で 1 回（そのときはまだ UI 言語が分からないので
/// 英語。mount 後のフロントの `menus_refresh(locale)` が作り直す。トレイと同じ）、
/// 以後は UI 言語が変わったときに `menus_refresh` から。同じ言語での呼び直しは
/// `LAST_LANG` が弾く。
pub fn refresh(app: &AppHandle, lang: &str) {
    {
        let mut last = LAST_LANG.lock().unwrap();
        if last.as_deref() == Some(lang) {
            return;
        }
        *last = Some(lang.to_string());
    }
    match build_menu(app, lang) {
        Ok(menu) => {
            if let Err(e) = app.set_menu(menu) {
                log::warn!("[appmenu] set_menu failed: {e}");
            }
        }
        Err(e) => log::warn!("[appmenu] rebuild menu failed: {e}"),
    }
}

/// グローバルの menu-event を受ける。Pike 固有の項目だけを拾い、フォーカス中の
/// ウィンドウへ転送する。predefined 項目（コピー・最小化・終了など）は AppKit が
/// 自分で処理するのでここには来ない。
pub fn on_menu_event(app: &AppHandle, event: MenuEvent) {
    let Some(action) = event.id().as_ref().strip_prefix(PREFIX) else {
        return;
    };
    // `Manager::get_focused_window` は unstable feature の向こうにあるので、
    // ウィンドウを走査して自分で探す。フォーカスが無い状況（全部を最小化した状態で
    // メニューバーだけを触る等）でも項目は押せるので、そのときは見えているウィンドウへ
    // 落とす。**`main` に決め打ちしない**: close-to-tray（既定 ON）の main は破棄されず
    // hide されているだけなので、そこへ送ると見えない場所でタブが開いたり閉じたりする。
    let mut visible: Option<String> = None;
    let mut focused: Option<String> = None;
    for (label, w) in app.webview_windows() {
        if w.is_focused().unwrap_or(false) {
            focused = Some(label);
            break;
        }
        if visible.is_none() && w.is_visible().unwrap_or(false) {
            visible = Some(label);
        }
    }
    if let Some(label) = focused.or(visible) {
        let _ = app.emit_to(label.as_str(), EVENT, action);
    }
}

fn build_menu(app: &AppHandle, lang: &str) -> tauri::Result<Menu<Wry>> {
    let l = labels(lang);

    // 先頭のサブメニューが macOS のアプリケーションメニューになる。
    let app_menu = SubmenuBuilder::new(app, "Pike")
        .item(&PredefinedMenuItem::about(app, None, Some(AboutMetadata::default()))?)
        .separator()
        .item(&item(app, "settings", l.settings, Some("Cmd+,"))?)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;

    let file_menu = SubmenuBuilder::new(app, l.file)
        .item(&item(app, "newTerminal", l.new_terminal, Some("Cmd+T"))?)
        .item(&item(app, "newFile", l.new_file, Some("Cmd+N"))?)
        .separator()
        // どちらも predefined を使えない: `close_window` のアクセラレータは
        // `Cmd+W` 固定で動かせず、Pike の閉じる経路（close-to-tray・実行中
        // ターミナルの確認）も通らない。フロントの `getCurrentWindow().close()`
        // に寄せて、既存の CloseRequested の分岐をそのまま使う。
        .item(&item(app, "closeTab", l.close_tab, Some("Cmd+W"))?)
        .item(&item(app, "closeWindow", l.close_window, Some("Shift+Cmd+W"))?)
        .build()?;

    let edit_menu = SubmenuBuilder::new(app, l.edit)
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    let view_menu = SubmenuBuilder::new(app, l.view)
        .item(&item(app, "quickOpen", l.quick_open, Some("Cmd+P"))?)
        .item(&item(app, "projectSwitcher", l.project_switcher, Some("Shift+Cmd+P"))?)
        .build()?;

    let window_menu = SubmenuBuilder::new(app, l.window)
        .minimize()
        .separator()
        .item(&item(app, "nextTab", l.next_tab, Some("Shift+Cmd+]"))?)
        .item(&item(app, "prevTab", l.prev_tab, Some("Shift+Cmd+["))?)
        .separator()
        .item(&PredefinedMenuItem::bring_all_to_front(app, None)?)
        .build()?;

    // マニュアルとショートカット一覧はアクセラレータを持たない。前者は F1、
    // 後者は Cmd+K で、どちらも WebView 側の層が握っている（モジュール冒頭）。
    let help_menu = SubmenuBuilder::new(app, l.help)
        .item(&item(app, "manual", l.manual, None)?)
        .item(&item(app, "shortcuts", l.shortcuts, None)?)
        .build()?;

    MenuBuilder::new(app)
        .items(&[&app_menu, &file_menu, &edit_menu, &view_menu, &window_menu, &help_menu])
        .build()
}

/// Pike 固有の項目。`action` は `AppActionId` の綴りをそのまま渡す（モジュール冒頭）。
fn item(
    app: &AppHandle,
    action: &str,
    text: &str,
    accelerator: Option<&str>,
) -> tauri::Result<tauri::menu::MenuItem<Wry>> {
    let mut builder = MenuItemBuilder::with_id(format!("{PREFIX}{action}"), text);
    if let Some(accel) = accelerator {
        builder = builder.accelerator(accel);
    }
    builder.build(app)
}
