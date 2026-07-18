//! Windows タスクバーのジャンプリスト（ピン留めアイコンの右クリックメニュー）。
//!
//! VS Code / Windows Terminal のように、Pike のアイコンを右クリックしたときの
//! メニューへ独自の「タスク」とプロジェクト一覧を差し込む（issue #160）。
//!
//! Windows は `ICustomDestinationList`（COM）でジャンプリストを構築する。本
//! モジュールは以下を登録する:
//!   - Tasks カテゴリ: 「新しいターミナルウィンドウ」→ `pike.exe --terminal`
//!   - 独自カテゴリ「プロジェクト」: 登録プロジェクトを最近開いた順に列挙し、
//!     選ぶと `pike.exe <root>` で該当ウィンドウをフォーカス / 新規に開く
//!     （single-instance の OpenDirectory ルーティングをそのまま再利用）
//!   - KDC_RECENT: 既定の「最近開いたファイル」カテゴリを復元する。カスタム
//!     リストを構築すると明示的に足さない限り消えてしまうため。
//!
//! ラベルは UI 言語に追従させたいが、Rust からフロントの i18n / localStorage は
//! 読めないので、フロント（`jumplistRefresh(locale)`）が現在のロケールを渡す。
//! Tasks / カテゴリ名の 2 文字列だけ言語別に持つ。
//!
//! COM のスレッド注意: shell のオブジェクトは STA。wry が main スレッドを STA で
//! OLE 初期化しているため、`run_on_main_thread` で main に載せてから構築する。
//! そこでは `CoInitializeEx` は S_FALSE（初期化済み）を返すので `CoUninitialize`
//! は呼ばない（呼ぶと wry の COM を壊す）。

use std::collections::HashSet;
use std::hash::{Hash, Hasher};
use std::sync::{Mutex, OnceLock};

use tauri::{AppHandle, Manager};
use windows::core::{Interface, HSTRING, PWSTR};
use windows::Win32::Foundation::{E_FAIL, E_OUTOFMEMORY, PROPERTYKEY, S_OK};
use windows::Win32::System::Com::StructuredStorage::{
    PROPVARIANT, PROPVARIANT_0, PROPVARIANT_0_0, PROPVARIANT_0_0_0,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemAlloc, CoUninitialize, CLSCTX_INPROC_SERVER,
    COINIT_APARTMENTTHREADED,
};
use windows::Win32::System::Variant::VT_LPWSTR;
use windows::Win32::UI::Shell::Common::{IObjectArray, IObjectCollection};
use windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore;
use windows::Win32::UI::Shell::{
    DestinationList, EnumerableObjectCollection, ICustomDestinationList, IShellLinkW, ShellLink,
    KDC_RECENT,
};

use crate::project;
use crate::types::ShellConfig;

/// 一覧に載せるプロジェクトの最大件数（Windows のカテゴリ表示上限にも収まる）。
const MAX_PROJECTS: usize = 10;

/// PKEY_Title（ジャンプリスト項目のタイトル）。`Win32_Storage_EnhancedStorage`
/// feature を足さずに済むよう定数を直接定義する。
const PKEY_TITLE: PROPERTYKEY = PROPERTYKEY {
    fmtid: windows::core::GUID::from_u128(0xf29f85e0_4ff9_1068_ab91_08002b27b3d9),
    pid: 2,
};

/// 直近にコミットしたリストの署名。フロントは session flush など無関係な契機でも
/// 呼びうるので、内容が変わらないなら CommitList をスキップする。
fn last_sig() -> &'static Mutex<Option<u64>> {
    static S: OnceLock<Mutex<Option<u64>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(None))
}

struct Labels {
    new_terminal: &'static str,
    projects: &'static str,
}

fn labels(lang: &str) -> Labels {
    if lang.starts_with("ja") {
        Labels {
            new_terminal: "新しいターミナルウィンドウ",
            projects: "プロジェクト",
        }
    } else {
        Labels {
            new_terminal: "New Terminal Window",
            projects: "Projects",
        }
    }
}

/// 1 プロジェクト分のリンク素材。
struct Entry {
    /// 表示タイトル（プロジェクト名）
    title: String,
    /// `pike.exe` に渡す引数（クォート済み）
    args: String,
    /// ツールチップ（開く先パス）
    tooltip: String,
}

/// ジャンプリストを再構築する。実際の COM 構築は main（STA）スレッドで行う。
pub fn refresh(app: &AppHandle, lang: &str) {
    let projects = collect_projects(app);
    let lang = lang.to_string();
    let _ = app.run_on_main_thread(move || {
        if let Err(e) = build_and_commit(&lang, &projects) {
            log::warn!("[jumplist] refresh failed: {e:?}");
        }
    });
}

