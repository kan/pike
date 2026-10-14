//! worktree の作成と削除（#478）。削除は `git_worktree_remove`（下の方）。
//!
//! 作成の段取りは `git_worktree_add` の 1 本で、フロントは置き場所（`lib/worktreeCreate.ts` が
//! 設定から組んだパス）・ブランチ名・ベース・持っていくファイルのパターンを渡すだけ。
//!
//! - **置き場所の計算はフロント**（設定の `${repoName}` と相対パスの解決、テストもあちら）。
//!   ここで行うのは先頭の `~` の展開だけで、WSL の `$HOME` は distro に聞かないと分からない
//! - **重なったらエラーにする**（利用者の判断）。VS Code のように `-1` を付けて逃がさない。
//!   ブランチは `BRANCH_EXISTS`、ディレクトリは `PATH_EXISTS` の綴りで返し、文言はフロントの i18n
//! - **repo の中に作るときは `.git/info/exclude` に足す**（利用者の判断）。足さないと、
//!   worktree のディレクトリが main 側の untracked に並び、ファイルツリーと検索にも入る。
//!   コミットされる `.gitignore` は触らない
//! - **ファイルのコピーは best effort**。失敗したものは名前を返し、worktree の作成は
//!   失敗にしない（VS Code の `git.worktreeIncludeFiles` と同じ）
use super::{run_git, validate_ref_name};
use crate::types::{
    ShellConfig, bash_quote, cwd_under_root, decode_console_output, git_args, into_lossy_string,
    starts_with_segment,
};
use serde::Serialize;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fmt::Write as _;
use std::path::Path;
use std::time::Duration;

/// 作成・コピー・削除の待ち時間。**30 秒では足りない**: 大きいリポジトリのチェックアウトと、
/// `node_modules` のような丸ごとのディレクトリのコピーと削除はそれを超える。
const LONG_TIMEOUT: Duration = Duration::from_secs(600);

