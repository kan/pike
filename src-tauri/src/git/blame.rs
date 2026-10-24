//! エディタの blame（#510）。
//!
//! **保存済みのファイルを blame する**（`git blame --incremental -- <path>`）。編集中の本文を
//! `--contents -` で渡す形は採らない: エディタの本文は改行を LF に、文字コードを UTF-8 に
//! 揃えたものなので、CRLF や Shift_JIS のファイルでは全行が履歴と一致せず「未コミット」に
//! 化ける。保存したあとの編集は、フロントが CodeMirror の変更で行をずらして追いかける
//! （`lib/editorBlame.ts`）。
//!
//! **`--porcelain` ではなく `--incremental` を読む。** 前者は 1 行ごとに本文をタブ付きで
//! 返すので、ファイルの大きさ以上の出力が WSL のパイプを渡る。後者は同じコミットが続く
//! かたまりごとに 1 件で、本文を含まない。
//!
//! 返すのは「コミットの一覧」と「行 → コミットの添字」。行ごとにコミットの情報を並べると、
//! 同じコミットの名前と件名が行数ぶん IPC を渡る。

use crate::types::{ShellConfig, git_args};
use serde::Serialize;
use std::collections::HashMap;

/// blame に出てくるコミット 1 つ。
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BlameCommit {
    pub hash: String,
    pub author: String,
    /// **committer date の UNIX 時刻（秒）。** Pike は日時を committer date で揃えている
    /// （理由は `GitLogEntry.date` の doc）。blame の行からコミットタブを開いたとき、
    /// 同じコミットが違う時刻に見えないようにする。
    pub time: i64,
    /// コミットメッセージの 1 行目。
    pub summary: String,
    /// まだコミットしていない行（作業ツリーにしか無い変更）。git はハッシュを 0 で埋める。
    pub uncommitted: bool,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitBlame {
    pub commits: Vec<BlameCommit>,
    /// 行（0 始まり）→ `commits` の添字。長さはファイルの行数。
    pub lines: Vec<u32>,
}

/// ファイルを blame する。**git が断ったら `None`**（追跡していないファイル、repo の外、
/// まだコミットの無い repo）。ボタンを押した結果ではなく、ファイルを開くたびに走るので、
/// 失敗をエラーとして見せる場面が無い。起こせなかったときだけ `Err` にする。
#[tauri::command]
pub async fn git_blame(
    root: String,
    shell: ShellConfig,
    path: String,
) -> Result<Option<GitBlame>, String> {
    tokio::task::spawn_blocking(move || {
        let (code, stdout, _) = shell.run(
            "git",
            &git_args(&root, &["blame", "--incremental", "--", &path]),
        )?;
        if code != 0 {
            return Ok(None);
        }
        Ok(Some(parse_incremental(&stdout)))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// `git blame --incremental` を読む。
///
/// かたまりごとに `<hash> <元の行> <今の行> <行数>` の見出しが来て、**そのコミットが初めて
/// 出てきたときだけ** `author` / `committer-time` / `summary` などの行が続き、`filename` の
/// 行で終わる。**かたまりは行の順に来るとは限らない**（git は見つけた順に出す）ので、
/// 見出しの「今の行」と行数で埋める。
fn parse_incremental(output: &str) -> GitBlame {
    let mut commits: Vec<BlameCommit> = Vec::new();
    let mut index: HashMap<&str, u32> = HashMap::new();
    let mut lines: Vec<u32> = Vec::new();
    // 見出しを読んだあと、`filename` の行が来るまでのあいだ指しているコミット。
    let mut current: Option<u32> = None;

    for line in output.lines() {
        if let Some(i) = current {
            let commit = &mut commits[i as usize];
            if let Some(v) = line.strip_prefix("author ") {
                v.clone_into(&mut commit.author);
            } else if let Some(v) = line.strip_prefix("committer-time ") {
                commit.time = v.trim().parse().unwrap_or(0);
            } else if let Some(v) = line.strip_prefix("summary ") {
                v.clone_into(&mut commit.summary);
            } else if line.starts_with("filename ") {
                current = None;
            }
            continue;
        }
        // 見出し。ハッシュ（16 進）のあとに数字が 3 つ続く。
        let mut words = line.split(' ');
        let (Some(hash), Some(_orig), Some(start), Some(count)) =
            (words.next(), words.next(), words.next(), words.next())
        else {
            continue;
        };
        let (Ok(start), Ok(count)) = (start.parse::<usize>(), count.parse::<usize>()) else {
            continue;
        };
        if start == 0 || hash.len() < 40 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
            continue;
        }
        let i = *index.entry(hash).or_insert_with(|| {
            commits.push(BlameCommit {
                hash: hash.to_owned(),
                author: String::new(),
                time: 0,
                summary: String::new(),
                uncommitted: hash.bytes().all(|b| b == b'0'),
            });
            (commits.len() - 1) as u32
        });
        let end = start - 1 + count;
        if lines.len() < end {
            lines.resize(end, 0);
        }
        lines[start - 1..end].fill(i);
        current = Some(i);
    }
    GitBlame { commits, lines }
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: &str = "1111111111111111111111111111111111111111";
    const B: &str = "2222222222222222222222222222222222222222";
    const ZERO: &str = "0000000000000000000000000000000000000000";

    /// 見出しの直後に続く、そのコミットが初めて出てきたときの行（`filename` は含まない）。
    fn header(author: &str, time: i64, summary: &str) -> String {
        format!(
            "author {author}\nauthor-mail <a@example.com>\nauthor-time 1\nauthor-tz +0900\n\
             committer {author}\ncommitter-mail <a@example.com>\ncommitter-time {time}\n\
             committer-tz +0900\nsummary {summary}\n",
        )
    }

    #[test]
    fn fills_lines_from_groups_in_any_order() {
        // 3〜4 行目のかたまりが先に来て、1〜2 行目があと。2 回目の A は詳細を持たない。
        let out = format!(
            "{B} 5 3 2\n{}previous {A} src/a.rs\nfilename src/a.rs\n\
             {A} 1 1 1\n{}filename src/a.rs\n\
             {A} 2 2 1\nfilename src/a.rs\n",
            header("Bob", 200, "second"),
            header("Alice", 100, "first"),
        );
        let blame = parse_incremental(&out);
        assert_eq!(blame.lines, vec![1, 1, 0, 0]);
        assert_eq!(blame.commits.len(), 2);
        assert_eq!(blame.commits[0].author, "Bob");
        assert_eq!(blame.commits[0].time, 200);
        assert_eq!(blame.commits[1].summary, "first");
        assert!(!blame.commits[1].uncommitted);
    }

    #[test]
    fn zero_hash_is_uncommitted() {
        let out = format!(
            "{ZERO} 1 1 1\n{}filename src/a.rs\n",
            header(
                "Not Committed Yet",
                300,
                "Version of src/a.rs from src/a.rs"
            ),
        );
        let blame = parse_incremental(&out);
        assert!(blame.commits[0].uncommitted);
        assert_eq!(blame.lines, vec![0]);
    }

    #[test]
    fn empty_output_is_an_empty_blame() {
        let blame = parse_incremental("");
        assert!(blame.commits.is_empty());
        assert!(blame.lines.is_empty());
    }
}
