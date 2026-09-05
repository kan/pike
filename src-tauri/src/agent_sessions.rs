//! 過去セッションの一覧（#267 / #275）。
//!
//! **一覧の取得と再開コマンドの組み立てを id で分ける。** `lib/agents.ts` の表が
//! 「2 つ目に付けるときはここから」と言っていた作業がこれで、それまで一覧・再開コマンド・
//! 見出しの全部が Claude 決め打ちだった。
//!
//! **出所は 4 つとも違う。** どれも「そのプロジェクトのディレクトリで動いた対話セッション」に
//! 絞るが、何をもって対話とみなすかは記録の形に依る。
//!
//! | id | 出所 | 対話セッションの選び方 |
//! |---|---|---|
//! | `claude` | `~/.claude/projects/<slug>/*.jsonl` | `entrypoint` が `cli` |
//! | `codex` | `~/.codex/sessions/**/rollout-*.jsonl` | `originator` が `codex_exec` 以外 |
//! | `copilot` | `~/.copilot/session-state/<uuid>/events.jsonl` | `assistant.turn_start` がある |
//! | `opencode` | `opencode db` の `session` テーブル | 全部（TUI しか記録を作らない） |
//!
//! **読むのはメニューを開いたときだけ。** ポーリングしない（WSL プロジェクトでは
//! `\\wsl.localhost` 越しの読みになり、opencode はプロセスを起こす）。

use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

use crate::agent_usage::AgentId;
use crate::types::ShellConfig;

/// 一覧に出す件数の上限。**サブメニューに入るので、素の並びより多めでよい**
/// （メニュー側に 60vh の上限とスクロールがある）。
const MAX_SESSIONS: usize = 20;

/// 題は 1 行に収まる長さで切る。上限は IPC に載る量の話で、見た目の省略はメニュー側の CSS。
pub(crate) const MAX_TITLE_CHARS: usize = 120;

/// 一覧に出す題。**最初の 1 行だけ**を取り、長ければ末尾に `…` を足す。
///
/// **4 つのアダプタが共有する。** 出所ごとに書くと、同じメニューに切り方の違う題が並ぶ
/// （実際、コピーした側は上限がリテラルで省略記号も付いていなかった）。
pub(crate) fn shorten(text: &str) -> String {
    let line = text.lines().next().unwrap_or("").trim();
    if line.chars().count() <= MAX_TITLE_CHARS {
        return line.to_string();
    }
    line.chars().take(MAX_TITLE_CHARS).collect::<String>() + "…"
}

/// ファイルの mtime を epoch ms へ。**失敗の扱いも 1 か所に置く**（アダプタごとに
/// `unwrap_or(0)` と `?` が割れていた）。
pub(crate) fn modified_ms(modified: SystemTime) -> Option<u64> {
    Some(modified.duration_since(UNIX_EPOCH).ok()?.as_millis() as u64)
}

/// 1 件ぶん。**再開コマンドはフロントが組む**（`lib/agents.ts` の `AgentDef.resume`）。
/// ここが返すのは id と、選ぶために要る情報だけ。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSession {
    /// 再開コマンドに渡す id。
    pub id: String,
    /// 一覧に出す名前。取れなければ空文字（フロントが id で代替する）。
    pub title: String,
    /// 最終更新（epoch ms）。並びと相対時刻に使う。
    pub modified_at: u64,
    /// 当時のブランチ。取れないエージェントでは `None`。
    pub git_branch: Option<String>,
}

/// そのエージェントの過去セッション。新しい順。
///
/// **失敗は空**（`Err` にしない）。一覧が出ないのと、そのエージェントを使っていないのは、
/// メニューの上では同じ見え方でよい。
#[tauri::command]
pub async fn agent_sessions(
    id: AgentId,
    shell: ShellConfig,
    project_root: String,
) -> Result<Vec<AgentSession>, String> {
    tokio::task::spawn_blocking(move || {
        // **アダプタの形は 4 つとも `(shell, root, limit) -> Vec<AgentSession>`。** 絞り込みも
        // 件数もあちらが持つので、ここは振り分けと並べ替えだけで済む（片方の腕にだけ
        // プロジェクトの照合が残ると、`limit` の意味もそこだけ違うことになる）。
        let (shell, root) = (&shell, project_root.as_str());
        let mut out = match id {
            AgentId::Claude => {
                crate::claude_usage::sessions::list_sessions(shell, root, MAX_SESSIONS)
            }
            AgentId::Codex => crate::codex_usage::list_sessions(shell, root, MAX_SESSIONS),
            AgentId::Copilot => {
                crate::agent_usage::copilot::list_sessions(shell, root, MAX_SESSIONS)
            }
            AgentId::Opencode => {
                crate::agent_usage::opencode::list_sessions(shell, root, MAX_SESSIONS)
            }
            AgentId::Unknown => Vec::new(),
        };
        out.sort_by_key(|s| std::cmp::Reverse(s.modified_at));
        out.truncate(MAX_SESSIONS);
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}
