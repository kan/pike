//! 今動いているエージェントのセッションの一覧を、アカウントごとに集める（#625 / #633）。
//!
//! **返すのはアカウント（エージェント × 環境 × 設定ディレクトリ）ごとの一覧の配列。** 1 つの
//! 一覧の中身は、Claude なら `claude_usage/live.rs`、Codex なら `codex_usage/live.rs` が読む。
//! 生存の照合（`procStart`・`DeadRecords`）は Claude の `live_records` 1 つのままで、ここは
//! 「どこを読むか」を決めるだけ。
//!
//! ## どの環境を読むか
//!
//! **今のプロジェクトの環境に加えて、Windows では、ホストと「Pike のターミナルが開いている
//! WSL の distro」を読む**（利用者の要望。Windows のプロジェクトを開いていても、WSL で動いている
//! claude が見える）。
//!
//! - **止まっている distro は読まない。** `\\wsl.localhost\<distro>` を読むとその distro が
//!   起動する。しかもポーリングで読み続けると、止まるはずの distro をずっと起こし続ける。
//!   **Pike のターミナルが開いている distro は確かに動いている**（その `wsl.exe` が保っている）ので、
//!   それだけを読む（`PtyState::open_wsl_distros`。プロセスを起こさない）
//!   - `wsl.exe --list --running` に聞く案は採らない。ポーリングのたびにプロセスを起こすか、
//!     答えを覚えるあいだに止まった distro を読んで起こすか（読むと動いている扱いになり、
//!     次の問い合わせも「動いている」と答えるので、起こし続ける）のどちらかになる
//!   - 代償: Pike のターミナルを開いていない distro で、Pike の外から起動したセッションは、
//!     今のプロジェクトがその distro でない限り並ばない
//! - **distro のホームは `wsl_home_cached`**（distro につき 1 回だけ `bash -c 'echo $HOME'`。
//!   ログインシェルは起こさない。distro が動いているので起こすこともない）
//! - **生存の照合は環境ごとに別**（Windows のプロセスと各 distro の `/proc` は別の pid 空間）。
//!   一覧は環境のシェルを持って返り、照合もそのシェルで行う（`Liveness::new` が環境で分かれる）
//! - **飛んだ先でターミナルを開くシェルも、一覧の環境のもの**（フロントが `LiveSessionList::shell`
//!   を使う）。WSL のセッションは WSL の distro で、Windows のセッションはホストのシェルで再開する
//! - macOS / Linux はホストだけ（WSL が無い）
//!
//! ## どのアカウントを読むか（Claude）
//!
//! 環境ごとに、次の候補を 1 つに畳んで読む。**今のプロジェクトのアカウントが先頭**で、これだけは
//! セッションが無くても返す（パネルの「動いていません」の見出しのため）。ほかはセッションが
//! 1 つでもあるときだけ返す。だから**アカウントが 1 つで Codex を使っていなければ、今までと
//! 同じ 1 つの一覧になる**。
//!
//! 1. 今のプロジェクトで解決したもの（`config::resolve`。今の環境だけ）
//! 2. hook の申告（`agent_hook::declared_config_dirs`）。プロジェクトを問わず、その環境で実際に
//!    走った claude が見ていた場所
//! 3. ホーム直下の `.claude*`（`agent_hook::candidate_dirs`。hook の登録先の候補と同じ当て推量）。
//!    既定の `~/.claude` もここに入る
//!
//! 登録済みのプロジェクトごとに `config::resolve` を払うことはしない（WSL では対話ログインシェルを
//! 起こす）。`.envrc` でホームの外を指すアカウントは、申告が届くまで並ばない。
//!
//! **候補の一覧は環境ごとに [`ACCOUNTS_TTL`] 覚える**（ホームの `read_dir` と `.claude.json` の読みを
//! ポーリングのたびに払わない）。申告のファイルが動いたら期限内でも作り直す（`config::resolve` と
//! 同じ手）。
//!
//! ## Codex
//!
//! 環境ごとに `~/.codex` を 1 つ（`codex_usage/live.rs`）。セッションがあるときだけ返す。

use crate::agent_usage::AgentId;
use crate::claude_usage::config;
use crate::claude_usage::live as claude_live;
use crate::types::{ShellConfig, cwd_matches_root, install_key};
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime};

/// アカウントの候補を覚える長さ。新しいアカウントで claude を起動してから一覧に出るまでの上限
/// （申告が届けば即座に作り直す）。
const ACCOUNTS_TTL: Duration = Duration::from_secs(60);

