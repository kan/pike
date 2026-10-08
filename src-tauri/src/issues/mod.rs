//! GitHub issue の一覧（#278）と PR の一覧（#413）。
//!
//! **認証は `gh` に丸ごと任せる。** `api.github.com` を直接叩くと CSP の緩和とトークンの
//! 保管が要るが、`gh` なら手元の認証をそのまま使えて、Pike はトークンに触らずに済む。
//!
//! 形は `diagnostics` と同じで、**検出したツールを要求時に 1 回だけ走らせて構造化出力を
//! 正規化する**。常駐もポーリングもしない（外部プロセスの起動を定期実行に混ぜない）。

use crate::cache::ProbeRegistry;
use crate::types::{first_line, install_key, ShellConfig};
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tauri::State;

/// `gh` の一覧取得は実測で約 1 秒（`gh --version` は 0.14 秒）。ネットワークを伴うので
/// 既定の 30 秒より短くするが、遅い回線でも 1 回は諦めない程度に取ってある。
const LIST_TIMEOUT: Duration = Duration::from_secs(20);

/// マージとクローズ（#450）の時間切れ。**一覧より長く取る**: 切れた時点で GitHub の側では
/// 済んでいることがあり、そのとき出るのは「失敗した」という嘘になる。
const ACTION_TIMEOUT: Duration = Duration::from_secs(60);

/// **`gh` が見つかったシェルをプロセス単位で覚える**（`SearchState.detected` と同じ形）。
/// Pinia のストアはウィンドウごとなので、フロントだけで覚えると同じリポジトリを N 枚
/// 開いたときに `gh --version` が N 回走る。WSL ではそれが `wsl.exe` の起動 N 回になる。
///
/// キーが**シェルの導入単位**なのは、WSL プロジェクトが見るのは distro の中の `gh`、
/// Windows プロジェクトが見るのはホストのそれ、と答えが変わるため。**真になるのは
/// 「見つかった」ときだけ**（理由は `issues_gh_available`）。
///
/// **`shell_probe.rs` には畳んでいない**（#275 の宿題 3）。あちらがまとめているのは
/// 対話ログインシェルを起こす問いで、費用は rc の評価にある。`gh --version` は
/// `run_shell_line`（非対話・PATH を前置するだけ）なので、同じ起動に相乗りする理由が無い。
///
/// **入れ物だけは共有する**（#315 で `cache::ProbeRegistry` に上げた）。1 本の `Mutex` を
/// probe 中も握っていたころは、冷えた distro の `gh` を待つあいだ**別の導入単位の
/// 問い合わせも止まっていた**（最長で `has_command` の時間切れまで）。キーごとに分ければ、その待ちは
/// 同じ distro を見に来た者だけのものになる。
#[derive(Default)]
pub struct IssuesState {
    gh: ProbeRegistry<String, bool>,
}

/// GitHub のラベル。**gh の JSON をそのまま受ける**ので `Deserialize` も持つ
/// （同じ形の内部用構造体を並べて 1 対 1 で写す層を作らない）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueLabel {
    #[serde(default)]
    pub name: String,
    /// GitHub のラベル色（`a2eeef` のような 6 桁 hex、`#` なし）。
    #[serde(default)]
    pub color: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueSummary {
    pub number: u64,
    pub title: String,
    pub url: String,
    pub author: String,
    pub updated_at: String,
    pub labels: Vec<IssueLabel>,
    /// 親 issue の番号（sub-issue のとき）。**番号だけ返す**: 木を組むのは取ってきた
    /// 一覧の中だけで、そこに居ない親は子をトップレベルに出すので、題名も URL も要らない。
    pub parent: Option<u64>,
    /// ドラフトの PR か（#413）。issue では常に false。
    pub draft: bool,
    /// PR の CI の状態（#413）。issue と、チェックが 1 つも無い PR は `None`。
    pub checks: Option<CheckState>,
}

/// PR のチェックを 1 つにまとめた状態（#413）。**行に出すのはアイコン 1 つ**なので、
/// どのジョブが落ちたかは運ばない（GitHub のページで見る）。
///
/// **並びが優先順位**（`summarize_checks` が `max` を取る）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CheckState {
    Success,
    Pending,
    Failure,
}