/// そのブランチが既にある。フロントはこの綴りで見分けて i18n の文言を出す。
const BRANCH_EXISTS: &str = "branch-exists";
/// 置き場所に何かが既にある（ディレクトリでもファイルでも）。
const PATH_EXISTS: &str = "path-exists";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeAdded {
    /// 作った worktree のパス（`~` は展開済み）。
    pub path: String,
    /// コピーした単位の数（丸ごとコピーしたディレクトリは 1 つと数える）。
    pub copied: usize,
    /// コピーできなかったもの（root からの相対パス）。
    pub failed: Vec<String>,
    /// 補助の処理（`.git/info/exclude` への追記・コピーするものの列挙）の失敗。worktree は
    /// できているので、エラーにはせず知らせるだけにする。
    pub warnings: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeRemoved {
    /// ブランチも消すよう頼まれたのに消さなかったとき、git の理由（マージされていない等）。
    /// worktree は消えているので、エラーにはせず知らせるだけにする。
    pub branch_kept: Option<String>,
}

/// worktree を消す。`force` は未コミットの変更・未追跡のファイルがあっても消す
/// （フロントが確認を取ってから立てる）。`locked` なら `--force` を 2 回重ねる（git は lock
/// された worktree を 1 回の `--force` では消さない）。`branch` を渡すと、そのあと
/// `git branch -d` で消す。**`-D` にはしない**: マージしていないコミットは残す（消せなければ
/// `branch_kept` で知らせる）。
///
/// gitignore 済みのファイル（`node_modules` など）は `--force` 無しでも一緒に消える（git の仕様）。
/// どれが main か・参照中かの判定はフロント（`stores/worktree.ts` の `removeWorktree`）。
#[tauri::command]
pub async fn git_worktree_remove(
    root: String,
    shell: ShellConfig,
    path: String,
    force: bool,
    locked: bool,
    branch: Option<String>,
) -> Result<WorktreeRemoved, String> {
    tokio::task::spawn_blocking(move || {
        if let Some(b) = &branch {
            validate_ref_name(b)?;
        }
        let mut args = vec!["worktree", "remove"];
        if force || locked {
            args.push("--force");
        }
        if locked {
            args.push("--force");
        }
        args.extend(["--", path.as_str()]);
        run_git_long(&shell, &root, &args)?;
        let branch_kept = branch.and_then(|b| run_git(&shell, &root, &["branch", "-d", &b]).err());
        Ok(WorktreeRemoved { branch_kept })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// worktree を新しいブランチで作る。`root` は main の worktree（コピーの元でもある）、
/// `include` は持っていく gitignore 済みのファイルのパターン（`.gitignore` 構文）。
#[tauri::command]
pub async fn git_worktree_add(
    root: String,
    shell: ShellConfig,
    path: String,
    branch: String,
    base: String,
    include: Vec<String>,
) -> Result<WorktreeAdded, String> {
    tokio::task::spawn_blocking(move || add(&shell, &root, &path, &branch, &base, &include))
        .await
        .map_err(|e| e.to_string())?
}

fn add(
    shell: &ShellConfig,
    root: &str,
    path: &str,
    branch: &str,
    base: &str,
    include: &[String],
) -> Result<WorktreeAdded, String> {
    // 自前の検査はフラグの注入を止めるため。名前として正しいかは git に決めさせる
    // （`.lock` で終わる、`/.` を含む、のような規則まで写さない）。
    validate_ref_name(branch)?;
    validate_ref_name(base)?;
    run_git(shell, root, &["check-ref-format", "--branch", branch])?;

    let path = expand_home(shell, path)?;
    if branch_exists(shell, root, branch)? {
        return Err(BRANCH_EXISTS.to_owned());
    }
    if crate::fs::path_exists(shell, &path)? {
        return Err(PATH_EXISTS.to_owned());
    }

    // `--no-track`: ベースにリモートのブランチ（`origin/main`）を選んだとき、git の既定
    // （`branch.autoSetupMerge`）は新しいブランチの upstream をそれにする。名前の違う
    // ブランチを追跡させると、`git push` が既定の `push.default=simple` で断られる。
    run_git_long(
        shell,
        root,
        &[
            "worktree",
            "add",
            "--no-track",
            "-b",
            branch,
            "--",
            &path,
            base,
        ],
    )?;

    let mut warnings = Vec::new();
    let location = exclude_target(shell, root, &path);
    if let Some(rel) = &location
        && let Err(e) = ensure_excluded(shell, root, rel)
    {
        warnings.push(e);
    }

    let (copied, failed) = if include.is_empty() {
        (0, Vec::new())
    } else {
        match copy_targets(shell, root, include) {
            Ok(mut units) => {
                // 置き場所が repo の中なら、そこ（ほかの worktree の作業ツリー）は持っていかない。
                // exclude に足したあとは無視されたディレクトリとして並び、`*` のような広い
                // パターンに一致する。
                if let Some(rel) = &location {
                    units.retain(|u| u != rel && !u.starts_with(&format!("{rel}/")));
                }
                copy_units(shell, root, &path, &units)
            }
            Err(e) => {
                warnings.push(e);
                (0, Vec::new())
            }
        }
    };

    Ok(WorktreeAdded {
        path,
        copied,
        failed,
        warnings,
    })
}

/// `run_git` の待ち時間を `LONG_TIMEOUT` にした版。失敗は git の stderr をそのまま返す。
fn run_git_long(shell: &ShellConfig, root: &str, args: &[&str]) -> Result<String, String> {
    let out = shell.run_with_timeout("git", &git_args(root, args), LONG_TIMEOUT)?;
    if !out.status.success() {
        return Err(decode_console_output(out.stderr).trim().to_owned());
    }
    // `-z` の出力をそのまま読むので、行ごとに文字コードを推し量る `decode_console_output`
    // ではなく UTF-8 として読む（`git_args` が `core.quotePath=false` を付けている）。
    Ok(into_lossy_string(out.stdout))
}

/// 先頭の `~` をそのシェルから見たホームに置き換える。`~user` の形は扱わない。
fn expand_home(shell: &ShellConfig, path: &str) -> Result<String, String> {
    let rest = match path.strip_prefix('~') {
        Some(rest) if rest.is_empty() || rest.starts_with(['/', '\\']) => rest,
        _ => return Ok(path.to_owned()),
    };
    let (home, _) = crate::claude_usage::config::shell_home(shell)
        .ok_or_else(|| "could not resolve the home directory".to_owned())?;
    Ok(format!("{home}{rest}"))
}

fn branch_exists(shell: &ShellConfig, root: &str, branch: &str) -> Result<bool, String> {
    let refname = format!("refs/heads/{branch}");
    let args = git_args(root, &["show-ref", "--verify", "--quiet", &refname]);
    // `--quiet` は無いときに 1 で抜ける。それ以外の非 0 はリポジトリが読めなかった。
    match shell.run("git", &args)? {
        (0, _, _) => Ok(true),
        (1, _, _) => Ok(false),
        (_, _, stderr) => Err(stderr.trim().to_owned()),
    }
}

/// `path` が `root` の中なら、`.git/info/exclude` に足すディレクトリ（root からの相対、
/// `/` 区切り）。置き場所のディレクトリ（`.worktrees`）を返し、置き場所が root そのものなら
/// worktree 自身を返す。外なら `None`。
fn exclude_target(shell: &ShellConfig, root: &str, path: &str) -> Option<String> {
    let rel = relative_to_root(shell, root, path)?;
    Some(match rel.rsplit_once('/') {
        Some((dir, _)) => dir.to_owned(),
        None => rel,
    })
}

/// `path` の `root` からの相対パス（`/` 区切り）。配下でなければ `None`。
///
/// 配下かどうかは `cwd_under_root`（Windows は区切りの混在と大小を吸収する）に任せ、
/// ここは区切りを `/` に揃えて root の長さで切り出すだけにする。
fn relative_to_root(shell: &ShellConfig, root: &str, path: &str) -> Option<String> {
    if !cwd_under_root(shell, path, root) {
        return None;
    }
    let root = root.replace('\\', "/");
    let path = path.replace('\\', "/");
    let rel = path
        .get(root.trim_end_matches('/').len()..)?
        .trim_matches('/');
    (!rel.is_empty()).then(|| rel.to_owned())
}

/// `rel`（root からの相対のディレクトリ）が git に無視されていなければ、`.git/info/exclude`
/// に 1 行足す。**判定は作ったあとの `git status` で行う**: まだ無いディレクトリは
/// `check-ignore` に渡しても「ディレクトリだけに効くパターン」（`/.worktrees/`）と照合されない。
fn ensure_excluded(shell: &ShellConfig, root: &str, rel: &str) -> Result<(), String> {
    let status = run_git(
        shell,
        root,
        &[
            "status",
            "--porcelain",
            "--untracked-files=normal",
            "--",
            rel,
        ],
    )?;
    // **そのディレクトリ自身が丸ごと untracked として並ぶときだけ足す。** 何か出たかで決めると、
    // 置き場所が追跡済みのディレクトリ（`src` など）のとき、中の変更済みファイルに反応して
    // `/src/` を丸ごと exclude し、以後そこに作ったファイルが untracked に出なくなる。
    let untracked_dir = format!("?? {rel}/");
    if !status.lines().any(|l| l.trim_end() == untracked_dir) {
        return Ok(());
    }
    // `info/` は linked worktree からでも共有の gitdir を指す。既定では相対で返るので、
    // `--path-format=absolute`（git 2.31 以降）で絶対パスにさせる。
    let file = run_git(
        shell,
        root,
        &[
            "rev-parse",
            "--path-format=absolute",
            "--git-path",
            "info/exclude",
        ],
    )?;
    let file = file.trim();
    let mut text = crate::fs::read_text(shell, file)?.unwrap_or_default();
    if !text.is_empty() && !text.ends_with('\n') {
        text.push('\n');
    }
    let _ = write!(text, "# git worktree (Pike)\n/{rel}/\n");
    crate::fs::write_bytes_atomic(shell, file, text.as_bytes())
}

/// 持っていくものの一覧。`include` に一致し、かつ git に無視されている untracked の
/// ファイル（`.gitignore` 構文で照合させるため、列挙は git に任せる）。
///
/// 畳んだ一覧とパターンの一覧は並べて取る（互いに依存しない。WSL では 1 回ごとに `wsl.exe`
/// を起こす）。パターンは `-x` で渡す（`--exclude-from` はファイルが要り、WSL へ一時ファイルを
/// 渡す経路を持たない）。標準の除外と同じ呼び出しに入れると和集合になるので、パターンだけの
/// 列挙は別に取る。**畳まない全件の列挙は、選ばれたファイルを持つディレクトリに絞る**
/// （pathspec）。絞らないと、`.env` だけを持っていくときにも `target/` の数十万ファイルを並べる。
///
/// **パターン側の列挙は `--directory` で畳まない。** 畳むと、一部だけ選んだ無視された
/// ディレクトリ（`config/` の中の `config/local.json` だけ）が列挙から消える（実測）。
fn copy_targets(
    shell: &ShellConfig,
    root: &str,
    include: &[String],
) -> Result<Vec<String>, String> {
    const IGNORED: [&str; 5] = [
        "ls-files",
        "--others",
        "--ignored",
        "--exclude-standard",
        "-z",
    ];
    let mut collapsed_args = IGNORED.to_vec();
    collapsed_args.extend(["--directory", "--no-empty-directory"]);
    let mut matched_args = vec!["ls-files", "--others", "--ignored", "-z"];
    for pattern in include {
        matched_args.push("-x");
        matched_args.push(pattern);
    }
    let (collapsed, matched) = std::thread::scope(|s| {
        let collapsed = s.spawn(|| run_git_long(shell, root, &collapsed_args));
        let matched = run_git_long(shell, root, &matched_args);
        let collapsed = collapsed
            .join()
            .unwrap_or_else(|_| Err("ls-files panicked".to_owned()));
        (collapsed, matched)
    });
    let (collapsed, matched) = (collapsed?, matched?);
    let (units, picked) = pick(&split_z(&collapsed), &split_z(&matched));
    let ignored = if picked.is_empty() {
        String::new()
    } else {
        let mut args = IGNORED.to_vec();
        args.push("--");
        args.extend(picked.keys().copied());
        run_git_long(shell, root, &args)?
    };
    Ok(plan_copy(units, picked, &split_z(&ignored)))
}

fn split_z(output: &str) -> Vec<&str> {
    output.split('\0').filter(|s| !s.is_empty()).collect()
}

/// 選ばれたファイルの振り分け（`plan_copy` の前半）。
///
/// - `collapsed`: 無視されている untracked を `--directory` で畳んだ一覧。丸ごと無視された
///   ディレクトリ（追跡ファイルを持たないもの）は `dir/` の 1 行、それ以外は 1 ファイル 1 行
/// - `matched`: パターンに一致する untracked のファイル
///
/// 戻り値は（そのままコピーするファイル、丸ごと無視されたディレクトリごとの選ばれたファイル）。
/// **無視されていないファイルは落とす**: 丸ごと無視されたディレクトリの中にも無く、畳んだ一覧に
/// ファイルとしても無いもの（利用者がまだ add していないだけのファイル）。
fn pick<'a>(
    collapsed: &[&'a str],
    matched: &[&'a str],
) -> (Vec<String>, BTreeMap<&'a str, Vec<&'a str>>) {
    let dirs: HashSet<&str> = collapsed
        .iter()
        .filter_map(|e| e.strip_suffix('/'))
        .collect();
    let files: HashSet<&str> = collapsed
        .iter()
        .copied()
        .filter(|e| !e.ends_with('/'))
        .collect();
    let mut units = Vec::new();
    let mut picked: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    for &file in matched {
        // 畳まれた一覧は入れ子にならないので、最初に当たった祖先が持ち主。
        let owner = file
            .match_indices('/')
            .map(|(i, _)| &file[..i])
            .find(|dir| dirs.contains(dir));
        match owner {
            Some(dir) => picked.entry(dir).or_default().push(file),
            None if files.contains(file) => units.push(file.to_owned()),
            None => {}
        }
    }
    (units, picked)
}

/// コピーする単位（root からの相対パス）を決める。`ignored_in_picked` は、`pick` が返した
/// ディレクトリの中の無視されているファイル全部（中身の数を数えるためだけに使う）。
///
/// **丸ごと無視されたディレクトリの中身が全部選ばれていたら、ディレクトリを 1 単位にする**
/// （VS Code と同じ）。`node_modules` を 1 ファイルずつコピーすると、WSL では数万回の
/// `cp` になる。一部だけ選ばれていればファイルごとにする。
fn plan_copy(
    mut units: Vec<String>,
    picked: BTreeMap<&str, Vec<&str>>,
    ignored_in_picked: &[&str],
) -> Vec<String> {
    let mut total: HashMap<&str, usize> = HashMap::new();
    for file in ignored_in_picked {
        if let Some(dir) = picked.keys().find(|d| starts_with_segment(file, d, '/')) {
            *total.entry(dir).or_default() += 1;
        }
    }
    for (dir, files) in picked {
        if total.get(dir) == Some(&files.len()) {
            units.push(dir.to_owned());
        } else {
            units.extend(files.into_iter().map(str::to_owned));
        }
    }
    units.sort();
    units
}

/// `units` を `root` から `dest` へ同じ相対パスでコピーする。**宛先に既にあるものは
/// 触らない**: main では無視されていても、ベースのブランチでは追跡されているファイルがある。
/// ただし**ディレクトリの単位が宛先にあるときは失敗として返す**（ベースのブランチがその中の
/// ファイルを追跡している）。混ぜてコピーはしないので、中の `.env` が来なかったことを知らせる。
/// コピーの途中で失敗したら作りかけを消す。戻り値は（コピーした数、失敗したもの）。
fn copy_units(
    shell: &ShellConfig,
    root: &str,
    dest: &str,
    units: &[String],
) -> (usize, Vec<String>) {
    if units.is_empty() {
        return (0, Vec::new());
    }
    match shell {
        ShellConfig::Wsl { .. } => copy_units_wsl(shell, root, dest, units),
        _ => copy_units_native(root, dest, units),
    }
}

/// distro の中で `cp -a` する（1 回の `wsl.exe`）。一覧は NUL 区切りで標準入力に渡す。
/// 1 単位ごとに `+`（コピーした）か `!<名前>`（失敗）を 1 行出させて数える。
fn copy_units_wsl(
    shell: &ShellConfig,
    root: &str,
    dest: &str,
    units: &[String],
) -> (usize, Vec<String>) {
    // 宛先にあるディレクトリは失敗として返す（`copy_units` の doc）。失敗したら作りかけを消す。
    let line = format!(
        "dest={}; while IFS= read -r -d '' f; do t=\"$dest/$f\"; \
         if [ -e \"$t\" ] || [ -L \"$t\" ]; then \
         if [ -d \"$f\" ] && [ ! -L \"$f\" ]; then printf '!%s\\n' \"$f\"; fi; continue; fi; \
         if mkdir -p -- \"${{t%/*}}\" && cp -a -- \"$f\" \"$t\" 2>/dev/null; \
         then echo +; else rm -rf -- \"$t\"; printf '!%s\\n' \"$f\"; fi; done",
        bash_quote(dest)
    );
    // `read -d ''` は区切りで終わらない最後の 1 つを返さないので、末尾にも NUL を置く。
    let input: String = units.iter().map(|u| format!("{u}\0")).collect();
    match shell.run_posix_line_stdin(root, &line, &input, LONG_TIMEOUT) {
        Ok((_, stdout, _)) => {
            let copied = stdout.lines().filter(|l| *l == "+").count();
            let failed = stdout
                .lines()
                .filter_map(|l| l.strip_prefix('!'))
                .map(str::to_owned)
                .collect();
            (copied, failed)
        }
        // 走らなかったなら全部失敗として返す（どれがコピーされたか分からない）。
        Err(_) => (0, units.to_vec()),
    }
}

fn copy_units_native(root: &str, dest: &str, units: &[String]) -> (usize, Vec<String>) {
    let mut copied = 0;
    let mut failed = Vec::new();
    for unit in units {
        let src = Path::new(root).join(unit);
        let dst = Path::new(dest).join(unit);
        if std::fs::symlink_metadata(&dst).is_ok() {
            let src_is_dir = std::fs::symlink_metadata(&src).is_ok_and(|m| m.is_dir());
            if src_is_dir {
                failed.push(unit.clone());
            }
            continue;
        }
        let result = match dst.parent() {
            Some(parent) => std::fs::create_dir_all(parent),
            None => Ok(()),
        }
        .and_then(|()| {
            // 単位の中を指す絶対パスのリンクを付け替える起点。junction の `read_link` は
            // `\\?\C:\…` の形で返すので、正規化した形でも比べる。
            let canonical = std::fs::canonicalize(&src).ok();
            let from: Vec<&Path> = std::iter::once(src.as_path())
                .chain(canonical.as_deref())
                .collect();
            copy_tree(&src, &dst, &from, &dst)
        });
        match result {
            Ok(()) => copied += 1,
            Err(_) => {
                let _ = if dst.is_dir() {
                    std::fs::remove_dir_all(&dst)
                } else {
                    std::fs::remove_file(&dst)
                };
                failed.push(unit.clone());
            }
        }
    }
    (copied, failed)
}

/// ファイルかディレクトリを再帰的にコピーする（ホスト側）。**symlink は辿らず、symlink のまま
/// 写す**（WSL の腕の `cp -a` と同じ扱い）。ファイルツリーの「コピー」（`fs_copy`）は辿る別物で、
/// 利用者が手で選んだものを写すのでそちらは変えない。
///
/// - `node_modules/.bin` の中身は相対の symlink で、実体をコピーすると `__dirname` が変わって
///   動かなくなる
/// - Windows の junction（pnpm の `node_modules`）も std では symlink に数えられる。辿ると
///   サイズが何倍にもなり、祖先を指すものがあれば再帰が止まらない
/// - **コピーする単位の中（`from`）を指す絶対パスのリンクは、コピー先（`to`）の同じ場所へ
///   付け替える**。junction は必ず絶対パスなので、付け替えないと worktree の `node_modules` が
///   main の `.pnpm` を使い続ける
/// - Windows で symlink を作るには開発者モードか管理者の権限が要る。作れなければその
///   エラーを返す（中身をコピーする形へは落とさない。上の 2 つが戻る）。種別はリンク自身の
///   属性で決める（リンク先が無くても、ディレクトリのリンクはディレクトリのリンクのまま）
fn copy_tree(src: &Path, dst: &Path, from: &[&Path], to: &Path) -> std::io::Result<()> {
    let meta = std::fs::symlink_metadata(src)?;
    if meta.file_type().is_symlink() {
        let target = std::fs::read_link(src)?;
        let target = if target.is_absolute() {
            from.iter()
                .find_map(|f| target.strip_prefix(f).ok())
                .map_or_else(|| target.clone(), |rest| to.join(rest))
        } else {
            target
        };
        #[cfg(unix)]
        return std::os::unix::fs::symlink(target, dst);
        #[cfg(windows)]
        {
            use std::os::windows::fs::FileTypeExt as _;
            return if meta.file_type().is_symlink_dir() {
                std::os::windows::fs::symlink_dir(target, dst)
            } else {
                std::os::windows::fs::symlink_file(target, dst)
            };
        }
    }
    if meta.is_dir() {
        std::fs::create_dir_all(dst)?;
        for entry in std::fs::read_dir(src)? {
            let entry = entry?;
            copy_tree(&entry.path(), &dst.join(entry.file_name()), from, to)?;
        }
        Ok(())
    } else {
        std::fs::copy(src, dst).map(|_| ())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `pick` と `plan_copy` を通しで回す（`ignored` は全件を渡してよい。数えるのは選ばれた
    /// ディレクトリの中だけ）。
    fn plan(ignored: &[&str], collapsed: &[&str], matched: &[&str]) -> Vec<String> {
        let (units, picked) = pick(collapsed, matched);
        plan_copy(units, picked, ignored)
    }

    fn wsl() -> ShellConfig {
        ShellConfig::Wsl {
            distro: "Ubuntu".into(),
        }
    }

    /// 丸ごと無視されたディレクトリは、中身が全部選ばれていれば 1 単位になる。
    #[test]
    fn plan_copy_collapses_wholly_selected_directories() {
        let ignored = [
            ".env",
            "node_modules/a/index.js",
            "node_modules/b/index.js",
            "dist/app.js",
        ];
        let collapsed = [".env", "node_modules/", "dist/"];
        let matched = [".env", "node_modules/a/index.js", "node_modules/b/index.js"];
        assert_eq!(
            plan(&ignored, &collapsed, &matched),
            vec![".env".to_owned(), "node_modules".to_owned()]
        );
    }

    /// 一部だけ選ばれたディレクトリは、選ばれたファイルだけを写す。
    #[test]
    fn plan_copy_keeps_files_of_partially_selected_directories() {
        let ignored = ["config/local.json", "config/cache.bin"];
        let collapsed = ["config/"];
        let matched = ["config/local.json"];
        assert_eq!(
            plan(&ignored, &collapsed, &matched),
            vec!["config/local.json".to_owned()]
        );
    }

    /// パターンに一致しても、無視されていない（＝利用者がまだ add していないだけの）
    /// ファイルは持っていかない。
    #[test]
    fn plan_copy_skips_files_that_are_not_ignored() {
        let ignored = [".env"];
        let collapsed = [".env"];
        let matched = [".env", "notes.txt"];
        assert_eq!(
            plan(&ignored, &collapsed, &matched),
            vec![".env".to_owned()]
        );
    }

    /// 追跡ファイルを含むディレクトリの中の無視されたファイルは、畳まれずに 1 行ずつ来る。
    #[test]
    fn plan_copy_handles_ignored_files_inside_tracked_directories() {
        let ignored = ["src/.env.local"];
        let collapsed = ["src/.env.local"];
        let matched = ["src/.env.local"];
        assert_eq!(
            plan(&ignored, &collapsed, &matched),
            vec!["src/.env.local".to_owned()]
        );
    }

    /// 単位の中を指す絶対パスのリンクはコピー先へ付け替え、外を指すものと相対のものは残す。
    #[cfg(unix)]
    #[test]
    fn copy_tree_rebases_links_inside_the_unit() {
        let base = std::env::temp_dir().join(format!("pike-copytree-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let src = base.join("src/node_modules");
        std::fs::create_dir_all(src.join(".pnpm/a")).unwrap();
        std::os::unix::fs::symlink(src.join(".pnpm/a"), src.join("a")).unwrap();
        std::os::unix::fs::symlink("/usr", src.join("outside")).unwrap();
        std::os::unix::fs::symlink(".pnpm/a", src.join("rel")).unwrap();
        let dst = base.join("dst/node_modules");
        std::fs::create_dir_all(dst.parent().unwrap()).unwrap();
        copy_tree(&src, &dst, &[src.as_path()], &dst).unwrap();
        assert_eq!(
            std::fs::read_link(dst.join("a")).unwrap(),
            dst.join(".pnpm/a")
        );
        assert_eq!(
            std::fs::read_link(dst.join("outside")).unwrap(),
            Path::new("/usr")
        );
        assert_eq!(
            std::fs::read_link(dst.join("rel")).unwrap(),
            Path::new(".pnpm/a")
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn relative_to_root_on_posix() {
        let sh = wsl();
        assert_eq!(
            relative_to_root(&sh, "/home/u/pike", "/home/u/pike/.worktrees/x"),
            Some(".worktrees/x".to_owned())
        );
        assert_eq!(
            relative_to_root(&sh, "/home/u/pike", "/home/u/pike.worktrees/x"),
            None
        );
        assert_eq!(
            relative_to_root(&sh, "/home/u/pike/", "/home/u/pike/x"),
            Some("x".to_owned())
        );
    }

    /// Windows は区切りの混在と大小を吸収する。
    #[test]
    fn relative_to_root_on_windows() {
        let sh = ShellConfig::Pwsh;
        assert_eq!(
            relative_to_root(&sh, "C:/src/pike", "c:\\src\\pike\\.worktrees\\x"),
            Some(".worktrees/x".to_owned())
        );
        assert_eq!(
            relative_to_root(&sh, "C:\\src\\pike", "C:\\src\\pike.worktrees\\x"),
            None
        );
    }

    #[test]
    fn exclude_target_is_the_location_directory() {
        let sh = wsl();
        assert_eq!(
            exclude_target(&sh, "/r", "/r/.worktrees/feat"),
            Some(".worktrees".to_owned())
        );
        // 置き場所が root そのもの（`.`）なら worktree 自身。
        assert_eq!(
            exclude_target(&sh, "/r", "/r/feat"),
            Some("feat".to_owned())
        );
        assert_eq!(exclude_target(&sh, "/r", "/r.worktrees/feat"), None);
    }

    #[test]
    fn expand_home_leaves_other_paths_alone() {
        let sh = wsl();
        assert_eq!(expand_home(&sh, "/abs/x").unwrap(), "/abs/x");
        // `~user` は展開しない（ホームを引きに行かないので distro を起こさない）。
        assert_eq!(expand_home(&sh, "~other/x").unwrap(), "~other/x");
    }
}
