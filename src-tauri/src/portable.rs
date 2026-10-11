//! ポータブル版（#451）。実行ファイルの隣に目印のファイルがあれば、設定とデータを
//! すべてそのフォルダの中に持ち、ホストの OS には何も登録しない。
//!
//! ## 判定は目印のファイル
//!
//! **実行ファイルの隣に `portable.txt` があればポータブル版**（中身は見ない）。バイナリは
//! インストール版と同じ 1 つで、配布の zip に目印を同梱する。別ビルドにしないのは、
//! リリースの Windows のビルドがもう 1 回増えるため。`data` フォルダの有無で決めないのは、
//! 空のフォルダは zip で落ちやすく、消えるとインストール版として動き出して `%APPDATA%` へ
//! 書くため。
//!
//! **判定は `AppHandle` にも `tauri::Context` にも依らない。** `pike agent-hook` は Tauri を
//! 起動せずに申告を書いて終わる（`main.rs`）ので、本体と同じ答えをそこでも出せる必要が
//! ある。起こされるのはポータブル版の実行ファイル自身（`PIKE_HOOK_EXE` が絶対パスを渡す）
//! なので、同じ目印を見れば同じ置き場に着く。
//!
//! ## 変わるもの
//!
//! - **データの置き場**は `<フォルダ>\data`。Tauri のパス API を通るものは
//!   `appDirectoriesOverride`（`apply`）で、通らないものは `types::pike_config_dir_for` で動く。
//!   WebView2 のユーザーデータ（localStorage の設定）も Tauri が local data に置くので一緒に動く
//! - **identifier はフォルダごと**（`identifier_for`）。インストール版とも、別のフォルダに
//!   置いたポータブル版とも並んで動く。single-instance のプラグインは実行時の
//!   `app.config().identifier` を読み、`wait.rs` と hook の通知は `types::app_identifier` を
//!   読むので、両方がここの値になる
//! - **プロジェクトの base はこのフォルダに固定**で、`project.json` のパスは base からの
//!   相対で書く（`to_disk` / `from_disk`）。フォルダごと移してドライブレターが変わっても開ける
//! - **base の外は登録できない**（`can_register`）。WSL のディレクトリも Windows の別の
//!   場所も、登録せずに開くことはできる（#230）
//!
//! ## 止めるもの
//!
//! ホストに登録が残る機能は、入口で断る（`is_portable` と `ensure_installed` を読む側の
//! 一覧が正本）:
//! デスクトップ通知（スタートメニューのショートカットと `pike:` スキーム）、ジャンプリスト、
//! ログイン時の起動、Claude Code の `settings.json` への hook の登録、セルフアップデート
//! （updater のプラグインを載せない）。設定の同期と OS の通知はフロントが止める
//! （`src/lib/portable.ts` を読む側）。一覧と理由は `.claude/rules/portable.md` の表。
//!
//! **対象は Windows だけ**（macOS は見送り）。他の OS では常に `None` を返す。

use std::path::PathBuf;
use std::sync::OnceLock;

/// 目印のファイルの名前。
const MARKER: &str = "portable.txt";
/// データを置くフォルダの名前（実行ファイルの隣）。
const DATA_DIR: &str = "data";
/// `project.json` に書く、base からの相対パスの目印。後ろは `/` 区切りの相対パス
/// （base そのものは目印だけ）。**絶対パスと取り違えない綴り**であること: `:` を 2 文字目
/// 以外に持つ Windows のパスは無い。
const RELATIVE_PREFIX: &str = "pike-portable:";

pub struct Portable {
    /// 実行ファイルのあるフォルダ。プロジェクトの base でもある。
    pub base: PathBuf,
    /// 設定とデータの置き場。
    pub data: PathBuf,
    /// このフォルダの identifier。
    pub identifier: String,
}

/// ポータブル版として動いているなら、その情報。プロセスの寿命で 1 回だけ判定する。
pub fn get() -> Option<&'static Portable> {
    static STATE: OnceLock<Option<Portable>> = OnceLock::new();
    STATE.get_or_init(detect).as_ref()
}