/// 一覧の種類（#413）。**PR も同じ器で運ぶ**: パネルに出す列（番号・題名・作者・更新・
/// ラベル）は issue と同じで、違うのは `gh` のサブコマンドと、片方にしか無いフィールド
/// （issue の `parent`、PR の `isDraft`）だけ。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ListKind {
    Issue,
    Pr,
}

/// PR のマージの方式（#450）。`gh pr merge` のフラグと 1 対 1。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MergeMethod {
    Merge,
    Squash,
    Rebase,
}

impl MergeMethod {
    fn flag(self) -> &'static str {
        match self {
            MergeMethod::Merge => "--merge",
            MergeMethod::Squash => "--squash",
            MergeMethod::Rebase => "--rebase",
        }
    }
}

/// issue をクローズする理由（#450）。GitHub の「完了」と「対応しない」。
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CloseReason {
    Completed,
    NotPlanned,
}

/// 一覧の行に対して実行する、状態を変える操作（#450）。
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum IssueAction {
    Merge {
        method: MergeMethod,
        /// `--delete-branch`。**リモートだけでなく手元のブランチも消える**（checkout 中なら
        /// 既定ブランチへ切り替わる）ので、既定では渡さず、確認ダイアログで選ばせる。
        #[serde(rename = "deleteBranch")]
        delete_branch: bool,
    },
    ClosePr,
    CloseIssue {
        reason: CloseReason,
    },
}

impl IssueAction {
    /// この操作が対象にする種類。URL の種類と合わないもの（issue をマージ、など）を断るのに使う。
    fn kind(self) -> ListKind {
        match self {
            IssueAction::Merge { .. } | IssueAction::ClosePr => ListKind::Pr,
            IssueAction::CloseIssue { .. } => ListKind::Issue,
        }
    }

    /// 実行する行。`url` は `parse_target` を通したものだけを渡すこと（行にそのまま埋まる）。
    ///
    /// **方式は必ず引数で渡す。** 無いと `gh pr merge` は端末に方式を聞きに行き、Pike の
    /// バックエンドは入力を返せない。
    fn line(self, url: &str) -> String {
        match self {
            IssueAction::Merge {
                method,
                delete_branch,
            } => {
                let delete = if delete_branch {
                    " --delete-branch"
                } else {
                    ""
                };
                format!("gh pr merge {url} {}{delete}", method.flag())
            }
            IssueAction::ClosePr => format!("gh pr close {url}"),
            // 二重引用符は bash でも `cmd /C` でも 1 つの引数になる。
            IssueAction::CloseIssue { reason } => {
                let reason = match reason {
                    CloseReason::Completed => "completed",
                    CloseReason::NotPlanned => "\"not planned\"",
                };
                format!("gh issue close {url} --reason {reason}")
            }
        }
    }
}

/// 一覧が返した issue / PR の URL を検証して、リポジトリの URL と種類に分ける（#450）。
///
/// **状態を変える操作は、番号ではなく URL を `gh` に渡す。** 番号だけだと対象のリポジトリは
/// `gh` が cwd から決めるので、fork（`upstream` を既定に解決することがある）では一覧に出て
/// いたものと別のリポジトリの同じ番号に当たりうる。URL なら一覧に出ていたそのものを指す。
///
/// **形を決め打ちで検証し、引用はしない。** 通すのは `https://<host>/<owner>/<repo>/
/// (pull|issues)/<数字>` で、各部分は英数字と `-` `_` `.` だけ。この文字集合は bash でも
/// `cmd /C` でもそのまま 1 つの引数になるので、シェルごとの引用（`ShellConfig::line_arg`）に
/// 頼らずに済む。
fn parse_target(url: &str) -> Option<(&str, ListKind)> {
    // 後ろから 2 つ切り出すと、残りがリポジトリの URL。
    let mut tail = url.rsplitn(3, '/');
    let (number, segment, repo_url) = (tail.next()?, tail.next()?, tail.next()?);
    if number.is_empty() || !number.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let kind = match segment {
        "pull" => ListKind::Pr,
        "issues" => ListKind::Issue,
        _ => return None,
    };
    // host / owner / repo のちょうど 3 つ。
    let parts: Vec<&str> = repo_url.strip_prefix("https://")?.split('/').collect();
    let safe = |s: &&str| {
        !s.is_empty()
            && s.chars()
                .all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c))
    };
    (parts.len() == 3 && parts.iter().all(safe)).then_some((repo_url, kind))
}

