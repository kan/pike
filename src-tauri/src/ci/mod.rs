//! CI の実行（run）の一覧と、再実行・中止（#457）。GitHub Actions と CircleCI を扱う。
//!
//! **形は `issues` と同じ**で、認証も取得も各サービスの CLI（`gh` / `circleci`）に任せる。
//! Pike はトークンに触らず、CLI を要求時に 1 回走らせて JSON を正規化するだけ。
//!
//! **2 つの CI を 1 つの器（`CiRun` / `CiJob`）に畳む。** パネルに出すのは題名・ブランチ・
//! 状態・時刻で、どちらも同じ列になる。違いは単位の切り方にある: GitHub Actions の run は
//! ワークフロー 1 本の実行で、CircleCI の run（旧称 pipeline）は複数のワークフローを束ねる。
//! **再実行の単位もそこで分かれる**（GitHub は run、CircleCI はワークフロー）ので、CircleCI の
//! 行は再実行で渡す id を自分で持って運ぶ（`CiRun.rerun_ids`）。

use crate::cache::ProbeRegistry;
use crate::types::{ShellConfig, first_line, install_key};
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tauri::State;

/// 一覧と内訳の時間切れ。`gh run list` は実測で約 1 秒、`circleci run list` は約 0.7 秒
/// （一覧はこれを 2 本続けて走らせる）。`issues` の `LIST_TIMEOUT` と同じ考え方で取ってある。
const LIST_TIMEOUT: Duration = Duration::from_secs(20);

/// 再実行と中止の時間切れ。**一覧より長く取る**（`issues` の `ACTION_TIMEOUT` と同じ理由で、
/// 切れた時点でサービスの側では済んでいることがある）。
const ACTION_TIMEOUT: Duration = Duration::from_secs(60);

/// 設定のディレクトリを見る時間切れ（WSL だけ。`has_command` の probe と同じ長さ）。
const CONFIGS_TIMEOUT: Duration = Duration::from_secs(10);

/// `circleci` が見つかったシェルをプロセス単位で覚える（`IssuesState` と同じ形・同じ理由）。
///
/// **`gh` はここで探さない。** GitHub Actions を出す条件は「origin が GitHub で `gh` がある」を
/// 含み、それは issue パネルの条件そのものなので、フロントが `issues_gh_available` の答えを
/// 共有する（同じ問いを 2 つの入れ物で覚えると、`gh --version` が 2 回走る）。
#[derive(Default)]
pub struct CiState {
    circleci: ProbeRegistry<String, bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Github,
    Circleci,
}

impl Provider {
    fn bin(self) -> &'static str {
        match self {
            Provider::Github => "gh",
            Provider::Circleci => "circleci",
        }
    }

    /// CLI に渡してよい id か。**行にそのまま埋めるので、形を決め打ちで検証する**
    /// （`issues` の `parse_target` と同じ考え方で、通す文字集合は bash でも `cmd /C` でも
    /// そのまま 1 引数になる）。GitHub は run の `databaseId`（数字）、CircleCI は UUID。
    fn valid_id(self, id: &str) -> bool {
        match self {
            Provider::Github => {
                !id.is_empty() && id.len() <= 20 && id.bytes().all(|b| b.is_ascii_digit())
            }
            // 8-4-4-4-12 の形まで見る。文字集合だけだと `-f` のような、CLI がフラグとして
            // 読む文字列が通る。
            Provider::Circleci => {
                id.len() == 36
                    && id.bytes().enumerate().all(|(i, b)| match i {
                        8 | 13 | 18 | 23 => b == b'-',
                        _ => b.is_ascii_hexdigit(),
                    })
            }
        }
    }

    /// 一覧を取る行。`branch` は `ShellConfig::line_arg` を通したものだけを渡すこと。
    ///
    /// **CircleCI は 2 本を続けて走らせる。** `run list` はワークフローを返さず、ページの URL も
    /// 持たない。再実行はワークフロー単位で、開けるページもワークフローのものなので、
    /// `workflow list`（run の id つきで返る）を同じ起動に相乗りさせる。別の IPC にすると、
    /// WSL では `wsl.exe` の起動が 2 回になる。
    fn list_line(self, limit: u32, branch: Option<&str>) -> String {
        let branch = branch.map(|b| format!(" --branch {b}")).unwrap_or_default();
        match self {
            Provider::Github => format!(
                "gh run list --limit {limit}{branch} --json \
                 databaseId,displayTitle,workflowName,headBranch,headSha,event,status,conclusion,createdAt,url"
            ),
            Provider::Circleci => format!(
                "circleci run list --json --limit {limit}{branch} && \
                 circleci workflow list --json --limit {limit}{branch}"
            ),
        }
    }

    /// 1 件の run の job を取る行。`id` は `valid_id` を通したものだけを渡すこと。
    fn jobs_line(self, id: &str) -> String {
        match self {
            Provider::Github => format!("gh run view {id} --json jobs"),
            Provider::Circleci => format!("circleci run get {id} --json"),
        }
    }

    /// 失敗のログを取る行。**エージェントが自分で走らせる**（Pike は走らせず、指示文に添える
    /// だけ）。どちらも失敗したステップだけに絞った出力を返す。
    fn failure_log_line(self, id: &str) -> String {
        match self {
            Provider::Github => format!("gh run view {id} --log-failed"),
            Provider::Circleci => format!("circleci run get {id} --failure-report"),
        }
    }

    /// 一覧の stdout を読む（`list_line` と対）。
    fn parse_runs(self, stdout: &str) -> Result<Vec<CiRun>, serde_json::Error> {
        match self {
            Provider::Github => parse_github_runs(stdout),
            Provider::Circleci => parse_circleci_runs(stdout),
        }
    }

    /// job の stdout を読む（`jobs_line` と対）。
    fn parse_jobs(self, stdout: &str) -> Result<Vec<CiJob>, serde_json::Error> {
        match self {
            Provider::Github => parse_github_jobs(stdout),
            Provider::Circleci => parse_circleci_jobs(stdout),
        }
    }
}

