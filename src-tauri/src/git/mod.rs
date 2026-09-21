use crate::cache::ProbeRegistry;
use crate::shell_probe::{ssh_auth_sock, SSH_AUTH_SOCK};
use crate::types::{git_args, git_bash_prefix, install_key, ShellConfig};
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use std::fmt::Write as _;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusResult {
    pub branch: String,
    /// Current HEAD commit oid (from `# branch.oid`), or "(initial)" before the
    /// first commit. Used by the frontend to detect when the commit log changed.
    pub head: String,
    pub is_dirty: bool,
    pub staged: Vec<GitFileChange>,
    pub unstaged: Vec<GitFileChange>,
    /// Unmerged paths (merge/rebase conflicts), from porcelain v2 `u ` lines.
    /// `status` holds the two-letter XY code (e.g. "UU", "AA", "DD").
    pub conflicted: Vec<GitFileChange>,
    pub ahead: u32,
    pub behind: u32,
    /// A rebase/merge/… that git stopped in the middle of (#222). `None` when
    /// the tree is not in the middle of one.
    pub operation: Option<GitOperation>,
}

/// A git operation left half-finished in the working tree, as recorded by the
/// state files in the gitdir. Detected on every status so the panel can offer
/// continue/abort instead of leaving the user to work it out (#222).
#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitOperation {
    /// `rebase` | `merge` | `cherry-pick` | `revert` | `am` | `bisect`. Also the
    /// git subcommand the frontend appends `--continue`/`--abort` to.
    pub kind: String,
    /// Branch being rebased. porcelain v2 reports `(detached)` during a rebase,
    /// so this is the only place the real name survives.
    pub branch: Option<String>,
    /// Progress, when both numbers are known — never a half-read `0/0`.
    pub step: Option<u32>,
    pub total: Option<u32>,
    /// `conflict` | `commit-failed` | `stopped`.
    pub stop: String,
    /// The commit a `commit-failed` rebase could not write, for `git commit -C`.
    pub stopped_sha: Option<String>,
    /// Its subject, so the confirm dialog can name what is about to be committed.
    pub stopped_subject: Option<String>,
    /// Whether `--continue` / `--abort` apply. Decided here rather than in the
    /// panel so the guard sits next to the classification it depends on.
    pub can_continue: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileChange {
    pub path: String,
    pub status: String,
    /// リネーム / コピーの元の名前（#306）。それ以外は `None`。
    /// diff とアンステージで要る理由は `.claude/rules/git.md`。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub orig_path: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitLogEntry {
    pub hash: String,
    pub parents: Vec<String>,
    pub refs: String,
    pub author: String,
    pub date: String,
    pub message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitWorktree {
    /// Absolute path of the worktree (native form for the project's shell).
    pub path: String,
    /// Short branch name (refs/heads/ stripped), or None when detached/bare.
    pub branch: Option<String>,
    /// Commit the worktree's HEAD points at.
    pub head: Option<String>,
    pub is_bare: bool,
    pub is_detached: bool,
    /// The first entry reported by git is the repository's main working tree.
    pub is_main: bool,
}

fn truncate_diff(output: String) -> String {
    match truncate_at_line(output, 100_000) {
        (cut, true) => format!("{cut}...\n\n[Diff truncated at 100KB]"),
        (whole, false) => whole,
    }
}

fn run_git(shell: &ShellConfig, root: &str, args: &[&str]) -> Result<String, String> {
    shell.run_stdout("git", &git_args(root, args))
}

/// 資格情報が要るせいで止まったときに ssh / git が出す文字列（#384）。
///
/// **止まったことを「待たせる」ではなく「すぐ失敗する」に変えてあるから、この判定が
/// 成り立つ**（`ssh_config_arg` の `BatchMode=yes`）。素のままだと ssh は `/dev/tty` を
/// 開いてパスフレーズを待ち、誰も答えられないまま 30 秒のタイムアウトで殺される。
///
/// **当てになるのは ssh 側の 2 つだけ**（OpenSSH はメッセージを訳さない）。この issue が
/// 相手にしている鍵のパスフレーズは必ずそちらに出る。
///
/// **git 側の 3 つは訳されうる。** バックエンドの git も distro の `LANG` を継ぐ
/// （非対話の `bash -c` でも `ja_JP.UTF-8` が入っていることを実測した）ので、git の翻訳が
/// 入っている環境では一致しない。**`LC_ALL=C` を被せて英語に倒す形は採らない**: 利用者に
/// 見えるエラー文まで英語になる。取りこぼしても「ターミナルで実行」のボタンが出ない
/// だけで、従来どおりのエラー表示に落ちる。
/// ssh: 鍵で認証できなかった。パスフレーズを聞けなかったときもここに来る。
///
/// **名前で持つのは `terminal_command` が引くため。** `AUTH_MARKERS` の添字で指していると、
/// 表の先頭に 1 行足しただけで `ssh-add` の前置が別の失敗（ホスト鍵・https）に付く。
const KEY_DENIED: &str = "Permission denied (publickey";

const AUTH_MARKERS: [&str; 5] = [
    KEY_DENIED,
    // ssh: 未知のホスト鍵を確認できなかった。
    "Host key verification failed",
    // git: https の資格情報を聞けなかった（`GIT_TERMINAL_PROMPT=0`）。
    "could not read Username",
    "terminal prompts disabled",
    // git: https の資格情報が違う。
    "Authentication failed",
];

fn needs_credentials(text: &str) -> bool {
    AUTH_MARKERS.iter().any(|marker| text.contains(marker))
}

/// ネットワークを使う git（fetch / pull / push）にだけ足す環境変数（#384）。
///
/// - `SSH_AUTH_SOCK` … バックエンドの git は非対話で走るので rc の export を継がない。
///   継がないと ssh が agent に届かず、パスフレーズ付きの鍵が毎回入力を要求する。
///   値の取り方は `shell_probe::ssh_auth_sock` の doc が正本
/// - `GIT_TERMINAL_PROMPT=0` … https のリモートで git 自身が利用者名を聞きに行くのを
///   止める。ssh 側の `BatchMode` と対で、**どの転送でも「聞かずに失敗する」に揃える**
fn network_env(shell: &ShellConfig) -> Vec<(&'static str, String)> {
    let mut env = vec![("GIT_TERMINAL_PROMPT", "0".to_owned())];
    if let Some(sock) = ssh_auth_sock(shell) {
        env.push((SSH_AUTH_SOCK, sock));
    }
    env
}

/// 利用者の `core.sshCommand`（空なら素の `ssh`）に `BatchMode=yes` を足した値。
///
/// **末尾に足すだけ**にしてあるのは、既存の値の引用を解かないため。git は `core.sshCommand`
/// をシェル風に分解するので、空白を含むパスを利用者が引用していれば、そのまま残る。
fn compose_ssh_command(base: &str) -> String {
    let base = base.trim();
    let base = if base.is_empty() { "ssh" } else { base };
    format!("core.sshCommand={base} -o BatchMode=yes")
}

/// `core.sshCommand` を読み直すまでの間隔。設定を変えた人が待つのはここまで。
///
/// **長いのは値の性質から。** ほとんどは `~/.gitconfig` 由来で、変える頻度は年単位。
/// ここを通る操作自体が最短でも 60 秒に 1 回（背景 fetch）なので、短くしても効くのは
/// spawn を増やす側だけになる。
const SSH_COMMAND_TTL: Duration = Duration::from_secs(3600);

/// 読めた `core.sshCommand`（`ssh_config_arg`）。
///
/// **`at` は「最後に読みに行った時刻」**（読めた時刻ではない）。読めなくても打つので、
/// 壊れた環境でも間隔が空く。`base` は読めたときだけ書き換わるので、前に読めた値は
/// そのまま残る。未設定と未読はどちらも空文字で、区別する必要はない（どちらも
/// 「`core.sshCommand` は無い」として扱ってよい）。
#[derive(Default)]
struct SshCommand {
    at: Option<Instant>,
    base: String,
}

/// その `core.sshCommand` に対して実際に渡す `-c` の値。`None` は「触らない」。
fn ssh_arg_for(base: &str) -> Option<String> {
    (!base.is_empty() || !ssh_set_by_env()).then(|| compose_ssh_command(base))
}

/// ssh の起動を env で決めている構成か。
///
/// git の優先順は `GIT_SSH_COMMAND`（env）→ `core.sshCommand`（config）→ `GIT_SSH`（env）→
/// `ssh`。**`core.sshCommand` が無いのにこのどちらかがある構成には手を出さない**:
///
/// - `GIT_SSH_COMMAND` があると `-c core.sshCommand=…` は読まれないので、渡しても無駄
/// - `GIT_SSH` は `-c` に**負ける**ので、渡すと PuTTY / plink を使う構成の転送を
///   素の `ssh` に差し替えてしまう（**Pike からだけ push できなくなる**）
///
/// 見るのは Pike のプロセス環境。Windows のシェルはそれを継ぐので一致し、WSL の中の値は
/// 見えないが、非対話の `bash -c` にこれらが入っていることはまず無い。
fn ssh_set_by_env() -> bool {
    ["GIT_SSH_COMMAND", "GIT_SSH"]
        .iter()
        .any(|name| std::env::var_os(name).is_some_and(|v| !v.is_empty()))
}

/// ネットワークの git に前置する `-c core.sshCommand=…` の値（#384）。
///
/// **「聞かずに失敗する」に倒すのが目的。** `BatchMode=yes` を足すと、ssh はパスフレーズも
/// ホスト鍵の確認も尋ねずに即座に失敗する。足さないと `/dev/tty` を開いて待ち込み、
/// **stdio を 3 つとも繋ぎ替えても `wsl.exe` 越しに `/dev/tty` は開ける**（実測）ので、
/// 30 秒のタイムアウトまで何も起きない。60 秒ごとの背景 fetch では、その待ちが間隔の
/// 半分を占める。
///
/// **利用者の設定を潰さないために、読んでから足す。** `core.sshCommand` に Windows の
/// `ssh.exe` を指している構成が実在する（この開発機がそれで、WSL の git が
/// `/mnt/c/Windows/System32/OpenSSH/ssh.exe` を呼ぶ）。`-c` も `GIT_SSH_COMMAND` も
/// 上書きしかできないので、既存の値の末尾にオプションを足した文字列を作る。
///
/// **代償**: GUI の askpass（`SSH_ASKPASS`）でパスフレーズを出せていた構成では、そこが
/// 出なくなる。代わりに「ターミナルで実行」で入力する形に揃う。
///
/// **答えは (導入単位, root) ごとに覚える。** 読みは git の spawn 1 回ぶんで、WSL なら
/// `wsl.exe` の起動。背景 fetch が毎回払うには重い。
///
/// **時刻は読めなくても打つ**（`shell_probe::refresh_if_stale` と同じ規約）。打たないと、
/// 読みが通らない環境（distro 停止・`git` 不在）では**ネットワークの git のたびに 30 秒
/// ブロックし続け、しかも自己修復しない**。読めなかったときに上書きしないのは `base` の
/// ほうで、前に読めた値はそのまま残る。
///
/// `None` は「触らない」（`ssh_set_by_env` の doc）。
fn ssh_config_arg(shell: &ShellConfig, root: &str) -> Option<String> {
    static REGISTRY: OnceLock<ProbeRegistry<(String, String), SshCommand>> = OnceLock::new();
    let fresh = |answer: &SshCommand| answer.at.is_some_and(|at| at.elapsed() < SSH_COMMAND_TTL);
    let entry = REGISTRY
        .get_or_init(ProbeRegistry::new)
        .entry((install_key(shell), root.to_owned()));

    if !fresh(&entry.answer()) {
        // 同じ問いを 2 回払わない（`cache::ProbeEntry` の 2 段ロック）。ロックを待つ
        // あいだに前の持ち主が済ませていることがあるので、取ってからもう一度見る。
        // **読みのあいだ答えのロックは握らない**（外部プロセスの起動を含むため）。
        let _probing = entry.probing();
        if !fresh(&entry.answer()) {
            let read = shell.run(
                "git",
                &git_args(root, &["config", "--get", "core.sshCommand"]),
            );
            let mut answer = entry.answer();
            // **確かめられた答えだけを覚える。** `git config --get` は未設定なら 1 を返すので、
            // 0 と 1 だけが「読めた」。冷えた WSL のタイムアウトを覚えると、利用者の
            // `core.sshCommand`（Windows の `ssh.exe` を指している構成が実在する）を
            // 次の期限まで素の `ssh` に落とすことになり、**それ自体が認証を失敗させる**。
            if let Ok((code @ (0 | 1), stdout, _)) = read {
                answer.base = if code == 0 {
                    stdout.trim().to_owned()
                } else {
                    String::new()
                };
            }
            answer.at = Some(Instant::now());
        }
    }
    // 一度も読めていないときは `base` が空のまま＝「`core.sshCommand` は無い」として扱う。
    let arg = ssh_arg_for(&entry.answer().base);
    arg
}

/// ネットワークの git を 1 回走らせた結果（#384）。
///
/// **`agent` を持たせるのが要点。** 「ssh-agent のソケットを渡せたか」は `network_env` が
/// 作るときに分かっているので、あとから `ssh_auth_sock` を引き直さない。引き直すと、
/// git が最長 30 秒走ったあいだに probe の期限が切れていた場合、**利用者が待っている
/// エラー表示の直前に対話ログインシェルが 1 本上がる**。
struct NetworkRun {
    code: i32,
    stdout: String,
    stderr: String,
    agent: bool,
}

/// `run_git` のネットワーク版（#384）。終了コードと両方の流れを返すのは、資格情報が
/// 要るのかを呼び出し側が見分けるため。`ssh_config_arg` と `network_env` を通すのは
/// **リモートに触る 3 つ（fetch / pull / push）だけ**で、残りの git 呼び出しは従来どおり。
///
/// **効いている区分は「ネットワークに触るか」ではなく「人に聞きうるか」**で、署名で
/// pinentry / 1Password が出うる `git_commit` は後者に入りながらバックエンドのままにして
/// ある（#222 の `runRecovery` がある理由そのもの）。そこを広げる日が来たら、この 1 本と
/// 「ターミナルで実行」をそのまま使い回すこと（並行の仕組みを発明しない）。
fn run_git_network(shell: &ShellConfig, root: &str, args: &[&str]) -> Result<NetworkRun, String> {
    let ssh = ssh_config_arg(shell, root);
    let prefix: Vec<&str> = ssh.as_deref().map_or_else(Vec::new, |v| vec!["-c", v]);
    let full = [&prefix[..], &git_args(root, args)].concat();
    let env = network_env(shell);
    let agent = env.iter().any(|(name, _)| *name == SSH_AUTH_SOCK);
    let (code, stdout, stderr) = shell.run_env("git", &full, &env)?;
    Ok(NetworkRun {
        code,
        stdout,
        stderr,
        agent,
    })
}

/// リモートに触る git（fetch / pull / push）の結果（#384）。
///
/// **失敗を `Err` ではなく値で返す**（`FileReadResult.too_large` と同じ形）。フロントは
/// 「資格情報が要るのか、それ以外で失敗したのか」で出し分けるので、エラー文字列の綴りを
/// Rust と TS で取り決める形は採らない。
///
/// **「資格情報が要る」の真偽値は持たない。** `command` の有無がそれで、2 つ持つと
/// 「真なのにボタンが出ない」という説明できない状態を作れる。成功したときの stdout も
/// 運ばない（フロントは一度も読んでいない）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitNetworkResult {
    /// 失敗の理由（成功なら `None`）。
    pub error: Option<String>,
    /// 資格情報が要るせいで失敗したときに、ターミナルで走らせ直す 1 行。
    pub command: Option<String>,
}

