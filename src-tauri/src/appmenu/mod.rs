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

use crate::types::MenuAction;

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
static LAST_SIG: Mutex<Option<String>> = Mutex::new(None);

struct Labels {
    file: &'static str,
    edit: &'static str,
    view: &'static str,
    window: &'static str,
    help: &'static str,
}

/// **サブメニューの見出しだけ**を持つ。項目のラベルはフロントの i18n が正本で、
/// `MenuAction` として渡ってくる（`types::MenuAction`）。見出しがここに残るのは、
/// AppKit のメニュー構造そのものが Rust 側の持ち物で、フロントに対応する語彙が
/// 無いため（tray / jumplist と同じく 5 語だけ言語別に持つ）。
fn labels(lang: &str) -> Labels {
    if lang.starts_with("ja") {
        Labels {
            file: "ファイル",
            edit: "編集",
            view: "表示",
            window: "ウィンドウ",
            help: "ヘルプ",
        }
    } else {
        Labels {
            file: "File",
            edit: "Edit",
            view: "View",
            window: "Window",
            help: "Help",
        }
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
        return;
    }
    // 見えているウィンドウが 1 枚も無い（close-to-tray で main を畳んだ状態で、Dock から
    // 呼び出してメニューバーだけを触る）。**ここで諦めると `⌘Q` が効かなくなる**ので、
    // main を出してからそこへ送る。出してしまえば、上のコメントが避けている
    // 「見えない場所でタブが開く」も起きない。
    crate::show_main_window(app);
    let _ = app.emit_to("main", EVENT, action);
}

/// メニューを作って設定する。
///
/// setup で 1 回呼ぶが、そのときはまだ項目が無い（ラベルもキーもフロントの持ち物で、
/// mount 前には受け取れない）ので、**サブメニューの見出しと predefined 項目だけ**の
/// メニューになる。mount 後の `menus_refresh` が中身つきで作り直す。
/// 同じ内容での呼び直しは `LAST_SIG` が弾く。
pub fn refresh(app: &AppHandle, lang: &str, actions: &[MenuAction]) {
    // 同じ内容での作り直しを弾く。`set_menu` は `NSApp.mainMenu` を丸ごと張り替えるので、
    // `menus_refresh` が開いているウィンドウの数だけ飛んでくる状況（プロジェクト切替の
    // たびに `lastOpened` が動く）で毎回やると、そのぶんメニューバーが作り直される。
    let sig = signature(lang, actions);
    if LAST_SIG.lock().unwrap().as_deref() == Some(sig.as_str()) {
        return;
    }
    // **記録は成功したあと。** 先に書くと、setup での 1 回目が失敗したときに
    // mount 後の `menus_refresh` が早期 return し、Tauri の既定メニュー（＝
    // このモジュールが防いでいる `Close Window ⌘W`）のまま二度と直らない。
    match build_menu(app, lang, actions).and_then(|menu| app.set_menu(menu)) {
        Ok(_) => *LAST_SIG.lock().unwrap() = Some(sig),
        Err(e) => log::warn!("[appmenu] failed to install menu: {e}"),
    }
}

/// 作り直しの要否を決める鍵。言語と、全項目の id / ラベル / アクセラレータ。
fn signature(lang: &str, actions: &[MenuAction]) -> String {
    let mut out = String::from(lang);
    for a in actions {
        out.push('\u{1f}');
        out.push_str(&a.id);
        out.push('\u{1f}');
        out.push_str(&a.label);
        out.push('\u{1f}');
        out.push_str(a.accelerator.as_deref().unwrap_or(""));
    }
    out
}

