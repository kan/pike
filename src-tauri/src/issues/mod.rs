//! GitHub issue の一覧（#278）。
//!
//! **認証は `gh` に丸ごと任せる。** `api.github.com` を直接叩くと CSP の緩和とトークンの
//! 保管が要るが、`gh` なら手元の認証をそのまま使えて、Pike はトークンに触らずに済む。
//!
//! 形は `diagnostics` と同じで、**検出したツールを要求時に 1 回だけ走らせて構造化出力を
//! 正規化する**。常駐もポーリングもしない（外部プロセスの起動を定期実行に混ぜない）。

use crate::types::{first_line, install_key, ShellConfig};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::State;

/// `gh` の一覧取得は実測で約 1 秒（`gh --version` は 0.14 秒）。ネットワークを伴うので
/// 既定の 30 秒より短くするが、遅い回線でも 1 回は諦めない程度に取ってある。
const LIST_TIMEOUT: Duration = Duration::from_secs(20);
const PROBE_TIMEOUT: Duration = Duration::from_secs(10);

/// **`gh` が見つかったシェルをプロセス単位で覚える**（`SearchState.detected` と同じ形）。
/// Pinia のストアはウィンドウごとなので、フロントだけで覚えると同じリポジトリを N 枚
/// 開いたときに `gh --version` が N 回走る。WSL ではそれが `wsl.exe` の起動 N 回になる。
///
/// キーが**シェルの導入単位**なのは、WSL プロジェクトが見るのは distro の中の `gh`、
/// Windows プロジェクトが見るのはホストのそれ、と答えが変わるため。**集合なのは
/// 「見つかった」しか覚えないから**（理由は `issues_gh_available`）。
///
/// **`shell_probe.rs` には畳んでいない**（#275 の宿題 3）。あちらがまとめているのは
/// 対話ログインシェルを起こす問いで、費用は rc の評価にある。`gh --version` は
/// `run_shell_line`（非対話・PATH を前置するだけ）なので、同じ起動に相乗りする理由が無い。
///
/// **ただしロックの粒度はあちらのほうが良い。** ここは probe のあいだ 1 本のロックを
/// 握ったままなので、冷えた distro の `gh` を待つあいだ**別の導入単位の問い合わせも
/// 止まる**（最長 `PROBE_TIMEOUT`）。`shell_probe::Entry` はキーごとに分けたうえ、
/// 答えのロックと probe のロックも分けてある。直すならその形を写す（#275 に宿題として記録）。
#[derive(Default)]
pub struct IssuesState {
    pub gh: Arc<Mutex<HashSet<String>>>,
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
        }
    }
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

/// `gh` が使えるか。**`--version` が存在確認も兼ねる**（`which` / `where` を別に叩かない）。
///
/// ここでは認証までは見ない: `gh auth status` をもう 1 回起こすことになるうえ、認証が
/// 切れているかどうかは一覧の取得が返す `error` で分かる。ここで見たいのは
/// 「サイドバーにアイコンを出してよいか」だけ。
///
/// **一覧と同じ `run_shell_line` を通す**。WSL では `WSL_EXTRA_PATH` が前置されるので、
/// `~/.local/bin` に入れた `gh` も見つかる。素の `run` で探すと、探し方と実際の走らせ方が
/// 食い違って「検出できないのに手で打てば動く」になる。
///
/// **覚えるのは「見つかった」だけ**（`force` は更新ボタンからの明示的なやり直し）。
///
/// 見つからなかったほうを焼き付けると、`PROBE_TIMEOUT` に届いた 1 回（WSL の冷えた起動で
/// 普通に起きる）でプロセスの寿命ぶんパネルが消え、**アイコンもパレットも出ないので
/// 更新ボタンに手が届かない**＝再起動しか手が無くなる。見つからない側は安いので
/// （`gh` が無ければ即座に失敗する）、聞かれるたびに確かめてよい。
///
/// **ロックは probe 中も持ったまま**にする（`claude_usage/config.rs` の環境変数プローブと
/// 同じ手口）。手放すと、前回のセッションを復元して 3 枚のウィンドウが同時に立ち上がる
/// ときに 3 本とも miss して `gh --version` が 3 回走る（WSL では `wsl.exe` の起動 3 回）。
/// 握ったままなら 2 本目以降は待って、入った答えを読む。
#[tauri::command]
pub async fn issues_gh_available(
    shell: ShellConfig,
    root: String,
    force: bool,
    state: State<'_, IssuesState>,
) -> Result<bool, String> {
    let key = install_key(&shell);
    let cache = state.gh.clone();
    tauri::async_runtime::spawn_blocking(move || {
        // ロックが毒されていたら（他のスレッドが probe 中に panic）、覚えるのを諦めて
        // 素で確かめる。ここで失敗を返すとパネルが理由なく消える。
        let Ok(mut found_in) = cache.lock() else {
            return matches!(
                shell.run_shell_line(&root, "gh --version", PROBE_TIMEOUT),
                Ok((0, _, _))
            );
        };
        if !force && found_in.contains(&key) {
            return true;
        }
        let found = matches!(
            shell.run_shell_line(&root, "gh --version", PROBE_TIMEOUT),
            Ok((0, _, _))
        );
        if found {
            found_in.insert(key);
        } else {
            found_in.remove(&key);
        }
        found
    })
    .await
    .map_err(|e| e.to_string())
}

