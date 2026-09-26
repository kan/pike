//! Vue SFC のプレビュー（#397）。外部コマンド `vue-preview`（kan/vue-preview）に SFC を
//! 「CSS をインライン化した 1 枚の HTML」へ描かせ、HTML のプレビュー（#399）の子 webview の
//! 仮想ファイルとして置く（`html_preview::put_virtual`）。
//!
//! **Pike は SFC をコンパイルしない。** コンパイラとランタイムを抱えないため（Monaco を
//! 使わないのと同じ軸）。`gh` や `rg` と同じく「入っていれば使える」外部ツールに任せる。
//! 開発サーバー（Vite）に描かせる方式は #397 で試して見送った（必須の props と `main.ts` の
//! 初期化を再現できない）。vue-preview は script を実行せず、値を fixture とプレースホルダで
//! 埋めるので、単体で描けないコンポーネントでも形は出る。
//!
//! **プロジェクトのシェルで、渡されたルート（SFC からいちばん近い package.json のディレクトリ。
//! 探すのはフロントの `VuePreview.vue`）を cwd にして走らせる**。node_modules が
//! コンテナの中にしか無いプロジェクトでも、vue-preview がロックファイルから依存を自前の
//! キャッシュへ入れて描く（vue-preview の REPORT V7）ので、Pike は Docker を知らなくてよい。

use crate::cache::ProbeRegistry;
use crate::html_preview::{self, PreviewState};
use crate::types::{install_key, truncate_chars_tail, ShellConfig};
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tauri::State;

/// 描画は通常 1 秒弱だが、**そのプロジェクトで初めて描くときは依存の install が入る**
/// （実測で 10〜30 秒。回線とロックファイルの大きさ次第）。そこで打ち切ると、何度押しても
/// キャッシュが完成しない。
const RENDER_TIMEOUT: Duration = Duration::from_secs(300);

/// **`vue-preview` が見つかったシェルをプロセス単位で覚える**（`IssuesState` の `gh` と同じ形。
/// 覚え方は `cache::ProbeEntry::found`）。
#[derive(Default)]
pub struct VuePreviewState {
    found: ProbeRegistry<String, bool>,
}

/// `vue-preview` が使えるか（探し方は `ShellConfig::has_command`。`gh` の検出と共有）。
#[tauri::command]
pub async fn vue_preview_available(
    shell: ShellConfig,
    root: String,
    force: bool,
    state: State<'_, VuePreviewState>,
) -> Result<bool, String> {
    let entry = state.found.entry(install_key(&shell));
    tauri::async_runtime::spawn_blocking(move || {
        entry.found(force, || shell.has_command(&root, "vue-preview"))
    })
    .await
    .map_err(|e| e.to_string())
}

/// `vue-preview render --json` の出力。契約になっている欄だけを受ける（`timings` などの
/// 計測用の欄は読まない）。
#[derive(Debug, Deserialize)]
struct Output {
    html: String,
    #[serde(default)]
    deps: Vec<String>,
    #[serde(default)]
    warnings: Vec<String>,
}

/// フロントへ返すもの。**HTML は返さない**（`put_virtual` で置いてある）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VueRender {
    /// 描いた結果に効いたファイル（ルートからの相対パス、区切りは `/`）。どれかが変わったら
    /// 描き直す。
    deps: Vec<String>,
    warnings: Vec<String>,
}

/// 失敗の理由。**stderr を丸ごと返す**（先頭の 1 行ではない。`issues` の `failure` と方針が
/// 違う）: vue-preview は依存の install に失敗したとき、原因を後ろの行に出す。長すぎるものは
/// 後ろを残して切る。
fn failure(line: &str, code: i32, stdout: &str, stderr: &str) -> String {
    let text = [stderr.trim(), stdout.trim()]
        .into_iter()
        .find(|s| !s.is_empty())
        .map(|s| truncate_chars_tail(s, 4000))
        .unwrap_or_else(|| format!("vue-preview exited with code {code}"));
    format!("{text}\n\n{line}")
}

/// `path`（ルートからの相対パス、区切りは `/`）の SFC を描き、子 webview `label` の仮想
/// ファイル `entry` に置く。再読み込みはフロントが呼ぶ。
#[tauri::command]
pub async fn vue_preview_render(
    shell: ShellConfig,
    root: String,
    path: String,
    label: String,
    entry: String,
    preview: State<'_, PreviewState>,
) -> Result<VueRender, String> {
    let line = format!("vue-preview render {} --json", shell.line_arg(&path)?);
    let out: Output = tauri::async_runtime::spawn_blocking(move || {
        let (code, stdout, stderr) = shell.run_shell_line(&root, &line, RENDER_TIMEOUT)?;
        if code != 0 {
            return Err(failure(&line, code, &stdout, &stderr));
        }
        serde_json::from_str(stdout.trim())
            .map_err(|e| format!("failed to parse vue-preview output: {e}\n\n{line}"))
    })
    .await
    .map_err(|e| e.to_string())??;
    html_preview::put_virtual(&preview, &label, &entry, out.html)?;
    Ok(VueRender {
        deps: out.deps,
        warnings: out.warnings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failure_keeps_every_line_and_the_tail() {
        assert_eq!(
            failure("vp", 1, "", "installing\nno lockfile\n"),
            "installing\nno lockfile\n\nvp"
        );
        assert_eq!(
            failure("vp", 3, "", ""),
            "vue-preview exited with code 3\n\nvp"
        );
        let long = "x".repeat(5000) + "END";
        assert!(failure("vp", 1, "", &long).starts_with('…'));
        assert!(failure("vp", 1, "", &long).contains("END"));
    }

    #[test]
    fn reads_the_contract_fields() {
        let r: Output = serde_json::from_str(
            r#"{"html":"<p>","deps":["a.vue"],"warnings":[],"timings":{"total":1}}"#,
        )
        .unwrap();
        assert_eq!(r.deps, ["a.vue"]);
    }
}