impl GitNetworkResult {
    /// 走らせた結果を、フロントが出し分けられる形に落とす。
    ///
    /// **エラー文には stdout も混ぜる。** 止まった merge / rebase は
    /// `CONFLICT (content): …` を stdout に書くので、stderr だけを渡すと競合の理由が
    /// 消える（#222）。
    fn of(args: &[&str], run: NetworkRun) -> Self {
        if run.code == 0 {
            return Self {
                error: None,
                command: None,
            };
        }
        let text = format!("{}{}", run.stdout, run.stderr);
        Self {
            error: Some(format!("git error: {}", text.trim())),
            command: needs_credentials(&text).then(|| terminal_command(args, &text, run.agent)),
        }
    }
}

/// ターミナルで走らせ直す 1 行。
///
/// **鍵が拒否されたときは `ssh-add` を前に置く**（agent に届いていると分かっているとき
/// だけ）。これが issue の「アプリ起動中はパスフレーズを保持する」の答えで、**保持するのは
/// agent**: Pike はパスフレーズを受け取らないし、どこにも書かない。素の `git pull` を
/// 走らせるだけだと ssh がその 1 回のために聞いて捨てるので、次の pull でまた聞かれる。
///
/// 区切りは `;`（`&&` ではない）。`ssh-add` が失敗しても git は走ってよく、そのときは
/// ssh が tty で聞くのでその 1 回は通る。PowerShell 5 に `&&` が無い問題
/// （`types/tab.ts` の `chainOnSuccess`）も、`;` なら避けて通れる。
/// `agent` は「そのとき agent のソケットを渡せたか」（`NetworkRun` の doc）。
fn terminal_command(args: &[&str], failure: &str, agent: bool) -> String {
    let git = format!("git {}", args.join(" "));
    if agent && failure.contains(KEY_DENIED) {
        format!("ssh-add; {git}")
    } else {
        git
    }
}

/// Like `run_git` but returns stdout regardless of exit code. Used for
/// commands like `git diff --no-index` that exit with code 1 when files differ.
fn run_git_raw_stdout(shell: &ShellConfig, root: &str, args: &[&str]) -> Result<String, String> {
    let output = shell.run_raw("git", &git_args(root, args))?;
    Ok(crate::types::into_lossy_string(output.stdout))
}

fn parse_status(output: &str) -> GitStatusResult {
    let mut branch = String::from("HEAD");
    let mut head = String::from("(initial)");
    let mut staged = Vec::new();
    let mut unstaged = Vec::new();
    let mut conflicted = Vec::new();
    let mut ahead: u32 = 0;
    let mut behind: u32 = 0;

    for line in output.lines() {
        if let Some(oid) = line.strip_prefix("# branch.oid ") {
            head = oid.to_owned();
        } else if let Some(head) = line.strip_prefix("# branch.head ") {
            branch = head.to_owned();
        } else if let Some(rest) = line.strip_prefix("# branch.ab ") {
            // Format: "# branch.ab +N -M"
            let parts: Vec<&str> = rest.split_whitespace().collect();
            if parts.len() >= 2 {
                ahead = parts[0].trim_start_matches('+').parse().unwrap_or(0);
                behind = parts[1].trim_start_matches('-').parse().unwrap_or(0);
            }
        } else if line.starts_with("1 ") || line.starts_with("2 ") {
            // Changed entry. **リネーム / コピーの `2 ` 行はフィールドが 1 つ多い**（#306）:
            //
            //   1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
            //   2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path><TAB><origPath>
            //
            // どちらも `splitn(9)` で分けていたころは、`2 ` 行の 9 個目に
            // 「スコア + 空白 + パス」がまるごと残り、タブで切っても `R100 new.md` が
            // ファイル名になっていた（実際の出力で確認）。
            let is_rename = line.starts_with("2 ");
            let fields = if is_rename { 10 } else { 9 };
            let parts: Vec<&str> = line.splitn(fields, ' ').collect();
            if parts.len() >= fields {
                let xy = parts[1];
                let x = &xy[..1];
                let y = &xy[1..2];
                // 並びは `<path><TAB><origPath>`（新しい名前が先）。パスに空白が入っていても
                // `splitn` の最後の要素なので、そのまま残る。
                let last = parts[fields - 1];
                let (path, orig_path) = match last.split_once('\t') {
                    Some((new, orig)) if is_rename => (new, Some(orig.to_owned())),
                    _ => (last, None),
                };
                if x != "." {
                    staged.push(GitFileChange {
                        path: path.to_owned(),
                        status: x.to_owned(),
                        orig_path: orig_path.clone(),
                    });
                }
                if y != "." {
                    unstaged.push(GitFileChange {
                        path: path.to_owned(),
                        status: y.to_owned(),
                        orig_path,
                    });
                }
            }
        } else if line.starts_with("u ") {
            // Unmerged entry: "u XY sub m1 m2 m3 mW h1 h2 h3 path"
            // (no rename, so the path is the final field and contains no \t).
            let parts: Vec<&str> = line.splitn(11, ' ').collect();
            if parts.len() >= 11 {
                conflicted.push(GitFileChange {
                    path: parts[10].to_owned(),
                    status: parts[1].to_owned(),
                    orig_path: None,
                });
            }
        } else if let Some(path) = line.strip_prefix("? ") {
            // Untracked: "? path"
            unstaged.push(GitFileChange {
                path: path.to_owned(),
                status: "?".to_owned(),
                orig_path: None,
            });
        }
    }

    let is_dirty = !staged.is_empty() || !unstaged.is_empty() || !conflicted.is_empty();
    GitStatusResult {
        branch,
        head,
        is_dirty,
        staged,
        unstaged,
        conflicted,
        ahead,
        behind,
        operation: None,
    }
}