/// `gh repo view` が返す、リポジトリで許可されているマージの方式。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhMergeSettings {
    #[serde(default)]
    merge_commit_allowed: bool,
    #[serde(default)]
    squash_merge_allowed: bool,
    #[serde(default)]
    rebase_merge_allowed: bool,
}

impl GhMergeSettings {
    /// 許可されている方式。**並びは GitHub のマージボタンと同じ**（先頭が既定の候補になる）。
    fn methods(&self) -> Vec<MergeMethod> {
        [
            (self.merge_commit_allowed, MergeMethod::Merge),
            (self.squash_merge_allowed, MergeMethod::Squash),
            (self.rebase_merge_allowed, MergeMethod::Rebase),
        ]
        .into_iter()
        .filter_map(|(allowed, method)| allowed.then_some(method))
        .collect()
    }
}

impl ListKind {
    /// 実行する行。**フィールドは種類ごとに要求する**（`gh pr list` は `parent` を、
    /// `gh issue list` は `isDraft` を知らず、渡すとエラーで落ちる）。
    fn list_line(self, limit: u32) -> String {
        match self {
            ListKind::Issue => format!(
                "gh issue list --state open --limit {limit} \
                 --json number,title,url,author,updatedAt,labels,parent"
            ),
            ListKind::Pr => format!(
                "gh pr list --state open --limit {limit} \
                 --json number,title,url,author,updatedAt,labels,isDraft,statusCheckRollup"
            ),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueListResult {
    pub issues: Vec<IssueSummary>,
    /// **未インストール・未認証・権限なしを「0 件」に見せないための理由**
    /// （`ProviderRun.error` と同じ考え方）。どれも一覧が空になるので、空と区別が付かない。
    /// **実行した行も畳んである**: 読むのは失敗したときだけなので、成功時も返る別の
    /// フィールドにすると、IPC が落ちた経路（フロントの catch）だけ古い行が残る。
    pub error: Option<String>,
}

/// 1 件の issue（タブで読む用、#278）。**書き込みは持たない**ので、編集に要る情報
/// （id やリアクション）は取らない。
///
/// **`gh` の JSON をそのまま受ける**（`IssueLabel` / `IssueComment` と同じ）。同じ形の
/// 内部用構造体を並べて 1 対 1 で写す層は作らない ―― `IssueSummary` が `From` を持つのは
/// `parent` のネストを畳むためで、こちらにはその必要が無い。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueDetail {
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub url: String,
    /// `OPEN` / `CLOSED`。一覧は open だけを取るので開いた時点では常に `OPEN` だが、
    /// **開いたままのタブを更新すると閉じた状態に転じうる**ので出す。
    #[serde(default)]
    pub state: String,
    #[serde(default, deserialize_with = "login_of")]
    pub author: String,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub labels: Vec<IssueLabel>,
    #[serde(default)]
    pub comments: Vec<IssueComment>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueComment {
    #[serde(default, deserialize_with = "login_of")]
    pub author: String,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub url: String,
}

/// `gh` の JSON。**使うフィールドだけ拾う**（`author` の `id` など、要求していないキーも
/// 返るので serde の既定＝未知のキーは無視、に乗る）。
#[derive(Deserialize)]
struct GhAuthor {
    #[serde(default)]
    login: String,
}

/// `{"login": …}` を文字列に畳む。消えたアカウントは `null` で来るので空にする。
fn login_of<'de, D: serde::Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    Ok(Option::<GhAuthor>::deserialize(d)?
        .map(|a| a.login)
        .unwrap_or_default())
}

/// `parent` は親 issue の全体（題名・状態・URL つき）で返るが、使うのは番号だけ。
#[derive(Deserialize)]
struct GhParent {
    number: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhIssue {
    number: u64,
    #[serde(default)]
    title: String,
    #[serde(default)]
    url: String,
    /// 消えたアカウントの issue は null で返る。
    #[serde(default)]
    author: Option<GhAuthor>,
    #[serde(default)]
    updated_at: String,
    #[serde(default)]
    labels: Vec<IssueLabel>,
    #[serde(default)]
    parent: Option<GhParent>,
    #[serde(default)]
    is_draft: bool,
    /// PR のチェック（#413）。issue では要求しないので来ない。`null` でも落とさないよう
    /// `Option` で受ける。
    #[serde(default)]
    status_check_rollup: Option<Vec<GhCheck>>,
}

/// `statusCheckRollup` の 1 件。**2 つの形が混ざって来る**: GitHub Actions などの
/// `CheckRun` は `status`（`COMPLETED` / `IN_PROGRESS` …）と `conclusion`（`SUCCESS` /
/// `FAILURE` …）、外部 CI が使う古い Status API の `StatusContext` は `state`（`SUCCESS` /
/// `PENDING` / `FAILURE` / `ERROR`）だけを持つ。
#[derive(Deserialize)]
struct GhCheck {
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    conclusion: Option<String>,
    #[serde(default)]
    state: Option<String>,
}

impl GhCheck {
    fn state(&self) -> CheckState {
        // `StatusContext` は `state` だけで決まる。
        if let Some(state) = &self.state {
            return match state.as_str() {
                "SUCCESS" => CheckState::Success,
                "FAILURE" | "ERROR" => CheckState::Failure,
                _ => CheckState::Pending,
            };
        }
        if self.status.as_deref() != Some("COMPLETED") {
            return CheckState::Pending;
        }
        // 見送られたもの（`NEUTRAL` / `SKIPPED`）は落ちていないので成功に寄せる
        // （GitHub の PR 一覧の ✓ と同じ扱い）。
        match self.conclusion.as_deref() {
            Some("SUCCESS" | "NEUTRAL" | "SKIPPED") => CheckState::Success,
            _ => CheckState::Failure,
        }
    }
}

/// チェックを 1 つにまとめる。**1 つでも落ちていれば失敗、次に 1 つでも走っていれば実行中**
/// （走っているあいだに落ちたものがあれば、それを先に知らせる）。空なら `None`。
fn summarize_checks(checks: &[GhCheck]) -> Option<CheckState> {
    checks.iter().map(GhCheck::state).max()
}

impl From<GhIssue> for IssueSummary {
    fn from(g: GhIssue) -> Self {
        IssueSummary {
            number: g.number,
            title: g.title,
            url: g.url,
            author: g.author.map(|a| a.login).unwrap_or_default(),
            updated_at: g.updated_at,
            labels: g.labels,
            parent: g.parent.map(|p| p.number),
            draft: g.is_draft,
            checks: summarize_checks(g.status_check_rollup.as_deref().unwrap_or_default()),
        }
    }
}

/// `gh` の JSON を一覧へ。**番号の降順に並べるところまでがこの関数の仕事**（#357。GitHub が
/// 並べるのは `createdAt` なので番号と割れうる。理由は `issues_list` の doc）。切り出して
/// あるのは、呼び出し元とテスト 4 本が同じ 2 行を書き写さずに済み、順序を純粋な関数として
/// テストできるため。
fn parse_list(stdout: &str) -> Result<Vec<IssueSummary>, serde_json::Error> {
    let mut issues: Vec<IssueSummary> = serde_json::from_str::<Vec<GhIssue>>(stdout.trim())?
        .into_iter()
        .map(IssueSummary::from)
        .collect();
    issues.sort_unstable_by_key(|i| std::cmp::Reverse(i.number));
    Ok(issues)
}

/// 失敗の理由。**stderr を優先し、空なら stdout を見る**（`gh` は認証エラーを stderr に
/// 出すが、シェル側の失敗は stdout に出ることがある）。どちらも空なら終了コードだけを言う。
/// 実行した行を添えるのは、何が走ったか読めるようにするため。
fn failure(line: &str, code: i32, stdout: &str, stderr: &str) -> String {
    let msg = first_line(stderr)
        .or_else(|| first_line(stdout))
        .unwrap_or_else(|| format!("gh exited with code {code}"));
    format!("{msg}\n{line}")
}

/// `gh` が使えるか。探し方（`--version` を一覧と同じ `run_shell_line` で走らせる）は
/// `ShellConfig::has_command`（`vue-preview` の検出と共有）。
///
/// ここでは認証までは見ない: `gh auth status` をもう 1 回起こすことになるうえ、認証が
/// 切れているかどうかは一覧の取得が返す `error` で分かる。ここで見たいのは
/// 「サイドバーにアイコンを出してよいか」だけ。
///
/// **覚えるのは「見つかった」だけ**（`force` は更新ボタンからの明示的なやり直し）。
/// 見つからなかったほうを焼き付けると、時間切れになった 1 回（WSL の冷えた起動で
/// 普通に起きる）でプロセスの寿命ぶんパネルが消え、**アイコンもパレットも出ないので
/// 更新ボタンに手が届かない**。覚え方と、同じ導入単位への問い合わせを 1 本に畳むのは
/// `cache::ProbeEntry::found`（`vue-preview` の検出と共有）。
#[tauri::command]
pub async fn issues_gh_available(
    shell: ShellConfig,
    root: String,
    force: bool,
    state: State<'_, IssuesState>,
) -> Result<bool, String> {
    let entry = state.gh.entry(install_key(&shell));
    tauri::async_runtime::spawn_blocking(move || {
        entry.found(force, || shell.has_command(&root, "gh"))
    })
    .await
    .map_err(|e| e.to_string())
}

/// 一覧を取る。**`gh` はプロジェクトのシェルで、プロジェクトの root を cwd にして走らせる**
/// （`--repo` を組み立てて渡す形にすると、origin の綴りを Pike 側でもう一度解釈することに
/// なる。どのリポジトリかを決めるのは `gh` に任せる）。
///
/// **並びは issue 番号の降順で固定する**（#357）。以前は `--search "sort:updated-desc"` で、
/// 誰かが触るたびに行が動いて追えなかった。
///
/// **並び替えの修飾子は渡さない。** `gh issue list` の既定が既に作成順の降順で、`--search`
/// の有無で同じ並び・同じ件数が返ることは実測済み。足すと `gh` が**検索 API** 側へ回り、
/// あちらはインデックス越しなので**作ったばかりの issue が更新ボタンを押しても出てこない**
/// ことがある（レート枠も別）。パネルのヘッダから issue を作れる以上、その遅れは払わない。
///
/// **それでも受け取った側で `parse_list` が番号に並べ直す。** GitHub が並べるのは
/// `createdAt` であって番号ではなく、他リポジトリから transfer した issue は `createdAt` を
/// 保ったまま新しい番号を受け取るので、両者は実際に割れる。**この関数が約束するのは番号の
/// 降順**なので、そこは戻り値の側で保証する。
///
/// **代償は、open が `limit` を超えるリポジトリで古い issue が窓から落ちること。**
/// `--limit` の絞り込みはサーバー側なので、`updated-desc` のころは「今まさに動いているもの」
/// が必ず窓に入っていた。作成順では番号の小さいものから順に外れ、パネルの絞り込み
/// （取得済みに対するクライアント側の処理）からも拾えなくなる。番号の降順という並びを
/// 選んだ以上、窓の軸もそちらへ揃うのが筋なので受け入れている。
///
/// **PR（#413）も同じコマンドで取る**（`kind`）。並び・件数・失敗の扱いは issue と同じ。
#[tauri::command]
pub async fn issues_list(
    shell: ShellConfig,
    root: String,
    limit: u32,
    kind: ListKind,
) -> Result<IssueListResult, String> {
    // 引数はすべてこちらが決めた定数か数値なので、シェルの行に埋めても注入の余地が無い。
    let line = kind.list_line(limit.clamp(1, 200));
    tauri::async_runtime::spawn_blocking(move || {
        let (code, stdout, stderr) = match shell.run_shell_line(&root, &line, LIST_TIMEOUT) {
            Ok(v) => v,
            Err(e) => {
                return IssueListResult {
                    issues: Vec::new(),
                    error: Some(format!("{e}\n{line}")),
                };
            }
        };
        if code != 0 {
            return IssueListResult {
                issues: Vec::new(),
                error: Some(failure(&line, code, &stdout, &stderr)),
            };
        }
        match parse_list(&stdout) {
            Ok(issues) => IssueListResult {
                issues,
                error: None,
            },
            // 終了コード 0 なのに読めない出力は、`gh` の版が違うか、シェルの初期化が
            // 何かを stdout に混ぜたとき。黙って 0 件にせず理由として出す。
            Err(e) => IssueListResult {
                issues: Vec::new(),
                error: Some(format!("failed to parse gh output: {e}\n{line}")),
            },
        }
    })
    .await
    .map_err(|e| e.to_string())
}

/// 1 件を読む（#278）。一覧と同じくプロジェクトのシェル・root で `gh` に任せる。
///
/// **番号は数値なので、シェルの行に埋めても注入の余地が無い。**
///
/// **失敗は `Err` で返す**（一覧の `IssueListResult.error` と意図的に違う形）。あちらは
/// 「0 件」と区別が付かないので理由を値に載せるが、タブは中身が無ければ何も出せないので、
/// 呼び出し側が空と区別する必要が無い。
#[tauri::command]
pub async fn issues_view(
    shell: ShellConfig,
    root: String,
    number: u64,
) -> Result<IssueDetail, String> {
    let line = format!(
        "gh issue view {number} \
         --json title,url,state,author,createdAt,body,labels,comments"
    );
    tauri::async_runtime::spawn_blocking(move || run_gh_json(&shell, &root, &line))
        .await
        .map_err(|e| e.to_string())?
}

/// `run_gh` の stdout を JSON として読む（読み取りの `--json` 用。時間切れは一覧と同じ）。
fn run_gh_json<T: serde::de::DeserializeOwned>(
    shell: &ShellConfig,
    root: &str,
    line: &str,
) -> Result<T, String> {
    let stdout = run_gh(shell, root, line, LIST_TIMEOUT)?;
    serde_json::from_str(stdout.trim())
        .map_err(|e| format!("failed to parse gh output: {e}\n{line}"))
}

/// `gh` の行を走らせて stdout を返す。**非 0 は `failure` の文面で `Err` にする**
/// （失敗を値に載せる一覧だけは、これを通さず自前で組む）。
fn run_gh(
    shell: &ShellConfig,
    root: &str,
    line: &str,
    timeout: Duration,
) -> Result<String, String> {
    let (code, stdout, stderr) = shell.run_shell_line(root, line, timeout)?;
    if code != 0 {
        return Err(failure(line, code, &stdout, &stderr));
    }
    Ok(stdout)
}

fn invalid_target(url: &str) -> String {
    format!("unsupported issue or pull request URL: {url}")
}

/// リポジトリで許可されているマージの方式（#450）。確認ダイアログに並べるボタンを決める。
///
/// **許可されていない方式を選ばせない**ために、マージの前に 1 回聞く（`gh` の起動が 1 回
/// 増える。利用者の判断）。聞く相手は PR の URL から導いたリポジトリで、cwd の解決には任せない
/// （理由は `parse_target`）。
#[tauri::command]
pub async fn issues_merge_methods(
    shell: ShellConfig,
    root: String,
    url: String,
) -> Result<Vec<MergeMethod>, String> {
    let Some((repo_url, ListKind::Pr)) = parse_target(&url) else {
        return Err(invalid_target(&url));
    };
    let line = format!(
        "gh repo view {repo_url} --json mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed"
    );
    tauri::async_runtime::spawn_blocking(move || {
        run_gh_json::<GhMergeSettings>(&shell, &root, &line).map(|s| s.methods())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// PR のマージとクローズ、issue のクローズ（#450）。**確認はフロントが済ませてから呼ぶ。**
///
/// **Pike のバックエンドで走らせる**（ターミナルのタブには出さない）。どの操作も引数だけで
/// 決まり、`gh` は端末に何も聞かない。失敗は `Err` で返し、フロントがダイアログに出す。
#[tauri::command]
pub async fn issues_act(
    shell: ShellConfig,
    root: String,
    url: String,
    action: IssueAction,
) -> Result<(), String> {
    if parse_target(&url).map(|(_, kind)| kind) != Some(action.kind()) {
        return Err(invalid_target(&url));
    }
    let line = action.line(&url);
    tauri::async_runtime::spawn_blocking(move || {
        run_gh(&shell, &root, &line, ACTION_TIMEOUT).map(|_| ())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_gh_issue_list() {
        let json = r#"[
          {"author":{"id":"x","is_bot":false,"login":"kan","name":"Kan"},
           "labels":[{"id":"y","name":"enhancement","description":"d","color":"a2eeef"}],
           "number":308,"state":"OPEN","title":"分割","updatedAt":"2026-09-03T06:54:00Z",
           "url":"https://github.com/kan/pike/issues/308"}
        ]"#;
        let issues = parse_list(json).unwrap();
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].number, 308);
        assert_eq!(issues[0].author, "kan");
        assert_eq!(issues[0].labels[0].color, "a2eeef");
    }

    /// 並びは番号の降順（#357）。`gh` が何順で返しても、戻り値はこの順になる。
    #[test]
    fn sorts_by_issue_number_descending() {
        let json = r#"[
          {"number":12,"title":"a","url":"u","updatedAt":"","author":null,"labels":[]},
          {"number":357,"title":"b","url":"u","updatedAt":"","author":null,"labels":[]},
          {"number":100,"title":"c","url":"u","updatedAt":"","author":null,"labels":[]}
        ]"#;
        let numbers: Vec<u64> = parse_list(json).unwrap().iter().map(|i| i.number).collect();
        assert_eq!(numbers, vec![357, 100, 12]);
    }

    /// sub-issue の `parent` は親の全体で返るが、番号だけ拾う（木を組むのは一覧の中だけ）。
    #[test]
    fn keeps_only_the_parent_number() {
        let json = r#"[
          {"number":299,"title":"c","url":"u","updatedAt":"2026-09-01T00:00:00Z",
           "author":{"login":"kan"},"labels":[],
           "parent":{"id":"I_x","number":275,"state":"OPEN","title":"p","url":"pu"}},
          {"number":275,"title":"p","url":"pu","updatedAt":"2026-09-01T00:00:00Z",
           "author":{"login":"kan"},"labels":[],"parent":null}
        ]"#;
        // 番号で引く（`parse_list` は並べ替えるので、添字は入力の順を意味しない）。
        let issues = parse_list(json).unwrap();
        let by = |n: u64| issues.iter().find(|i| i.number == n).unwrap();
        assert_eq!(by(299).parent, Some(275));
        assert_eq!(by(275).parent, None);
    }

    /// PR の `isDraft` を拾う（#413）。issue には無いフィールドなので、無ければ false。
    #[test]
    fn reads_draft_flag_of_pull_requests() {
        let json = r#"[
          {"number":2,"title":"d","url":"u","updatedAt":"","author":null,"labels":[],"isDraft":true},
          {"number":1,"title":"r","url":"u","updatedAt":"","author":null,"labels":[]}
        ]"#;
        let issues = parse_list(json).unwrap();
        assert!(issues[0].draft);
        assert!(!issues[1].draft);
    }

