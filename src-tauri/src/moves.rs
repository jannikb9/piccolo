//! Finding code that was moved rather than written: a run of removed lines that comes back as
//! added lines elsewhere, in another file or another part of the same one, maybe re-indented and
//! maybe with a few lines changed on the way.
//!
//! Lines are compared without their indentation. Matches start at lines with some substance (not
//! a lone `}`), take in the lines around them that match too, and the longest are taken first. A
//! removed line and an added line in the same run of changes are an edit in place, never a move.
//! Matches a few changed lines apart between the same two runs make one move "with changes".
//!
//! The diff then leaves out the removed side of a move (the reviewer sees a note in its place)
//! and keeps the added side, where the app marks what is the same as before.

use crate::imports::{hide_no_newline_notes, hunk_rows, pieces, split_files};
use serde::Serialize;
use std::collections::{HashMap, HashSet};

/// Shortest run of lines that counts as a move.
const MIN_LINES: usize = 3;
/// Lines with letters or digits in a move, at least.
const MIN_SUBSTANTIAL: usize = 2;
/// Characters other than whitespace in a move, at least.
const MIN_CHARS: usize = 40;
/// Changed lines between two matches that still make one move.
const MAX_GAP: usize = 3;
/// A line this common (an often repeated statement) doesn't start a match.
const MAX_OCCURRENCES: usize = 64;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Block {
    /// The file's path in the diff: its new path, or the old one for a deleted file.
    pub path: String,
    /// First and last line, on the old side for the removed lines, on the new side for the added.
    pub start: u32,
    pub end: u32,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Move {
    pub from: Block,
    pub to: Block,
    /// The removed lines were left out of the patch. They stay in a deleted file, which would
    /// otherwise be left with nothing to show.
    pub hidden: bool,
    /// Lines of `to` that are the same as before, as `[first, last]` ranges.
    pub same: Vec<[u32; 2]>,
    /// The moved lines before and after, for showing what changed on the way.
    pub old_text: String,
    pub new_text: String,
}

/// A removed or added line, in patch order.
#[derive(Debug)]
struct Line<'a> {
    file: usize,
    /// The run of changes it is in (rows of `+` and `-` between unchanged lines), across files.
    run: usize,
    line: u32,
    text: &'a str,
    /// Without indentation and line break.
    key: &'a str,
}

impl Line<'_> {
    fn substantial(&self) -> bool {
        self.key.chars().any(char::is_alphanumeric)
    }

    /// The line after `prev` in the same run, so both belong to one block.
    fn follows(&self, prev: &Line) -> bool {
        self.run == prev.run && self.line == prev.line + 1
    }
}

/// A match between `len` removed lines from `del` and added lines from `add`.
#[derive(Debug, Clone, Copy)]
struct Match {
    del: usize,
    add: usize,
    len: usize,
}

/// Finds the moves in `patch` and leaves their removed lines out of it.
pub fn find(patch: &str) -> (String, Vec<Move>) {
    let files = split_files(patch);
    let paths: Vec<Option<(Option<&str>, Option<&str>)>> = files.iter().map(|f| f.paths()).collect();
    let (dels, adds) = lines(&files);
    let mut moves = Vec::new();
    for found in merged(&dels, &adds, matches(&dels, &adds)) {
        let (from, to) = (&dels[found.del..found.del + found.len_del], &adds[found.add..found.add + found.len_add]);
        let path = |file: usize| {
            let (old, new) = paths[file].expect("files with changes have paths");
            new.or(old).expect("a file has a path on one side").to_string()
        };
        let from_file = from[0].file;
        let hidden = matches!(paths[from_file], Some((Some(_), Some(_))));
        let before: HashSet<&str> = from.iter().map(|l| l.key).collect();
        let mut same: Vec<[u32; 2]> = Vec::new();
        for line in to.iter().filter(|l| before.contains(l.key)) {
            match same.last_mut() {
                Some(range) if range[1] + 1 == line.line => range[1] = line.line,
                _ => same.push([line.line, line.line]),
            }
        }
        let text = |lines: &[Line]| lines.iter().map(|l| l.text[1..].trim_end_matches(['\n', '\r'])).collect::<Vec<_>>().join("\n");
        moves.push(Move {
            from: Block { path: path(from_file), start: from[0].line, end: from[from.len() - 1].line },
            to: Block { path: path(to[0].file), start: to[0].line, end: to[to.len() - 1].line },
            hidden,
            same,
            old_text: text(from),
            new_text: text(to),
        });
    }
    moves.sort_by(|a, b| (&a.to.path, a.to.start).cmp(&(&b.to.path, b.to.start)));
    if !moves.iter().any(|m| m.hidden) {
        return (patch.to_string(), moves);
    }

    let mut out = String::with_capacity(patch.len());
    for (file, file_paths) in files.iter().zip(&paths) {
        let key = file_paths.and_then(|(old, new)| new.or(old));
        let hide: Vec<&Move> = moves.iter().filter(|m| m.hidden && Some(m.from.path.as_str()) == key).collect();
        out.push_str(&file.header.concat());
        for hunk in &file.hunks {
            let Some((mut rows, heading)) = (!hide.is_empty()).then(|| hunk_rows(hunk)).flatten() else {
                out.push_str(&hunk.concat());
                continue;
            };
            for row in rows.iter_mut().filter(|r| r.kind() == b'-') {
                row.hidden = hide.iter().any(|m| (m.from.start..=m.from.end).contains(&(row.old as u32)));
            }
            hide_no_newline_notes(&mut rows);
            // What's around a move stays, so its note has a place.
            pieces(&rows, heading, true).iter().for_each(|piece| out.push_str(piece));
        }
    }
    (out, moves)
}

