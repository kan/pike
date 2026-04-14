use crate::types::ShellConfig;
use serde::Serialize;

#[derive(Serialize)]
pub struct MakeTarget {
    pub name: String,
}

/// Extract targets from a Makefile.
/// Looks for lines like `target-name:` that aren't variable assignments or special targets.
#[tauri::command]
pub async fn task_list_makefile_targets(
    shell: ShellConfig,
    root: String,
) -> Result<Vec<MakeTarget>, String> {
    tokio::task::spawn_blocking(move || {
        let sep = if root.contains('/') { "/" } else { "\\" };
        let candidates = ["Makefile", "makefile", "GNUmakefile"];
        for filename in candidates {
            let path = format!("{root}{sep}{filename}");
            let content = match &shell {
                ShellConfig::Wsl { .. } => shell.run_stdout("cat", &["--", &path]).ok(),
                _ => std::fs::read_to_string(&path).ok(),
            };
            if let Some(content) = content {
                return Ok(parse_makefile_targets(&content));
            }
        }
        Ok(vec![])
    })
    .await
    .map_err(|e| e.to_string())?
}

fn parse_makefile_targets(content: &str) -> Vec<MakeTarget> {
    let mut targets = Vec::new();
    for line in content.lines() {
        // Skip lines starting with whitespace (recipe lines), comments, or empty
        if line.is_empty() || line.starts_with('\t') || line.starts_with('#') || line.starts_with(' ') {
            continue;
        }
        // Match "target:" but not "VAR := value" or "VAR = value"
        if let Some(colon_pos) = line.find(':') {
            let before = &line[..colon_pos];
            // Skip if it looks like a variable assignment (contains =)
            if before.contains('=') {
                continue;
            }
            let name = before.trim();
            // Skip special targets (starting with .) and empty names
            if name.is_empty() || name.starts_with('.') {
                continue;
            }
            // Skip if name contains spaces (likely not a real target)
            if name.contains(' ') {
                continue;
            }
            // Valid target name: alphanumeric, hyphens, underscores, slashes
            if name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '/') {
                targets.push(MakeTarget { name: name.to_string() });
            }
        }
    }
    targets
}