fn detect() -> Option<Portable> {
    if !cfg!(windows) {
        return None;
    }
    let exe = std::env::current_exe().ok()?;
    let base = exe.parent()?.to_path_buf();
    if !base.join(MARKER).is_file() {
        return None;
    }
    // identifier は**実体のパス**から作る。同じフォルダには、割り当てたドライブ・UNC・
    // ジャンクションなど別の綴りで届きうる。綴りごとに identifier が変わると single-instance が
    // 効かず、2 つのプロセスが同じ `data` へ書いてセッションを巻き戻し合う。解決できなければ
    // 起動した綴りのまま使う。**base は起動した綴りのまま**（利用者に見せるパスなので）。
    let real = std::fs::canonicalize(&base).unwrap_or_else(|_| base.clone());
    Some(Portable {
        identifier: identifier_for(&real.to_string_lossy()),
        data: base.join(DATA_DIR),
        base,
    })
}

/// フォルダのパスから identifier を作る。
///
/// **ハッシュは自前の FNV-1a**（`DefaultHasher` を使わない）。あちらは Rust の版で値が
/// 変わりうるので、Pike を差し替えただけで identifier が動く。identifier は Docker の
/// トンネルの持ち主の印（`docker::DockerState::instance_id`）にもなるので、動くと前の版が
/// 作ったコンテナを自分のものと認識できなくなる。
///
/// 大小と区切りの違いを畳んでから取る（Windows のパスは大小を区別しないので、同じフォルダを
/// `c:\tools` と `C:\Tools` で起動しても同じ値になる）。
fn identifier_for(base: &str) -> String {
    let normalized = base
        .trim_end_matches(['\\', '/'])
        .replace('/', "\\")
        .to_lowercase();
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in normalized.bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("com.pike.portable.{hash:016x}")
}

/// Tauri の設定をポータブル版のものへ差し替える。**`Builder` へ渡す前**に呼ぶ
/// （single-instance のプラグインも `window_geom::prune_plugin_state` も、差し替えたあとの
/// identifier と置き場を読む）。
///
/// データのフォルダを作れなければ `Err`。**`%APPDATA%` へ逃がさない**: 黙って逃がすと、
/// ホストに何も残さないという前提が崩れたまま動き続ける（Program Files に置いた場合など）。
pub fn apply(context: &mut tauri::Context<tauri::Wry>) -> Result<(), String> {
    let Some(portable) = get() else {
        return Ok(());
    };
    let unwritable = |e: std::io::Error| format!("{}: {e}", portable.data.display());
    std::fs::create_dir_all(&portable.data).map_err(unwritable)?;
    // **実際に書いて確かめる。** `data` が既にあると `create_dir_all` は書けない場所でも
    // 成功する（書き込み禁止にした USB メモリに、前に使ったフォルダを置いた場合）。そのまま
    // 進むと、設定もログも保存できないまま理由の出ない画面になる。
    let probe = portable
        .data
        .join(format!(".write-test-{}", std::process::id()));
    std::fs::write(&probe, b"").map_err(unwritable)?;
    let _ = std::fs::remove_file(&probe);
    let config = context.config_mut();
    config.identifier.clone_from(&portable.identifier);
    // 絶対パスで渡す（相対でも Tauri が実行ファイルのフォルダを基準に解くが、`pike agent-hook` と
    // 同じ値を両方が使うほうが、置き場が 1 つであることを読み取りやすい）。
    config.app.app_directories_override = Some(tauri::utils::config::AppDirectoriesOverride::Root(
        portable.data.clone(),
    ));
    Ok(())
}

/// ポータブル版として動いているか。**ホストに登録を残す機能を止める側は、これか
/// `ensure_installed` を読む**（どちらを読んでいるかで、止めてある箇所を洗い出せる）。
pub fn is_portable() -> bool {
    get().is_some()
}

/// ホストに登録を残す操作の入口で呼ぶ。ポータブル版なら `Err`。
pub fn ensure_installed() -> Result<(), String> {
    if is_portable() {
        return Err("not available in the portable build".to_owned());
    }
    Ok(())
}

/// `root` をプロジェクトとして登録できるか。ポータブル版でなければ常に真。
///
/// 登録できるのは base と同じか、その下にあるディレクトリだけ。WSL の native パス
/// （`/home/...`）は base の下に来ないので、ここで自然に落ちる。
pub fn can_register(root: &str) -> bool {
    get().is_none_or(|p| relative_to(&p.base.to_string_lossy(), root).is_some())
}