/// 登録プロジェクトを最近開いた順に最大 MAX_PROJECTS 件、リンク素材へ変換する。
fn collect_projects(app: &AppHandle) -> Vec<Entry> {
    let Some(state) = app.try_state::<project::ProjectState>() else {
        return vec![];
    };
    project::read_all_projects_sorted(&state.config_dir)
        .into_iter()
        .take(MAX_PROJECTS)
        .map(|p| {
            let path = open_arg_for(&p.shell, &p.root);
            Entry {
                title: p.name,
                args: quote_arg(&path),
                tooltip: path,
            }
        })
        .collect()
}

/// `pike.exe` にプロジェクトを開かせるためのパス引数。WSL プロジェクトの root は
/// ネイティブパス（例 `/home/kan/foo`）なので、CLI 側で解釈できる UNC 形へ変換する
/// （`\\wsl.localhost\<distro>\...`。cli::resolve_path_arg が native へ戻して
/// OpenDirectory のマッチに使う）。Windows プロジェクトは root をそのまま渡す。
fn open_arg_for(shell: &ShellConfig, root: &str) -> String {
    match shell {
        ShellConfig::Wsl { distro } => {
            let tail = root.replace('/', "\\");
            let tail = if tail.starts_with('\\') {
                tail
            } else {
                format!("\\{tail}")
            };
            format!(r"\\wsl.localhost\{distro}{tail}")
        }
        _ => root.to_string(),
    }
}

/// 引数 1 個としてダブルクォートで囲む（スペース入りパス対策）。
fn quote_arg(s: &str) -> String {
    format!("\"{}\"", s.replace('"', "\\\""))
}

fn build_and_commit(lang: &str, projects: &[Entry]) -> windows::core::Result<()> {
    let exe = std::env::current_exe()
        .map_err(|e| {
            log::warn!("[jumplist] current_exe failed: {e}");
            windows::core::Error::from(E_FAIL)
        })?
        .to_string_lossy()
        .into_owned();
    let home = std::env::var("USERPROFILE").ok();
    let labels = labels(lang);

    let sig = compute_sig(&exe, lang, projects);
    if *last_sig().lock().unwrap() == Some(sig) {
        return Ok(());
    }

    unsafe {
        let hr = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        // S_OK = 本モジュールが初期化した。S_FALSE / RPC_E_CHANGED_MODE は既に
        // 別コード（wry）が所有 → uninit しない。
        let need_uninit = hr == S_OK;
        let res = build_inner(&exe, home.as_deref(), &labels, projects);
        if need_uninit {
            CoUninitialize();
        }
        res?;
    }

    *last_sig().lock().unwrap() = Some(sig);
    Ok(())
}

unsafe fn build_inner(
    exe: &str,
    home: Option<&str>,
    labels: &Labels,
    projects: &[Entry],
) -> windows::core::Result<()> {
    let list: ICustomDestinationList =
        CoCreateInstance(&DestinationList, None, CLSCTX_INPROC_SERVER)?;

    // BeginList はユーザーが「一覧から削除」した項目を返す。カスタムカテゴリに
    // 同じ項目を再投入すると CommitList が失敗しうるので、引数で照合して除外する。
    let mut min_slots: u32 = 0;
    let removed: IObjectArray = list.BeginList(&mut min_slots)?;
    let removed_args = removed_arg_set(&removed);

    // 独自カテゴリ「プロジェクト」
    if !projects.is_empty() {
        let coll: IObjectCollection =
            CoCreateInstance(&EnumerableObjectCollection, None, CLSCTX_INPROC_SERVER)?;
        let mut added = 0u32;
        for e in projects {
            if removed_args.contains(&e.args) {
                continue;
            }
            let link = make_link(exe, &e.args, &e.title, Some(&e.tooltip), None)?;
            coll.AddObject(&link)?;
            added += 1;
        }
        if added > 0 {
            // 失敗しても Tasks / Recent は生かす。
            if let Err(err) = list.AppendCategory(&HSTRING::from(labels.projects), &coll) {
                log::warn!("[jumplist] AppendCategory failed: {err:?}");
            }
        }
    }

    // 既定の「最近開いたファイル」を復元（カスタムリストで消えるため）。
    let _ = list.AppendKnownCategory(KDC_RECENT);

    // Tasks カテゴリ（常に最下部に表示される）。
    let tasks: IObjectCollection =
        CoCreateInstance(&EnumerableObjectCollection, None, CLSCTX_INPROC_SERVER)?;
    let term = make_link(exe, "--terminal", labels.new_terminal, None, home)?;
    tasks.AddObject(&term)?;
    list.AddUserTasks(&tasks)?;

    list.CommitList()?;
    Ok(())
}