fn build_menu(app: &AppHandle, lang: &str, actions: &[MenuAction]) -> tauri::Result<Menu<Wry>> {
    let l = labels(lang);
    // Pike 固有の項目はフロントが渡した spec から作る。渡って来ていない id は
    // **項目ごと出さない**（起動直後のブートストラップがこれ。mount 後の
    // `menus_refresh` が一覧つきで作り直す）。ラベルを Rust 側に持って埋めると、
    // 写しが増えて i18n とずれる（このモジュールが解こうとしている問題そのもの）。
    let find = |id: &str| actions.iter().find(|a| a.id == id);

    // 先頭のサブメニューが macOS のアプリケーションメニューになる。
    let mut app_menu = SubmenuBuilder::new(app, "Pike")
        .item(&PredefinedMenuItem::about(
            app,
            None,
            Some(AboutMetadata::default()),
        )?)
        .separator();
    app_menu = push(app, app_menu, find("settings"))?;
    app_menu = app_menu
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator();
    // predefined の `quit()` は即座に終了する。走っているコマンドがあれば確認を
    // 挟みたいので（#178。閉じる経路と同じ確認）、フロントへ回す項目にする。
    app_menu = push(app, app_menu, find("quit"))?;

    let mut file_menu = SubmenuBuilder::new(app, l.file);
    file_menu = push(app, file_menu, find("newTerminal"))?;
    file_menu = push(app, file_menu, find("newFile"))?;
    file_menu = push(app, file_menu, find("openDirectory"))?;
    file_menu = file_menu.separator();
    // どちらも predefined を使えない: `close_window` のアクセラレータは
    // `Cmd+W` 固定で動かせず、Pike の閉じる経路（close-to-tray・実行中
    // ターミナルの確認）も通らない。フロントの `getCurrentWindow().close()`
    // に寄せて、既存の CloseRequested の分岐をそのまま使う。
    file_menu = push(app, file_menu, find("closeTab"))?;
    file_menu = push(app, file_menu, find("closeWindow"))?;

    let edit_menu = SubmenuBuilder::new(app, l.edit)
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    let mut view_menu = SubmenuBuilder::new(app, l.view);
    view_menu = push(app, view_menu, find("quickOpen"))?;
    view_menu = push(app, view_menu, find("projectSwitcher"))?;

    let mut window_menu = SubmenuBuilder::new(app, l.window).minimize().separator();
    window_menu = push(app, window_menu, find("nextTab"))?;
    window_menu = push(app, window_menu, find("prevTab"))?;
    window_menu = window_menu
        .separator()
        .item(&PredefinedMenuItem::bring_all_to_front(app, None)?);

    // マニュアルとショートカット一覧はアクセラレータを持たない。前者は F1、
    // 後者は Cmd+K で、どちらも WebView 側の層が握っている（モジュール冒頭）。
    // フロントは `accelerator: null` で渡してくる。
    let mut help_menu = SubmenuBuilder::new(app, l.help);
    help_menu = push(app, help_menu, find("manual"))?;
    help_menu = push(app, help_menu, find("shortcuts"))?;

    let app_menu = app_menu.build()?;
    let file_menu = file_menu.build()?;
    let view_menu = view_menu.build()?;
    let window_menu = window_menu.build()?;
    let help_menu = help_menu.build()?;

    MenuBuilder::new(app)
        .items(&[&app_menu, &file_menu, &edit_menu, &view_menu, &window_menu, &help_menu])
        .build()
}

/// Pike 固有の項目を 1 つ足す。spec が無ければ**何も足さない**。
///
/// id はフロントの `AppActionId` に接頭辞を付けたもので、`on_menu_event` が同じ
/// 接頭辞を剥がして payload に戻す。
fn push<'m>(
    app: &'m AppHandle,
    builder: SubmenuBuilder<'m, Wry, AppHandle>,
    action: Option<&MenuAction>,
) -> tauri::Result<SubmenuBuilder<'m, Wry, AppHandle>> {
    let Some(a) = action else {
        return Ok(builder);
    };
    let mut item = MenuItemBuilder::with_id(format!("{PREFIX}{}", a.id), &a.label);
    if let Some(accel) = &a.accelerator {
        item = item.accelerator(accel);
    }
    Ok(builder.item(&item.build(app)?))
}
