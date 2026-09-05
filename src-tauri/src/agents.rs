//! コーディングエージェントの検出（#275 / #267）。
//!
//! **どのエージェントを知っているかは持たない。** 一覧の正本はフロントの
//! `src/lib/agents.ts` で、ここが受け取るのは「この名前のコマンドがあるか」だけ。
//! 両方に一覧を置くと、増やすたびに 2 つのファイルを揃えることになる（`lib/shortcuts.ts` の
//! 表と `appmenu` の関係と同じ分担で、語彙を持つ側は 1 つ）。
//!
//! **1 回のシェル起動で全部聞く。** 1 つずつ確かめると、WSL プロジェクトでは
//! `wsl.exe` の起動がエージェントの数だけ並ぶ（冷えていると 1 本あたり 1〜2 秒）。
//! 聞き方・キャッシュ・`CLAUDE_CONFIG_DIR` との相乗りは `shell_probe.rs` の担当で、
//! このファイルに残るのは**コマンドの形と、シェルに渡してよい名前かの検証**だけ。

use crate::shell_probe::{self, is_safe_bin_name};
use crate::types::ShellConfig;

/// PATH にあるエージェントの名前を返す（渡された順で、見つかったものだけ）。
///
/// **名前の検証の番人は `shell_probe`**（シェルの行を組み立てるのはあちら）。ここで
/// 先に落とすのは、1 つも残らなかったときにシェルを起こさずに帰るため。
#[tauri::command]
pub async fn agent_detect(
    shell: ShellConfig,
    root: String,
    bins: Vec<String>,
) -> Result<Vec<String>, String> {
    let wanted: Vec<String> = bins.into_iter().filter(|b| is_safe_bin_name(b)).collect();
    if wanted.is_empty() {
        return Ok(Vec::new());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let found = shell_probe::agent_bins(&shell, &root, &wanted);
        // 聞かれた順に戻す（`found` は集合なので順を持たない）。
        Ok(wanted.into_iter().filter(|b| found.contains(b)).collect())
    })
    .await
    .map_err(|e| e.to_string())?
}
