use crate::fs::IGNORED_DIRS;
use crate::search::SearchState;
use crate::types::ShellConfig;
use serde::Serialize;
use tauri::State;

const TASK_FILE_GLOBS: &[&str] = &[
    "package.json",
    "Makefile",
    "makefile",
    "GNUmakefile",
    "deno.json",
    "deno.jsonc",
];

const MAX_DEPTH: u32 = 5;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredTask {
    pub name: String,
    pub command: String,
    pub runner: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredTaskGroup {
    pub runner: String,
    pub label: String,
    pub source_file: String,
    pub cwd: String,
    pub tasks: Vec<DiscoveredTask>,
}

/// Discover all task files recursively in the project, respecting .gitignore.
#[tauri::command]
pub async fn task_discover(
    shell: ShellConfig,
    root: String,
    search_state: State<'_, SearchState>,
) -> Result<Vec<DiscoveredTaskGroup>, String> {
    let backend = search_state
        .detected
        .lock()
        .ok()
        .and_then(|g| g.clone());

    tokio::task::spawn_blocking(move || {
        let paths = find_task_files(&shell, &root, backend.as_ref());
        let sep = if root.contains('/') { "/" } else { "\\" };

        // Batch-read all files
        let contents = batch_read_files(&shell, &root, sep, &paths);
        let mut groups = Vec::new();

        for (path, content) in paths.iter().zip(contents.iter()) {
            let Some(content) = content else { continue };

            let rel = if path.starts_with(&root) {
                path[root.len()..].trim_start_matches(['/', '\\']).to_string()
            } else {
                path.clone()
            };

            let dir_rel = rel
                .rsplit_once('/')
                .or_else(|| rel.rsplit_once('\\'))
                .map(|(d, _)| d.to_string())
                .unwrap_or_default();
            let cwd = if dir_rel.is_empty() {
                root.clone()
            } else {
                format!("{root}{sep}{dir_rel}")
            };

            let filename = rel
                .rsplit_once('/')
                .or_else(|| rel.rsplit_once('\\'))
                .map(|(_, f)| f)
                .unwrap_or(&rel);

            let label_prefix = if dir_rel.is_empty() {
                String::new()
            } else {
                format!("{dir_rel}{sep}")
            };

            match filename.to_lowercase().as_str() {
                "package.json" => {
                    let tasks = parse_package_json(content);
                    if !tasks.is_empty() {
                        groups.push(DiscoveredTaskGroup {
                            runner: "npm".into(),
                            label: format!("{label_prefix}npm scripts"),
                            source_file: rel,
                            cwd,
                            tasks,
                        });
                    }
                }
                "makefile" | "gnumakefile" => {
                    let tasks = parse_makefile_targets(content);
                    if !tasks.is_empty() {
                        groups.push(DiscoveredTaskGroup {
                            runner: "make".into(),
                            label: format!("{label_prefix}make targets"),
                            source_file: rel,
                            cwd,
                            tasks,
                        });
                    }
                }
                "deno.json" | "deno.jsonc" => {
                    let tasks = parse_deno_json(content);
                    if !tasks.is_empty() {
                        groups.push(DiscoveredTaskGroup {
                            runner: "deno".into(),
                            label: format!("{label_prefix}deno tasks"),
                            source_file: rel,
                            cwd,
                            tasks,
                        });
                    }
                }
                _ => {}
            }
        }

        Ok(groups)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Read multiple files. For WSL, batches all reads into a single wsl.exe invocation.
fn batch_read_files(
    shell: &ShellConfig,
    root: &str,
    sep: &str,
    paths: &[String],
) -> Vec<Option<String>> {
    if paths.is_empty() {
        return vec![];
    }
    match shell {
        ShellConfig::Wsl { .. } => {
            // Build a single bash script that cats all files separated by record separator
            let rs = "\x1e"; // ASCII record separator
            let parts: Vec<String> = paths
                .iter()
                .map(|p| {
                    let full = if p.starts_with('/') || p.contains(':') {
                        p.clone()
                    } else {
                        format!("{root}{sep}{p}")
                    };
                    format!("cat '{}' 2>/dev/null || echo", full.replace('\'', "'\\''"))
                })
                .collect();
            let script = parts.join(&format!("; printf '{rs}'; "));
            match shell.run_stdout("bash", &["-c", &script]) {
                Ok(output) => output
                    .split(rs)
                    .map(|s| {
                        let trimmed = s.trim();
                        if trimmed.is_empty() {
                            None
                        } else {
                            Some(trimmed.to_string())
                        }
                    })
                    .collect(),
                Err(_) => paths.iter().map(|_| None).collect(),
            }
        }
        _ => paths
            .iter()
            .map(|p| {
                let full = if p.starts_with('/') || p.contains(':') {
                    p.clone()
                } else {
                    format!("{root}{sep}{p}")
                };
                std::fs::read_to_string(&full).ok()
            })
            .collect(),
    }
}

fn find_task_files(
    shell: &ShellConfig,
    root: &str,
    backend: Option<&crate::search::SearchBackend>,
) -> Vec<String> {
    if let Some(b) = backend {
        if b.is_rg() {
            let depth_arg = format!("{MAX_DEPTH}");
            let mut args: Vec<&str> = vec!["--files", "--max-depth", &depth_arg];
            for g in TASK_FILE_GLOBS {
                args.push("-g");
                args.push(g);
            }
            args.push("--");
            args.push(root);
            if let Ok((code, stdout, _)) = shell.run(b.rg_program(), &args) {
                if code == 0 || !stdout.is_empty() {
                    return stdout.lines().map(|l| l.to_string()).collect();
                }
            }
        }
    }

    // Fallback: find (WSL) or walkdir-like approach (Windows)
    match shell {
        ShellConfig::Wsl { .. } => {
            let prune_expr: String = IGNORED_DIRS
                .iter()
                .map(|d| format!("-name '{d}'"))
                .collect::<Vec<_>>()
                .join(" -o ");
            let name_expr: String = TASK_FILE_GLOBS
                .iter()
                .map(|g| format!("-name '{g}'"))
                .collect::<Vec<_>>()
                .join(" -o ");
            let script = format!(
                "find '{}' -maxdepth {MAX_DEPTH} \\( {prune_expr} \\) -prune -o \\( {name_expr} \\) -print",
                root.replace('\'', "'\\''"),
            );
            shell
                .run_stdout("bash", &["-c", &script])
                .ok()
                .map(|s| s.lines().map(|l| l.to_string()).collect())
                .unwrap_or_default()
        }
        _ => {
            let mut results = Vec::new();
            walk_for_task_files(std::path::Path::new(root), &mut results, 0);
            results
        }
    }
}

fn walk_for_task_files(dir: &std::path::Path, results: &mut Vec<String>, depth: u32) {
    if depth >= MAX_DEPTH {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            if IGNORED_DIRS.contains(&name.as_str()) {
                continue;
            }
            walk_for_task_files(&entry.path(), results, depth + 1);
        } else {
            let lower = name.to_lowercase();
            if TASK_FILE_GLOBS.iter().any(|g| g.to_lowercase() == lower) {
                if let Some(path) = entry.path().to_str() {
                    results.push(path.to_string());
                }
            }
        }
    }
}

fn parse_package_json(content: &str) -> Vec<DiscoveredTask> {
    let Ok(val) = serde_json::from_str::<serde_json::Value>(content) else {
        return vec![];
    };
    let Some(scripts) = val.get("scripts").and_then(|s| s.as_object()) else {
        return vec![];
    };
    scripts
        .iter()
        .filter_map(|(name, cmd)| {
            cmd.as_str().map(|c| DiscoveredTask {
                name: name.clone(),
                command: c.to_string(),
                runner: "npm".into(),
            })
        })
        .collect()
}

fn parse_deno_json(content: &str) -> Vec<DiscoveredTask> {
    let stripped: String = strip_json_comments(content);
    let Ok(val) = serde_json::from_str::<serde_json::Value>(&stripped) else {
        return vec![];
    };
    let Some(tasks) = val.get("tasks").and_then(|t| t.as_object()) else {
        return vec![];
    };
    tasks
        .iter()
        .filter_map(|(name, cmd)| {
            cmd.as_str().map(|c| DiscoveredTask {
                name: name.clone(),
                command: c.to_string(),
                runner: "deno".into(),
            })
        })
        .collect()
}

fn strip_json_comments(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    let mut in_string = false;
    while let Some(c) = chars.next() {
        if in_string {
            out.push(c);
            if c == '\\' {
                if let Some(&next) = chars.peek() {
                    out.push(next);
                    chars.next();
                }
            } else if c == '"' {
                in_string = false;
            }
        } else if c == '"' {
            in_string = true;
            out.push(c);
        } else if c == '/' {
            match chars.peek() {
                Some(&'/') => {
                    for ch in chars.by_ref() {
                        if ch == '\n' {
                            out.push('\n');
                            break;
                        }
                    }
                }
                Some(&'*') => {
                    chars.next();
                    while let Some(ch) = chars.next() {
                        if ch == '*' && chars.peek() == Some(&'/') {
                            chars.next();
                            break;
                        }
                    }
                }
                _ => out.push(c),
            }
        } else {
            out.push(c);
        }
    }
    out
}

fn parse_makefile_targets(content: &str) -> Vec<DiscoveredTask> {
    let mut targets = Vec::new();
    for line in content.lines() {
        if line.is_empty()
            || line.starts_with('\t')
            || line.starts_with('#')
            || line.starts_with(' ')
        {
            continue;
        }
        if let Some(colon_pos) = line.find(':') {
            let before = &line[..colon_pos];
            if before.contains('=') {
                continue;
            }
            let name = before.trim();
            if name.is_empty() || name.starts_with('.') || name.contains(' ') {
                continue;
            }
            if name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '/')
            {
                targets.push(DiscoveredTask {
                    name: name.to_string(),
                    command: name.to_string(),
                    runner: "make".into(),
                });
            }
        }
    }
    targets
}
