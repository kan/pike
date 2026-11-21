//! 大きなファイルビューアの編集（#630）。行単位のピーステーブルと、その履歴。
//!
//! 文書は「元のファイルの行の範囲」と「編集で入れた行」の並び（`Piece`）で表す。**持つのは
//! 編集で入れた行だけ**で、元のファイルの行はその都度ファイルから読む（`large.rs`）。1GB のログの
//! 1 行を直しても、増えるメモリはその 1 行とピースの数個ぶんで済む。
//!
//! **単位を行にしてある**（バイトや文字ではない）。表示も編集も行で扱い、検索の問い合わせは改行を
//! 含まないので、一致は必ず 1 つのピースの中に収まる（ピースをまたぐ一致を考えなくてよい）。
//!
//! 履歴はピースの並びの写しを積む（`History`）。追加した行は `Arc` で共有し、ピースはその範囲を
//! 指す（`Added`）ので、写しも分割もピースの数ぶんの小さな配列で済む。

use std::sync::Arc;

/// 文書の一部分。
#[derive(Clone, Debug)]
pub(crate) enum Piece {
    /// 元のファイルの行 `start..start + count`。
    Source { start: u64, count: u64 },
    /// 編集で入れた行（改行を含まない）の `buf[from..from + len]`。空にはしない。**範囲で持つ**:
    /// 分割のたびに行を写すと、大量に貼り付けた行の中の 1 行を直すたびに全部を写し直す。
    Added {
        buf: Arc<[String]>,
        from: usize,
        len: usize,
    },
}

/// 同じ行を指していれば等しい（共有のしかたは問わない）。
impl PartialEq for Piece {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (
                Piece::Source { start, count },
                Piece::Source {
                    start: s2,
                    count: c2,
                },
            ) => start == s2 && count == c2,
            (Piece::Added { .. }, Piece::Added { .. }) => self.added() == other.added(),
            _ => false,
        }
    }
}

impl Piece {
    /// 編集で入れた行のピース。
    pub(crate) fn added_from(lines: Vec<String>) -> Self {
        let len = lines.len();
        Piece::Added {
            buf: lines.into(),
            from: 0,
            len,
        }
    }

    /// 編集で入れた行（`Source` なら空）。
    pub(crate) fn added(&self) -> &[String] {
        match self {
            Piece::Source { .. } => &[],
            Piece::Added { buf, from, len } => &buf[*from..*from + *len],
        }
    }

    pub(crate) fn len(&self) -> u64 {
        match self {
            Piece::Source { count, .. } => *count,
            Piece::Added { len, .. } => *len as u64,
        }
    }

    /// 先頭から `n` 行と、残りに分ける（`0 < n < len`）。
    fn split(&self, n: u64) -> (Piece, Piece) {
        match self {
            Piece::Source { start, count } => (
                Piece::Source {
                    start: *start,
                    count: n,
                },
                Piece::Source {
                    start: start + n,
                    count: count - n,
                },
            ),
            Piece::Added { buf, from, len } => {
                let n = n as usize;
                (
                    Piece::Added {
                        buf: Arc::clone(buf),
                        from: *from,
                        len: n,
                    },
                    Piece::Added {
                        buf: Arc::clone(buf),
                        from: from + n,
                        len: len - n,
                    },
                )
            }
        }
    }
}

/// 行単位のピーステーブル。
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct PieceTable {
    pieces: Vec<Piece>,
}

impl PieceTable {
    /// 元のファイルの `lines` 行そのままの文書。
    pub(crate) fn pristine(lines: u64) -> Self {
        Self {
            pieces: vec![Piece::Source {
                start: 0,
                count: lines,
            }],
        }
    }

    pub(crate) fn pieces(&self) -> &[Piece] {
        &self.pieces
    }

    /// 文書の行数。
    pub(crate) fn len(&self) -> u64 {
        self.pieces.iter().map(Piece::len).sum()
    }