/// Field separator (ASCII Unit Separator) and record separator (ASCII Record Separator).
/// Using these instead of NUL avoids collision when %D (refs) is empty — an empty
/// field between two NUL bytes would be indistinguishable from a double-NUL record separator.
/// **`git log` には必ず付ける。** `log.showSignature=true` を設定していると、`git log` は
/// 署名の検証結果を**標準出力の、`--format` より前**に出す。位置で読む側（`parse_log` /
/// `parse_log_simple` / `commit_patch`）が丸ごと外れるので、その設定のマシンでは履歴も
/// コミットの差分も空になる。`git diff` は影響を受けないぶん気付きにくい。
const NO_SHOW_SIGNATURE: &str = "--no-show-signature";

const FS: char = '\x1f';
const RS: &str = "\x1e";

fn parse_log(output: &str) -> Vec<GitLogEntry> {
    output
        .split(RS)
        .filter_map(|record| {
            let record = record.trim_matches('\n');
            if record.is_empty() {
                return None;
            }
            let parts: Vec<&str> = record.splitn(6, FS).collect();
            if parts.len() == 6 {
                let parents = parts[1]
                    .split_whitespace()
                    .filter(|s| !s.is_empty())
                    .map(|s| s.to_owned())
                    .collect();
                Some(GitLogEntry {
                    hash: parts[0].to_owned(),
                    parents,
                    refs: parts[2].trim().to_owned(),
                    author: parts[3].to_owned(),
                    date: parts[4].to_owned(),
                    message: parts[5].trim().to_owned(),
                })
            } else if parts.len() == 4 {
                // Backward compat: git_log_file uses 4-field format
                Some(GitLogEntry {
                    hash: parts[0].to_owned(),
                    parents: vec![],
                    refs: String::new(),
                    author: parts[1].to_owned(),
                    date: parts[2].to_owned(),
                    message: parts[3].trim().to_owned(),
                })
            } else {
                None
            }
        })
        .collect()
}

/// Whether `root` is inside a git working tree. Returns `Ok(false)` (never an
/// error) when the directory is not a repository, so the frontend can show a
/// dedicated "initialize repository" view instead of a raw git error.
#[tauri::command]
pub async fn git_is_repo(root: String, shell: ShellConfig) -> Result<bool, String> {
    tokio::task::spawn_blocking(move || {
        let output = run_git(&shell, &root, &["rev-parse", "--is-inside-work-tree"]);
        // `git rev-parse --is-inside-work-tree` prints "true" and exits 0 inside a
        // work tree; outside a repo it exits non-zero (run_git returns Err).
        matches!(output, Ok(s) if s.trim() == "true")
    })
    .await
    .map_err(|e| e.to_string())
}

/// Initialize a git repository at `root` (`git init`).
#[tauri::command]
pub async fn git_init(root: String, shell: ShellConfig) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        run_git(&shell, &root, &["init"])?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// State files that tell us which operation is half-finished, relative to the
/// gitdir. Every one lives in the *per-worktree* gitdir, so a single
/// `rev-parse --absolute-git-dir` resolves them all — including when `.git` is
/// a file because the root is a linked worktree.
///
/// `rebase-merge/head-name` (and its `rebase-apply` twin) doubles as the
/// "a rebase exists" marker. Note `rebase-merge/interactive` is written for a
/// plain `git rebase` too, so it cannot be used to spot `-i` (measured).
/// `(path, read contents)`. Most entries are pure markers — whether git wrote
/// them is the whole signal — and `BISECT_LOG` in particular grows a block per
/// bisect step, so only the files whose text is actually used get read.
const OP_STATE_FILES: &[(&str, bool)] = &[
    ("rebase-merge/head-name", true),
    ("rebase-merge/msgnum", true),
    ("rebase-merge/end", true),
    ("rebase-merge/message", false),
    ("rebase-merge/stopped-sha", false),
    ("rebase-merge/done", true),
    ("rebase-apply/head-name", true),
    ("rebase-apply/next", true),
    ("rebase-apply/last", true),
    ("rebase-apply/applying", false),
    ("MERGE_HEAD", false),
    ("CHERRY_PICK_HEAD", false),
    ("REVERT_HEAD", false),
    ("BISECT_LOG", false),
];

/// Probed state: a key is present exactly when the file is. An *empty* file
/// therefore maps to `""` — the distinction the `commit-failed` classification
/// rests on, and the reason this is not `fs::batch_read_files` (that one trims
/// contents and folds empty into "missing").
type StateFiles = std::collections::HashMap<&'static str, String>;

/// Read the status and the operation state in **one** `wsl.exe` spawn — the
/// same trick `remote_urls_wsl` uses. A second round trip per 10 s poll is the
/// one cost worth avoiding here; everything else about the probe is cheap.
fn status_and_state_wsl(shell: &ShellConfig, root: &str) -> Result<(String, StateFiles), String> {
    let git = git_bash_prefix(root);
    let mut script = format!(
        "{git} status --porcelain=v2 --branch --untracked-files=all || exit 1\n\
         printf '{RS}'\n\
         d=$({git} rev-parse --absolute-git-dir 2>/dev/null)\n"
    );
    for (name, read) in OP_STATE_FILES {
        // One record per entry, in table order: `exists FS contents`. Positional
        // like `remote_urls_wsl`, so the name never travels through the stream.
        // 組み立てるシェル 1 行はテンプレート 1 本のまま置く（3 文に割ると、途中の
        // `else …` が単独の行に見えて読めなくなる）。`cat` の String は `read` が真の
        // ぶんだけで、この関数はその直後に `wsl.exe` を起こす。
        let cat = if *read {
            format!("cat \"$d/{name}\" 2>/dev/null; ")
        } else {
            String::new()
        };
        let _ = writeln!(
            script,
            "if [ -e \"$d/{name}\" ]; then printf '1{FS}'; {cat}else printf '0{FS}'; fi; printf '{RS}'"
        );
    }
    let (code, mut stdout, stderr) = shell.run("bash", &["-c", &script])?;
    if code != 0 {
        return Err(format!("git error: {stderr}"));
    }
    let files = match stdout.find(RS) {
        Some(at) => {
            let files = parse_state_records(&stdout[at + RS.len()..]);
            stdout.truncate(at);
            files
        }
        None => StateFiles::new(),
    };
    Ok((stdout, files))
}

/// Windows: `git status`, then plain file reads. `.git` is a directory at the
/// root for an ordinary repo, so ask git for the gitdir only when it is not —
/// a linked worktree, a submodule, or a root below the top level. That keeps
/// the common case at the one process spawn it has always been.
fn status_and_state_native(
    shell: &ShellConfig,
    root: &str,
) -> Result<(String, StateFiles), String> {
    let status = run_git(
        shell,
        root,
        &[
            "status",
            "--porcelain=v2",
            "--branch",
            "--untracked-files=all",
        ],
    )?;
    let plain = std::path::Path::new(root).join(".git");
    let dir = if plain.is_dir() {
        Some(plain)
    } else {
        run_git(shell, root, &["rev-parse", "--absolute-git-dir"])
            .ok()
            .map(|d| std::path::PathBuf::from(d.trim()))
    };

    let mut files = StateFiles::new();
    if let Some(dir) = dir {
        for (name, read) in OP_STATE_FILES {
            let path = dir.join(name);
            if *read {
                if let Ok(text) = std::fs::read_to_string(&path) {
                    files.insert(name, text);
                }
            } else if path.try_exists().unwrap_or(false) {
                files.insert(name, String::new());
            }
        }
    }
    Ok((status, files))
}

fn parse_state_records(rest: &str) -> StateFiles {
    let mut files = StateFiles::new();
    for ((name, _), record) in OP_STATE_FILES.iter().zip(rest.split(RS)) {
        if let Some((exists, content)) = record.split_once(FS) {
            if exists == "1" {
                files.insert(name, content.to_owned());
            }
        }
    }
    files
}

/// The `pick`-like rebase todo commands: those that produce a commit, and so
/// the only ones a "the commit could not be written" recovery may target.
/// `exec` and `break` stop *after* a successful commit — re-committing there
/// would fabricate a commit carrying another one's author, date and message.
fn is_commit_producing(command: &str) -> bool {
    matches!(
        command,
        "pick" | "p" | "reword" | "r" | "edit" | "e" | "squash" | "s" | "fixup" | "f"
    )
}

/// The commit a stopped rebase was working on, from the last line of
/// `rebase-merge/done` (`pick <sha> # <subject>`). Measured against both stop
/// kinds: when a conflict stops the rebase the todo is already empty, so `done`
/// is the source that holds in every case. The trailing line may be a partial
/// write (`done` is appended, not rewritten), hence the shape check.
fn stopped_commit(done: &str) -> Option<(String, String)> {
    let line = done.lines().rev().find(|l| !l.trim().is_empty())?;
    let mut parts = line.trim().splitn(3, ' ');
    let command = parts.next()?;
    let sha = parts.next()?;
    if !is_commit_producing(command) || !is_sha(sha) {
        return None;
    }
    let subject = parts
        .next()
        .map(|rest| rest.trim_start_matches('#').trim().to_owned())
        .unwrap_or_default();
    Some((sha.to_owned(), subject))
}

/// The id goes into a shell command line, and it comes out of a file git wrote
/// rather than from a command we ran — hold it to the hex alphabet. Up to 64 digits
/// so SHA-256 repositories pass too.
fn is_sha(value: &str) -> bool {
    (7..=64).contains(&value.len()) && value.chars().all(|c| c.is_ascii_hexdigit())
}

