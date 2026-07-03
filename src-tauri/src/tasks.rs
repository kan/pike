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
    "Cargo.toml",
    "cargo.toml",
    // Existence-only markers for cargo context (never content-read)
    "tauri.conf.json",
    "main.rs",
];

/// `.cargo/config.toml` ([alias] section) lives in a hidden directory, so rg
/// needs `--hidden` plus this path-qualified glob. The find/walkdir fallback
/// matches the bare name instead; `find_task_files` filters to `.cargo/`
/// parents so unrelated config.toml files (Hugo etc.) are never read.
const CARGO_CONFIG_RG_GLOB: &str = "**/.cargo/config.toml";
const CARGO_CONFIG_NAME: &str = "config.toml";

const MAX_DEPTH: u32 = 5;

/// Upper bound on manifests read/parsed per discovery (a committed vendor/
/// tree or a huge monorepo shouldn't stall the panel or blow the WSL batch
/// command line).
const MAX_TASK_FILES: usize = 300;

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
        let all_paths = find_task_files(&shell, &root, backend.as_ref());
        let sep = if root.contains('/') { "/" } else { "\\" };

        // Split existence-only markers from manifests that need their content
        let mut paths: Vec<String> = Vec::new();
        let mut tauri_conf_dirs: std::collections::HashSet<String> =
            std::collections::HashSet::new();
        let mut main_rs_paths: std::collections::HashSet<String> =
            std::collections::HashSet::new();
        for p in all_paths {
            match file_name_of(&p).to_lowercase().as_str() {
                "tauri.conf.json" => {
                    tauri_conf_dirs.insert(parent_dir(&p));
                }
                "main.rs" => {
                    main_rs_paths.insert(p);
                }
                _ => paths.push(p),
            }
        }
        paths.truncate(MAX_TASK_FILES);

        // Batch-read all files
        let contents = batch_read_files(&shell, &root, sep, &paths);

        // Pre-parse cargo manifests: workspace roots decide which members
        // skip the standard subcommand set
        let mut cargo_docs: std::collections::HashMap<usize, toml::Table> =
            std::collections::HashMap::new();
        let mut workspace_dirs: Vec<String> = Vec::new();
        for (i, (path, content)) in paths.iter().zip(contents.iter()).enumerate() {
            let Some(content) = content else { continue };
            if file_name_of(path).to_lowercase() != "cargo.toml" {
                continue;
            }
            let Ok(doc) = content.parse::<toml::Table>() else {
                continue;
            };
            if doc.contains_key("workspace") {
                workspace_dirs.push(parent_dir(path));
            }
            cargo_docs.insert(i, doc);
        }

        // Pre-parse .cargo/config.toml [alias] entries, keyed by the base dir
        // (parent of .cargo). Consumed by the sibling Cargo.toml group below;
        // leftovers (config without a manifest, e.g. a repo root whose crate
        // lives in a subdir) become standalone groups after the main loop.
        let mut alias_map: std::collections::HashMap<String, (usize, Vec<DiscoveredTask>)> =
            std::collections::HashMap::new();
        for (i, (path, content)) in paths.iter().zip(contents.iter()).enumerate() {
            let Some(content) = content else { continue };
            if !file_name_of(path).eq_ignore_ascii_case(CARGO_CONFIG_NAME) {
                continue;
            }
            let tasks = parse_cargo_aliases(content);
            if !tasks.is_empty() {
                alias_map.insert(parent_dir(&parent_dir(path)), (i, tasks));
            }
        }

        let mut groups = Vec::new();

        for (i, (path, content)) in paths.iter().zip(contents.iter()).enumerate() {
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
                "config.toml" => {} // consumed by the alias pre-pass above
                "cargo.toml" => {
                    let Some(doc) = cargo_docs.get(&i) else { continue };
                    let dir = parent_dir(path);
                    let ctx = CargoContext {
                        is_tauri_app: tauri_conf_dirs.contains(&dir),
                        is_workspace_member: workspace_dirs
                            .iter()
                            .any(|w| w != &dir && dir.starts_with(&format!("{w}{sep}"))),
                        has_default_bin: main_rs_paths
                            .contains(&format!("{dir}{sep}src{sep}main.rs")),
                    };
                    let mut tasks = cargo_tasks(doc, &ctx);
                    // Aliases from a sibling .cargo/config.toml go first
                    // (user-defined beats synthesized); drop synthesized
                    // duplicates — `cargo {name}` runs the same thing anyway
                    if let Some((_, aliases)) = alias_map.remove(&dir) {
                        tasks.retain(|t| aliases.iter().all(|a| a.name != t.name));
                        tasks.splice(0..0, aliases);
                    }
                    if !tasks.is_empty() {
                        groups.push(DiscoveredTaskGroup {
                            runner: "cargo".into(),
                            label: format!("{label_prefix}cargo tasks"),
                            source_file: rel,
                            cwd,
                            tasks,
                        });
                    }
                }
                _ => {}
            }
        }

        // Aliases without a sibling Cargo.toml (e.g. repo-root .cargo/config.toml
        // for a crate living in a subdir, like musql) get their own group
        let mut leftovers: Vec<(String, (usize, Vec<DiscoveredTask>))> =
            alias_map.into_iter().collect();
        leftovers.sort_by_key(|(_, (i, _))| *i);
        for (base_dir, (i, tasks)) in leftovers {
            let path = &paths[i];
            let rel = if path.starts_with(&root) {
                path[root.len()..].trim_start_matches(['/', '\\']).to_string()
            } else {
                path.clone()
            };
            let base_rel = parent_dir(&parent_dir(&rel));
            let label_prefix = if base_rel.is_empty() {
                String::new()
            } else {
                format!("{base_rel}{sep}")
            };
            groups.push(DiscoveredTaskGroup {
                runner: "cargo".into(),
                label: format!("{label_prefix}cargo alias"),
                source_file: rel,
                cwd: base_dir,
                tasks,
            });
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
    let mut files = find_task_files_raw(shell, root, backend);
    // Committed vendored trees (cargo vendor, composer) aren't gitignored,
    // and their hundreds of manifests would flood the panel
    files.retain(|p| !p.split(['/', '\\']).any(|seg| seg == "vendor"));
    // config.toml is only a cargo task source inside a .cargo directory
    // (the fallback walker matches by bare file name)
    files.retain(|p| {
        !file_name_of(p).eq_ignore_ascii_case(CARGO_CONFIG_NAME)
            || file_name_of(&parent_dir(p)).eq_ignore_ascii_case(".cargo")
    });
    files
}

