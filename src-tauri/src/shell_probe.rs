//! シェルに「PATH と環境変数」を 1 回で聞く共有の場所（#275 の宿題 3）。
//!
//! 問いは 2 つある。
//!
//! - **エージェントの `bin` が PATH にあるか**（`agents.rs` の起動ボタン）
//! - **`CLAUDE_CONFIG_DIR` に何が入っているか**（`claude_usage/config.rs` の集計・
//!   セッション一覧・レート取得）
//!
//! **どちらも同じ対話ログインシェル（`-lic`）に聞く。** 別々に起こしていたころは、
//! 同じ distro に 2 本の `bash -lic` が上がっていた。**費用のほぼ全部は rc の評価**
//! （nvm / fnm / asdf / mise / Homebrew が PATH を組み立てる）で、問いの数ではない。
//! 1 回の起動で両方の目印を出させれば、そこが半分になる。
//!
//! **効くのは 2 回目以降**（1 セッションにつき 1 回は 2 本上がりうる）。エージェントの
//! 名前を知っているのはフロントだけなので、環境変数の側が先に走ったときの probe は
//! 名前を 1 つも聞けず、直後の `agent_bins` がもう 1 本起こす。しかもそのとき
//! `agent_bins` は前の probe を待つので、独立していたころより**遅くなる**。ウィンドウを
//! 開いた直後は実際にこの順になりやすい（usage のポーリングはプロジェクトを開いた時点、
//! エージェント検出は PTY が上がったあと）。
//!
//! **Rust に名前の一覧を持たせて先回りしない。** それは `agents.rs` の doc が約束した
//! 分担（語彙を持つ側は 1 つ）を崩す。TTL のあいだに `asked` が埋まれば、以後の更新は
//! 1 本にまとまる。
//!
//! **答えは導入単位（`install_key`）で覚える。** WSL プロジェクトが見るのは distro の
//! 中の PATH、Windows プロジェクトが見るのはホストのそれ、と答えが変わる。ウィンドウを
//! 何枚開いても導入単位につき 1 回でよい。
//!
//! **Tauri の `manage` ではなくプロセス内の `OnceLock` に置く。** 消費者の片方
//! （`claude_usage/config.rs` の `shell_env_value`）はコマンドではない素の関数で、
//! `State` を受け取れない。同じ理由であちらが元から `OnceLock` を持っていた。

use std::collections::HashSet;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use crate::cache::{ProbeEntry, ProbeRegistry};
use crate::types::{install_key, marker_values, ShellConfig, LOGIN_PROBE_TIMEOUT};

/// 聞き直すまでの間隔。
///
/// **「見つからなかった」も覚える必要がある。** 覚えないと、表の 4 つを全部入れて
/// いない利用者は**タブを開くたびに**対話ログインシェルが 1 本上がる（新しいターミナル
/// だけでなく、タスク実行や `docker compose up` が開くコマンドタブも `pty_spawn` を
/// 通る）。かといって永久に覚えると、冷えた WSL でタイムアウトした 1 回で再起動するまで
/// 起動ボタンが出ない。**間隔を置いて聞き直す**のが両方の答え。
///
/// **2 つの問いで同じ長さにしてある。** ずらすと、片方の期限が切れるたびに結局
/// シェルが起きるので、まとめた意味が薄れる。
const PROBE_TTL: Duration = Duration::from_secs(300);

/// 見つかった名前を出すときの目印。`.bashrc` がバナー（このマシンの WSL は
/// `git status` の結果を出す）を混ぜてくるので、行の位置では選べない。
const AGENT_MARKER: &str = "PIKEAGENT";
/// 環境変数の値を出すときの目印。
const ENV_MARKER: &str = "PIKEENV";

/// 1 つの導入単位ぶんの答え。
///
/// **`asked` を持つのが要点。** キーはシェルだけなので、これが無いと「表の一部だけを
/// 聞いた 2 人目」の答えが TTL のあいだ起動メニューの答えとして返る。
#[derive(Default)]
struct Answer {
    at: Option<Instant>,
    /// そのとき聞いたエージェントの名前。
    asked: HashSet<String>,
    /// そのうち PATH にあったもの。
    found: HashSet<String>,
    /// `CLAUDE_CONFIG_DIR`。**空文字は `None` に落とす**（未設定と同じ扱い）。
    env: Option<String>,
}

