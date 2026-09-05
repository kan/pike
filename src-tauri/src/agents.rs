//! コーディングエージェントの検出（#275 / #267）。
//!
//! **どのエージェントを知っているかは持たない。** 一覧の正本はフロントの
//! `src/lib/agents.ts` で、ここが受け取るのは「この名前のコマンドがあるか」だけ。
//! 両方に一覧を置くと、増やすたびに 2 つのファイルを揃えることになる（`lib/shortcuts.ts` の
//! 表と `appmenu` の関係と同じ分担で、語彙を持つ側は 1 つ）。
//!
//! **1 回のシェル起動で全部聞く。** 1 つずつ確かめると、WSL プロジェクトでは
//! `wsl.exe` の起動がエージェントの数だけ並ぶ（冷えていると 1 本あたり 1〜2 秒）。

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::State;

use crate::types::{install_key, marker_values, ShellConfig, LOGIN_PROBE_TIMEOUT};

/// 聞き直すまでの間隔（`claude_usage/config.rs` の `RESOLVE_TTL` と同じ考え方）。
///
/// **「見つからなかった」も覚える必要がある。** 覚えないと、表の 4 つを全部入れて
/// いない利用者は**タブを開くたびに**対話ログインシェルが 1 本上がる（新しい
/// ターミナルだけでなく、タスク実行や `docker compose up` が開くコマンドタブも
/// `pty_spawn` を通る）。かといって永久に覚えると、冷えた WSL でタイムアウトした
/// 1 回で再起動するまで起動ボタンが出ない。**間隔を置いて聞き直す**のが両方の答え。
const DETECT_TTL: Duration = Duration::from_secs(300);

/// 1 つの導入単位ぶんの答え。`asked` は**そのとき聞いた名前**で、`found` はそのうち
/// 見つかったもの。
///
/// **`asked` を持つのが要点。** キーはシェルだけなので、これが無いと「表の一部だけを
/// 聞いた 2 人目」の答えが TTL のあいだ起動メニューの答えとして返る（このモジュールの
/// doc は使用量・通知という将来の消費者を明示的に招いているので、1 人目のうちに閉じる）。
#[derive(Default)]
struct Answer {
    at: Option<Instant>,
    asked: HashSet<String>,
    found: HashSet<String>,
}

/// **シェルの導入単位**で覚える（`IssuesState` と同じ形）。
///
/// Pinia のストアはウィンドウごとなので、フロントだけで覚えると同じプロジェクトを
/// N 枚開いたときに検出が N 回走る。キーが導入単位なのは、WSL プロジェクトが見るのは
/// distro の中の PATH、Windows プロジェクトが見るのはホストのそれ、と答えが変わるため。
///
/// **ロックはキーごとに分ける。** 外側は取り出す一瞬だけ握り、probe（最長 30 秒）は
/// 内側のロックで囲む。1 本にすると、前回のセッションを復元して WSL と Windows の
/// ウィンドウが同時に立ち上がるとき、**キーが違う probe まで直列化**して起動の待ちが
/// そのぶん伸びる（しかも待っているあいだ blocking スレッドを 1 本占有する）。
type DetectCache = Arc<Mutex<HashMap<String, Arc<Mutex<Answer>>>>>;

#[derive(Default)]
pub struct AgentState {
    detected: DetectCache,
}

/// シェルの行に埋めてよい名前か。**組み立てる側が検証する**（`tasks.rs` の
/// `is_safe_cargo_name` と同じ規約）。フロントの表にある名前しか来ない前提だが、
/// IPC の引数は誰でも投げられる。
fn is_safe_bin_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

/// 見つかった名前を出すときの目印。`.bashrc` がバナー（このマシンの WSL は
/// `git status` の結果を出す）を混ぜてくるので、行の位置では選べない。
/// `claude_usage/config.rs` の `PIKEENV` と同じ手口。
const MARKER: &str = "PIKEAGENT";

/// 対話ログインシェルに渡すスクリプト（POSIX 側）。
///
/// **`unset HISTFILE` を先頭に置く**（`config.rs` と同じ理由）。対話シェルは終了時に
/// 履歴を書き戻すので、落とさないと `HISTSIZE` の設定次第でこのプローブが利用者の
/// `.bash_history` を削りうる。
fn posix_probe_script(bins: &[String]) -> String {
    let list = bins.join(" ");
    format!(
        "unset HISTFILE\nfor c in {list}; do command -v \"$c\" >/dev/null 2>&1 && printf '{MARKER}\\t%s\\n' \"$c\"; done\nexit 0"
    )
}

/// Windows 側の 1 行（`cmd.exe /C` に渡る）。
///
/// `run_shell_line` の Windows 側はシェル種別に関わらず `cmd.exe /C` で走らせる
/// （Git Bash も PowerShell もそこへ落ちる）ので、cmd の構文で書けば全部に当たる。
fn windows_probe_line(bins: &[String]) -> String {
    bins.iter()
        .map(|b| format!("where {b} >nul 2>&1 && echo {MARKER}\t{b}"))
        .collect::<Vec<_>>()
        .join(" & ")
}