fn find_task_files_raw(
    shell: &ShellConfig,
    root: &str,
    backend: Option<&crate::search::SearchBackend>,
) -> Vec<String> {
    if let Some(b) = backend {
        if b.is_rg() {
            let depth_arg = format!("{MAX_DEPTH}");
            // --hidden lets rg descend into .cargo/; keep .git excluded
            // (it is only skipped by the hidden filter we just disabled)
            let mut args: Vec<&str> =
                vec!["--files", "--max-depth", &depth_arg, "--hidden", "-g", "!.git"];
            for g in TASK_FILE_GLOBS {
                args.push("-g");
                args.push(g);
            }
            args.push("-g");
            args.push(CARGO_CONFIG_RG_GLOB);
            args.push("--");
            args.push(root);
            if let Ok((code, stdout, _)) = shell.run(b.rg_program(), &args) {
                if code == 0 || !stdout.is_empty() {
                    return stdout.lines().map(|l| l.to_string()).collect();
                }
            }
        }
    }

    // Fallback (no .gitignore awareness): shared find/walk helper.
    let mut names: Vec<&str> = TASK_FILE_GLOBS.to_vec();
    names.push(CARGO_CONFIG_NAME);
    crate::fs::walk_files_by_name(shell, root, &names, MAX_DEPTH)
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

/// Directory-level context for a Cargo.toml, derived from sibling files
/// discovered in the same scan pass.
#[derive(Default)]
struct CargoContext {
    /// tauri.conf.json sits next to the manifest (tauri-cli's own contract)
    is_tauri_app: bool,
    /// An ancestor directory in this project has a [workspace] manifest
    is_workspace_member: bool,
    /// src/main.rs exists next to the manifest (default bin target)
    has_default_bin: bool,
}

/// Task names are interpolated into a shell line by the frontend
/// (RUNNER_COMMANDS), so bin/package names from an untrusted manifest must
/// not carry shell metacharacters. Same guard as parse_makefile_targets.
fn is_safe_cargo_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
}

