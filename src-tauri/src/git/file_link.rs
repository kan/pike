//! エディタの行をホスティングサービスで開くための git の情報（#540）。URL を組むのはフロントの
//! `lib/gitRemote.ts` の `buildFileLink` で、ここは材料を集めるだけ。
//!
//! - **ファイルのディレクトリで git を走らせる。** プロジェクトのルートはリポジトリのトップと
//!   一致するとは限らない（モノレポのサブディレクトリを登録できる）し、worktree やサブモジュールの
//!   中のファイルもある。サブモジュールは親とは別のリポジトリなので、origin もここで取る
//! - **WSL は 1 回の `wsl.exe` に束ねる**（`remote_urls_wsl` と同じ、位置で読む形）。他のシェルは
//!   git を順に起こす（プロセスの起動が安いので、スクリプトの引用を 2 通り持たない）
//! - **クリックしてから 1 回だけ取る。** メニューを開くたびに外部プロセスを起こさない
use super::{origin_url, run_git};
use crate::types::{ShellConfig, bash_quote, git_bash_prefix};
use serde::Serialize;

#[derive(Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileLinkInfo {
    /// リポジトリのトップからのパス（`/` 区切り）。**`None` は HEAD のコミットに無い**（未追跡・
    /// ステージしただけ・リポジトリの外・まだコミットが無い）で、フロントはそこで止める。
    /// 見るのは index ではなく HEAD の木（`ls-tree`）: ステージしただけのファイルはリモートに無い。
    path: Option<String>,
    /// HEAD のコミットの完全な SHA。まだコミットが無ければ `None`。
    head: Option<String>,
    /// HEAD のブランチ名。detached なら `None`。
    branch: Option<String>,
    /// そのファイルが属するリポジトリの origin。
    remote_url: Option<String>,
    /// HEAD が origin のリモート追跡ブランチから辿れるか（＝その SHA のリンクが開ける）。
    /// **origin に限る**: リンクは origin に向けて作るので、upstream にだけある SHA は 404 になる。
    head_pushed: bool,
    /// `origin/<branch>` のコミットの SHA。無ければ `None`（未 publish か detached）。未 push の
    /// ときにブランチ名で開けるかはこれで決まる。Bitbucket はブランチ名に `/` があると
    /// パスにこの SHA を置く（`buildFileLink`）。
    branch_commit: Option<String>,
    /// そのファイルが `branch_commit` の木にあるか（未 push のコミットで足したファイルは無い）。
    /// HEAD が push 済みなら見ない（`false` のまま）。
    branch_has_file: bool,
    /// そのファイルに未コミットの変更があるか（行がリモートとずれうる）。
    dirty: bool,
}

/// パスをディレクトリと名前に割る。区切りは `/` と `\` のどちらも受ける（WSL と Windows）。
fn split_file(path: &str) -> Result<(&str, &str), String> {
    let (dir, name) = path
        .rsplit_once(['/', '\\'])
        .ok_or_else(|| format!("not an absolute path: {path}"))?;
    if name.is_empty() {
        return Err(format!("not a file: {path}"));
    }
    // `/a.txt` と `C:\a.txt` のディレクトリはルート（区切りまで含める）。`-C ''` は無効で、
    // `-C C:` はドライブのルートではなく、そのドライブのカレントディレクトリになる。
    Ok(if dir.is_empty() || dir.ends_with(':') {
        (&path[..=dir.len()], name)
    } else {
        (dir, name)
    })
}

/// ファイル名を pathspec として読ませない（`foo[1].ts` が `foo1.ts` に、`:x` が magic に化ける）。
/// git の全体のオプションなので、サブコマンドの前に置く。
const LITERAL: &str = "--literal-pathspecs";

/// git の出力の 1 行目（空なら `None`）。**`types::first_line` とは別物**: あちらは長い行を
/// 切り詰めるので、パスや URL には使えない。
fn output_line(s: &str) -> Option<String> {
    s.lines()
        .next()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(str::to_owned)
}

/// `rev-list -1 HEAD --not --remotes=origin` が失敗したときに出す印。空（＝push 済み）と見分ける。
const REV_LIST_FAILED: &str = "error";