/// The removed and the added lines of every file, in patch order.
fn lines<'a>(files: &[crate::imports::FilePatch<'a>]) -> (Vec<Line<'a>>, Vec<Line<'a>>) {
    let (mut dels, mut adds) = (Vec::new(), Vec::new());
    let mut run = 0;
    for (file, patch) in files.iter().enumerate() {
        for hunk in &patch.hunks {
            let Some((rows, _)) = hunk_rows(hunk) else { continue };
            let mut in_run = false;
            for row in &rows {
                let (list, line) = match row.kind() {
                    b'-' => (&mut dels, row.old),
                    b'+' => (&mut adds, row.new),
                    b'\\' => continue,
                    _ => {
                        in_run = false;
                        continue;
                    }
                };
                if !in_run {
                    run += 1;
                    in_run = true;
                }
                let key = row.text[1..].trim();
                list.push(Line { file, run, line: line as u32, text: row.text, key });
            }
        }
    }
    (dels, adds)
}

/// The longest matches of removed and added lines that don't share a line, longest first.
fn matches(dels: &[Line], adds: &[Line]) -> Vec<Match> {
    let mut by_key: HashMap<&str, Vec<usize>> = HashMap::new();
    for (i, line) in adds.iter().enumerate().filter(|(_, l)| l.substantial()) {
        by_key.entry(line.key).or_default().push(i);
    }
    let mut seen = HashSet::new();
    let mut found = Vec::new();
    for (i, del) in dels.iter().enumerate().filter(|(_, l)| l.substantial()) {
        let Some(candidates) = by_key.get(del.key) else { continue };
        if candidates.len() > MAX_OCCURRENCES {
            continue;
        }
        for &j in candidates {
            // In the same run of changes, it's an edit in place (such as a new indentation).
            if adds[j].run == del.run {
                continue;
            }
            let (mut d, mut a) = (i, j);
            while d > 0 && a > 0 && dels[d].follows(&dels[d - 1]) && adds[a].follows(&adds[a - 1]) && dels[d - 1].key == adds[a - 1].key {
                d -= 1;
                a -= 1;
            }
            if !seen.insert((d, a)) {
                continue;
            }
            let mut len = 1;
            while d + len < dels.len()
                && a + len < adds.len()
                && dels[d + len].follows(&dels[d + len - 1])
                && adds[a + len].follows(&adds[a + len - 1])
                && dels[d + len].key == adds[a + len].key
            {
                len += 1;
            }
            found.push(Match { del: d, add: a, len });
        }
    }
    let weight = |m: &Match| dels[m.del..m.del + m.len].iter().map(|l| l.key.chars().filter(|c| !c.is_whitespace()).count()).sum::<usize>();
    found.sort_by_key(|m| (std::cmp::Reverse(m.len), std::cmp::Reverse(weight(m))));

    let (mut used_del, mut used_add) = (vec![false; dels.len()], vec![false; adds.len()]);
    let mut taken = Vec::new();
    for m in found {
        if used_del[m.del..m.del + m.len].iter().any(|&u| u) || used_add[m.add..m.add + m.len].iter().any(|&u| u) {
            continue;
        }
        let lines = &dels[m.del..m.del + m.len];
        let substantial = lines.iter().filter(|l| l.substantial()).count();
        if m.len < MIN_LINES || substantial < MIN_SUBSTANTIAL || weight(&m) < MIN_CHARS {
            continue;
        }
        used_del[m.del..m.del + m.len].fill(true);
        used_add[m.add..m.add + m.len].fill(true);
        taken.push(m);
    }
    taken
}