fn parse_operation(files: &StateFiles, has_conflicts: bool) -> Option<GitOperation> {
    let content = |key: &str| files.get(key).map(String::as_str);
    let exists = |key: &str| files.contains_key(key);
    let number = |key: &str| content(key).and_then(|v| v.trim().parse::<u32>().ok());
    let branch_of = |key: &str| {
        content(key).map(|v| {
            let v = v.trim();
            v.strip_prefix("refs/heads/").unwrap_or(v).to_owned()
        })
    };

    let (kind, branch, step, total) = if exists("rebase-merge/head-name") {
        (
            "rebase",
            branch_of("rebase-merge/head-name"),
            number("rebase-merge/msgnum"),
            number("rebase-merge/end"),
        )
    } else if exists("rebase-apply/head-name") {
        // The old apply backend backs both `rebase` and `am`; `applying` is
        // what tells them apart.
        let kind = if exists("rebase-apply/applying") {
            "am"
        } else {
            "rebase"
        };
        (
            kind,
            branch_of("rebase-apply/head-name"),
            number("rebase-apply/next"),
            number("rebase-apply/last"),
        )
    } else if exists("MERGE_HEAD") {
        ("merge", None, None, None)
    } else if exists("CHERRY_PICK_HEAD") {
        ("cherry-pick", None, None, None)
    } else if exists("REVERT_HEAD") {
        ("revert", None, None, None)
    } else if exists("BISECT_LOG") {
        ("bisect", None, None, None)
    } else {
        return None;
    };

    // A rebase that stopped without conflicts and without writing `message` /
    // `stopped-sha` did not stop *at* a commit — it failed to create one
    // (signing, a hook). `git rebase --continue` refuses that state with "you
    // have staged changes in your working tree", so the way out is to write the
    // commit first. Measured against a forced signing failure.
    let stopped = (kind == "rebase"
        && !has_conflicts
        && !exists("rebase-merge/message")
        && !exists("rebase-merge/stopped-sha"))
    .then(|| content("rebase-merge/done").and_then(stopped_commit))
    .flatten();

    let stop = if has_conflicts {
        "conflict"
    } else if stopped.is_some() {
        "commit-failed"
    } else {
        "stopped"
    };
    let (stopped_sha, stopped_subject) = stopped.map_or((None, None), |(s, t)| (Some(s), Some(t)));
    // Both halves of the progress, or neither: a half-written "0/0" is worse
    // than showing nothing.
    let (step, total) = step
        .zip(total)
        .map_or((None, None), |(s, t)| (Some(s), Some(t)));

    Some(GitOperation {
        kind: kind.to_owned(),
        branch,
        step,
        total,
        stop: stop.to_owned(),
        stopped_sha,
        stopped_subject,
        // `am` wants the mailbox and `bisect` wants good/bad; neither belongs
        // behind a two-button banner, so the panel only labels those.
        can_continue: matches!(kind, "rebase" | "merge" | "cherry-pick" | "revert"),
    })
}

#[tauri::command]
pub async fn git_status(root: String, shell: ShellConfig) -> Result<GitStatusResult, String> {
    let (output, files) = tokio::task::spawn_blocking(move || match &shell {
        ShellConfig::Wsl { .. } => status_and_state_wsl(&shell, &root),
        _ => status_and_state_native(&shell, &root),
    })
    .await
    .map_err(|e| e.to_string())??;

    let mut status = parse_status(&output);
    // Never let the probe break the status the panel depends on.
    status.operation = parse_operation(&files, !status.conflicted.is_empty());
    Ok(status)
}

#[tauri::command]
pub async fn git_log(
    root: String,
    shell: ShellConfig,
    count: Option<u32>,
    all: Option<bool>,
) -> Result<Vec<GitLogEntry>, String> {
    let n = count.unwrap_or(50).to_string();
    let output = tokio::task::spawn_blocking(move || {
        let mut args = vec![
            "log",
            NO_SHOW_SIGNATURE,
            "--format=%H%x1f%P%x1f%D%x1f%an%x1f%aI%x1f%B%x1e",
            "-n",
            &n,
        ];
        // グラフ表示（#371）。`--all` にしないのは `refs/stash` を拾わないため（stash の
        // コミットは親を 2〜3 個持ち、無関係なレーンを足す）。HEAD は detached のときのため。
        //
        // **並びは `--date-order`（#374）。** SourceTree の既定の「日付順」と同じで、子を必ず
        // 親より先に出したうえで日時順に並べる。素の時刻順（オプション無し）は時計がずれると
        // 親が先に出て、そのレーンが一覧の最後まで閉じないので使わない。#371 では
        // `--topo-order`（ブランチごとにまとめる）にしていたが、SourceTree と並びが食い違って
        // 見比べられなかった。並行するブランチが交互に並ぶぶんレーンは増えるが、グラフの幅は
        // パネル側で上限を付けられる。代償は commit-graph の無いリポジトリで `-n` に関わらず
        // 履歴全体を歩くこと（`--topo-order` と同じ）。
        if all.unwrap_or(false) {
            args.extend(["--branches", "--remotes", "--tags", "HEAD", "--date-order"]);
        }
        run_git(&shell, &root, &args)
    })
    .await
    .map_err(|e| e.to_string())??;

    Ok(parse_log(&output))
}