    /// CI のチェックを 1 値にまとめる（#413）。落ちたもの > 走っているもの > 成功、の順。
    /// `CheckRun`（`status` / `conclusion`）と `StatusContext`（`state`）が混ざって来る。
    #[test]
    fn summarizes_status_check_rollup() {
        let json = r#"[
          {"number":5,"title":"","url":"","updatedAt":"","author":null,"labels":[],
           "statusCheckRollup":[
             {"__typename":"CheckRun","status":"COMPLETED","conclusion":"SUCCESS"},
             {"__typename":"CheckRun","status":"IN_PROGRESS","conclusion":""},
             {"__typename":"CheckRun","status":"COMPLETED","conclusion":"FAILURE"}]},
          {"number":4,"title":"","url":"","updatedAt":"","author":null,"labels":[],
           "statusCheckRollup":[
             {"__typename":"CheckRun","status":"COMPLETED","conclusion":"SUCCESS"},
             {"__typename":"StatusContext","state":"PENDING"}]},
          {"number":3,"title":"","url":"","updatedAt":"","author":null,"labels":[],
           "statusCheckRollup":[
             {"__typename":"CheckRun","status":"COMPLETED","conclusion":"SKIPPED"},
             {"__typename":"StatusContext","state":"SUCCESS"}]},
          {"number":2,"title":"","url":"","updatedAt":"","author":null,"labels":[],
           "statusCheckRollup":[]},
          {"number":1,"title":"","url":"","updatedAt":"","author":null,"labels":[],
           "statusCheckRollup":null}
        ]"#;
        let checks: Vec<_> = parse_list(json).unwrap().iter().map(|i| i.checks).collect();
        assert_eq!(
            checks,
            vec![
                Some(CheckState::Failure),
                Some(CheckState::Pending),
                Some(CheckState::Success),
                None,
                None,
            ]
        );
    }