/// 1 つの導入単位ぶんの入れ物。
///
/// **ロックを 2 つに分ける形は `cache::ProbeEntry` の担当**（#315 でそこへ上げた。理由も
/// あのモジュールの doc が正本）。ここで効いているのは、**エージェント検出の probe
/// （最長 30 秒）が `CLAUDE_CONFIG_DIR` の読み出しを止めない**こと。あちらは `resolve()` が
/// グローバルのロックを握ったまま呼ぶので、待たせると別プロジェクトの usage・レート・
/// セッション一覧の解決まで巻き添えになる。
type Entry = ProbeEntry<Answer>;

fn entry_for(shell: &ShellConfig) -> Arc<Entry> {
    static REGISTRY: OnceLock<ProbeRegistry<String, Answer>> = OnceLock::new();
    REGISTRY
        .get_or_init(ProbeRegistry::new)
        .entry(install_key(shell))
}

/// PATH にあるエージェントの名前（聞かれたもののうち見つかったもの）。
///
/// **失敗は「1 つも無い」として扱う**（`Err` にしない）。シェルが起動できないときに
/// 起動ボタンが消えるのは、エージェントが入っていないときと同じ見え方でよい。
///
/// **名前はここで検証する**（`is_safe_bin_name`）。シェルの行を組み立てるのはこの
/// モジュールなので、規約どおり組み立てる側が番人になる（`agents.rs` の呼び出しも
/// 同じ関数を通しているが、`pub` な入口はここ 1 つではない前提で書く）。
pub fn agent_bins(shell: &ShellConfig, root: &str, wanted: &[String]) -> HashSet<String> {
    let wanted: Vec<String> = wanted
        .iter()
        .filter(|b| is_safe_bin_name(b))
        .cloned()
        .collect();
    let entry = entry_for(shell);
    let stale = {
        let answer = entry.answer();
        !covers(&answer, &wanted)
    };
    if stale {
        // **ここは待つ。** 同じシェルへの問い合わせを 1 本に畳むのが目的で、呼ぶ側は
        // `spawn_blocking` の中に居る。
        let _probing = entry.probing();
        refresh_if_stale(shell, root, &entry, &wanted);
    }
    let answer = entry.answer();
    answer.found.clone()
}

/// そのシェルが持っている `CLAUDE_CONFIG_DIR`。**WSL 専用**（他のシェルの扱いは
/// `claude_usage/config.rs` の担当で、あちらが Pike のプロセス環境を見る）。
///
/// **期限切れのときは、前に聞いたエージェントの名前も一緒に聞き直す。** そうしないと、
/// 30 秒ごとの usage ポーリングがこちらだけを更新し、少しあとで起動ボタンの側が同じ
/// シェルをもう一度起こすことになる。まとめた意味はここで効く。
///
/// **走っている probe を待たないのは、前の答えを持っているときだけ**（`try_lock`）。
/// 防いでいるのは「同じ導入単位のエージェント検出が probe 中にここへ来る」ときの待ちで、
/// 呼び出し元の `resolve()` はグローバルのロックを握ったままここへ来るため、待つと
/// **別プロジェクトの解決まで**巻き添えになる。走っているのは同じ `-lic` なので、
/// 次のポーリング（30 秒後）には答えが入っている。
///
/// **一度も答えを持っていないときは待つ。** そこで `None` を返すと、`resolve()` が
/// それを `RESOLVE_TTL`（5 分）、`rate.rs` は最大 1 時間覚えるので、**別アカウントの
/// 残量をステータスバーが出す**（#225 が直した症状）。ウィンドウを開いた直後は
/// エージェント検出と usage のポーリングが同じ tick で走るため、この競合は普通に起きる。
/// 待つといっても相手は同じ `-lic` 1 本で、答えが入ったら即座に返る。
///
/// **待ちが及ぶ範囲は同じキーの解決だけ**（#315 で `resolve()` をキーごとのロックにした）。
/// 以前はあちらがキーに関わらず 1 本だったので、ここが自分で probe するあいだ**どの
/// プロジェクトの解決も**待っていた。今そこで待つのは、同じ (インストール, root) を
/// 見に来た者 —— つまり `probing()` が畳む相手そのもの。
pub fn config_dir_env(shell: &ShellConfig) -> Option<String> {
    let entry = entry_for(shell);
    let (stale, answered) = {
        let answer = entry.answer();
        (!is_fresh(&answer), answer.at.is_some())
    };
    if stale {
        let probing = if answered {
            entry.try_probing()
        } else {
            Some(entry.probing())
        };
        if let Some(_probing) = probing {
            let asked: Vec<String> = {
                let answer = entry.answer();
                answer.asked.iter().cloned().collect()
            };
            refresh_if_stale(shell, "", &entry, &asked);
        }
    }
    let answer = entry.answer();
    answer.env.clone()
}