    /// 文書の行 `start` から `delete` 行を、`insert` の行で置き換える。範囲は文書の末尾で切る。
    /// **文書は最低 1 行**（エディタと同じく、全部消しても空の行が 1 つ残る）。
    pub(crate) fn replace(&mut self, start: u64, delete: u64, insert: Vec<String>) {
        let total = self.len();
        let start = start.min(total);
        let end = start.saturating_add(delete).min(total);
        let mut out = Vec::with_capacity(self.pieces.len() + 2);
        let mut at = 0u64;
        // 入れる行は 1 度だけ置く（置いたら `None`）。
        let mut insert = Some(insert);
        let put_insert = |out: &mut Vec<Piece>, insert: &mut Option<Vec<String>>| {
            if let Some(lines) = insert.take()
                && !lines.is_empty()
            {
                out.push(Piece::added_from(lines));
            }
        };
        for piece in &self.pieces {
            let len = piece.len();
            let (p_start, p_end) = (at, at + len);
            at = p_end;
            if p_end <= start {
                // 置き換える範囲より前。ただし範囲の先頭がこのピースの末尾ちょうどなら、後で入れる。
                out.push(piece.clone());
                continue;
            }
            if p_start >= end {
                put_insert(&mut out, &mut insert);
                out.push(piece.clone());
                continue;
            }
            // 範囲と重なる。前に残る部分・後ろに残る部分を切り出す。
            let mut rest = piece.clone();
            if start > p_start {
                let (head, tail) = rest.split(start - p_start);
                out.push(head);
                rest = tail;
            }
            put_insert(&mut out, &mut insert);
            if end < p_end {
                let keep = p_end - end;
                let drop = rest.len() - keep;
                if drop == 0 {
                    out.push(rest);
                } else {
                    out.push(rest.split(drop).1);
                }
            }
        }
        put_insert(&mut out, &mut insert);
        out.retain(|p| p.len() > 0);
        if out.is_empty() {
            out.push(Piece::added_from(vec![String::new()]));
        }
        self.pieces = merge_adjacent(out);
    }

    /// 文書の行 `line` がどのピースの何行目か。末尾より後ろなら `None`。
    pub(crate) fn locate(&self, line: u64) -> Option<(usize, u64)> {
        let mut at = 0;
        for (i, p) in self.pieces.iter().enumerate() {
            if line < at + p.len() {
                return Some((i, line - at));
            }
            at += p.len();
        }
        None
    }

    /// 文書の行 `start` から `count` 行に当たるピースを順に（ピース, ピースの中の先頭の行, 行数）で
    /// 返す。文書の末尾で切る。
    pub(crate) fn range(&self, start: u64, count: u64) -> impl Iterator<Item = (&Piece, u64, u64)> {
        let (first, mut off) = self.locate(start).unwrap_or((self.pieces.len(), 0));
        let mut left = count;
        self.pieces[first..].iter().map_while(move |p| {
            if left == 0 {
                return None;
            }
            let want = (p.len() - off).min(left);
            let item = (p, off, want);
            left -= want;
            off = 0;
            Some(item)
        })
    }

    /// 各ピースの文書の上の先頭の行。
    pub(crate) fn starts(&self) -> Vec<u64> {
        let mut at = 0;
        self.pieces
            .iter()
            .map(|p| {
                let s = at;
                at += p.len();
                s
            })
            .collect()
    }
}

/// 隣り合う、元のファイルの続いた範囲をまとめる（取り消しを重ねてもピースが増え続けない）。
fn merge_adjacent(pieces: Vec<Piece>) -> Vec<Piece> {
    let mut out: Vec<Piece> = Vec::with_capacity(pieces.len());
    for p in pieces {
        if let (
            Some(Piece::Source { start, count }),
            Piece::Source {
                start: s2,
                count: c2,
            },
        ) = (out.last_mut(), &p)
            && *start + *count == *s2
        {
            *count += c2;
            continue;
        }
        out.push(p);
    }
    out
}