/// A move: removed lines `del..del + len_del`, added lines `add..add + len_add`.
#[derive(Debug, Clone, Copy)]
struct Found {
    del: usize,
    len_del: usize,
    add: usize,
    len_add: usize,
}

/// Matches joined into moves where a few changed lines separate them, between the same runs.
fn merged(dels: &[Line], adds: &[Line], mut matches: Vec<Match>) -> Vec<Found> {
    matches.sort_by_key(|m| (m.del, m.add));
    let mut moves: Vec<Found> = Vec::new();
    for m in matches {
        if let Some(last) = moves.last_mut() {
            let (del_end, add_end) = (last.del + last.len_del, last.add + last.len_add);
            let contiguous = |lines: &[Line], from: usize, to: usize| (from..to).all(|k| lines[k + 1].follows(&lines[k]));
            if m.del >= del_end
                && m.add >= add_end
                && m.del - del_end <= MAX_GAP
                && m.add - add_end <= MAX_GAP
                && contiguous(dels, last.del, m.del)
                && contiguous(adds, last.add, m.add)
            {
                last.len_del = m.del + m.len - last.del;
                last.len_add = m.add + m.len - last.add;
                continue;
            }
        }
        moves.push(Found { del: m.del, len_del: m.len, add: m.add, len_add: m.len });
    }
    // Lines changed on the way at either end, such as a signature that became `pub`.
    let taken = |moves: &[Found], d: usize, a: usize| {
        moves.iter().any(|f| (f.del..f.del + f.len_del).contains(&d) || (f.add..f.add + f.len_add).contains(&a))
    };
    for i in 0..moves.len() {
        for _ in 0..MAX_GAP {
            let f = moves[i];
            let (Some(d), Some(a)) = (f.del.checked_sub(1), f.add.checked_sub(1)) else { break };
            if !dels[f.del].follows(&dels[d]) || !adds[f.add].follows(&adds[a]) || taken(&moves, d, a) || !similar(&dels[d], &adds[a]) {
                break;
            }
            moves[i] = Found { del: d, len_del: f.len_del + 1, add: a, len_add: f.len_add + 1 };
        }
        for _ in 0..MAX_GAP {
            let f = moves[i];
            let (d, a) = (f.del + f.len_del, f.add + f.len_add);
            if d >= dels.len() || a >= adds.len() || !dels[d].follows(&dels[d - 1]) || !adds[a].follows(&adds[a - 1]) || taken(&moves, d, a) || !similar(&dels[d], &adds[a]) {
                break;
            }
            moves[i] = Found { len_del: f.len_del + 1, len_add: f.len_add + 1, ..f };
        }
    }
    moves
}