/// `pike.exe <args>` を起動する IShellLinkW を作る。title は PKEY_Title に、
/// tooltip は Description に、workdir は作業ディレクトリに設定する。
unsafe fn make_link(
    exe: &str,
    args: &str,
    title: &str,
    tooltip: Option<&str>,
    workdir: Option<&str>,
) -> windows::core::Result<IShellLinkW> {
    let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)?;
    link.SetPath(&HSTRING::from(exe))?;
    link.SetArguments(&HSTRING::from(args))?;
    // アプリ本体のアイコンを流用。
    link.SetIconLocation(&HSTRING::from(exe), 0)?;
    if let Some(t) = tooltip {
        link.SetDescription(&HSTRING::from(t))?;
    }
    if let Some(w) = workdir {
        link.SetWorkingDirectory(&HSTRING::from(w))?;
    }

    let store: IPropertyStore = link.cast()?;
    let title_pv = title_propvariant(title)?;
    store.SetValue(&PKEY_TITLE, &title_pv)?;
    store.Commit()?;
    Ok(link)
}

/// VT_LPWSTR の PROPVARIANT を作る。文字列は CoTaskMemAlloc で確保し、
/// PROPVARIANT の Drop（PropVariantClear）が CoTaskMemFree で解放する。
/// （crate の `From<&str>` は VT_BSTR になり、ジャンプリストのタイトルとして
/// 表示されないため手組みする）
unsafe fn title_propvariant(s: &str) -> windows::core::Result<PROPVARIANT> {
    let wide: Vec<u16> = s.encode_utf16().chain(std::iter::once(0)).collect();
    let mem = CoTaskMemAlloc(wide.len() * 2) as *mut u16;
    if mem.is_null() {
        return Err(windows::core::Error::from(E_OUTOFMEMORY));
    }
    std::ptr::copy_nonoverlapping(wide.as_ptr(), mem, wide.len());
    Ok(PROPVARIANT {
        Anonymous: PROPVARIANT_0 {
            Anonymous: std::mem::ManuallyDrop::new(PROPVARIANT_0_0 {
                vt: VT_LPWSTR,
                wReserved1: 0,
                wReserved2: 0,
                wReserved3: 0,
                Anonymous: PROPVARIANT_0_0_0 { pwszVal: PWSTR(mem) },
            }),
        },
    })
}

/// BeginList が返した「ユーザーが削除した項目」の引数集合を作る。
unsafe fn removed_arg_set(removed: &IObjectArray) -> HashSet<String> {
    let mut set = HashSet::new();
    let count = removed.GetCount().unwrap_or(0);
    for i in 0..count {
        let Ok(link) = removed.GetAt::<IShellLinkW>(i) else {
            continue;
        };
        let mut buf = [0u16; 1024];
        if link.GetArguments(&mut buf).is_ok() {
            let s = String::from_utf16_lossy(&buf);
            let s = s.trim_end_matches('\0');
            if !s.is_empty() {
                set.insert(s.to_string());
            }
        }
    }
    set
}

fn compute_sig(exe: &str, lang: &str, projects: &[Entry]) -> u64 {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    exe.hash(&mut h);
    lang.hash(&mut h);
    for e in projects {
        e.title.hash(&mut h);
        e.args.hash(&mut h);
    }
    h.finish()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_project_passes_root_verbatim() {
        let shell = ShellConfig::Powershell;
        assert_eq!(
            open_arg_for(&shell, r"C:\work\pike"),
            r"C:\work\pike".to_string()
        );
    }

    #[test]
    fn wsl_project_becomes_unc() {
        let shell = ShellConfig::Wsl {
            distro: "Ubuntu".to_string(),
        };
        // native /home/kan/foo -> \\wsl.localhost\Ubuntu\home\kan\foo so the CLI
        // (cli::resolve_path_arg) can convert it back and match the WSL root.
        assert_eq!(
            open_arg_for(&shell, "/home/kan/foo"),
            r"\\wsl.localhost\Ubuntu\home\kan\foo".to_string()
        );
        // distro root
        assert_eq!(
            open_arg_for(&shell, "/"),
            r"\\wsl.localhost\Ubuntu\".to_string()
        );
    }

    #[test]
    fn quote_arg_wraps_and_escapes() {
        assert_eq!(quote_arg(r"C:\a b\c"), r#""C:\a b\c""#.to_string());
        assert_eq!(quote_arg(r#"a"b"#), r#""a\"b""#.to_string());
    }

    #[test]
    fn labels_follow_locale() {
        assert_eq!(labels("ja").projects, "プロジェクト");
        assert_eq!(labels("ja-JP").projects, "プロジェクト");
        assert_eq!(labels("en").projects, "Projects");
    }
}