/// 一覧を取る。**`gh` はプロジェクトのシェルで、プロジェクトの root を cwd にして走らせる**
/// （`--repo` を組み立てて渡す形にすると、origin の綴りを Pike 側でもう一度解釈することに
/// なる。どのリポジトリかを決めるのは `gh` に任せる）。
///
/// 並びは `sort:updated-desc`。`gh issue list` に並び替えのフラグは無く、検索の修飾子として
/// 渡すのが唯一の方法（実測で効く）。
#[tauri::command]
pub async fn issues_list(
    shell: ShellConfig,
    root: String,
    limit: u32,
) -> Result<IssueListResult, String> {
    // 引数はすべてこちらが決めた定数か数値なので、シェルの行に埋めても注入の余地が無い。
    let limit = limit.clamp(1, 200);
    let line = format!(
        "gh issue list --state open --limit {limit} --search \"sort:updated-desc\" \
         --json number,title,url,author,updatedAt,labels,parent"
    );
    tauri::async_runtime::spawn_blocking(move || {
        let (code, stdout, stderr) = match shell.run_shell_line(&root, &line, LIST_TIMEOUT) {
            Ok(v) => v,
            Err(e) => {
                return IssueListResult {
                    issues: Vec::new(),
                    error: Some(format!("{e}\n{line}")),
                }
            }
        };
        if code != 0 {
            return IssueListResult {
                issues: Vec::new(),
                error: Some(failure(&line, code, &stdout, &stderr)),
            };
        }
        match serde_json::from_str::<Vec<GhIssue>>(stdout.trim()) {
            Ok(list) => IssueListResult {
                issues: list.into_iter().map(IssueSummary::from).collect(),
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
    tauri::async_runtime::spawn_blocking(move || {
        let (code, stdout, stderr) = shell.run_shell_line(&root, &line, LIST_TIMEOUT)?;
        if code != 0 {
            return Err(failure(&line, code, &stdout, &stderr));
        }
        serde_json::from_str(stdout.trim())
            .map_err(|e| format!("failed to parse gh output: {e}\n{line}"))
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
        let parsed: Vec<GhIssue> = serde_json::from_str(json).unwrap();
        let issues: Vec<IssueSummary> = parsed.into_iter().map(IssueSummary::from).collect();
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].number, 308);
        assert_eq!(issues[0].author, "kan");
        assert_eq!(issues[0].labels[0].color, "a2eeef");
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
        let parsed: Vec<GhIssue> = serde_json::from_str(json).unwrap();
        let issues: Vec<IssueSummary> = parsed.into_iter().map(IssueSummary::from).collect();
        assert_eq!(issues[0].parent, Some(275));
        assert_eq!(issues[1].parent, None);
    }

    /// 消えたアカウントの issue は `author` が null で来る。落とさず空にする。
    #[test]
    fn tolerates_missing_author() {
        let json = r#"[{"number":1,"title":"t","url":"u",
                        "updatedAt":"2026-01-01T00:00:00Z","author":null,"labels":[]}]"#;
        let parsed: Vec<GhIssue> = serde_json::from_str(json).unwrap();
        let issues: Vec<IssueSummary> = parsed.into_iter().map(IssueSummary::from).collect();
        assert_eq!(issues[0].author, "");
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