/// WSL で走らせる 1 本のスクリプト。**1 行に 1 つ、`parse_wsl` の順で出す**。
/// HEAD に無いファイルなら 1 行目を出さずに終える（残りの git を走らせない）。
fn wsl_script(dir: &str, name: &str) -> String {
    let g = git_bash_prefix(dir);
    let n = bash_quote(name);
    // 各行は必ず改行で終える（値が無くても行の数は変えない）。
    format!(
        "p=$({g} {LITERAL} ls-tree --full-name --name-only HEAD -- {n} 2>/dev/null | head -n1 | tr -d '\\r\\n'); [ -n \"$p\" ] || exit 0; printf '%s\\n' \"$p\"\n\
         {g} rev-parse -q --verify HEAD 2>/dev/null | tr -d '\\r\\n'; echo\n\
         b=$({g} symbolic-ref -q --short HEAD 2>/dev/null); printf '%s\\n' \"$b\"\n\
         {g} remote get-url origin 2>/dev/null | head -n1 | tr -d '\\r\\n'; echo\n\
         r=$({g} rev-list -1 HEAD --not --remotes=origin 2>/dev/null) || r={REV_LIST_FAILED}; printf '%s\\n' \"$r\" | head -n1\n\
         c=; [ -n \"$b\" ] && c=$({g} rev-parse -q --verify \"refs/remotes/origin/$b\" 2>/dev/null | tr -d '\\r\\n'); printf '%s\\n' \"$c\"\n\
         {g} {LITERAL} status --porcelain -- {n} 2>/dev/null | head -n1 | tr -d '\\r\\n'; echo\n\
         if [ -n \"$c\" ] && {g} cat-file -e \"$c:$p\" 2>/dev/null; then echo 1; else echo; fi"
    )
}

/// `wsl_script` の出力を読む。**行が足りなければ HEAD に無いものとして返す**（そこで打ち切ったか、
/// distro が起きなかった。行が足りないまま位置で読むと、別の値を別の欄に入れる）。
fn parse_wsl(stdout: &str) -> FileLinkInfo {
    let lines: Vec<&str> = stdout.lines().map(str::trim).collect();
    if lines.len() < 8 || lines[0].is_empty() {
        return FileLinkInfo::default();
    }
    let opt = |i: usize| (!lines[i].is_empty()).then(|| lines[i].to_owned());
    let head = opt(1);
    let head_pushed = head.is_some() && lines[4].is_empty();
    FileLinkInfo {
        path: opt(0),
        head_pushed,
        head,
        branch: opt(2),
        remote_url: opt(3),
        branch_commit: opt(5),
        dirty: !lines[6].is_empty(),
        branch_has_file: !head_pushed && lines[7] == "1",
    }
}

/// WSL 以外。git を順に起こし、HEAD に無いファイルならそこで止める。
fn collect_native(shell: &ShellConfig, dir: &str, name: &str) -> FileLinkInfo {
    let git = |args: &[&str]| run_git(shell, dir, args);
    let line = |args: &[&str]| git(args).ok().and_then(|s| output_line(&s));
    let path = line(&[
        LITERAL,
        "ls-tree",
        "--full-name",
        "--name-only",
        "HEAD",
        "--",
        name,
    ]);
    let Some(path) = path else {
        return FileLinkInfo::default();
    };
    let head = line(&["rev-parse", "-q", "--verify", "HEAD"]);
    let branch = line(&["symbolic-ref", "-q", "--short", "HEAD"]);
    let remote_url = origin_url(shell, dir);
    let branch_commit = branch.as_ref().and_then(|b| {
        line(&[
            "rev-parse",
            "-q",
            "--verify",
            &format!("refs/remotes/origin/{b}"),
        ])
    });
    // origin のブランチが HEAD と同じなら push 済みと分かる（いちばん多い場合で 1 本省く）。
    // それ以外は rev-list に聞き、失敗は「push されていない」に倒す（開けないリンクを黙って
    // 作らない）。
    let head_pushed = head.is_some()
        && (branch_commit == head
            || git(&["rev-list", "-1", "HEAD", "--not", "--remotes=origin"])
                .is_ok_and(|s| s.trim().is_empty()));
    // ブランチで開くかを聞くときだけ要る。
    let branch_has_file = !head_pushed
        && branch_commit
            .as_ref()
            .is_some_and(|c| git(&["cat-file", "-e", &format!("{c}:{path}")]).is_ok());
    let dirty =
        git(&[LITERAL, "status", "--porcelain", "--", name]).is_ok_and(|s| !s.trim().is_empty());
    FileLinkInfo {
        path: Some(path),
        head,
        branch,
        remote_url,
        head_pushed,
        branch_commit,
        branch_has_file,
        dirty,
    }
}