/// 取り消せる数の上限。古いものから捨てる。
const MAX_HISTORY: usize = 200;

/// 編集の履歴。`snaps[cursor]` が今の文書で、`saved` は保存した（または開いた）ときの版。
#[derive(Debug)]
pub(crate) struct History {
    snaps: Vec<(u64, PieceTable)>,
    cursor: usize,
    next_id: u64,
    saved: u64,
}

impl History {
    /// 元のファイルの `lines` 行のままの文書。保存済みとして始める。
    pub(crate) fn new(lines: u64) -> Self {
        Self {
            snaps: vec![(0, PieceTable::pristine(lines))],
            cursor: 0,
            next_id: 1,
            saved: 0,
        }
    }

    pub(crate) fn current(&self) -> &PieceTable {
        &self.snaps[self.cursor].1
    }

    /// 保存したときの版から変わっているか。
    pub(crate) fn dirty(&self) -> bool {
        self.snaps[self.cursor].0 != self.saved
    }

    pub(crate) fn can_undo(&self) -> bool {
        self.cursor > 0
    }

    pub(crate) fn can_redo(&self) -> bool {
        self.cursor + 1 < self.snaps.len()
    }

    /// 編集を 1 つ積む。取り消した先の履歴は捨てる。
    pub(crate) fn edit(&mut self, start: u64, delete: u64, insert: Vec<String>) {
        let mut next = self.current().clone();
        next.replace(start, delete, insert);
        if next == *self.current() {
            return;
        }
        self.snaps.truncate(self.cursor + 1);
        self.snaps.push((self.next_id, next));
        self.next_id += 1;
        if self.snaps.len() > MAX_HISTORY {
            self.snaps.remove(0);
        }
        self.cursor = self.snaps.len() - 1;
    }

    pub(crate) fn undo(&mut self) {
        if self.can_undo() {
            self.cursor -= 1;
        }
    }