/// Cargo.toml has no user-defined task list, so synthesize the standard
/// cargo subcommands (workspace roots and standalone packages only — members
/// would duplicate them per crate), `tauri dev`/`tauri build` for Tauri apps,
/// and `run` / `run --bin {name}` for binary targets.
fn cargo_tasks(doc: &toml::Table, ctx: &CargoContext) -> Vec<DiscoveredTask> {
    let package = doc.get("package");
    // A Cargo.toml without [package]/[workspace] is not a manifest root
    if package.is_none() && !doc.contains_key("workspace") {
        return vec![];
    }

    let bins: Vec<&str> = doc
        .get("bin")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|b| b.get("name")?.as_str())
                .filter(|n| is_safe_cargo_name(n))
                .collect()
        })
        .unwrap_or_default();

    let mut subs: Vec<String> = Vec::new();
    if !ctx.is_workspace_member {
        subs.extend(["build", "check", "test", "clippy", "fmt"].map(String::from));
    }
    if ctx.is_tauri_app {
        // Requires tauri-cli (cargo install tauri-cli); harmless to offer
        subs.push("tauri dev".into());
        subs.push("tauri build".into());
    }
    if ctx.has_default_bin {
        if bins.is_empty() {
            subs.push("run".into());
        } else if let Some(pkg) = package
            .and_then(|p| p.get("name"))
            .and_then(|n| n.as_str())
            .filter(|n| is_safe_cargo_name(n))
        {
            // With explicit [[bin]] targets, plain `cargo run` is ambiguous
            subs.push(format!("run --bin {pkg}"));
        }
    }
    subs.extend(bins.iter().map(|b| format!("run --bin {b}")));

    subs.into_iter()
        .map(|sub| DiscoveredTask {
            command: format!("cargo {sub}"),
            name: sub,
            runner: "cargo".into(),
        })
        .collect()
}

/// `.cargo/config.toml` [alias] entries run as `cargo {name}`. Only the name
/// is interpolated into the shell line (so it gets the same metacharacter
/// guard); the expansion is display-only — cargo resolves the alias itself.
fn parse_cargo_aliases(content: &str) -> Vec<DiscoveredTask> {
    let Ok(doc) = content.parse::<toml::Table>() else {
        return vec![];
    };
    let Some(aliases) = doc.get("alias").and_then(|a| a.as_table()) else {
        return vec![];
    };
    aliases
        .iter()
        .filter_map(|(name, val)| {
            if !is_safe_cargo_name(name) {
                return None;
            }
            let expansion = match val {
                toml::Value::String(s) => s.clone(),
                toml::Value::Array(arr) => {
                    let parts: Vec<&str> = arr.iter().filter_map(|v| v.as_str()).collect();
                    if parts.is_empty() {
                        return None;
                    }
                    parts.join(" ")
                }
                _ => return None,
            };
            Some(DiscoveredTask {
                name: name.clone(),
                command: format!("cargo {expansion}"),
                runner: "cargo".into(),
            })
        })
        .collect()
}

fn file_name_of(path: &str) -> &str {
    path.rsplit(['/', '\\']).next().unwrap_or(path)
}