/// PATH にあるエージェントの名前を返す（渡された順ではなく、見つかったものだけ）。
///
/// **失敗は「1 つも無い」として扱う**（`Err` にしない）。シェルが起動できないときに
/// 起動ボタンが消えるのは、エージェントが入っていないときと同じ見え方でよい。
#[tauri::command]
pub async fn agent_detect(
    shell: ShellConfig,
    root: String,
    bins: Vec<String>,
    state: State<'_, AgentState>,
) -> Result<Vec<String>, String> {
    let wanted: Vec<String> = bins.into_iter().filter(|b| is_safe_bin_name(b)).collect();
    if wanted.is_empty() {
        return Ok(Vec::new());
    }
    let key = install_key(&shell);
    let cache = state.detected.clone();
    tauri::async_runtime::spawn_blocking(move || {
        // 外側は entry を取り出す一瞬だけ握る（`DetectCache` の doc）。**毒されていても
        // 諦めない**: `into_inner` で中身をそのまま使う（probe を書き写した分岐を持たない）。
        let entry = {
            let mut map = cache.lock().unwrap_or_else(|e| e.into_inner());
            map.entry(key).or_default().clone()
        };
        // **こちらは probe 中も握ったまま。** 同じシェルへの問い合わせを合流させるため
        // （前回のセッションを復元して複数のウィンドウが同時に立ち上がるときに、対話
        // ログインシェルが枚数ぶん起きるのを防ぐ）。
        let mut answer = entry.lock().unwrap_or_else(|e| e.into_inner());
        let fresh = answer.at.is_some_and(|at| at.elapsed() < DETECT_TTL)
            && wanted.iter().all(|b| answer.asked.contains(b));
        if !fresh {
            answer.found = probe(&shell, &root, &wanted);
            answer.asked = wanted.iter().cloned().collect();
            answer.at = Some(Instant::now());
        }
        Ok(intersect(&wanted, &answer.found))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 聞かれた順で、見つかったものだけを返す。
fn intersect(wanted: &[String], found: &HashSet<String>) -> Vec<String> {
    wanted
        .iter()
        .filter(|b| found.contains(*b))
        .cloned()
        .collect()
}

/// PATH を実際に見に行く。
///
/// **POSIX 側は対話ログインシェルで聞く**（`ShellConfig::run_login_script`）。ここが要点で、
/// nvm / fnm / asdf / mise / Homebrew はどれも rc の中で PATH を足すので、非対話の
/// `bash -c` では「ターミナルでは打てるのに検出では見つからない」になる（この開発機の
/// WSL がまさにそれで、`claude` は非対話から見えない）。Pike のターミナルは対話シェル
/// なので、**判定する環境を PTY に合わせる**。
///
/// **Windows 側は `cmd /C where`。** cmd / PowerShell / pwsh はどれも Pike のプロセス
/// 環境を継ぐので、それで PTY と揃う。拾えないのは 2 通り: PowerShell のプロファイルの
/// 中だけで PATH を足した場合（`config.rs` と同じ既知の制約）と、**Git Bash**（PTY は
/// `--login` で起こすので `/etc/profile` と `~/.bash_profile` を読む）。どちらも
/// 「入れていない」と同じ見え方になるが、設定に行を足せば起動ボタンは出る。
fn probe(shell: &ShellConfig, root: &str, wanted: &[String]) -> HashSet<String> {
    let stdout = if shell.is_posix() {
        shell.run_login_script(&posix_probe_script(wanted), LOGIN_PROBE_TIMEOUT)
    } else {
        // **root は空で来る**（プロジェクトを持たないグローバルモードのウィンドウ）。
        // 見るのは PATH だけなので cwd はどこでもよいが、`current_dir("")` は失敗する。
        let dir = if root.trim().is_empty() { "." } else { root };
        shell
            .run_shell_line(dir, &windows_probe_line(wanted), LOGIN_PROBE_TIMEOUT)
            .ok()
            .map(|(_, stdout, _)| stdout)
    };
    stdout
        .map(|s| marker_values(&s, MARKER).into_iter().collect())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_names_that_would_reach_the_shell() {
        assert!(is_safe_bin_name("claude"));
        assert!(is_safe_bin_name("copilot-cli"));
        assert!(!is_safe_bin_name("rm -rf /"));
        assert!(!is_safe_bin_name("a;b"));
        assert!(!is_safe_bin_name("$(id)"));
        assert!(!is_safe_bin_name(""));
    }

    #[test]
    fn posix_script_asks_for_every_name_and_spares_the_history() {
        let script = posix_probe_script(&["claude".to_string(), "codex".to_string()]);
        assert!(script.starts_with("unset HISTFILE\n"));
        assert!(script.contains("for c in claude codex;"));
        assert!(script.contains("command -v"));
        assert!(script.contains("PIKEAGENT"));
    }

    #[test]
    fn windows_line_uses_cmd_syntax() {
        let line = windows_probe_line(&["claude".to_string(), "codex".to_string()]);
        assert_eq!(
            line,
            "where claude >nul 2>&1 && echo PIKEAGENT\tclaude & where codex >nul 2>&1 && echo PIKEAGENT\tcodex"
        );
    }

    /// 見つかった名前は `types.rs` の `marker_values` が拾う（そちらにテストがある）。
    /// ここでは目印の綴りが両方の腕で揃っていることだけを確かめる。
    #[test]
    fn both_arms_use_the_same_marker() {
        assert!(posix_probe_script(&["claude".to_string()]).contains(MARKER));
        assert!(windows_probe_line(&["claude".to_string()]).contains(MARKER));
    }
}