/// `path` が `base` と同じか下にあれば、base からの相対パス（`/` 区切り。同じなら空）。
///
/// 大小は無視する（Windows のパス）。区切りは `\` と `/` のどちらでも受ける: フロントは
/// 場所によって `/` で繋いだパスを持つ。
fn relative_to(base: &str, path: &str) -> Option<String> {
    let base = base.trim_end_matches(['\\', '/']).replace('\\', "/");
    let path = path.trim_end_matches(['\\', '/']).replace('\\', "/");
    if base.is_empty() || path.len() < base.len() || !path.is_char_boundary(base.len()) {
        return None;
    }
    let (head, tail) = path.split_at(base.len());
    if head.to_lowercase() != base.to_lowercase() {
        return None;
    }
    let rest = match tail.strip_prefix('/') {
        Some(rest) => rest,
        None if tail.is_empty() => "",
        // `C:\pike-old` は `C:\pike` の下ではない。
        None => return None,
    };
    // `.` と `..` を含むパスは下にあるとは言えない（`E:\Pike\..\work` は base の外）。
    // 解決はせずに断る: 登録の入口が渡すのは解決済みのパスで、ここへ来るのは手で書いたもの。
    if rest.split('/').any(|part| part == "." || part == "..") {
        return None;
    }
    Some(rest.to_owned())
}

fn encode(base: &str, path: &str) -> Option<String> {
    relative_to(base, path).map(|rel| format!("{RELATIVE_PREFIX}{rel}"))
}

fn decode(base: &str, stored: &str) -> Option<String> {
    let rel = stored.strip_prefix(RELATIVE_PREFIX)?;
    let base = base.trim_end_matches(['\\', '/']);
    Some(if rel.is_empty() {
        // ドライブ直下が base のときは区切りを戻す。`E:` は「E ドライブのカレント
        // ディレクトリ」を指す別のパスになる。
        if base.ends_with(':') {
            format!("{base}\\")
        } else {
            base.to_owned()
        }
    } else {
        format!("{base}\\{}", rel.replace('/', "\\"))
    })
}

/// ディスクへ書く形にする（base の下のパスを相対にする）。ポータブル版でなければ何もしない。
///
/// base の外のパス（プロジェクトの外のファイルを開いたタブなど）は絶対パスのまま残る。
/// **どの欄がパスかは `ProjectConfig::map_paths` が持つ**（型の定義の隣）。
pub fn to_disk(config: &mut crate::project::ProjectConfig) {
    if let Some(portable) = get() {
        let base = portable.base.to_string_lossy();
        config.map_paths(|path| encode(&base, path));
    }
}

/// ディスクから読んだ形を、今の base の絶対パスへ戻す。ポータブル版でなければ何もしない。
pub fn from_disk(config: &mut crate::project::ProjectConfig) {
    if let Some(portable) = get() {
        let base = portable.base.to_string_lossy();
        config.map_paths(|stored| decode(&base, stored));
    }
}

/// フロントへ渡す情報。`null` ならポータブル版ではない。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortableInfo {
    /// プロジェクトの base（実行ファイルのあるフォルダ）。
    base: String,
}