/// run・ワークフロー・job の状態。**2 つの CI の語彙をここへ畳む**（GitHub は `status` と
/// `conclusion`、CircleCI は `phase` と `outcome`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RunState {
    /// 待ち（queued / pending）も含む。終わっていないものは全部これ。
    Running,
    Success,
    Failure,
    Cancelled,
    /// 走らなかったもの（GitHub の `skipped` / `neutral`）。落ちていないので失敗に寄せない。
    Skipped,
}

impl RunState {
    /// GitHub Actions。`status` が `completed` でなければ実行中（`queued` / `in_progress` /
    /// `waiting` / `requested` / `pending`）。**知らない `conclusion` は失敗に倒す**
    /// （`timed_out` / `startup_failure` / `action_required` など。成功と読み違えるより安全）。
    fn of_github(status: &str, conclusion: &str) -> Self {
        if status != "completed" {
            return RunState::Running;
        }
        match conclusion {
            "success" => RunState::Success,
            "cancelled" => RunState::Cancelled,
            "skipped" | "neutral" => RunState::Skipped,
            _ => RunState::Failure,
        }
    }

    /// CircleCI。`phase` が `ended` でなければ実行中。結果は `outcome`（ワークフローと job）か
    /// `current_outcome`（run。実測では終わった run にも `outcome` は載らない）。
    /// 知らない結果を失敗に倒すのは GitHub と同じ（`failed` / `timedout` など）。
    fn of_circleci(phase: &str, outcome: Option<&str>) -> Self {
        if phase != "ended" {
            return RunState::Running;
        }
        match outcome.unwrap_or_default() {
            "succeeded" => RunState::Success,
            "canceled" | "cancelled" => RunState::Cancelled,
            "skipped" | "not_run" => RunState::Skipped,
            _ => RunState::Failure,
        }
    }
}

/// CircleCI のワークフロー（run の中の 1 本）。一覧を組むあいだだけ使う。
struct Workflow<'a> {
    id: &'a str,
    name: &'a str,
    state: RunState,
}