fn is_fresh(answer: &Answer) -> bool {
    answer.at.is_some_and(|at| at.elapsed() < PROBE_TTL)
}

/// 覚えている答えでその問いに足りるか。**鮮度だけでは足りない**（`asked` を見る理由は
/// `Answer` の doc）ので、判定を 1 箇所に置く。
fn covers(answer: &Answer, wanted: &[String]) -> bool {
    is_fresh(answer) && wanted.iter().all(|b| answer.asked.contains(b))
}

/// `probe` のロックを取ったあとで、もう一度だけ鮮度を見てから聞きに行く。
///
/// **二度見るのが要点**（double-checked locking）。ロックを待っているあいだに前の持ち主が
/// 同じ問いを済ませていることがあり、そのまま走らせるとシェルが 2 回起きる。
fn refresh_if_stale(shell: &ShellConfig, root: &str, entry: &Entry, wanted: &[String]) {
    let asked = {
        let answer = entry.answer();
        if covers(&answer, wanted) {
            return;
        }
        answer.asked.clone()
    };

    // **聞く名前は「前に聞いたもの ∪ 今ほしいもの」。** 環境変数の側から呼ばれたときに
    // エージェントの答えを落とさないため（落とすと次の `agent_bins` が同じシェルをもう
    // 一度起こす）。
    let mut bins: Vec<String> = asked
        .union(&wanted.iter().cloned().collect())
        .cloned()
        .collect();
    // 出力の順は読まないが、決めておくとテストが書ける。
    bins.sort();

    let stdout = if shell.is_posix() {
        shell.run_login_script(&posix_script(shell, &bins), LOGIN_PROBE_TIMEOUT)
    } else {
        // **root は空で来ることがある**（プロジェクトを持たないグローバルモードの
        // ウィンドウ、および環境変数の側からの呼び出し）。見るのは PATH だけなので
        // cwd はどこでもよいが、`current_dir("")` は失敗する。
        let dir = if root.trim().is_empty() { "." } else { root };
        shell
            .run_shell_line(dir, &windows_line(&bins), LOGIN_PROBE_TIMEOUT)
            .ok()
            .map(|(_, stdout, _)| stdout)
    };

    let mut answer = entry.answer();
    // **聞けなかったときは前の答えを残す。** 冷えた WSL のタイムアウトは普通に起きるので、
    // 上書きすると**エージェント検出の 1 回の失敗が、解決済みの `CLAUDE_CONFIG_DIR` を
    // 捨てる**。そうなると次の TTL のあいだ既定の `~/.claude` を見て、ステータスバーが
    // 別アカウントの残量を出す（#225 が直した症状）。**時刻は打つ**（打たないと、壊れた
    // シェルに対して呼ばれるたびに 30 秒待つ）。
    if let Some(stdout) = stdout {
        answer.found = marker_values(&stdout, AGENT_MARKER).into_iter().collect();
        answer.env = marker_values(&stdout, ENV_MARKER).into_iter().next();
    }
    answer.asked = bins.into_iter().collect();
    answer.at = Some(Instant::now());
}