/// セッションの状態。Claude は Claude Code の `status` をそのまま 3 つ（`Waiting` / `Busy` / `Idle`）に
/// 写す（`claude_usage/live.rs`）。Codex は `Busy` と `Recent` の 2 つだけを使う（`codex_usage/live.rs`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LiveStatus {
    /// 許可の確認や質問への答えを待っている（Claude Code の `waiting`）。
    Waiting,
    /// ターンが動いている（`busy`）。
    Busy,
    /// 入力を待っている（`idle`）。**知らない値もここへ倒す**: 新しい状態が増えても、
    /// 一覧から消すより「動いていない」に並べるほうが見つけやすい。
    Idle,
    /// 直近に書かれたが、今ターンが動いているとは言えないもの（Codex だけ。プロセスが
    /// 生きているかは分からないので、Claude の `Idle` とは分ける）。
    Recent,
}

/// 一覧の 1 件。**並べ替えはフロント**（`lib/liveSessions.ts` の `groupLiveSessions`）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveSession {
    /// プロセスの id。Codex は記録に持たないので無い。
    pub pid: Option<u64>,
    pub session_id: String,
    /// 起動したディレクトリ（そのシェルから見た形）。
    pub cwd: String,
    /// Claude Code が付けた名前（`pike-47` のような、ディレクトリ名＋短い id）。
    pub name: Option<String>,
    pub status: LiveStatus,
    /// 待っている理由（`waiting` のときだけ。Claude Code の英語の文言のまま）。
    pub waiting_for: Option<String>,
    /// 起動した時刻（epoch ms）。
    pub started_at: Option<u64>,
    /// 状態が最後に変わった時刻（epoch ms）。無ければ記録の更新時刻。
    pub status_since: Option<u64>,
    pub version: Option<String>,
    /// 記録から読んだ題（再開のメニューと同じ規則）。記録が見つからなければ無い。
    pub title: Option<String>,
    pub git_branch: Option<String>,
}

/// 1 つのアカウントの一覧。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveSessionList {
    pub agent: AgentId,
    /// 記録を書いた環境のシェル。飛んだ先でターミナルを開くのもこのシェル。
    pub shell: ShellConfig,
    /// 読んだ設定ディレクトリ（Pike から読める形）。
    pub config_dir: String,
    /// 再開するときに `CLAUDE_CONFIG_DIR` へ渡す値（そのシェルから見た形）。既定の `~/.claude`
    /// なら無い（渡すと `.claude.json` の置き場が変わる。`config::read_account` の doc）。
    pub config_override: Option<String>,
    /// そのアカウントのメールアドレス。
    pub account: Option<String>,
    /// 今のプロジェクトのアカウントか。
    pub current: bool,
    pub sessions: Vec<LiveSession>,
}

/// 今動いているセッションを、アカウントごとに返す。並びは Claude（今のプロジェクトのアカウントが
/// 先頭、続いて今の環境、ほかの環境）→ Codex。
///
/// **失敗は空の一覧**（`Err` にしない）。設定ディレクトリが無いのと、セッションが 1 つも
/// 動いていないのは、パネルの上では同じ見え方でよい。
#[tauri::command]
pub async fn agent_live_sessions(
    shell: ShellConfig,
    project_root: String,
    pty: tauri::State<'_, crate::pty::PtyState>,
) -> Result<Vec<LiveSessionList>, String> {
    let distros = pty.open_wsl_distros();
    tokio::task::spawn_blocking(move || lists(&environments(&shell, distros), &project_root))
        .await
        .map_err(|e| e.to_string())
}

/// 動いているセッションを再開できるディレクトリ（起動した場所の `cwd` のままでよければ `None`）。
/// 一覧の行から `claude --resume` するときに呼ぶ。決め方は `sessions::resume_dir_of`。
///
/// `shell` と `config_dir` は一覧（`LiveSessionList`）の値をそのまま渡す。**読むのは
/// `projects/<slug>/<id>.jsonl` の stat だけ**なので、`config_dir` の検証は形（`projects` を
/// 持つディレクトリか）にとどめる。`projects` を持たない Codex の `~/.codex` を渡されたら `None`
/// （Codex は起動した場所で再開する）なので、フロントはエージェントを問わず呼べる。
#[tauri::command]
pub async fn agent_live_session_resume_dir(
    shell: ShellConfig,
    config_dir: String,
    cwd: String,
    session_id: String,
) -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(move || {
        let dir = PathBuf::from(config_dir);
        if !dir.join("projects").is_dir() {
            return None;
        }
        crate::claude_usage::sessions::resume_dir_of(&shell, &dir, &cwd, &session_id)
    })
    .await
    .map_err(|e| e.to_string())
}