/// ポータブル版として動いているか。フロントは mount の前に 1 回だけ聞く
/// （`src/lib/portable.ts`）。
#[tauri::command]
pub fn portable_info() -> Option<PortableInfo> {
    get().map(|p| PortableInfo {
        base: p.base.to_string_lossy().into_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 目印の名前は、zip を作るスクリプトにも別に書いてある。片方だけ変えると、配った zip が
    /// インストール版として動いて `%APPDATA%` へ書く（どの検査でも見つからない）。
    #[test]
    fn packaging_script_writes_the_marker() {
        let script = include_str!("../../scripts/package-portable.sh");
        assert!(script.contains(&format!("/{MARKER}\"")), "{MARKER}");
    }

    #[test]
    fn identifier_ignores_case_and_separators() {
        let a = identifier_for(r"C:\Tools\Pike");
        assert_eq!(a, identifier_for(r"c:\tools\pike\"));
        assert_eq!(a, identifier_for("C:/Tools/Pike"));
        assert_ne!(a, identifier_for(r"D:\Tools\Pike"));
        assert!(a.starts_with("com.pike.portable."));
    }

    #[test]
    fn relative_only_for_the_base_and_below() {
        let base = r"E:\Pike";
        assert_eq!(relative_to(base, r"E:\Pike"), Some(String::new()));
        assert_eq!(
            relative_to(base, r"e:\pike\oss\app"),
            Some("oss/app".into())
        );
        assert_eq!(relative_to(base, "E:/Pike/oss"), Some("oss".into()));
        assert_eq!(relative_to(base, r"E:\Pike-old\app"), None);
        assert_eq!(relative_to(base, r"C:\work\app"), None);
        assert_eq!(relative_to(base, "/home/kan/app"), None);
        // 文字列の上では下に見えても、`..` で外へ出られる。
        assert_eq!(relative_to(base, r"E:\Pike\..\work\app"), None);
        assert_eq!(relative_to(base, r"E:\Pike\oss\.\app"), None);
        assert_eq!(
            relative_to(base, r"E:\Pike\.config"),
            Some(".config".into())
        );
    }

    /// ドライブ直下に置いたとき、base 自身が `E:`（ドライブ相対）に化けない。
    #[test]
    fn drive_root_base_round_trips() {
        let stored = encode(r"E:\", r"E:\").unwrap();
        assert_eq!(decode(r"F:\", &stored).unwrap(), r"F:\");
        let stored = encode(r"E:\", r"E:\app").unwrap();
        assert_eq!(decode(r"F:\", &stored).unwrap(), r"F:\app");
    }

    /// 書いたものを別の base で読むと、その base の下へ付け替わる。
    #[test]
    fn stored_paths_follow_the_base() {
        let stored = encode(r"E:\Pike", r"E:\Pike\oss\app").unwrap();
        assert_eq!(stored, "pike-portable:oss/app");
        assert_eq!(
            decode(r"F:\usb\Pike", &stored).unwrap(),
            r"F:\usb\Pike\oss\app"
        );
        assert_eq!(
            decode(r"F:\usb\Pike", "pike-portable:").unwrap(),
            r"F:\usb\Pike"
        );
        // base の外は相対にしないので、読むときもそのまま。
        assert_eq!(encode(r"E:\Pike", r"C:\work\notes.md"), None);
        assert_eq!(decode(r"F:\usb\Pike", r"C:\work\notes.md"), None);
    }

    #[test]
    fn maps_every_path_field() {
        let mut config: crate::project::ProjectConfig = serde_json::from_str(
            r#"{
                "id": "app", "name": "app", "root": "E:\\Pike\\oss\\app",
                "shell": { "kind": "powershell" }, "pinnedTabs": [], "lastOpened": "",
                "lastSession": { "activeTabId": null, "tabs": [
                    { "id": "a", "kind": "editor", "title": "a", "pinned": false,
                      "path": "E:\\Pike\\oss\\app\\src\\a.rs" },
                    { "id": "b", "kind": "editor", "title": "b", "pinned": false,
                      "path": "C:\\work\\notes.md" },
                    { "id": "c", "kind": "terminal", "title": "c", "pinned": true,
                      "agentSession": { "id": "s", "dir": "E:\\Pike\\oss\\app-wt" } }
                ] }
            }"#,
        )
        .unwrap();
        config.map_paths(|p| encode(r"E:\Pike", p));
        assert_eq!(config.root, "pike-portable:oss/app");
        let tabs = &config.last_session.as_ref().unwrap().tabs;
        assert_eq!(
            tabs[0].path.as_deref(),
            Some("pike-portable:oss/app/src/a.rs")
        );
        assert_eq!(tabs[1].path.as_deref(), Some(r"C:\work\notes.md"));
        assert_eq!(
            tabs[2].extra["agentSession"]["dir"],
            "pike-portable:oss/app-wt"
        );

        config.map_paths(|p| decode(r"F:\Pike", p));
        assert_eq!(config.root, r"F:\Pike\oss\app");
        let tabs = &config.last_session.as_ref().unwrap().tabs;
        assert_eq!(tabs[0].path.as_deref(), Some(r"F:\Pike\oss\app\src\a.rs"));
        assert_eq!(tabs[2].extra["agentSession"]["dir"], r"F:\Pike\oss\app-wt");
    }
}