#[tauri::command]
pub async fn git_diff(
    root: String,
    shell: ShellConfig,
    path: String,
    staged: bool,
    untracked: bool,
    // リネーム / コピーの元の名前（`GitFileChange.origPath`、#306）。
    orig_path: Option<String>,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        // Untracked files have no diff against HEAD; synthesize a "new file"
        // diff via --no-index against the null device.
        if untracked {
            let args = ["diff", "--no-index", "--", shell.null_device(), &path];
            let output = run_git_raw_stdout(&shell, &root, &args)?;
            return Ok(truncate_diff(output));
        }
        let mut args = vec!["diff"];
        if staged {
            args.push("--cached");
        }
        args.push("--");
        args.push(&path);
        // **元の名前も渡す（#306、理由は `.claude/rules/git.md`）。** 作業ツリー側に元の名前は
        // もう無いが、一致しない pathspec は無視されるだけなので staged かどうかで分けない。
        if let Some(orig) = orig_path.as_deref() {
            args.push(orig);
        }
        let output = run_git(&shell, &root, &args)?;
        Ok(truncate_diff(output))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Get the full working tree diff (all unstaged changes).
#[tauri::command]
pub async fn git_diff_working(root: String, shell: ShellConfig) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let output = run_git(&shell, &root, &["diff"])?;
        Ok(truncate_diff(output))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_stage(root: String, shell: ShellConfig, paths: Vec<String>) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let mut args = vec!["add", "--"];
        let path_refs: Vec<&str> = paths.iter().map(|s| s.as_str()).collect();
        args.extend(path_refs);
        run_git(&shell, &root, &args)?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_unstage(
    root: String,
    shell: ShellConfig,
    paths: Vec<String>,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let mut args = vec!["reset", "HEAD", "--"];
        let path_refs: Vec<&str> = paths.iter().map(|s| s.as_str()).collect();
        args.extend(path_refs);
        run_git(&shell, &root, &args)?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_discard_changes(
    root: String,
    shell: ShellConfig,
    paths: Vec<String>,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let mut args = vec!["checkout", "HEAD", "--"];
        let path_refs: Vec<&str> = paths.iter().map(|s| s.as_str()).collect();
        args.extend(path_refs);
        run_git(&shell, &root, &args)?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_commit(root: String, shell: ShellConfig, message: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        // Route through user-PATH variant so commit hooks, gpg.ssh.program,
        // and other user-installed binaries resolve (Pike's default WSL spawn
        // bypasses bash and misses ~/.local/bin, ~/bin, etc.).
        shell.run_stdout_with_user_path("git", &git_args(&root, &["commit", "-m", &message]))?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Branches offered by the switcher (#197): local ones, plus remote-tracking
/// ones so a branch that exists only on the remote can be checked out directly.
#[derive(Debug, Default, PartialEq, Serialize)]
pub struct GitBranches {
    pub local: Vec<String>,
    /// `<remote>/<branch>` form, e.g. `origin/main`.
    pub remote: Vec<String>,
}

fn parse_branch_refs(output: &str) -> GitBranches {
    let mut branches = GitBranches::default();
    for line in output.lines() {
        let line = line.trim();
        if let Some(name) = line.strip_prefix("refs/heads/") {
            branches.local.push(name.to_owned());
        } else if let Some(name) = line.strip_prefix("refs/remotes/") {
            // `<remote>/HEAD` is a symbolic ref mirroring the remote's default
            // branch, not a branch of its own.
            if name.ends_with("/HEAD") {
                continue;
            }
            branches.remote.push(name.to_owned());
        }
    }
    branches
}

#[tauri::command]
pub async fn git_branch_list(root: String, shell: ShellConfig) -> Result<GitBranches, String> {
    // `for-each-ref` over both namespaces keeps local and remote separable
    // without the `remotes/` prefix guesswork that parsing `branch -a` needs.
    let output = tokio::task::spawn_blocking(move || {
        run_git(
            &shell,
            &root,
            &[
                "for-each-ref",
                "--format=%(refname)",
                "refs/heads",
                "refs/remotes",
            ],
        )
    })
    .await
    .map_err(|e| e.to_string())??;

    Ok(parse_branch_refs(&output))
}

#[derive(Default)]
struct WorktreeRecord {
    path: Option<String>,
    head: Option<String>,
    branch: Option<String>,
    is_bare: bool,
    is_detached: bool,
    is_prunable: bool,
}

fn parse_worktrees(output: &str) -> Vec<GitWorktree> {
    let mut worktrees = Vec::new();
    let mut rec = WorktreeRecord::default();

    // `git worktree list --porcelain` emits blank-line-separated records.
    // Prunable worktrees (directory gone / pruneable) are skipped: selecting one
    // would point the panels at a missing path. `is_main` is assigned later to
    // the first non-bare entry, since a bare-clone layout lists `bare` first.
    let flush = |rec: &mut WorktreeRecord, worktrees: &mut Vec<GitWorktree>| {
        if let Some(p) = rec.path.take() {
            if !rec.is_prunable {
                worktrees.push(GitWorktree {
                    path: p,
                    branch: rec.branch.take(),
                    head: rec.head.take(),
                    is_bare: rec.is_bare,
                    is_detached: rec.is_detached,
                    is_main: false,
                });
            }
        }
        *rec = WorktreeRecord::default();
    };

    for line in output.lines() {
        let line = line.trim_end();
        if line.is_empty() {
            flush(&mut rec, &mut worktrees);
        } else if let Some(p) = line.strip_prefix("worktree ") {
            rec.path = Some(p.to_owned());
        } else if let Some(h) = line.strip_prefix("HEAD ") {
            rec.head = Some(h.to_owned());
        } else if let Some(b) = line.strip_prefix("branch ") {
            rec.branch = Some(b.strip_prefix("refs/heads/").unwrap_or(b).to_owned());
        } else if line == "bare" {
            rec.is_bare = true;
        } else if line == "detached" {
            rec.is_detached = true;
        } else if line == "prunable" || line.starts_with("prunable ") {
            rec.is_prunable = true;
        }
        // `locked` annotations are ignored (a locked worktree is still valid).
    }
    // Final record may not be followed by a trailing blank line.
    flush(&mut rec, &mut worktrees);

    // The repository's main working tree is the first non-bare entry.
    if let Some(w) = worktrees.iter_mut().find(|w| !w.is_bare) {
        w.is_main = true;
    }
    worktrees
}

#[tauri::command]
pub async fn git_worktree_list(
    root: String,
    shell: ShellConfig,
) -> Result<Vec<GitWorktree>, String> {
    let output = tokio::task::spawn_blocking(move || {
        run_git(&shell, &root, &["worktree", "list", "--porcelain"])
    })
    .await
    .map_err(|e| e.to_string())??;

    Ok(parse_worktrees(&output))
}

#[tauri::command]
pub async fn git_checkout(root: String, shell: ShellConfig, branch: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        run_git(&shell, &root, &["checkout", &branch])?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Check out a remote-tracking branch by creating the local branch that tracks
/// it (`origin/foo` → local `foo`, #197). Git derives the local name from its own
/// remote list, so a slash in either the remote or the branch stays correct.
/// Fails when the local branch already exists — the caller switches to it
/// instead.
#[tauri::command]
pub async fn git_checkout_track(
    root: String,
    shell: ShellConfig,
    remote_branch: String,
) -> Result<(), String> {
    validate_ref_name(&remote_branch)?;
    tokio::task::spawn_blocking(move || {
        run_git(&shell, &root, &["checkout", "--track", &remote_branch])?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

fn validate_ref_name(name: &str) -> Result<(), String> {
    // 最低限のフラグ injection 対策と git のリファレンス命名規約に沿った検証
    if name.is_empty() {
        return Err("branch name is empty".to_owned());
    }
    if name.starts_with('-') {
        return Err("branch name cannot start with '-'".to_owned());
    }
    if name
        .chars()
        .any(|c| c.is_control() || matches!(c, ' ' | '~' | '^' | ':' | '?' | '*' | '[' | '\\'))
    {
        return Err("branch name contains invalid characters".to_owned());
    }
    if name.contains("..") || name.contains("@{") {
        return Err("branch name contains invalid sequence".to_owned());
    }
    Ok(())
}

#[tauri::command]
pub async fn git_create_branch(
    root: String,
    shell: ShellConfig,
    name: String,
    start_point: String,
) -> Result<(), String> {
    validate_ref_name(&name)?;
    validate_ref_name(&start_point)?;
    tokio::task::spawn_blocking(move || {
        run_git(&shell, &root, &["branch", &name, &start_point])?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_remote_url(root: String, shell: ShellConfig) -> Result<Option<String>, String> {
    let output = tokio::task::spawn_blocking(move || {
        run_git(&shell, &root, &["remote", "get-url", "origin"])
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(output
        .ok()
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty()))
}

/// `git_remote_url` for many roots at once, in the same order. Used to backfill
/// the origin of projects registered before Pike stored it (#164): a WSL probe
/// costs a `wsl.exe` launch, so all of one distro's roots share a single call.
/// A root that is not a repository, or has no origin, yields `None`.
#[tauri::command]
pub async fn git_remote_urls(
    shell: ShellConfig,
    roots: Vec<String>,
) -> Result<Vec<Option<String>>, String> {
    tokio::task::spawn_blocking(move || match &shell {
        ShellConfig::Wsl { .. } => remote_urls_wsl(&shell, &roots),
        _ => Ok(roots
            .iter()
            .map(|root| {
                run_git(&shell, root, &["remote", "get-url", "origin"])
                    .ok()
                    .map(|s| s.trim().to_owned())
                    .filter(|s| !s.is_empty())
            })
            .collect()),
    })
    .await
    .map_err(|e| e.to_string())?
}

fn remote_urls_wsl(shell: &ShellConfig, roots: &[String]) -> Result<Vec<Option<String>>, String> {
    if roots.is_empty() {
        return Ok(vec![]);
    }
    // One line of output per root, in order: the URL, or empty when there is
    // none. `head -n1` keeps a multi-URL remote from shifting later rows.
    let script = roots
        .iter()
        .map(|root| {
            format!(
                "{} remote get-url origin 2>/dev/null | head -n1 | tr -d '\\r\\n'; echo",
                git_bash_prefix(root)
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let (_, stdout, _) = shell.run("bash", &["-c", &script])?;
    let mut urls: Vec<Option<String>> = stdout
        .lines()
        .map(|l| {
            let trimmed = l.trim();
            (!trimmed.is_empty()).then(|| trimmed.to_owned())
        })
        .collect();
    // A distro that fails to start prints nothing: report "no origin" rather
    // than mis-assigning one root's URL to another.
    urls.resize(roots.len(), None);
    Ok(urls)
}

#[tauri::command]
pub async fn git_fetch(root: String, shell: ShellConfig) -> Result<GitNetworkResult, String> {
    tokio::task::spawn_blocking(move || {
        // **3 つとも同じ形で返す**（#384）。「背景の取得だから知らせない」は呼び出し側の
        // 方針なので、戻り値の型に焼き込まない。焼き込んでいたころは、エラー文の整形を
        // ここへ書き写したうえで唯一の呼び出し元が捨てていた。
        let args = ["fetch", "--prune"];
        let run = run_git_network(&shell, &root, &args)?;
        Ok(GitNetworkResult::of(&args, run))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Options offered by the pull/push button context menus (#179).
///
/// Modelled as enums rather than free-form strings so the frontend can never
/// hand arbitrary arguments to the git CLI; adding an option means adding a
/// variant here.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PullOption {
    Rebase,
    Autostash,
    FfOnly,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PushOption {
    ForceWithLease,
    Tags,
    SetUpstream,
}

#[tauri::command]
pub async fn git_push(
    root: String,
    shell: ShellConfig,
    options: Option<Vec<PushOption>>,
) -> Result<GitNetworkResult, String> {
    tokio::task::spawn_blocking(move || {
        let mut args = vec!["push"];
        // `--set-upstream` needs an explicit destination, and it has to come
        // after the flags. `origin` matches what the rest of the module assumes
        // (see `git_remote_url`); HEAD resolves to the current branch.
        let mut destination: &[&str] = &[];
        for opt in options.unwrap_or_default() {
            match opt {
                PushOption::ForceWithLease => args.push("--force-with-lease"),
                PushOption::Tags => args.push("--tags"),
                PushOption::SetUpstream => {
                    args.push("--set-upstream");
                    destination = &["origin", "HEAD"];
                }
            }
        }
        args.extend_from_slice(destination);
        let run = run_git_network(&shell, &root, &args)?;
        Ok(GitNetworkResult::of(&args, run))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_pull(
    root: String,
    shell: ShellConfig,
    options: Option<Vec<PullOption>>,
) -> Result<GitNetworkResult, String> {
    tokio::task::spawn_blocking(move || {
        let mut args = vec!["pull"];
        for opt in options.unwrap_or_default() {
            args.push(match opt {
                PullOption::Rebase => "--rebase",
                PullOption::Autostash => "--autostash",
                PullOption::FfOnly => "--ff-only",
            });
        }
        // Unlike every other git call, keep stdout when pull fails: a stopped
        // merge/rebase writes `CONFLICT (content): Merge conflict in …` there,
        // and the terse stderr half alone would lose it (#222). 組み立ては
        // `GitNetworkResult::of` が持つ（push と同じ扱い）。
        let run = run_git_network(&shell, &root, &args)?;
        Ok(GitNetworkResult::of(&args, run))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// コミットタブ（#374）に出す差分の上限。ファイル 1 つぶんの `truncate_diff`（100KB）より
/// 大きくするのは、コミット全体（複数のファイル）を 1 本で運ぶため。これを超える差分は
/// 描くだけで重いので、行の切れ目で打ち切って知らせる。
const COMMIT_PATCH_MAX: usize = 1_000_000;

/// コミット 1 つぶんの差分（コミットタブ、#374）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitPatch {
    pub patch: String,
    /// `COMMIT_PATCH_MAX` で打ち切ったか。
    pub truncated: bool,
}

/// 行の切れ目で `max` バイト以内に切る。1 行が `max` を超えるときだけ文字境界で切る。
fn truncate_at_line(mut output: String, max: usize) -> (String, bool) {
    if output.len() <= max {
        return (output, false);
    }
    let mut end = max;
    while end > 0 && !output.is_char_boundary(end) {
        end -= 1;
    }
    if let Some(nl) = output[..end].rfind('\n') {
        end = nl + 1;
    }
    output.truncate(end);
    (output, true)
}

/// コミット全体の差分（#374）。**比べる相手は呼び出し元が渡す第 1 親**で、マージコミットも
/// 第 1 親との差分になる（`git show` の既定は combined diff で、`diffParser` が読めない）。
/// 親が無い最初のコミットは `diff-tree --root` で全ファイルの追加として出す。親の一覧は
/// パネルが `git log` で既に持っているので、ここで数え直す spawn は要らない。
#[tauri::command]
pub async fn git_commit_patch(
    root: String,
    shell: ShellConfig,
    hash: String,
    parent: Option<String>,
) -> Result<CommitPatch, String> {
    // コマンド行に入るので 16 進に限る（`-` で始まる値をオプションとして読ませない）。
    if !is_sha(&hash) || parent.as_deref().is_some_and(|p| !is_sha(p)) {
        return Err(format!("invalid commit id: {hash}"));
    }
    tokio::task::spawn_blocking(move || {
        let output = match parent.as_deref() {
            Some(parent) => run_git(&shell, &root, &["diff", "-M", parent, &hash])?,
            None => run_git(
                &shell,
                &root,
                &[
                    "diff-tree",
                    "-p",
                    "-M",
                    "-r",
                    "--root",
                    "--no-commit-id",
                    &hash,
                ],
            )?,
        };
        let (patch, truncated) = truncate_at_line(output, COMMIT_PATCH_MAX);
        Ok(CommitPatch { patch, truncated })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_show_files(
    root: String,
    shell: ShellConfig,
    hash: String,
) -> Result<Vec<GitFileChange>, String> {
    let output = tokio::task::spawn_blocking(move || {
        run_git(
            &shell,
            &root,
            &["show", "--pretty=", "--name-status", &hash],
        )
    })
    .await
    .map_err(|e| e.to_string())??;

    Ok(output
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() {
                return None;
            }
            let mut parts = line.splitn(2, '\t');
            let status = parts.next()?.chars().next()?.to_string();
            let rest = parts.next()?;
            // リネーム / コピーは `R100\t<orig>\t<new>` の形。**こちらは元の名前が先**
            // （porcelain v2 の `2 ` 行とは逆）。**コミットの差分は `--follow` 側で解決する**
            // ので、ここで埋めた元の名前を diff に渡す消費者は今のところ無い。
            let (path, orig_path) = match rest.split_once('\t') {
                Some((orig, new)) => (new.to_owned(), Some(orig.to_owned())),
                None => (rest.to_owned(), None),
            };
            Some(GitFileChange {
                path,
                status,
                orig_path,
            })
        })
        .collect())
}

#[tauri::command]
pub async fn git_diff_commit(
    root: String,
    shell: ShellConfig,
    hash: String,
    path: String,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        // **`--follow` でリネームを追う（#306、理由は `.claude/rules/git.md`）。** 呼び出し元の
        // 2 つ（履歴タブ・アウトラインの履歴）が元の名前を知らないので、`git_diff` と違って
        // pathspec を足す手が使えない。親を持たない最初のコミットもそのまま扱える。
        let output = run_git(
            &shell,
            &root,
            &[
                "log",
                NO_SHOW_SIGNATURE,
                "--follow",
                "-p",
                "--format=%H",
                "--max-count=1",
                &hash,
                "--",
                &path,
            ],
        )?;
        let patch = commit_patch(&output, &hash);
        if !patch.is_empty() {
            return Ok(truncate_diff(patch.to_owned()));
        }

        // **マージコミットは `--follow` で出せない。** パスを絞った `git log` はマージを
        // 素通りして祖先へ遡るので（上の確認で弾かれる）、そこだけ従来どおり第 1 親との
        // 差分を出す。リネーム検出は効かないが、置き換える前と同じ見え方になる。
        //
        // **失敗を空に潰さないこと。** 「変更なし」と出して終わると、#306 が直したのと同じ
        // 「静かに壊れる」形になる。`~1` が無い最初のコミットだけを `--root` で拾い、
        // それ以外のエラーは git の言い分をそのまま返す。
        let output = match run_git(
            &shell,
            &root,
            &["diff", &format!("{hash}~1"), &hash, "--", &path],
        ) {
            Ok(o) => o,
            Err(_) => run_git(&shell, &root, &["diff", "--root", &hash, "--", &path])?,
        };
        Ok(truncate_diff(output))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// `git log --format=%H -p` の出力（`<hash>\n\n<patch>`）から、**要求したコミットのもので
/// あれば**パッチを取り出す。
///
/// **確かめるのが要点。** `git log` は pathspec に一致しない commit を飛ばして遡るので、
/// 「そのコミットはこのパスを触っていない」場合に**祖先のコミットの差分**が返る（実測）。
/// 置き換える前の `git diff <hash>~1 <hash>` は空を返していたので、確認せずに使うと
/// 別のコミットの中身を黙って見せることになる。
fn commit_patch<'a>(output: &'a str, hash: &str) -> &'a str {
    let Some((first, rest)) = output.split_once('\n') else {
        return "";
    };
    // 呼び出し側は短縮ハッシュを渡すこともある。
    let found = first.trim();
    if found.is_empty() || !found.starts_with(hash) {
        return "";
    }
    rest.strip_prefix('\n').unwrap_or(rest)
}

#[tauri::command]
pub async fn git_show_file(
    root: String,
    shell: ShellConfig,
    hash: String,
    path: String,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        run_git(&shell, &root, &["show", &format!("{hash}:{path}")])
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Raw bytes of a file at a commit, base64-encoded.
///
/// `git_show_file` decodes stdout as text, which destroys binary content. The
/// "open file" action needs the actual bytes so an image at a commit can go to
/// the image viewer instead of being rendered as mojibake in the editor (#178
/// の確認中に判明した不具合).
#[tauri::command]
pub async fn git_show_file_base64(
    root: String,
    shell: ShellConfig,
    hash: String,
    path: String,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let spec = format!("{hash}:{path}");
        let output = shell.run_raw("git", &git_args(&root, &["show", &spec]))?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_owned());
        }
        Ok(base64::engine::general_purpose::STANDARD.encode(&output.stdout))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_log_file(
    root: String,
    shell: ShellConfig,
    path: String,
    count: Option<u32>,
) -> Result<Vec<GitLogEntry>, String> {
    let n = count.unwrap_or(20).to_string();
    let output = tokio::task::spawn_blocking(move || {
        run_git(
            &shell,
            &root,
            &[
                "log",
                NO_SHOW_SIGNATURE,
                "--format=%H%x1f%an%x1f%aI%x1f%s%x1e",
                "-n",
                &n,
                "--",
                &path,
            ],
        )
    })
    .await
    .map_err(|e| e.to_string())??;

    Ok(parse_log(&output))
}

/// Get commits that modified a specific line range of a file using `git log -L`.
/// Note: `git log -L` ignores `-n`, so we truncate the parsed result instead.
#[tauri::command]
pub async fn git_log_file_lines(
    root: String,
    shell: ShellConfig,
    path: String,
    start_line: u32,
    end_line: u32,
    count: Option<u32>,
) -> Result<Vec<GitLogEntry>, String> {
    if start_line == 0 || end_line < start_line {
        return Err("invalid line range".to_owned());
    }
    let range = format!("{},{}:{}", start_line, end_line, path);
    let output = tokio::task::spawn_blocking(move || {
        run_git(
            &shell,
            &root,
            &[
                "log",
                NO_SHOW_SIGNATURE,
                "--format=%H%x1f%an%x1f%aI%x1f%s%x1e",
                "-s",
                "-L",
                &range,
            ],
        )
    })
    .await
    .map_err(|e| e.to_string())??;

    let mut entries = parse_log(&output);
    if let Some(n) = count {
        entries.truncate(n as usize);
    }
    Ok(entries)
}

/// ガターのホバーで見せる「消えた行」1 かたまり（#322）。
///
/// **出すのは `-` の側だけ。** `+` の側は今エディタに映っているものなので、並べても
/// 同じ内容が 2 度出るだけになる。
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RemovedBlock {
    /// 新しい側でこのかたまりが現れる行（`modified` の開始行、または `deleted` の位置）。
    pub line: u32,
    /// 消えた行の中身（`-` を外したもの）。**`MAX_PREVIEW_LINES` で切る。**
    pub lines: Vec<String>,
    /// 実際に消えた行数。`lines.len()` より多ければ、フロントが「ほか N 行」と出す。
    pub total: u32,
}

/// 1 かたまりに載せる行数の上限。**ここで切るのは IPC のため**でもある: ガターはファイルを
/// 開くたびに取るので、全消しのような diff で数 MB の JSON を毎回渡すことになる。
const MAX_PREVIEW_LINES: usize = 40;

/// 1 行の長さの上限。ミニファイされた JS の 1 行は数 MB あり、そのままでは載らない。
const MAX_PREVIEW_LINE_LEN: usize = 200;

/// ファイル全体で載せる行数の上限。**かたまり単位の上限だけでは足りない**: 削除が細かく
/// 散った diff（生成物の作り直し、コメントの一括削除、改行コードの変換）では、かたまりの
/// 数だけ積み上がる。ガターは開くときだけでなく**保存のたび**にも取り直すので、自動保存を
/// 使っていると打鍵が止まるたびにこれを払う。
///
/// 超えたぶんは `lines` を空にして返す（`total` は残るので、ホバーすれば「ほか N 行」だけが
/// 出る）。**かたまりごと落とさない**のは、`removed` が `modified` / `deleted` と位置で
/// 対応しているため。
const MAX_PREVIEW_LINES_TOTAL: usize = 400;

/// 溜めている `-` の行（#322）。**上限に当たったあとも数え続ける**ので、`total` が
/// 「実際に消えた行数」になる。
#[derive(Default)]
struct PendingDel {
    lines: Vec<String>,
    total: u32,
}

impl PendingDel {
    fn is_empty(&self) -> bool {
        self.total == 0
    }

    /// **上限に当たったら溜めない**（`total` だけ数える）。`budget` はファイル全体の残りで、
    /// **確保してから捨てるのではなく最初から作らない**ためにここまで渡す: 削除が細かく
    /// 散った diff では、かたまりごとに 40 行ぶんの `String` を作っては落とすことになる。
    fn push(&mut self, text: &str, budget: usize) {
        self.total += 1;
        if self.lines.len() < MAX_PREVIEW_LINES.min(budget) {
            self.lines
                .push(crate::types::truncate_chars(text, MAX_PREVIEW_LINE_LEN));
        }
    }

    /// 溜めたぶんを 1 かたまりとして取り出し、使ったぶんを `budget` から引く。
    /// 空なら `None`（追加だけの変更）。
    fn take(&mut self, line: u32, budget: &mut usize) -> Option<RemovedBlock> {
        if self.is_empty() {
            return None;
        }
        let total = std::mem::take(&mut self.total);
        let lines = std::mem::take(&mut self.lines);
        *budget -= lines.len();
        Some(RemovedBlock { line, lines, total })
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffLines {
    pub added: Vec<[u32; 2]>,
    pub modified: Vec<[u32; 2]>,
    pub deleted: Vec<u32>,
    /// 消えた行（#322）。`modified` / `deleted` の位置に対応する。
    pub removed: Vec<RemovedBlock>,
}

fn parse_diff_lines(diff_output: &str) -> GitDiffLines {
    let mut added = Vec::new();
    let mut modified = Vec::new();
    let mut deleted = Vec::new();
    let mut removed: Vec<RemovedBlock> = Vec::new();

    let mut new_line: u32 = 0;
    // 溜めている `-` の行（#322）。**bool ではなく中身を持つ**ので、`is_empty()` が
    // 以前の `pending_del` と同じ意味になる。
    let mut pending_del = PendingDel::default();
    // ファイル全体で載せられる残り行数（`MAX_PREVIEW_LINES_TOTAL`）。
    let mut budget = MAX_PREVIEW_LINES_TOTAL;
    let mut add_start: Option<u32> = None;
    let mut mod_start: Option<u32> = None;

    fn flush_range(start: &mut Option<u32>, end: u32, out: &mut Vec<[u32; 2]>) {
        if let Some(s) = start.take() {
            out.push([s, end]);
        }
    }

    /// 溜めた `-` を「削除」として確定する（`@@`・context 行・末尾の 3 か所で同じ）。
    /// **`+` の枝だけは別**（あちらは `deleted` ではなく `modified` に紐付く）。
    fn flush_deletion(
        pending: &mut PendingDel,
        line: u32,
        budget: &mut usize,
        deleted: &mut Vec<u32>,
        removed: &mut Vec<RemovedBlock>,
    ) {
        if let Some(block) = pending.take(line, budget) {
            deleted.push(line);
            removed.push(block);
        }
    }

    for line in diff_output.lines() {
        if line.starts_with("@@") {
            flush_range(&mut add_start, new_line.saturating_sub(1), &mut added);
            flush_range(&mut mod_start, new_line.saturating_sub(1), &mut modified);
            flush_deletion(
                &mut pending_del,
                new_line,
                &mut budget,
                &mut deleted,
                &mut removed,
            );
            // Parse @@ -old,count +new,count @@
            if let Some(plus) = line.find('+') {
                let rest = &line[plus + 1..];
                let num_end = rest.find([',', ' ']).unwrap_or(rest.len());
                if let Ok(n) = rest[..num_end].parse::<u32>() {
                    new_line = n;
                }
            }
            continue;
        }
        if line.starts_with("diff ")
            || line.starts_with("index ")
            || line.starts_with("---")
            || line.starts_with("+++")
        {
            continue;
        }
        if let Some(text) = line.strip_prefix('-') {
            flush_range(&mut add_start, new_line.saturating_sub(1), &mut added);
            pending_del.push(text, budget);
        } else if line.starts_with('+') {
            // 溜めた `-` があれば「置き換え」。**この行に紐付ける**ので、変更範囲の
            // どの行にホバーしても同じかたまりが引ける（フロントが範囲へ展開する）。
            if let Some(block) = pending_del.take(new_line, &mut budget) {
                removed.push(block);
                if mod_start.is_none() {
                    mod_start = Some(new_line);
                }
            } else if mod_start.is_none() && add_start.is_none() {
                add_start = Some(new_line);
            }
            new_line += 1;
        } else {
            flush_range(&mut add_start, new_line.saturating_sub(1), &mut added);
            flush_range(&mut mod_start, new_line.saturating_sub(1), &mut modified);
            flush_deletion(
                &mut pending_del,
                new_line,
                &mut budget,
                &mut deleted,
                &mut removed,
            );
            new_line += 1;
        }
    }
    flush_range(&mut add_start, new_line.saturating_sub(1), &mut added);
    flush_range(&mut mod_start, new_line.saturating_sub(1), &mut modified);
    flush_deletion(
        &mut pending_del,
        new_line,
        &mut budget,
        &mut deleted,
        &mut removed,
    );

    GitDiffLines {
        added,
        modified,
        deleted,
        removed,
    }
}

#[tauri::command]
pub async fn git_diff_lines(
    root: String,
    shell: ShellConfig,
    path: String,
) -> Result<GitDiffLines, String> {
    tokio::task::spawn_blocking(move || {
        let output = run_git(&shell, &root, &["diff", "HEAD", "--", &path]);
        match output {
            Ok(diff) => Ok(parse_diff_lines(&diff)),
            Err(_) => Ok(GitDiffLines {
                added: vec![],
                modified: vec![],
                deleted: vec![],
                removed: vec![],
            }),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 利用者の設定を潰さず、末尾に足すだけであること（#384）。
    #[test]
    fn ssh_command_keeps_the_users_value() {
        assert_eq!(
            compose_ssh_command(""),
            "core.sshCommand=ssh -o BatchMode=yes"
        );
        assert_eq!(
            compose_ssh_command("  \n"),
            "core.sshCommand=ssh -o BatchMode=yes"
        );
        assert_eq!(
            compose_ssh_command("C:/Windows/System32/OpenSSH/ssh.exe"),
            "core.sshCommand=C:/Windows/System32/OpenSSH/ssh.exe -o BatchMode=yes"
        );
        // 空白を含むパスは利用者が引用している。その引用は解かない。
        assert_eq!(
            compose_ssh_command("\"C:/Program Files/ssh.exe\" -F /dev/null"),
            "core.sshCommand=\"C:/Program Files/ssh.exe\" -F /dev/null -o BatchMode=yes"
        );
    }

    /// `BatchMode` で即座に失敗したものを、資格情報待ちとして見分けられること（#384）。
    #[test]
    fn credential_failures_are_told_apart() {
        assert!(needs_credentials(
            "git@github.com: Permission denied (publickey)."
        ));
        assert!(needs_credentials("Host key verification failed."));
        assert!(needs_credentials(
            "fatal: could not read Username for 'https://github.com': terminal prompts disabled"
        ));
        // 競合で止まった pull や、普通のネットワーク断は対象外。
        assert!(!needs_credentials(
            "CONFLICT (content): Merge conflict in src/main.rs"
        ));
        assert!(!needs_credentials(
            "fatal: unable to access 'https://example.com/': Could not resolve host"
        ));
    }

    #[test]
    fn truncate_at_line_cuts_on_a_line_boundary() {
        assert_eq!(
            truncate_at_line("ab\ncd\n".into(), 10),
            ("ab\ncd\n".into(), false)
        );
        assert_eq!(
            truncate_at_line("ab\ncd\nef\n".into(), 7),
            ("ab\ncd\n".into(), true)
        );
        // 改行が無ければ文字境界で切る（`あ` は 3 バイト）。
        assert_eq!(truncate_at_line("ああ".into(), 4), ("あ".into(), true));
    }

    #[test]
    fn parses_multiple_worktrees() {
        let out = "worktree /home/user/repo
HEAD aaa111
branch refs/heads/main

worktree /home/user/repo-feat
HEAD bbb222
branch refs/heads/feat

worktree /home/user/repo-det
HEAD ccc333
detached
";
        let wts = parse_worktrees(out);
        assert_eq!(wts.len(), 3);

        assert_eq!(wts[0].path, "/home/user/repo");
        assert_eq!(wts[0].branch.as_deref(), Some("main"));
        assert_eq!(wts[0].head.as_deref(), Some("aaa111"));
        assert!(wts[0].is_main);
        assert!(!wts[0].is_detached);

        assert_eq!(wts[1].path, "/home/user/repo-feat");
        assert_eq!(wts[1].branch.as_deref(), Some("feat"));
        assert!(!wts[1].is_main);

        assert_eq!(wts[2].path, "/home/user/repo-det");
        assert!(wts[2].branch.is_none());
        assert!(wts[2].is_detached);
    }

    #[test]
    fn parses_final_record_without_trailing_blank_line() {
        let out = "worktree /repo
HEAD aaa
branch refs/heads/main";
        let wts = parse_worktrees(out);
        assert_eq!(wts.len(), 1);
        assert_eq!(wts[0].branch.as_deref(), Some("main"));
        assert!(wts[0].is_main);
    }

    #[test]
    fn bare_entry_is_not_main_first_working_tree_is() {
        let out = "worktree /repo/.bare
bare

worktree /repo/main
HEAD aaa
branch refs/heads/main
";
        let wts = parse_worktrees(out);
        assert_eq!(wts.len(), 2);
        assert!(wts[0].is_bare);
        assert!(
            !wts[0].is_main,
            "the bare entry must not be treated as main"
        );
        assert!(wts[1].is_main, "the first working tree is main");
        assert_eq!(wts[1].branch.as_deref(), Some("main"));
    }

    #[test]
    fn parses_unmerged_conflict_entries() {
        // Porcelain v2: `u` lines for conflicts, `1` for a staged change, `?` for untracked.
        let out = "# branch.oid abc123
# branch.head main
1 M. N... 100644 100644 100644 hhh iii staged.txt
u UU N... 100644 100644 100644 100644 h1 h2 h3 conflict.txt
u AA N... 000000 100644 100644 100644 h1 h2 h3 both added.txt
? untracked.txt
";
        let st = parse_status(out);
        assert_eq!(st.conflicted.len(), 2);
        assert_eq!(st.conflicted[0].path, "conflict.txt");
        assert_eq!(st.conflicted[0].status, "UU");
        // Path with a space must survive (splitn(11) keeps the remainder intact).
        assert_eq!(st.conflicted[1].path, "both added.txt");
        assert_eq!(st.conflicted[1].status, "AA");
        // Conflicts must not leak into staged/unstaged.
        assert_eq!(st.staged.len(), 1);
        assert_eq!(st.unstaged.len(), 1);
        assert!(st.is_dirty);
    }

    #[test]
    fn parses_renamed_entries() {
        // Porcelain v2 の `2 ` 行はスコア（`R100`）のぶんフィールドが 1 つ多い（#306）。
        // 実際の `git status --porcelain=v2` の出力から。
        let out = "# branch.oid abc123
# branch.head main
2 RM N... 100644 100644 100644 94954ab 94954ab R100 new.md\told.md
2 R. N... 100644 100644 100644 3774da6 3774da6 R100 renamed space.txt\twith space.txt
2 C75 N... 100644 100644 100644 aaa bbb C75 copy.txt\tsource.txt
1 M. N... 100644 100644 100644 hhh iii plain.txt
";
        let st = parse_status(out);

        // `RM` は staged（R）と unstaged（M）の両方に出る。どちらも新しい名前。
        assert_eq!(st.staged[0].path, "new.md");
        assert_eq!(st.staged[0].status, "R");
        assert_eq!(st.unstaged[0].path, "new.md");
        assert_eq!(st.unstaged[0].status, "M");

        // 名前に空白があっても、スコアだけが落ちる。
        assert_eq!(st.staged[1].path, "renamed space.txt");
        // コピー（`C<score>`）も同じ形。
        assert_eq!(st.staged[2].path, "copy.txt");
        // 通常の `1 ` 行は 9 フィールドのまま。
        assert_eq!(st.staged[3].path, "plain.txt");
    }

    #[test]
    fn commit_patch_needs_the_requested_commit() {
        let out =
            "abc123def\n\ndiff --git a/old.md b/new.md\nrename from old.md\nrename to new.md\n";
        assert!(commit_patch(out, "abc123def").starts_with("diff --git"));
        // 短縮ハッシュで引いても同じ。
        assert!(commit_patch(out, "abc123").starts_with("diff --git"));

        // **そのコミットが触っていないパスを渡すと、`git log` は祖先まで遡る。**
        // 別のコミットの差分を黙って見せないよう、ここで落とす。
        assert_eq!(commit_patch(out, "999999"), "");
        // 該当が無ければ出力そのものが空。
        assert_eq!(commit_patch("", "abc123def"), "");
    }

    #[test]
    fn prunable_worktrees_are_skipped() {
        let out = "worktree /repo
HEAD aaa
branch refs/heads/main

worktree /repo-gone
HEAD bbb
branch refs/heads/gone
prunable gitdir file points to non-existent location
";
        let wts = parse_worktrees(out);
        assert_eq!(wts.len(), 1);
        assert_eq!(wts[0].path, "/repo");
        assert!(wts[0].is_main);
    }

    #[test]
    fn splits_local_and_remote_branch_refs() {
        let out = "refs/heads/feature/nested
refs/heads/main
refs/remotes/origin/HEAD
refs/remotes/origin/feature/nested
refs/remotes/origin/main
refs/remotes/upstream/main
refs/tags/v1.0.0
";
        let branches = parse_branch_refs(out);
        assert_eq!(branches.local, vec!["feature/nested", "main"]);
        assert_eq!(
            branches.remote,
            vec!["origin/feature/nested", "origin/main", "upstream/main"]
        );
    }

    #[test]
    fn branch_refs_of_empty_repo_are_empty() {
        assert_eq!(parse_branch_refs(""), GitBranches::default());
    }
}

#[cfg(test)]
mod operation_tests {
    use super::*;

    /// Build the probe map. `(name, Some(content))` is a file git wrote (empty
    /// contents included); `(name, None)` spells out an absent one, which the
    /// map represents by having no key at all.
    fn files(entries: &[(&str, Option<&str>)]) -> StateFiles {
        entries
            .iter()
            .filter_map(|(name, content)| {
                let key = OP_STATE_FILES.iter().find(|(n, _)| n == name)?.0;
                Some((key, (*content)?.to_owned()))
            })
            .collect()
    }

    #[test]
    fn no_state_files_means_no_operation() {
        assert_eq!(parse_operation(&files(&[]), false), None);
        // A plain detached HEAD (a checked-out tag) must not raise a banner.
        assert_eq!(
            parse_operation(&files(&[("MERGE_HEAD", None)]), false),
            None
        );
    }

    #[test]
    fn rebase_conflict_carries_progress_and_branch() {
        // Measured layout of a conflict stop: message and stopped-sha written.
        let op = parse_operation(
            &files(&[
                ("rebase-merge/head-name", Some("refs/heads/topic\n")),
                ("rebase-merge/msgnum", Some("2\n")),
                ("rebase-merge/end", Some("5\n")),
                ("rebase-merge/message", Some("topic side\n")),
                ("rebase-merge/stopped-sha", Some("3eb7a26\n")),
            ]),
            true,
        )
        .expect("an operation");
        assert_eq!(op.kind, "rebase");
        assert_eq!(op.branch.as_deref(), Some("topic"));
        assert_eq!((op.step, op.total), (Some(2), Some(5)));
        assert_eq!(op.stop, "conflict");
        assert_eq!(op.stopped_sha, None);
    }

    #[test]
    fn merge_is_detected_without_conflicts() {
        // A plain `git pull` whose commit failed to sign: MERGE_HEAD is the only
        // trace — HEAD is not detached and nothing is unmerged (measured).
        let op = parse_operation(&files(&[("MERGE_HEAD", Some("abc\n"))]), false).unwrap();
        assert_eq!(op.kind, "merge");
        assert_eq!(op.stop, "stopped");
        assert_eq!((op.step, op.total), (None, None));
    }

    #[test]
    fn rebase_that_could_not_commit_offers_the_stopped_commit() {
        let done = "pick 9a8060c672571cc0c1c6eeae67e99e2f516bcbbb # feat one\n";
        let op = parse_operation(
            &files(&[
                ("rebase-merge/head-name", Some("refs/heads/feat\n")),
                ("rebase-merge/msgnum", Some("1\n")),
                ("rebase-merge/end", Some("3\n")),
                ("rebase-merge/message", None),
                ("rebase-merge/stopped-sha", None),
                ("rebase-merge/done", Some(done)),
            ]),
            false,
        )
        .unwrap();
        assert_eq!(op.stop, "commit-failed");
        assert_eq!(
            op.stopped_sha.as_deref(),
            Some("9a8060c672571cc0c1c6eeae67e99e2f516bcbbb")
        );
        assert_eq!(op.stopped_subject.as_deref(), Some("feat one"));
    }

    #[test]
    fn exec_and_break_stops_offer_no_recommit() {
        // The commit already succeeded here, so re-committing would fabricate one
        // carrying the next pick's author and message.
        for done in ["exec make test\n", "break\n"] {
            let op = parse_operation(
                &files(&[
                    ("rebase-merge/head-name", Some("refs/heads/feat\n")),
                    ("rebase-merge/message", None),
                    ("rebase-merge/stopped-sha", None),
                    ("rebase-merge/done", Some(done)),
                ]),
                false,
            )
            .unwrap();
            assert_eq!(op.stop, "stopped");
            assert_eq!(op.stopped_sha, None);
        }
    }

    #[test]
    fn partial_done_line_is_rejected() {
        // `done` is appended, so the last line can be caught mid-write.
        assert_eq!(stopped_commit("pick 9a8060c6 # ok\npick 9a80"), None);
        assert_eq!(stopped_commit(""), None);
        assert_eq!(stopped_commit("pick zzzz # not hex"), None);
    }

    #[test]
    fn apply_backend_splits_rebase_from_am() {
        let am = parse_operation(
            &files(&[
                ("rebase-apply/head-name", Some("refs/heads/main\n")),
                ("rebase-apply/applying", Some("")),
                ("rebase-apply/next", Some("1\n")),
                ("rebase-apply/last", Some("4\n")),
            ]),
            false,
        )
        .unwrap();
        assert_eq!(am.kind, "am");
        assert_eq!((am.step, am.total), (Some(1), Some(4)));

        let rebase = parse_operation(
            &files(&[("rebase-apply/head-name", Some("refs/heads/main\n"))]),
            false,
        )
        .unwrap();
        assert_eq!(rebase.kind, "rebase");
    }

    #[test]
    fn half_read_progress_is_dropped() {
        let op = parse_operation(
            &files(&[
                ("rebase-merge/head-name", Some("refs/heads/feat\n")),
                ("rebase-merge/msgnum", Some("2\n")),
            ]),
            true,
        )
        .unwrap();
        assert_eq!((op.step, op.total), (None, None));
    }

    #[test]
    fn state_records_keep_empty_files_distinct_from_missing() {
        // Records are positional, in OP_STATE_FILES order: `exists FS contents`.
        // An empty file present (`1` with nothing after it) must not read as
        // absent — the whole commit-failed classification turns on that.
        let raw: String = OP_STATE_FILES
            .iter()
            .map(|(name, _)| match *name {
                "rebase-merge/head-name" => format!("1{FS}refs/heads/feat\n{RS}"),
                "rebase-merge/message" => format!("1{FS}{RS}"),
                _ => format!("0{FS}{RS}"),
            })
            .collect();
        let parsed = parse_state_records(&raw);
        assert_eq!(parsed.get("rebase-merge/message"), Some(&String::new()));
        assert_eq!(
            parsed.get("rebase-merge/head-name").unwrap(),
            "refs/heads/feat\n"
        );
        assert_eq!(parsed.get("rebase-merge/done"), None);
    }

    /// 置き換え（#322）。消えた行は**変更範囲の開始行**に紐付く。
    #[test]
    fn keeps_the_removed_lines_of_a_replacement() {
        let diff = "diff --git a/f b/f\n\
index 111..222 100644\n\
--- a/f\n\
+++ b/f\n\
@@ -1,4 +1,4 @@\n\
 ctx\n\
-old one\n\
-old two\n\
+new one\n\
+new two\n";
        let got = parse_diff_lines(diff);
        assert_eq!(got.modified, vec![[2, 3]]);
        assert_eq!(
            got.removed,
            vec![RemovedBlock {
                line: 2,
                lines: vec!["old one".into(), "old two".into()],
                total: 2,
            }]
        );
    }

    /// 純粋な削除は `deleted` と同じ位置に付く。
    #[test]
    fn keeps_the_removed_lines_of_a_deletion() {
        let diff = "@@ -1,3 +1,2 @@\n ctx\n-gone\n ctx2\n";
        let got = parse_diff_lines(diff);
        assert_eq!(got.deleted, vec![2]);
        assert_eq!(got.removed.len(), 1);
        assert_eq!(got.removed[0].line, 2);
        assert_eq!(got.removed[0].lines, vec!["gone".to_owned()]);
    }

    /// **追加だけの変更は何も持たない**（ホバーで出すものが無い）。
    #[test]
    fn an_addition_has_nothing_removed() {
        let diff = "@@ -1,1 +1,2 @@\n ctx\n+added\n";
        let got = parse_diff_lines(diff);
        assert_eq!(got.added, vec![[2, 2]]);
        assert!(got.removed.is_empty());
    }

    /// 上限を超えたぶんは落とすが、**`total` は実際の行数を保つ**（「ほか N 行」に使う）。
    #[test]
    fn caps_the_preview_but_keeps_the_real_count() {
        let mut diff = String::from("@@ -1,60 +1,1 @@\n");
        for i in 0..60 {
            let _ = writeln!(diff, "-line {i}");
        }
        diff.push_str("+one\n");
        let got = parse_diff_lines(&diff);
        assert_eq!(got.removed.len(), 1);
        assert_eq!(got.removed[0].lines.len(), MAX_PREVIEW_LINES);
        assert_eq!(got.removed[0].total, 60);
    }

    /// ファイル全体の上限（#322）。**かたまり単位の上限では止まらない**散り方でも、
    /// 載る行数は頭打ちになる。`total` は残るので「ほか N 行」は出せる。
    #[test]
    fn caps_the_preview_across_the_whole_file() {
        // 40 行消して 1 行足す、を 12 回（480 行ぶん）。
        let mut diff = String::new();
        for h in 0..12 {
            let at = h * 50 + 1;
            let _ = writeln!(diff, "@@ -{at},41 +{at},1 @@");
            for i in 0..40 {
                let _ = writeln!(diff, "-h{h} line {i}");
            }
            diff.push_str("+one\n");
        }
        let got = parse_diff_lines(&diff);
        let shown: usize = got.removed.iter().map(|b| b.lines.len()).sum();
        assert_eq!(shown, MAX_PREVIEW_LINES_TOTAL);
        let total: u32 = got.removed.iter().map(|b| b.total).sum();
        assert_eq!(total, 480);
    }

    /// 長い行は文字数で切る。**バイトで切ると panic する**ので、マルチバイトで確かめる。
    #[test]
    fn truncates_long_lines_by_chars() {
        let long = "あ".repeat(MAX_PREVIEW_LINE_LEN + 10);
        let diff = format!("@@ -1,1 +1,1 @@\n-{long}\n+short\n");
        let got = parse_diff_lines(&diff);
        let shown = &got.removed[0].lines[0];
        assert_eq!(shown.chars().count(), MAX_PREVIEW_LINE_LEN + 1); // 末尾の「…」
        assert!(shown.ends_with('…'));
    }
}