fn parent_dir(path: &str) -> String {
    path.rsplit_once(['/', '\\'])
        .map(|(d, _)| d.to_string())
        .unwrap_or_default()
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


#[cfg(test)]
mod tests {
    use super::*;

    fn table(s: &str) -> toml::Table {
        s.parse().unwrap()
    }

    fn ctx() -> CargoContext {
        CargoContext::default()
    }

    #[test]
    fn cargo_standard_set_with_bins() {
        // Single-quoted TOML literal strings must parse the same as basic strings
        let doc = table(
            r#"
[package]
name = "pike" # comment

[[bin]]
path = "src/bin/verify_pty.rs"
name = "verify_pty"

[[bin]]
name = 'verify_tmux'
"#,
        );
        let tasks = cargo_tasks(&doc, &ctx());
        let names: Vec<&str> = tasks.iter().map(|t| t.name.as_str()).collect();
        assert_eq!(
            names,
            vec![
                "build",
                "check",
                "test",
                "clippy",
                "fmt",
                "run --bin verify_pty",
                "run --bin verify_tmux",
            ]
        );
        assert_eq!(tasks[0].command, "cargo build");
        assert_eq!(tasks[5].command, "cargo run --bin verify_pty");
    }

    #[test]
    fn cargo_tauri_app_context_adds_tauri_tasks() {
        let doc = table("[package]\nname = \"musql\"\n");
        let tasks = cargo_tasks(
            &doc,
            &CargoContext {
                is_tauri_app: true,
                ..Default::default()
            },
        );
        let names: Vec<&str> = tasks.iter().map(|t| t.name.as_str()).collect();
        assert!(names.contains(&"tauri dev"));
        assert!(names.contains(&"tauri build"));
    }

    #[test]
    fn cargo_workspace_member_skips_standard_set() {
        let doc = table("[package]\nname = \"member\"\n\n[[bin]]\nname = \"tool\"\n");
        let tasks = cargo_tasks(
            &doc,
            &CargoContext {
                is_workspace_member: true,
                ..Default::default()
            },
        );
        let names: Vec<&str> = tasks.iter().map(|t| t.name.as_str()).collect();
        assert_eq!(names, vec!["run --bin tool"]);
    }

    #[test]
    fn cargo_unsafe_bin_name_is_excluded() {
        let doc = table("[package]\nname = \"x\"\n\n[[bin]]\nname = \"a; rm -rf /\"\n");
        let tasks = cargo_tasks(&doc, &ctx());
        assert!(tasks.iter().all(|t| !t.name.contains(';')));
    }

    #[test]
    fn cargo_default_bin_offers_run() {
        let doc = table("[package]\nname = \"cli\"\n");
        let with_main = CargoContext {
            has_default_bin: true,
            ..Default::default()
        };
        let names: Vec<String> = cargo_tasks(&doc, &with_main)
            .into_iter()
            .map(|t| t.name)
            .collect();
        assert!(names.contains(&"run".to_string()));

        // With explicit [[bin]] targets, plain run is ambiguous: use the
        // package name for the default target
        let doc = table("[package]\nname = \"cli\"\n\n[[bin]]\nname = \"extra\"\n");
        let names: Vec<String> = cargo_tasks(&doc, &with_main)
            .into_iter()
            .map(|t| t.name)
            .collect();
        assert!(names.contains(&"run --bin cli".to_string()));
        assert!(names.contains(&"run --bin extra".to_string()));
        assert!(!names.contains(&"run".to_string()));
    }

    #[test]
    fn cargo_workspace_only_manifest() {
        let tasks = cargo_tasks(&table("[workspace]\nmembers = [\"a\"]\n"), &ctx());
        let names: Vec<&str> = tasks.iter().map(|t| t.name.as_str()).collect();
        assert_eq!(names, vec!["build", "check", "test", "clippy", "fmt"]);
    }

    #[test]
    fn cargo_non_manifest_yields_nothing() {
        assert!(cargo_tasks(&table("[dependencies]\nserde = \"1\"\n"), &ctx()).is_empty());
    }

    #[test]
    fn cargo_aliases_string_and_array() {
        let tasks = parse_cargo_aliases(
            r#"
[alias]
dev = "tauri dev --config src-tauri/tauri.dev.conf.json"
lint = ["clippy", "--", "-D", "warnings"]
"#,
        );
        let names: Vec<&str> = tasks.iter().map(|t| t.name.as_str()).collect();
        assert_eq!(names, vec!["dev", "lint"]);
        assert_eq!(
            tasks[0].command,
            "cargo tauri dev --config src-tauri/tauri.dev.conf.json"
        );
        assert_eq!(tasks[1].command, "cargo clippy -- -D warnings");
    }

    #[test]
    fn cargo_alias_unsafe_name_is_excluded() {
        let tasks = parse_cargo_aliases("[alias]\n\"a;b\" = \"build\"\nok = \"check\"\n");
        let names: Vec<&str> = tasks.iter().map(|t| t.name.as_str()).collect();
        assert_eq!(names, vec!["ok"]);
    }

    #[test]
    fn cargo_config_without_alias_yields_nothing() {
        assert!(parse_cargo_aliases("[build]\njobs = 4\n").is_empty());
        assert!(parse_cargo_aliases("not toml [").is_empty());
    }
}