/// シェルの行に埋めてよい名前か。**組み立てる側が検証する**（`tasks.rs` の
/// `is_safe_cargo_name` と同じ規約）。フロントの表にある名前しか来ない前提だが、
/// IPC の引数は誰でも投げられる。
pub fn is_safe_bin_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

/// 対話ログインシェルに渡すスクリプト。
///
/// `unset HISTFILE` と `exit 0` は `run_login_script` が前後に付ける（起こし方の契約は
/// あちらが持つ）。ここが持つのは問いだけ。
///
/// **環境変数を聞くのは WSL のときだけ。** 他の POSIX シェル（macOS のローカルシェル）
/// では `claude_usage/config.rs` が Pike のプロセス環境を見る決まりで、ここで値を取っても
/// 使い道が無い（`.claude/rules/platform.md` の「macOS で拾えない環境変数」。**この
/// まとめによって代償は消えた**ので、有効にするなら向こうの 1 行を変えるだけになった）。
fn posix_script(shell: &ShellConfig, bins: &[String]) -> String {
    let mut lines: Vec<String> = Vec::new();
    if matches!(shell, ShellConfig::Wsl { .. }) {
        lines.push(format!(
            "printf '{ENV_MARKER}\\t%s\\n' \"$CLAUDE_CONFIG_DIR\""
        ));
    }
    if !bins.is_empty() {
        let list = bins.join(" ");
        lines.push(format!(
            "for c in {list}; do command -v \"$c\" >/dev/null 2>&1 && printf '{AGENT_MARKER}\\t%s\\n' \"$c\"; done"
        ));
    }
    lines.join("\n")
}

/// Windows 側の 1 行（`cmd.exe /C` に渡る）。
///
/// `run_shell_line` の Windows 側はシェル種別に関わらず `cmd.exe /C` で走らせる
/// （Git Bash も PowerShell もそこへ落ちる）ので、cmd の構文で書けば全部に当たる。
/// **環境変数は聞かない**: Windows シェルは Pike のプロセス環境を継ぐので、あちらが
/// 自分で読める。
fn windows_line(bins: &[String]) -> String {
    bins.iter()
        .map(|b| format!("where {b} >nul 2>&1 && echo {AGENT_MARKER}\t{b}"))
        .collect::<Vec<_>>()
        .join(" & ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wsl() -> ShellConfig {
        ShellConfig::Wsl {
            distro: "Ubuntu".to_string(),
        }
    }

    #[test]
    fn wsl_script_asks_both_questions_in_one_go() {
        let script = posix_script(&wsl(), &["claude".to_string(), "codex".to_string()]);
        assert!(script.contains("PIKEENV\\t%s"), "{script}");
        assert!(script.contains("for c in claude codex;"), "{script}");
        assert!(script.contains("PIKEAGENT\\t%s"), "{script}");
        // 起こし方の契約は `run_login_script` の担当なので、ここでは付けない。
        assert!(!script.contains("unset HISTFILE"), "{script}");
        assert!(!script.contains("exit 0"), "{script}");
    }

    /// macOS のローカルシェルでは環境変数を聞かない（`posix_script` の doc）。
    #[test]
    fn local_unix_script_asks_only_for_bins() {
        let script = posix_script(
            &ShellConfig::Unix {
                program: String::new(),
            },
            &["claude".to_string()],
        );
        assert!(!script.contains(ENV_MARKER), "{script}");
        assert!(script.contains(AGENT_MARKER), "{script}");
    }

    /// エージェントを 1 つも聞かないとき（環境変数の側から、まだ何も聞いていない
    /// シェルに対して呼ばれた場合）でも、空の `for` を流さない。
    #[test]
    fn empty_bin_list_leaves_out_the_loop() {
        let script = posix_script(&wsl(), &[]);
        assert_eq!(script, "printf 'PIKEENV\\t%s\\n' \"$CLAUDE_CONFIG_DIR\"");
    }

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
    fn windows_line_uses_cmd_syntax() {
        let line = windows_line(&["claude".to_string(), "codex".to_string()]);
        assert_eq!(
            line,
            "where claude >nul 2>&1 && echo PIKEAGENT\tclaude & where codex >nul 2>&1 && echo PIKEAGENT\tcodex"
        );
    }
}