    /// 消えたアカウントの issue は `author` が null で来る。落とさず空にする。
    #[test]
    fn tolerates_missing_author() {
        let json = r#"[{"number":1,"title":"t","url":"u",
                        "updatedAt":"2026-01-01T00:00:00Z","author":null,"labels":[]}]"#;
        let issues = parse_list(json).unwrap();
        assert_eq!(issues[0].author, "");
    }

    /// 通すのは一覧が返す形の URL だけ（#450）。シェルに意味のある文字はどの位置でも断る。
    #[test]
    fn parses_only_well_formed_targets() {
        assert_eq!(
            parse_target("https://github.com/kan/pike/pull/12"),
            Some(("https://github.com/kan/pike", ListKind::Pr))
        );
        assert_eq!(
            parse_target("https://ghe.example.com/a-b/c_d.e/issues/450"),
            Some(("https://ghe.example.com/a-b/c_d.e", ListKind::Issue))
        );
        for bad in [
            "http://github.com/kan/pike/pull/12",
            "https://github.com/kan/pike/pull/",
            "https://github.com/kan/pike/pull/12/files",
            "https://github.com/kan/pike/commit/12",
            "https://github.com/kan/pike/pull/12;rm",
            "https://github.com/kan/pi ke/pull/12",
            "https://github.com/kan/$(x)/pull/12",
            "https://github.com/kan/pike&x/issues/1",
            "https://github.com//pike/issues/1",
        ] {
            assert_eq!(parse_target(bad), None, "{bad}");
        }
    }

    #[test]
    fn builds_action_lines() {
        let pr = "https://github.com/kan/pike/pull/12";
        let merge = |method, delete_branch| IssueAction::Merge {
            method,
            delete_branch,
        };
        assert_eq!(
            merge(MergeMethod::Squash, false).line(pr),
            format!("gh pr merge {pr} --squash")
        );
        assert_eq!(
            merge(MergeMethod::Merge, true).line(pr),
            format!("gh pr merge {pr} --merge --delete-branch")
        );
        assert_eq!(IssueAction::ClosePr.line(pr), format!("gh pr close {pr}"));
        let issue = "https://github.com/kan/pike/issues/450";
        let close = |reason| IssueAction::CloseIssue { reason };
        assert_eq!(
            close(CloseReason::NotPlanned).line(issue),
            format!("gh issue close {issue} --reason \"not planned\"")
        );
        assert_eq!(
            close(CloseReason::Completed).line(issue),
            format!("gh issue close {issue} --reason completed")
        );
    }

    /// フロントが送る形（`types/issues.ts` の `IssueAction`）をそのまま読めること。
    #[test]
    fn deserializes_actions_from_the_frontend() {
        let action: IssueAction =
            serde_json::from_str(r#"{"type":"merge","method":"rebase","deleteBranch":true}"#)
                .unwrap();
        assert_eq!(action.line("u"), "gh pr merge u --rebase --delete-branch");
        let action: IssueAction =
            serde_json::from_str(r#"{"type":"closeIssue","reason":"notPlanned"}"#).unwrap();
        assert_eq!(action.kind(), ListKind::Issue);
        let action: IssueAction = serde_json::from_str(r#"{"type":"closePr"}"#).unwrap();
        assert_eq!(action.kind(), ListKind::Pr);
    }

    /// 許可されている方式だけを、GitHub のボタンと同じ並びで返す。
    #[test]
    fn lists_allowed_merge_methods() {
        let settings: GhMergeSettings = serde_json::from_str(
            r#"{"mergeCommitAllowed":false,"rebaseMergeAllowed":true,"squashMergeAllowed":true}"#,
        )
        .unwrap();
        assert_eq!(
            settings.methods(),
            vec![MergeMethod::Squash, MergeMethod::Rebase]
        );
    }

    #[test]
    fn failure_prefers_stderr_then_stdout_and_echoes_the_line() {
        assert_eq!(
            failure("gh x", 1, "out", "  \nerr line\n"),
            "err line\ngh x"
        );
        assert_eq!(failure("gh x", 1, "\nout line", ""), "out line\ngh x");
        assert_eq!(failure("gh x", 4, "", ""), "gh exited with code 4\ngh x");
    }
}