/// CircleCI の再実行の対象（ワークフローの id）。`failed_only` は失敗したものだけ。
///
/// **同じ名前のワークフローは 1 本にまとめる。** 再実行すると、同じ run の下に同名の新しい
/// ワークフローが増え、古いほうも失敗のまま残る。全部を対象にすると、押すたびに古いぶんまで
/// やり直して本数が倍に増える。どれが新しいかは一覧から分からないので、「その名前が 1 本でも
/// 成功していれば、もう落ちていない」と読む（成功したワークフローに `--from-failed` を渡すと、
/// やり直す job が無くて断られる）。
fn circleci_rerun_ids(workflows: &[Workflow], failed_only: bool) -> Vec<String> {
    let mut names: Vec<&str> = Vec::new();
    for w in workflows {
        if !names.contains(&w.name) {
            names.push(w.name);
        }
    }
    names
        .into_iter()
        .filter_map(|name| {
            let mut same = workflows.iter().filter(|w| w.name == name);
            if !failed_only {
                return same.next();
            }
            if same.clone().any(|w| w.state == RunState::Success) {
                return None;
            }
            same.find(|w| w.state == RunState::Failure)
        })
        .map(|w| w.id.to_owned())
        .collect()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CiRun {
    /// GitHub は run の `databaseId`（数字を文字列で）、CircleCI は run の UUID。
    pub id: String,
    /// GitHub は `displayTitle`（コミットの題か PR の題）、CircleCI はコミットの題。
    pub title: String,
    /// ワークフローの名前。CircleCI で複数あるときは `, ` でつなぐ。
    pub workflow: String,
    pub branch: String,
    /// コミットの短い SHA（7 桁）。
    pub sha: String,
    /// 起動のきっかけ（`push` / `pull_request` など）。CircleCI は返さないので空。
    pub event: String,
    pub state: RunState,
    /// ISO 8601。
    pub created_at: String,
    /// CI のページ。CircleCI でワークフローがまだ 1 つも無い run は `None`。
    pub url: Option<String>,
    /// 再実行で CLI に渡す id（空なら再実行できない）。**単位が CI で違う**ので、ここで決めて
    /// 運ぶ: GitHub は run の id、CircleCI はワークフローの id（`circleci_rerun_ids`）。
    pub rerun_ids: Vec<String>,
    /// 失敗した job だけを再実行するときの id。
    pub rerun_failed_ids: Vec<String>,
    /// 失敗のログを取るコマンド。エージェントへの指示文に添える（Pike は走らせない）。
    pub failure_log_command: String,
}

/// run の中の job 1 つ（行を開いたときに取る）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CiJob {
    pub id: String,
    pub name: String,
    /// CircleCI のワークフロー名。GitHub は空。
    pub group: String,
    pub state: RunState,
    /// GitHub は job のページ。CircleCI は job の番号が取れないので、ワークフローのページ。
    pub url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CiListResult {
    pub runs: Vec<CiRun>,
    /// 未認証・権限なしを「0 件」に見せないための理由（`IssueListResult.error` と同じ）。
    /// 実行した行も畳んである。
    pub error: Option<String>,
}

/// run に対する、状態を変える操作。
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum CiAction {
    Rerun {
        /// 失敗した job だけをやり直す（GitHub は `--failed`、CircleCI は `--from-failed`）。
        #[serde(rename = "failedOnly")]
        failed_only: bool,
    },
    Cancel,
}

impl CiAction {
    /// 実行する行。`id` は `valid_id` を通したものだけを渡すこと。
    ///
    /// **id が指すものは操作で違う**: CircleCI の再実行だけはワークフローの id で、それ以外は
    /// run の id。再実行の id は一覧が `CiRun.rerun_ids` として返したものを、フロントが
    /// そのまま渡す。
    ///
    /// **確認を端末に聞かせない。** `circleci run cancel` は `--force` が無いと確認を出し、
    /// Pike のバックエンドは入力を返せない。
    fn line(self, provider: Provider, id: &str) -> String {
        match (provider, self) {
            (Provider::Github, CiAction::Rerun { failed_only }) => {
                let failed = if failed_only { " --failed" } else { "" };
                format!("gh run rerun {id}{failed}")
            }
            (Provider::Github, CiAction::Cancel) => format!("gh run cancel {id}"),
            (Provider::Circleci, CiAction::Rerun { failed_only }) => {
                let failed = if failed_only { " --from-failed" } else { "" };
                format!("circleci workflow rerun {id}{failed}")
            }
            (Provider::Circleci, CiAction::Cancel) => format!("circleci run cancel {id} --force"),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhRun {
    database_id: u64,
    #[serde(default)]
    display_title: String,
    #[serde(default)]
    workflow_name: String,
    #[serde(default)]
    head_branch: String,
    #[serde(default)]
    head_sha: String,
    #[serde(default)]
    event: String,
    #[serde(default)]
    status: String,
    #[serde(default)]
    conclusion: String,
    #[serde(default)]
    created_at: String,
    #[serde(default)]
    url: String,
}

impl From<GhRun> for CiRun {
    fn from(g: GhRun) -> Self {
        let id = g.database_id.to_string();
        CiRun {
            // run がワークフロー 1 本なので、再実行の対象はどちらも run そのもの。
            rerun_ids: vec![id.clone()],
            rerun_failed_ids: vec![id.clone()],
            failure_log_command: Provider::Github.failure_log_line(&id),
            id,
            title: g.display_title,
            workflow: g.workflow_name,
            branch: g.head_branch,
            sha: g.head_sha.chars().take(7).collect(),
            event: g.event,
            state: RunState::of_github(&g.status, &g.conclusion),
            created_at: g.created_at,
            url: Some(g.url).filter(|u| !u.is_empty()),
        }
    }
}

#[derive(Deserialize)]
struct GhJobs {
    #[serde(default)]
    jobs: Vec<GhJob>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhJob {
    database_id: u64,
    #[serde(default)]
    name: String,
    #[serde(default)]
    status: String,
    #[serde(default)]
    conclusion: String,
    #[serde(default)]
    url: String,
}

#[derive(Deserialize)]
struct CcCommit {
    #[serde(default)]
    subject: String,
}

/// `circleci run list` / `run get` の 1 件。`workflows` は `run get` だけが返す。
#[derive(Deserialize)]
struct CcRun {
    id: String,
    #[serde(default)]
    phase: String,
    #[serde(default)]
    outcome: Option<String>,
    #[serde(default)]
    current_outcome: Option<String>,
    #[serde(default)]
    branch: String,
    /// タグで起きた run は `branch` が無く、こちらに入る。
    #[serde(default)]
    tag: String,
    #[serde(default)]
    revision: String,
    #[serde(default)]
    commit: Option<CcCommit>,
    #[serde(default)]
    created_at: String,
    #[serde(default)]
    workflows: Vec<CcWorkflow>,
}

/// ワークフロー。`run_id` は `workflow list`（直近の run をまたぐ形）だけが、`jobs` は
/// `run get` だけが返す。
#[derive(Deserialize)]
struct CcWorkflow {
    id: String,
    #[serde(default)]
    run_id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    phase: String,
    #[serde(default)]
    outcome: Option<String>,
    #[serde(default)]
    current_outcome: Option<String>,
    #[serde(default)]
    jobs: Vec<CcJob>,
}

/// CircleCI の状態。結果は `outcome`（ワークフローと job）か `current_outcome`（run）に入る。
fn circleci_state(phase: &str, outcome: &Option<String>, current: &Option<String>) -> RunState {
    RunState::of_circleci(phase, outcome.as_deref().or(current.as_deref()))
}

#[derive(Deserialize)]
struct CcJob {
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    phase: String,
    #[serde(default)]
    outcome: Option<String>,
    #[serde(default)]
    current_outcome: Option<String>,
}

/// `circleci` が失敗したときに stderr へ出す JSON。
#[derive(Deserialize)]
struct CcError {
    #[serde(default)]
    code: String,
    #[serde(default)]
    message: String,
}

/// ワークフローのページ。**run のページは組めない**（URL に要る run の番号を JSON が返さない）
/// ので、id だけで開けるこちらを使う。id は `valid_id` と同じ文字集合のときだけ通す。
fn circleci_workflow_url(id: &str) -> Option<String> {
    Provider::Circleci
        .valid_id(id)
        .then(|| format!("https://app.circleci.com/pipelines/workflows/{id}"))
}

/// CircleCI の時刻（`2026-10-07 08:42 UTC`。`run get` は秒つき）を ISO 8601 にする。
/// フロントは `new Date()` に通すので、この形のままだと処理系によって読めない。
/// 知らない形はそのまま返す。
fn circleci_time(s: &str) -> String {
    let mut parts = s.split_whitespace();
    match (parts.next(), parts.next(), parts.next(), parts.next()) {
        (Some(date), Some(time), Some("UTC"), None) => {
            let seconds = if time.matches(':').count() == 1 {
                ":00"
            } else {
                ""
            };
            format!("{date}T{time}{seconds}Z")
        }
        _ => s.to_owned(),
    }
}

fn parse_github_runs(stdout: &str) -> Result<Vec<CiRun>, serde_json::Error> {
    Ok(serde_json::from_str::<Vec<GhRun>>(stdout.trim())?
        .into_iter()
        .map(CiRun::from)
        .collect())
}

/// `run list` と `workflow list` を続けて走らせた stdout（JSON が 2 つ並ぶ）を一覧へ。
///
/// **開くページは、落ちたワークフローがあればそれ**（無ければ先頭）。行を押す理由の多くは
/// 「なぜ落ちたか」なので、成功したほうを先に開かない。
///
/// **2 つ目（ワークフロー）は読めなくても run を返す。** `workflow list` だけが失敗したとき
/// （ワークフローがまだ 1 本も無い、など）に、取れている run まで捨てない。その run は
/// ページも再実行の対象も持たないだけで、一覧には出る。
fn parse_circleci_runs(stdout: &str) -> Result<Vec<CiRun>, serde_json::Error> {
    let mut de = serde_json::Deserializer::from_str(stdout);
    let runs = Vec::<CcRun>::deserialize(&mut de)?;
    let workflows = Vec::<CcWorkflow>::deserialize(&mut de).unwrap_or_default();
    Ok(runs
        .into_iter()
        .map(|run| {
            let workflows: Vec<Workflow> = workflows
                .iter()
                .filter(|w| w.run_id == run.id)
                .map(|w| Workflow {
                    id: &w.id,
                    name: &w.name,
                    state: circleci_state(&w.phase, &w.outcome, &w.current_outcome),
                })
                .collect();
            let page = workflows
                .iter()
                .find(|w| w.state == RunState::Failure)
                .or(workflows.first());
            let names: Vec<&str> = workflows.iter().map(|w| w.name).collect();
            let branch = if run.branch.is_empty() {
                run.tag
            } else {
                run.branch
            };
            CiRun {
                title: run
                    .commit
                    .map(|c| c.subject)
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(|| branch.clone()),
                workflow: names.join(", "),
                branch,
                sha: run.revision.chars().take(7).collect(),
                event: String::new(),
                state: circleci_state(&run.phase, &run.outcome, &run.current_outcome),
                created_at: circleci_time(&run.created_at),
                url: page.and_then(|w| circleci_workflow_url(w.id)),
                rerun_ids: circleci_rerun_ids(&workflows, false),
                rerun_failed_ids: circleci_rerun_ids(&workflows, true),
                failure_log_command: Provider::Circleci.failure_log_line(&run.id),
                id: run.id,
            }
        })
        .collect())
}

fn parse_github_jobs(stdout: &str) -> Result<Vec<CiJob>, serde_json::Error> {
    Ok(serde_json::from_str::<GhJobs>(stdout.trim())?
        .jobs
        .into_iter()
        .map(|j| CiJob {
            id: j.database_id.to_string(),
            state: RunState::of_github(&j.status, &j.conclusion),
            name: j.name,
            group: String::new(),
            url: Some(j.url).filter(|u| !u.is_empty()),
        })
        .collect())
}

fn parse_circleci_jobs(stdout: &str) -> Result<Vec<CiJob>, serde_json::Error> {
    let run: CcRun = serde_json::from_str(stdout.trim())?;
    Ok(run
        .workflows
        .into_iter()
        .flat_map(|w| {
            let url = circleci_workflow_url(&w.id);
            let group = w.name;
            w.jobs.into_iter().map(move |j| CiJob {
                state: circleci_state(&j.phase, &j.outcome, &j.current_outcome),
                id: j.id,
                name: j.name,
                group: group.clone(),
                url: url.clone(),
            })
        })
        .collect())
}

/// 失敗の理由（実行した行つき）。**`circleci` は理由を JSON で stderr に出す**ので、読めたら
/// その `message` を使う（1 行目を取ると `{` だけになる）。それ以外は `issues` の `failure` と
/// 同じで、stderr、stdout、終了コードの順に見る。
fn failure(provider: Provider, line: &str, code: i32, stdout: &str, stderr: &str) -> String {
    let msg = serde_json::from_str::<CcError>(stderr.trim())
        .ok()
        .map(|e| e.message)
        .filter(|m| !m.is_empty())
        .or_else(|| first_line(stderr))
        .or_else(|| first_line(stdout))
        .unwrap_or_else(|| format!("{} exited with code {code}", provider.bin()));
    format!("{msg}\n{line}")
}

/// **run が 1 件も無いのを失敗にしない。** `circleci run list` は、run の無いプロジェクトや
/// ブランチで空の配列ではなく `run.not_found`（終了コード 5）を返す。エラー帯に出すと、
/// まだ CI が走っていないだけのブランチが壊れて見える。
fn is_no_runs(provider: Provider, stderr: &str) -> bool {
    provider == Provider::Circleci
        && serde_json::from_str::<CcError>(stderr.trim()).is_ok_and(|e| e.code == "run.not_found")
}

/// CLI の行を走らせて stdout を返す。非 0 は `failure` の文面で `Err` にする。
fn run_cli(
    provider: Provider,
    shell: &ShellConfig,
    root: &str,
    line: &str,
    timeout: Duration,
) -> Result<String, String> {
    let (code, stdout, stderr) = shell
        .run_shell_line(root, line, timeout)
        .map_err(|e| format!("{e}\n{line}"))?;
    if code != 0 {
        return Err(failure(provider, line, code, &stdout, &stderr));
    }
    Ok(stdout)
}

/// リポジトリがどの CI の設定を持つか。
#[derive(Debug, Clone, Copy, Serialize)]
pub struct CiConfigs {
    /// `.github/workflows/` がある。
    pub github: bool,
    /// `.circleci/` がある。
    pub circleci: bool,
}

/// CI の設定があるかを、ディレクトリの有無で見る（#457）。**パネルを出すかどうかの前提**で、
/// 設定の無いリポジトリに空の一覧しか出ないアイコンを並べない。CircleCI では `circleci` を
/// 探しに行くかどうかの門番でもある（`ci_circleci_available`）。
///
/// **2 つを 1 往復で見る**（WSL では `wsl.exe` の起動 1 回）。中身は読まない: ワークフローが
/// 1 本も無い `.github/workflows/` は空の一覧になるだけで、YAML を数えるほどの害が無い。
///
/// **WSL で `fs::dirs_exist` を使わない。** あちらは distro が応答しないとき「在る」に倒す
/// （プロジェクトの一覧を「全部見つからない」にしないため）。ここでそれを受けると、フロントが
/// 偽の「両方在る」を覚えて、設定の無いリポジトリで `circleci` を探しに行く。答えられなかった
/// ときは `Err` を返し、フロントは何も覚えない。
#[tauri::command]
pub async fn ci_configs(shell: ShellConfig, root: String) -> Result<CiConfigs, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !matches!(shell, ShellConfig::Wsl { .. }) {
            // ホストのファイルは直に見る。区切りは `/` で足りる（Windows の `std::fs` は
            // 混ざっていても読める）。
            let is_dir = |rel: &str| std::path::Path::new(&format!("{root}/{rel}")).is_dir();
            return Ok(CiConfigs {
                github: is_dir(".github/workflows"),
                circleci: is_dir(".circleci"),
            });
        }
        // 最後の `ok` が「シェルが最後まで走った」印。無ければ答えを信用しない。
        const LINE: &str = "[ -d .github/workflows ] && echo github; \
                            [ -d .circleci ] && echo circleci; echo ok";
        let (_, stdout, _) = shell.run_shell_line(&root, LINE, CONFIGS_TIMEOUT)?;
        let has = |word: &str| stdout.lines().any(|l| l.trim() == word);
        if !has("ok") {
            return Err("could not inspect the project directory".to_owned());
        }
        Ok(CiConfigs {
            github: has("github"),
            circleci: has("circleci"),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// `circleci` が使えるか。覚え方は `issues_gh_available` と同じ（「見つかった」だけを覚え、
/// 同じ導入単位の probe は 1 本に畳む）。
///
/// **フロントは `.circleci/config.yml` があるプロジェクトでしか呼ばない**（検出のためだけに
/// 起動時へ `wsl.exe` を足さない、の例外にしてよい範囲を CircleCI を使うリポジトリに絞る）。
#[tauri::command]
pub async fn ci_circleci_available(
    shell: ShellConfig,
    root: String,
    force: bool,
    state: State<'_, CiState>,
) -> Result<bool, String> {
    let entry = state.circleci.entry(install_key(&shell));
    tauri::async_runtime::spawn_blocking(move || {
        entry.found(force, || shell.has_command(&root, "circleci"))
    })
    .await
    .map_err(|e| e.to_string())
}

/// run の一覧を新しい順に取る。**CLI はプロジェクトのシェルで、root を cwd にして走らせる**
/// （どのリポジトリかは CLI が origin から決める。`issues_list` と同じ）。
///
/// `branch` を渡すとそのブランチの run だけにする。**絞り込みは CLI に任せる**: 取ってから
/// 絞ると、`limit` の窓がほかのブランチの run で埋まって、目当てのブランチが 1 件も残らない。
///
/// 失敗は `Err` ではなく `CiListResult.error` に載せる（0 件と区別するため。`issues_list` と同じ）。
#[tauri::command]
pub async fn ci_list(
    shell: ShellConfig,
    root: String,
    provider: Provider,
    limit: u32,
    branch: Option<String>,
) -> Result<CiListResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let failed = |error: String| CiListResult {
            runs: Vec::new(),
            error: Some(error),
        };
        // ブランチ名は外から来る値なので、シェルごとの引用に通す（Windows のシェルで `%` や
        // `"` を含む名前は断られる）。
        let branch = match branch.as_deref().map(|b| shell.line_arg(b)).transpose() {
            Ok(b) => b,
            Err(e) => return failed(e),
        };
        let line = provider.list_line(limit.clamp(1, 100), branch.as_deref());
        let (code, stdout, stderr) = match shell.run_shell_line(&root, &line, LIST_TIMEOUT) {
            Ok(v) => v,
            Err(e) => return failed(format!("{e}\n{line}")),
        };
        if code != 0 {
            if is_no_runs(provider, &stderr) {
                return CiListResult {
                    runs: Vec::new(),
                    error: None,
                };
            }
            // CircleCI は 2 本を `&&` でつないでいるので、非 0 でも 1 本目（run）は取れて
            // いることがある。取れていればそれを出す（`parse_circleci_runs` の doc）。
            if provider == Provider::Circleci
                && let Ok(runs) = parse_circleci_runs(&stdout)
                && !runs.is_empty()
            {
                return CiListResult { runs, error: None };
            }
            return failed(failure(provider, &line, code, &stdout, &stderr));
        }
        match provider.parse_runs(&stdout) {
            Ok(runs) => CiListResult { runs, error: None },
            Err(e) => failed(format!(
                "failed to parse {} output: {e}\n{line}",
                provider.bin()
            )),
        }
    })
    .await
    .map_err(|e| e.to_string())
}

fn invalid_id(id: &str) -> String {
    format!("unsupported CI run id: {id}")
}

/// 1 件の run の job を取る（行を開いたとき）。失敗は `Err`（`issues_view` と同じで、
/// 中身が無ければ何も出せないので、空と区別する必要が無い）。
#[tauri::command]
pub async fn ci_jobs(
    shell: ShellConfig,
    root: String,
    provider: Provider,
    id: String,
) -> Result<Vec<CiJob>, String> {
    if !provider.valid_id(&id) {
        return Err(invalid_id(&id));
    }
    let line = provider.jobs_line(&id);
    tauri::async_runtime::spawn_blocking(move || {
        let stdout = run_cli(provider, &shell, &root, &line, LIST_TIMEOUT)?;
        provider
            .parse_jobs(&stdout)
            .map_err(|e| format!("failed to parse {} output: {e}\n{line}", provider.bin()))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 再実行と中止。**確認はフロントが済ませてから呼ぶ。** Pike のバックエンドで走らせるのは
/// `issues_act` と同じ（どの操作も引数だけで決まり、CLI は端末に何も聞かない）。
///
/// `ids` が複数になるのは CircleCI の再実行だけ（run が束ねるワークフローを 1 本ずつ）。
/// **`&&` でつなぐ**ので、途中で断られたら残りは走らない。
///
/// **対象のリポジトリは CLI が cwd から決める**（`issues_act` は URL で名指しするが、こちらは
/// しない）。id がサービス全体で一意なので、一覧と別のリポジトリに解決されても、同じ番号の
/// 別物に当たることは無い（見つからずに失敗するだけ）。
#[tauri::command]
pub async fn ci_act(
    shell: ShellConfig,
    root: String,
    provider: Provider,
    action: CiAction,
    ids: Vec<String>,
) -> Result<(), String> {
    if ids.is_empty() {
        return Err(invalid_id(""));
    }
    if let Some(bad) = ids.iter().find(|id| !provider.valid_id(id)) {
        return Err(invalid_id(bad));
    }
    let line = ids
        .iter()
        .map(|id| action.line(provider, id))
        .collect::<Vec<_>>()
        .join(" && ");
    tauri::async_runtime::spawn_blocking(move || {
        run_cli(provider, &shell, &root, &line, ACTION_TIMEOUT).map(|_| ())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_gh_run_list() {
        let json = r#"[
          {"conclusion":"success","createdAt":"2026-10-07T17:03:08Z","databaseId":37655983603,
           "displayTitle":"CI","event":"push","headBranch":"main",
           "headSha":"eb0d7a5805828fe4ff3b932dd2d4a0960f5e0ed8","status":"completed",
           "url":"https://github.com/kan/pike/actions/runs/37655983603","workflowName":"CI"},
          {"conclusion":"","createdAt":"2026-10-07T17:00:00Z","databaseId":2,
           "displayTitle":"t","event":"pull_request","headBranch":"b","headSha":"abc",
           "status":"in_progress","url":"","workflowName":"Release"}
        ]"#;
        let runs = parse_github_runs(json).unwrap();
        assert_eq!(runs[0].id, "37655983603");
        assert_eq!(runs[0].sha, "eb0d7a5");
        assert_eq!(runs[0].state, RunState::Success);
        assert_eq!(
            runs[0].url.as_deref(),
            Some("https://github.com/kan/pike/actions/runs/37655983603")
        );
        assert_eq!(runs[1].state, RunState::Running);
        assert_eq!(runs[1].url, None);
    }

    /// 終わっていないものは `conclusion` に関わらず実行中。知らない結果は失敗に倒す。
    #[test]
    fn maps_github_states() {
        assert_eq!(RunState::of_github("queued", ""), RunState::Running);
        assert_eq!(
            RunState::of_github("completed", "cancelled"),
            RunState::Cancelled
        );
        assert_eq!(
            RunState::of_github("completed", "skipped"),
            RunState::Skipped
        );
        assert_eq!(
            RunState::of_github("completed", "timed_out"),
            RunState::Failure
        );
    }

    #[test]
    fn maps_circleci_states() {
        assert_eq!(RunState::of_circleci("running", None), RunState::Running);
        assert_eq!(
            RunState::of_circleci("running", Some("failed")),
            RunState::Running
        );
        assert_eq!(
            RunState::of_circleci("ended", Some("succeeded")),
            RunState::Success
        );
        assert_eq!(
            RunState::of_circleci("ended", Some("canceled")),
            RunState::Cancelled
        );
        assert_eq!(
            RunState::of_circleci("ended", Some("failed")),
            RunState::Failure
        );
        assert_eq!(RunState::of_circleci("ended", None), RunState::Failure);
    }

    /// `run list` と `workflow list` の出力が続けて来る。ワークフローは `run_id` で run に付け、
    /// 開くページは落ちたワークフローを優先する。
    #[test]
    fn joins_circleci_runs_with_their_workflows() {
        let stdout = r#"[{"id":"887102d3-ddf3-4eec-b8f5-a1f896e4505b","phase":"ended",
            "current_outcome":"failed","branch":"develop","revision":"0e9e2a1",
            "commit":{"subject":"Merged in docs","author_name":"x"},
            "created_at":"2026-10-07 08:42 UTC"},
           {"id":"3617f06d-1095-4e7f-8e24-80fb3f12e16c","phase":"running","tag":"v1",
            "revision":"ee6f5c0","created_at":"2026-10-07 08:06 UTC"}]
          [{"run_id":"887102d3-ddf3-4eec-b8f5-a1f896e4505b","id":"aaaaaaaa-0000-0000-0000-000000000001",
            "name":"build","phase":"ended","outcome":"succeeded"},
           {"run_id":"887102d3-ddf3-4eec-b8f5-a1f896e4505b","id":"aaaaaaaa-0000-0000-0000-000000000002",
            "name":"test","phase":"ended","outcome":"failed"}]
        "#;
        let runs = parse_circleci_runs(stdout).unwrap();
        assert_eq!(runs.len(), 2);
        assert_eq!(runs[0].title, "Merged in docs");
        assert_eq!(runs[0].workflow, "build, test");
        assert_eq!(runs[0].state, RunState::Failure);
        assert_eq!(runs[0].created_at, "2026-10-07T08:42:00Z");
        assert_eq!(
            runs[0].url.as_deref(),
            Some(
                "https://app.circleci.com/pipelines/workflows/aaaaaaaa-0000-0000-0000-000000000002"
            )
        );
        // 再実行はワークフロー単位。失敗したものだけなら、落ちた test だけが対象になる。
        assert_eq!(runs[0].rerun_ids.len(), 2);
        assert_eq!(
            runs[0].rerun_failed_ids,
            vec!["aaaaaaaa-0000-0000-0000-000000000002"]
        );
        assert_eq!(
            runs[0].failure_log_command,
            "circleci run get 887102d3-ddf3-4eec-b8f5-a1f896e4505b --failure-report"
        );
        // コミットの題が無ければブランチ（タグの run はタグ）を題にする。ワークフローが
        // まだ無い run は開くページを持たない。
        assert_eq!(runs[1].title, "v1");
        assert_eq!(runs[1].branch, "v1");
        assert_eq!(runs[1].state, RunState::Running);
        assert_eq!(runs[1].url, None);

        // `workflow list` だけが失敗して 2 つ目が無くても、run は返す。
        let only_runs = r#"[{"id":"887102d3-ddf3-4eec-b8f5-a1f896e4505b","phase":"running"}]"#;
        let runs = parse_circleci_runs(only_runs).unwrap();
        assert_eq!(runs.len(), 1);
        assert!(runs[0].rerun_ids.is_empty());
    }

    /// 再実行で増えた同名のワークフローは 1 本にまとめる。その名前が 1 本でも成功していれば、
    /// 失敗したものだけの再実行の対象から外す。
    #[test]
    fn dedupes_rerun_targets_by_workflow_name() {
        let wf = |id, name, state| Workflow { id, name, state };
        let workflows = [
            wf("t2", "test", RunState::Success),
            wf("t1", "test", RunState::Failure),
            wf("d2", "deploy", RunState::Failure),
            wf("d1", "deploy", RunState::Failure),
            wf("b1", "build", RunState::Running),
        ];
        assert_eq!(
            circleci_rerun_ids(&workflows, false),
            vec!["t2", "d2", "b1"]
        );
        assert_eq!(circleci_rerun_ids(&workflows, true), vec!["d2"]);
    }

    #[test]
    fn normalizes_circleci_time() {
        assert_eq!(
            circleci_time("2026-10-07 08:42 UTC"),
            "2026-10-07T08:42:00Z"
        );
        assert_eq!(
            circleci_time("2026-10-07 08:42:21 UTC"),
            "2026-10-07T08:42:21Z"
        );
        assert_eq!(
            circleci_time("2026-10-07T08:42:21Z"),
            "2026-10-07T08:42:21Z"
        );
    }

    #[test]
    fn parses_jobs_of_both_providers() {
        let gh = r#"{"jobs":[{"conclusion":"failure","databaseId":112910728951,
            "name":"Check & Test","status":"completed","steps":[],
            "url":"https://github.com/kan/pike/actions/runs/1/job/112910728951"}]}"#;
        let jobs = parse_github_jobs(gh).unwrap();
        assert_eq!(jobs[0].id, "112910728951");
        assert_eq!(jobs[0].state, RunState::Failure);
        assert_eq!(jobs[0].group, "");

        let cc = r#"{"id":"887102d3-ddf3-4eec-b8f5-a1f896e4505b","phase":"ended",
            "workflows":[{"id":"7aae9ac8-a638-450b-a068-8a0ef5e35ae3","name":"test",
              "phase":"ended","outcome":"succeeded","duration":"5m50s",
              "jobs":[{"id":"971d8fd6-5905-4f8a-a2c0-3d64d8d906b4","name":"app",
                       "phase":"ended","outcome":"succeeded","type":"build"}]}]}"#;
        let jobs = parse_circleci_jobs(cc).unwrap();
        assert_eq!(jobs[0].name, "app");
        assert_eq!(jobs[0].group, "test");
        assert_eq!(jobs[0].state, RunState::Success);
        assert_eq!(
            jobs[0].url.as_deref(),
            Some(
                "https://app.circleci.com/pipelines/workflows/7aae9ac8-a638-450b-a068-8a0ef5e35ae3"
            )
        );
    }

    /// 通すのは CLI が返す形の id だけ。シェルに意味のある文字はどの位置でも断る。
    #[test]
    fn validates_ids_per_provider() {
        assert!(Provider::Github.valid_id("37655983603"));
        assert!(Provider::Circleci.valid_id("887102d3-ddf3-4eec-b8f5-a1f896e4505b"));
        for bad in ["", "12;rm", "12 3", "$(x)", "887102d3-ddf3"] {
            assert!(!Provider::Github.valid_id(bad), "{bad}");
        }
        for bad in [
            "",
            "887102d3;rm",
            "$(x)",
            "--force",
            "-f",
            "887102d3-ddf3",
            "887102d3-ddf3-4eec-b8f5-a1f896e4505z",
            "887102d3addf3-4eec-b8f5-a1f896e4505b",
        ] {
            assert!(!Provider::Circleci.valid_id(bad), "{bad}");
        }
    }

    #[test]
    fn builds_list_and_action_lines() {
        assert!(
            Provider::Github
                .list_line(30, Some("main"))
                .starts_with("gh run list --limit 30 --branch main --json ")
        );
        assert_eq!(
            Provider::Circleci.list_line(30, None),
            "circleci run list --json --limit 30 && circleci workflow list --json --limit 30"
        );
        let rerun = |failed_only| CiAction::Rerun { failed_only };
        assert_eq!(
            rerun(true).line(Provider::Github, "12"),
            "gh run rerun 12 --failed"
        );
        assert_eq!(
            CiAction::Cancel.line(Provider::Github, "12"),
            "gh run cancel 12"
        );
        assert_eq!(
            rerun(false).line(Provider::Circleci, "ab-1"),
            "circleci workflow rerun ab-1"
        );
        assert_eq!(
            rerun(true).line(Provider::Circleci, "ab-1"),
            "circleci workflow rerun ab-1 --from-failed"
        );
        assert_eq!(
            CiAction::Cancel.line(Provider::Circleci, "ab-1"),
            "circleci run cancel ab-1 --force"
        );
    }

    /// フロントが送る形（`types/ci.ts` の `CiAction`）をそのまま読めること。
    #[test]
    fn deserializes_actions_from_the_frontend() {
        let action: CiAction =
            serde_json::from_str(r#"{"type":"rerun","failedOnly":true}"#).unwrap();
        assert_eq!(
            action.line(Provider::Github, "1"),
            "gh run rerun 1 --failed"
        );
        let action: CiAction = serde_json::from_str(r#"{"type":"cancel"}"#).unwrap();
        assert_eq!(action.line(Provider::Github, "1"), "gh run cancel 1");
    }

    /// `circleci` の失敗は stderr の JSON から理由を拾う。run が無いだけなら失敗にしない。
    #[test]
    fn reads_circleci_error_json() {
        let stderr = r#"{
          "error": true,
          "code": "run.not_found",
          "message": "No run found for \"gh/comlinks/quick\".",
          "exit_code": 5
        }"#;
        assert!(is_no_runs(Provider::Circleci, stderr));
        assert!(!is_no_runs(Provider::Github, stderr));
        assert!(!is_no_runs(Provider::Circleci, "not logged in"));
        assert_eq!(
            failure(Provider::Circleci, "circleci x", 5, "", stderr),
            "No run found for \"gh/comlinks/quick\".\ncircleci x"
        );
        assert_eq!(
            failure(Provider::Github, "gh x", 1, "", "  \nerr line\n"),
            "err line\ngh x"
        );
        assert_eq!(
            failure(Provider::Github, "gh x", 4, "", ""),
            "gh exited with code 4\ngh x"
        );
    }
}