    pub(crate) fn redo(&mut self) {
        if self.can_redo() {
            self.cursor += 1;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn src(start: u64, count: u64) -> Piece {
        Piece::Source { start, count }
    }

    fn added(lines: &[&str]) -> Piece {
        Piece::added_from(strings(lines))
    }

    #[test]
    fn range_walks_the_pieces_that_cover_the_lines() {
        let mut t = PieceTable::pristine(10);
        t.replace(3, 2, strings(&["a", "b", "c"]));
        // 文書は 元 0..3 / 入れた 3 行 / 元 5..10。
        let got: Vec<_> = t
            .range(2, 5)
            .map(|(p, off, want)| (p.len(), off, want))
            .collect();
        assert_eq!(got, vec![(3, 2, 1), (3, 0, 3), (5, 0, 1)]);
        assert_eq!(t.range(9, 100).map(|(_, _, n)| n).sum::<u64>(), 2);
        assert_eq!(t.range(50, 3).count(), 0);
        assert_eq!(t.range(0, 0).count(), 0);
    }

    #[test]
    fn splitting_added_lines_shares_the_buffer() {
        let mut t = PieceTable::pristine(1);
        t.replace(1, 0, strings(&["a", "b", "c"]));
        t.replace(2, 1, strings(&["B"]));
        let bufs: Vec<_> = t
            .pieces()
            .iter()
            .filter_map(|p| match p {
                Piece::Added { buf, len: 1, .. } if buf.len() == 3 => Some(Arc::clone(buf)),
                _ => None,
            })
            .collect();
        assert_eq!(bufs.len(), 2, "a と c は元の 3 行のバッファの範囲");
        assert!(Arc::ptr_eq(&bufs[0], &bufs[1]));
    }

    fn strings(lines: &[&str]) -> Vec<String> {
        lines.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn replace_one_line_in_the_middle() {
        let mut t = PieceTable::pristine(10);
        t.replace(4, 1, strings(&["x"]));
        assert_eq!(t.pieces(), &[src(0, 4), added(&["x"]), src(5, 5)]);
        assert_eq!(t.len(), 10);
    }

    #[test]
    fn insert_and_delete_change_the_length() {
        let mut t = PieceTable::pristine(10);
        t.replace(3, 0, strings(&["a", "b"]));
        assert_eq!(t.pieces(), &[src(0, 3), added(&["a", "b"]), src(3, 7)]);
        assert_eq!(t.len(), 12);
        t.replace(0, 2, Vec::new());
        assert_eq!(t.pieces(), &[src(2, 1), added(&["a", "b"]), src(3, 7)]);
        assert_eq!(t.len(), 10);
    }

    #[test]
    fn edits_at_both_ends() {
        let mut t = PieceTable::pristine(3);
        t.replace(0, 0, strings(&["head"]));
        t.replace(4, 0, strings(&["tail"]));
        assert_eq!(t.pieces(), &[added(&["head"]), src(0, 3), added(&["tail"])]);
        // 範囲が末尾を越えても末尾で切る。
        t.replace(3, 99, strings(&["end"]));
        assert_eq!(t.pieces(), &[added(&["head"]), src(0, 2), added(&["end"])]);
    }

    #[test]
    fn edits_inside_added_lines_split_them() {
        let mut t = PieceTable::pristine(2);
        t.replace(1, 0, strings(&["a", "b", "c"]));
        t.replace(2, 1, strings(&["B"]));
        assert_eq!(
            t.pieces(),
            &[
                src(0, 1),
                added(&["a"]),
                added(&["B"]),
                added(&["c"]),
                src(1, 1)
            ]
        );
        assert_eq!(t.locate(3), Some((3, 0)));
        assert_eq!(t.locate(4), Some((4, 0)));
        assert_eq!(t.locate(5), None);
        assert_eq!(t.starts(), vec![0, 1, 2, 3, 4]);
    }

    #[test]
    fn a_range_across_pieces_is_replaced_once() {
        let mut t = PieceTable::pristine(10);
        t.replace(2, 1, strings(&["x"]));
        t.replace(6, 1, strings(&["y"]));
        t.replace(1, 7, strings(&["z"]));
        assert_eq!(t.pieces(), &[src(0, 1), added(&["z"]), src(8, 2)]);
    }

    #[test]
    fn deleting_everything_leaves_one_empty_line() {
        let mut t = PieceTable::pristine(5);
        t.replace(0, 5, Vec::new());
        assert_eq!(t.pieces(), &[added(&[""])]);
        assert_eq!(t.len(), 1);
    }

    #[test]
    fn deleting_then_restoring_source_lines_merges_them() {
        let mut t = PieceTable::pristine(10);
        t.replace(5, 0, strings(&["x"]));
        t.replace(5, 1, Vec::new());
        assert_eq!(t.pieces(), &[src(0, 10)]);
    }

    #[test]
    fn history_tracks_dirty_undo_and_redo() {
        let mut h = History::new(10);
        assert!(!h.dirty() && !h.can_undo());
        h.edit(0, 1, strings(&["a"]));
        assert!(h.dirty() && h.can_undo() && !h.can_redo());
        h.undo();
        assert!(
            !h.dirty(),
            "取り消して開いたときの版に戻ったら未保存ではない"
        );
        assert!(h.can_redo());
        h.redo();
        assert!(h.dirty());
        // 取り消した先で編集すると、やり直しの履歴は捨てる。
        h.undo();
        h.edit(1, 1, strings(&["b"]));
        assert!(!h.can_redo());
        assert_eq!(h.current().pieces()[1], added(&["b"]));
    }

    #[test]
    fn an_edit_that_changes_nothing_is_not_recorded() {
        let mut h = History::new(3);
        h.edit(1, 0, Vec::new());
        assert!(!h.can_undo());
    }
}