/// Two lines with mostly the same words, like a line and its edit.
fn similar(a: &Line, b: &Line) -> bool {
    let words = |l: &Line| -> HashSet<String> {
        l.key.split(|c: char| !c.is_alphanumeric() && c != '_').filter(|w| !w.is_empty()).map(str::to_string).collect()
    };
    let (a, b) = (words(a), words(b));
    let union = a.union(&b).count();
    union > 0 && a.intersection(&b).count() * 2 >= union
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file_patch(path: &str, hunks: &[&str]) -> String {
        format!("diff --git a/{path} b/{path}\nindex 1111111..2222222 100644\n--- a/{path}\n+++ b/{path}\n{}", hunks.concat())
    }

    const BODY: [&str; 4] = ["let total = items.iter().map(|i| i.price).sum();", "if total > limit {", "    return Err(TooMuch(total));", "}"];

    #[test]
    fn finds_a_function_moved_to_another_file() {
        let mut from = String::from("@@ -1,8 +1,2 @@\n fn a() {}\n-fn check(items: &[Item]) {\n");
        BODY.iter().for_each(|l| from.push_str(&format!("-    {l}\n")));
        from.push_str("-}\n fn b() {}\n");
        let mut to = String::from("@@ -1,1 +1,7 @@\n fn c() {}\n+pub fn check(items: &[Item]) {\n");
        BODY.iter().for_each(|l| to.push_str(&format!("+    {l}\n")));
        to.push_str("+}\n");
        let patch = file_patch("a.rs", &[&from]) + &file_patch("b.rs", &[&to]);

        let (shown, moves) = find(&patch);
        assert_eq!(moves.len(), 1);
        let m = &moves[0];
        assert_eq!(m.from, Block { path: "a.rs".into(), start: 2, end: 7 });
        assert_eq!(m.to, Block { path: "b.rs".into(), start: 2, end: 7 });
        assert!(m.hidden);
        assert_eq!(m.same, vec![[3, 7]]);
        assert!(m.old_text.starts_with("fn check(") && m.new_text.starts_with("pub fn check("));
        // The removed side is gone, what was around it stays.
        assert!(shown.contains("@@ -1,1 +1,1 @@\n fn a() {}\n@@ -8,1 +2,1 @@\n fn b() {}\n"), "{shown}");
        assert!(shown.contains("+pub fn check("));
    }

    #[test]
    fn re_indenting_in_place_is_no_move() {
        let mut hunk = String::from("@@ -1,4 +1,6 @@\n+if ok {\n");
        BODY.iter().for_each(|l| hunk.push_str(&format!("-{l}\n")));
        BODY.iter().for_each(|l| hunk.push_str(&format!("+    {l}\n")));
        hunk.push_str("+}\n");
        let (shown, moves) = find(&file_patch("a.rs", &[&hunk]));
        assert!(moves.is_empty());
        assert!(shown.contains("-if total > limit {"));
    }

    #[test]
    fn short_or_trivial_runs_are_no_move() {
        let from = "@@ -1,4 +1,1 @@\n a\n-}\n-}\n-x = 1\n";
        let to = "@@ -1,1 +1,4 @@\n b\n+}\n+}\n+x = 1\n";
        let (_, moves) = find(&(file_patch("a.py", &[from]) + &file_patch("b.py", &[to])));
        assert!(moves.is_empty());
    }

    #[test]
    fn a_few_changed_lines_make_one_move_with_changes() {
        let old = ["alpha = compute_alpha(x)", "beta = compute_beta(alpha)", "gamma = compute_gamma(beta)", "old_line(1)", "delta = compute_delta(gamma)", "epsilon = compute_eps(delta)", "zeta = compute_zeta(epsilon)"];
        let new = ["alpha = compute_alpha(x)", "beta = compute_beta(alpha)", "gamma = compute_gamma(beta)", "new_line(2)", "delta = compute_delta(gamma)", "epsilon = compute_eps(delta)", "zeta = compute_zeta(epsilon)"];
        let mut from = String::from("@@ -1,8 +1,1 @@\n a\n");
        old.iter().for_each(|l| from.push_str(&format!("-{l}\n")));
        let mut to = String::from("@@ -1,1 +1,8 @@\n b\n");
        new.iter().for_each(|l| to.push_str(&format!("+{l}\n")));
        let (_, moves) = find(&(file_patch("a.py", &[&from]) + &file_patch("b.py", &[&to])));
        assert_eq!(moves.len(), 1);
        assert_eq!((moves[0].from.start, moves[0].from.end, moves[0].to.start, moves[0].to.end), (2, 8, 2, 8));
        assert_eq!(moves[0].same, vec![[2, 4], [6, 8]]);
    }

    #[test]
    fn moves_out_of_a_deleted_file_stay_in_it() {
        let mut from = String::from("diff --git a/old.rs b/old.rs\ndeleted file mode 100644\nindex 1111111..0000000\n--- a/old.rs\n+++ /dev/null\n@@ -1,4 +0,0 @@\n");
        BODY.iter().for_each(|l| from.push_str(&format!("-{l}\n")));
        let mut to = String::from("@@ -1,1 +1,5 @@\n x\n");
        BODY.iter().for_each(|l| to.push_str(&format!("+{l}\n")));
        let patch = from + &file_patch("new.rs", &[&to]);
        let (shown, moves) = find(&patch);
        assert_eq!(moves.len(), 1);
        assert_eq!(moves[0].from.path, "old.rs");
        assert!(!moves[0].hidden);
        assert_eq!(shown, patch);
    }
}