/// `path` は `shell` の作法の絶対パス（WSL なら distro の中のパス）。
#[tauri::command]
pub async fn git_file_link_info(shell: ShellConfig, path: String) -> Result<FileLinkInfo, String> {
    tokio::task::spawn_blocking(move || {
        let (dir, name) = split_file(&path)?;
        match &shell {
            ShellConfig::Wsl { .. } => {
                let (_, stdout, _) = shell.run("bash", &["-c", &wsl_script(dir, name)])?;
                Ok(parse_wsl(&stdout))
            }
            _ => Ok(collect_native(&shell, dir, name)),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_both_separators() {
        assert_eq!(
            split_file("/home/me/repo/a b.rs").unwrap(),
            ("/home/me/repo", "a b.rs")
        );
        assert_eq!(
            split_file(r"C:\src\repo\x.ts").unwrap(),
            (r"C:\src\repo", "x.ts")
        );
        assert_eq!(split_file("/a.txt").unwrap(), ("/", "a.txt"));
        // ドライブ直下は区切りまで含める（`-C C:` はドライブのカレントディレクトリになる）。
        assert_eq!(split_file(r"C:\a.txt").unwrap(), (r"C:\", "a.txt"));
        assert!(split_file("/home/me/").is_err());
        assert!(split_file("relative.txt").is_err());
    }

    #[test]
    fn reads_the_wsl_lines_by_position() {
        let out = "src/a.rs\nabc123\nmain\ngit@github.com:kan/pike.git\n\ndef456\n\n1\n";
        assert_eq!(
            parse_wsl(out),
            FileLinkInfo {
                path: Some("src/a.rs".into()),
                head: Some("abc123".into()),
                branch: Some("main".into()),
                remote_url: Some("git@github.com:kan/pike.git".into()),
                head_pushed: true,
                branch_commit: Some("def456".into()),
                // push 済みならブランチの木は見ない。
                branch_has_file: false,
                dirty: false,
            }
        );
    }

    #[test]
    fn unpushed_detached_and_dirty() {
        // rev-list が HEAD を返した（origin から辿れない）・detached・変更あり。
        let out = "a.rs\nabc123\n\nhttps://github.com/kan/pike\nabc123\n\n M a.rs\n\n";
        let info = parse_wsl(out);
        assert!(!info.head_pushed);
        assert_eq!(info.branch, None);
        assert_eq!(info.branch_commit, None);
        assert!(!info.branch_has_file);
        assert!(info.dirty);
    }

    #[test]
    fn unpushed_with_the_file_on_the_branch() {
        let out = "a.rs\nabc123\nmain\nx\nabc123\ndef456\n\n1\n";
        let info = parse_wsl(out);
        assert!(!info.head_pushed);
        assert!(info.branch_has_file);
    }

    #[test]
    fn a_failed_rev_list_is_not_pushed() {
        let out = format!("a.rs\nabc123\nmain\nx\n{REV_LIST_FAILED}\n\n\n\n");
        assert!(!parse_wsl(&out).head_pushed);
    }

    #[test]
    fn short_output_reads_as_untracked() {
        // distro が起きなかった。位置がずれた値を返さない。
        assert_eq!(parse_wsl("src/a.rs\n"), FileLinkInfo::default());
        assert_eq!(parse_wsl(""), FileLinkInfo::default());
        // 1 行目が空（未追跡）なら、他の欄があっても使わない。
        assert_eq!(
            parse_wsl("\nabc\nmain\nx\n\n\n\n\n"),
            FileLinkInfo::default()
        );
        // 古い 7 行の形（最後の欄が無い）も位置で読まない。
        assert_eq!(
            parse_wsl("a.rs\nabc\nmain\nx\n\n\n\n"),
            FileLinkInfo::default()
        );
    }
}