/// `envs` の先頭は今のプロジェクトの環境（[`environments`]）。
///
/// **環境ごとにスレッドを分けて読む。** WSL の環境では `sessions/` の読みも `/proc` の照合も
/// UNC 越しの往復なので、直列だと 1 回のポーリングが環境の数だけ足し算で延びる。環境どうしは
/// pid 空間もキャッシュの鍵も別なので、並べても互いを待たない。結果は環境の順に並べ直す。
fn lists(envs: &[ShellConfig], project_root: &str) -> Vec<LiveSessionList> {
    let per_env: Vec<(Vec<LiveSessionList>, Option<LiveSessionList>)> = std::thread::scope(|s| {
        let handles: Vec<_> = envs
            .iter()
            .enumerate()
            .map(|(i, env)| s.spawn(move || env_lists(env, (i == 0).then_some(project_root))))
            .collect();
        handles.into_iter().filter_map(|h| h.join().ok()).collect()
    });
    let mut out = Vec::new();
    let mut codex = Vec::new();
    for (claude, found) in per_env {
        out.extend(claude);
        codex.extend(found);
    }
    out.extend(codex);
    out
}

/// 1 つの環境の、Claude のアカウントごとの一覧と Codex の一覧。
fn env_lists(
    env: &ShellConfig,
    project_root: Option<&str>,
) -> (Vec<LiveSessionList>, Option<LiveSessionList>) {
    let claude = claude_accounts(env, project_root)
        .into_iter()
        .filter_map(|account| {
            let sessions = claude_live::list(env, &account.read);
            (account.current || !sessions.is_empty()).then(|| LiveSessionList {
                agent: AgentId::Claude,
                shell: env.clone(),
                config_dir: account.read.to_string_lossy().into_owned(),
                config_override: account.native_override,
                account: account.email,
                current: account.current,
                sessions,
            })
        })
        .collect();
    let codex = crate::codex_usage::live::list(env)
        .filter(|found| !found.sessions.is_empty())
        .map(|found| LiveSessionList {
            agent: AgentId::Codex,
            shell: env.clone(),
            config_dir: found.dir.to_string_lossy().into_owned(),
            config_override: None,
            account: found.account,
            current: false,
            sessions: found.sessions,
        });
    (claude, codex)
}

/// 読む環境のシェル。先頭は今のプロジェクトのシェル。`open_distros` は Pike のターミナルが
/// 開いている distro（モジュールの doc）。
fn environments(shell: &ShellConfig, open_distros: Vec<String>) -> Vec<ShellConfig> {
    let mut envs = vec![shell.clone()];
    // WSL が無い OS では、ホスト（＝今のシェル）だけ。
    if !cfg!(windows) {
        return envs;
    }
    let current_distro = match shell {
        ShellConfig::Wsl { distro } => {
            // WSL のプロジェクトからは、ホストの claude / codex も読む。
            envs.push(ShellConfig::host_default());
            Some(distro.clone())
        }
        _ => None,
    };
    envs.extend(
        open_distros
            .into_iter()
            // distro の名前は大小を区別しない（`wsl -d ubuntu` も `Ubuntu` に当たる）。
            .filter(|d| {
                current_distro
                    .as_ref()
                    .is_none_or(|c| !c.eq_ignore_ascii_case(d))
            })
            .map(|distro| ShellConfig::Wsl { distro }),
    );
    envs
}

/// 読む Claude のアカウント 1 つ。
#[derive(Debug, Clone)]
struct Account {
    read: PathBuf,
    native_override: Option<String>,
    email: Option<String>,
    current: bool,
}

/// その環境で読む Claude のアカウント。`project_root` は今の環境のときだけ渡す（今のプロジェクトの
/// アカウントを先頭に置く）。
fn claude_accounts(env: &ShellConfig, project_root: Option<&str>) -> Vec<Account> {
    let mut out: Vec<Account> = Vec::new();
    if let Some(root) = project_root {
        let resolved = config::resolve(env, root);
        if let Some(read) = resolved.read_path {
            // **既定の `~/.claude` が申告されていても上書きとして扱わない**（ほかのアカウントと同じ
            // 規則。`resolve` はそれも `native_override` に入れるが、再開で渡すと `.claude.json` の
            // 置き場が変わる）。
            let home = config::shell_home(env).map(|(native, _)| native);
            let native_override = resolved.native_override.filter(|native| {
                home.as_deref()
                    .is_none_or(|home| !is_default_dir(env, home, native))
            });
            out.push(Account {
                read,
                native_override,
                email: resolved.account.and_then(|a| a.email),
                current: true,
            });
        }
    }
    for account in known_accounts(env) {
        if !out.iter().any(|a| same_dir(env, &a.read, &account.read)) {
            out.push(account);
        }
    }
    out
}

/// 同じディレクトリか（読むパス同士）。比べ方は `cwd_matches_root`（Windows は大小と区切りを
/// 区別せず、WSL は区別する）。
fn same_dir(env: &ShellConfig, a: &Path, b: &Path) -> bool {
    cwd_matches_root(env, &a.to_string_lossy(), &b.to_string_lossy())
}

/// 申告とホーム直下の候補から作る、その環境のアカウント（[`ACCOUNTS_TTL`] のあいだ覚える）。
fn known_accounts(env: &ShellConfig) -> Vec<Account> {
    struct Entry {
        at: Instant,
        declared_at: Option<SystemTime>,
        accounts: Vec<Account>,
    }
    static CACHE: OnceLock<Mutex<HashMap<String, Entry>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let key = install_key(env);
    let declared_at = crate::agent_hook::declarations_mtime();
    if let Ok(map) = cache.lock()
        && let Some(e) = map.get(&key)
        && e.at.elapsed() < ACCOUNTS_TTL
        && e.declared_at == declared_at
    {
        return e.accounts.clone();
    }
    // 作るあいだはロックを握らない（環境の違う問い合わせを待たせない）。
    let accounts = collect_accounts(env, &key);
    if let Ok(mut map) = cache.lock() {
        map.insert(
            key,
            Entry {
                at: Instant::now(),
                declared_at,
                accounts: accounts.clone(),
            },
        );
    }
    accounts
}

fn collect_accounts(env: &ShellConfig, install: &str) -> Vec<Account> {
    let Some((home_native, _)) = config::shell_home(env) else {
        return Vec::new();
    };
    let declared = crate::agent_hook::declared_config_dirs(install)
        .into_iter()
        .filter_map(|native| config::readable_dir(env, &native).map(|read| (native, read)));
    let mut out: Vec<Account> = Vec::new();
    for (native, read) in declared.chain(crate::agent_hook::candidate_dirs(env)) {
        if out.iter().any(|a| same_dir(env, &a.read, &read)) {
            continue;
        }
        let overridden = !is_default_dir(env, &home_native, &native);
        out.push(Account {
            email: config::account_email(&read, overridden),
            native_override: overridden.then_some(native),
            read,
            current: false,
        });
    }
    out
}

/// `native` が既定の `<ホーム>/.claude` か。
fn is_default_dir(env: &ShellConfig, home: &str, native: &str) -> bool {
    let default = format!("{}/.claude", home.trim_end_matches(['/', '\\']));
    cwd_matches_root(env, native, &default)
}

#[cfg(test)]
mod tests {
    use super::{is_default_dir, same_dir};
    use crate::types::ShellConfig;
    use std::path::Path;

    #[test]
    fn the_default_dir_is_the_one_next_to_home() {
        let wsl = ShellConfig::Wsl {
            distro: "Ubuntu".to_owned(),
        };
        assert!(is_default_dir(&wsl, "/home/kan", "/home/kan/.claude"));
        assert!(is_default_dir(&wsl, "/home/kan/", "/home/kan/.claude/"));
        assert!(!is_default_dir(&wsl, "/home/kan", "/home/kan/.claude-ai"));
        let win = ShellConfig::Powershell;
        assert!(is_default_dir(
            &win,
            r"C:\Users\kan",
            r"c:\users\kan\.claude"
        ));
        assert!(!is_default_dir(
            &win,
            r"C:\Users\kan",
            r"C:\Users\kan\.claude-ai"
        ));
    }

    #[test]
    fn windows_paths_fold_case_but_wsl_paths_do_not() {
        let win = ShellConfig::Powershell;
        assert!(same_dir(
            &win,
            Path::new(r"C:\Users\kan\.claude"),
            Path::new(r"c:\users\kan\.claude\")
        ));
        let wsl = ShellConfig::Wsl {
            distro: "Ubuntu".to_owned(),
        };
        assert!(!same_dir(
            &wsl,
            Path::new(r"\\wsl.localhost\Ubuntu\home\kan\.Claude"),
            Path::new(r"\\wsl.localhost\Ubuntu\home\kan\.claude")
        ));
    }
}
