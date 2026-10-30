//! Keeping the lines that comments are on in the diff.
//!
//! A reviewer may expand unchanged lines to comment on them, but the diff folds them away again
//! whenever it's read anew (the worktree changed). So the lines of open threads, and a few around
//! them, go into the patch as unchanged context, as if they were near a change. Hunks that end up
//! touching are merged, as git does.

use crate::comments::{LineRange, Side};
use crate::git::{self, DiffRange, Result};
use crate::imports::{split_files, FilePatch};
use std::collections::{BTreeSet, HashMap};
use std::path::Path;

/// Lines to keep in the diff, by the file's (new) path.
pub type Keep = HashMap<String, Vec<LineRange>>;

/// Unchanged lines shown above and below kept ones, as git shows around changes.
const CONTEXT: u32 = 3;

/// Single lines to show by the file's (new) path, without lines around them: the first lines of
/// changed functions, so the reviewer sees what a change is in.
pub type Headers = HashMap<String, BTreeSet<u32>>;

/// `shown` with the `keep` lines and `headers` of its files added as context. `raw` is the patch
/// before anything was left out of it (import changes, moved lines), which tells which lines are
/// unchanged.
pub fn keep_lines(wt: &Path, range: &DiffRange, raw: &str, shown: &str, keep: &Keep, headers: &Headers) -> Result<String> {
    if keep.is_empty() && headers.is_empty() {
        return Ok(shown.to_string());
    }
    let raw_files = split_files(raw);
    let raw_hunks: HashMap<&str, &FilePatch> = raw_files.iter().filter_map(|f| Some((f.paths()?.1?, f))).collect();
    let files = split_files(shown);

    // Per file: its hunks, the unchanged lines to add, and its path to read them from.
    let mut plans = Vec::with_capacity(files.len());
    for file in &files {
        let plan = (|| {
            // Added and deleted files show every line already.
            let (Some(_), Some(path)) = file.paths()? else { return None };
            let shown = parse_hunks(file)?;
            let raw = parse_hunks(raw_hunks.get(path)?)?;
            let mut lines = keep.get(path).map(|ranges| wanted_lines(&raw, &shown, ranges)).unwrap_or_default();
            let is_shown = |line: u32| shown.iter().any(|h| (h.new..h.new_end()).contains(&line));
            let header_lines = headers.get(path).into_iter().flatten().copied();
            lines.extend(header_lines.filter(|&line| line > 0 && !is_shown(line) && unchanged(&raw, Side::Additions, line).is_some()));
            (!lines.is_empty()).then_some((path, shown, raw, lines))
        })();
        plans.push(plan);
    }

    let paths: Vec<&str> = plans.iter().flatten().map(|(path, ..)| *path).collect();
    let mut contents = match &range.new_rev {
        Some(rev) => git::blobs(wt, &paths.iter().map(|p| format!("{rev}:{p}")).collect::<Vec<_>>())?,
        None => paths.iter().map(|p| git::worktree_file(wt, p).and_then(|p| git::read_text(&p))).collect(),
    }
    .into_iter();

    let mut out = String::with_capacity(shown.len());
    for (file, plan) in files.iter().zip(plans) {
        out.push_str(&file.header.concat());
        let Some((_, shown, raw, lines)) = plan else {
            file.hunks.iter().for_each(|hunk| out.push_str(&hunk.concat()));
            continue;
        };
        let Some(text) = contents.next().expect("one blob per path") else {
            file.hunks.iter().for_each(|hunk| out.push_str(&hunk.concat()));
            continue;
        };
        with_context(shown, &raw, &lines, &text).iter().for_each(|hunk| hunk.write(&mut out));
    }
    Ok(out)
}

/// A hunk, with the first line number of each side as it comes up (also for empty sides).
#[derive(Debug, Clone)]
struct Hunk {
    old: u32,
    new: u32,
    old_count: u32,
    new_count: u32,
    /// What follows the line numbers in the header, with its line break.
    heading: String,
    rows: Vec<String>,
}

impl Hunk {
    /// `@@ -12,5 +12,7 @@ fn heading`, then its rows.
    fn parse(lines: &[&str]) -> Option<Self> {
        let (ranges, heading) = lines.first()?.strip_prefix("@@ ")?.split_once("@@")?;
        let mut sides = ranges.split_whitespace().map(|range| {
            let (start, count) = range[1..].split_once(',').unwrap_or((&range[1..], "1"));
            let (start, count) = (start.parse::<u32>().ok()?, count.parse::<u32>().ok()?);
            // An empty range starts after the line it names.
            Some((if count == 0 { start + 1 } else { start }, count))
        });
        let ((old, old_count), (new, new_count)) = (sides.next()??, sides.next()??);
        let rows = lines[1..].iter().map(|row| row.to_string()).collect();
        Some(Self { old, new, old_count, new_count, heading: heading.to_string(), rows })
    }

    /// One unchanged line, without a heading.
    fn context(old: u32, new: u32, text: &str) -> Self {
        let mut row = format!(" {text}");
        if !text.ends_with('\n') {
            row.push_str("\n\\ No newline at end of file\n");
        }
        Self { old, new, old_count: 1, new_count: 1, heading: "\n".into(), rows: vec![row] }
    }

    fn old_end(&self) -> u32 {
        self.old + self.old_count
    }

    fn new_end(&self) -> u32 {
        self.new + self.new_count
    }

    /// The line number on each side of every row; rows that aren't on a side don't advance it.
    fn numbered(&self) -> impl Iterator<Item = (u8, u32, u32)> + '_ {
        let (mut old, mut new) = (self.old, self.new);
        self.rows.iter().map(move |row| {
            let kind = row.as_bytes().first().copied().unwrap_or(b' ');
            let at = (kind, old, new);
            match kind {
                b' ' => (old, new) = (old + 1, new + 1),
                b'-' => old += 1,
                b'+' => new += 1,
                _ => {}
            }
            at
        })
    }

    fn write(&self, out: &mut String) {
        // An empty range names the line before it.
        let start = |line: u32, count: u32| if count == 0 { line - 1 } else { line };
        let (old, new) = (start(self.old, self.old_count), start(self.new, self.new_count));
        out.push_str(&format!("@@ -{old},{} +{new},{} @@{}", self.old_count, self.new_count, self.heading));
        self.rows.iter().for_each(|row| out.push_str(row));
    }
}

fn parse_hunks(file: &FilePatch) -> Option<Vec<Hunk>> {
    let hunks: Option<Vec<Hunk>> = file.hunks.iter().map(|lines| Hunk::parse(lines)).collect();
    hunks.filter(|hunks| !hunks.is_empty())
}

/// The other side's number of an unchanged line, `None` for a changed one. `raw` is every change
/// to the file; `from` says which side `line` is on.
fn unchanged(raw: &[Hunk], from: Side, line: u32) -> Option<u32> {
    let pick = |h: &Hunk| match from {
        Side::Additions => (h.new, h.new_end(), h.old),
        Side::Deletions => (h.old, h.old_end(), h.new),
    };
    // Between hunks, both sides move together.
    let shift = |line: u32, from: u32, to: u32| u32::try_from(i64::from(line) - i64::from(from) + i64::from(to)).ok();
    for hunk in raw {
        let (start, end, other) = pick(hunk);
        if line < start {
            return shift(line, start, other);
        }
        if line < end {
            return hunk.numbered().find_map(|(kind, old, new)| {
                let (here, there) = if from == Side::Additions { (new, old) } else { (old, new) };
                (kind == b' ' && here == line).then_some(there)
            });
        }
    }
    let last = raw.last()?;
    let (end, other_end) = match from {
        Side::Additions => (last.new_end(), last.old_end()),
        Side::Deletions => (last.old_end(), last.new_end()),
    };
    shift(line, end, other_end)
}

/// New line numbers of the unchanged lines to add for `ranges`: theirs and those around them,
/// unless already shown.
fn wanted_lines(raw: &[Hunk], shown: &[Hunk], ranges: &[LineRange]) -> BTreeSet<u32> {
    let to_new = |side: Side, line: u32| match side {
        Side::Additions => Some(line),
        // A removed line is in a hunk, and its range ends next to the hunk's added lines.
        Side::Deletions => unchanged(raw, Side::Deletions, line),
    };
    let is_shown = |line: u32| shown.iter().any(|h| (h.new..h.new_end()).contains(&line));
    let mut lines = BTreeSet::new();
    for range in ranges {
        let ends: Vec<u32> = [to_new(range.start_side, range.start_line), to_new(range.end_side, range.end_line)]
            .into_iter()
            .flatten()
            .collect();
        let (Some(&first), Some(&last)) = (ends.iter().min(), ends.iter().max()) else { continue };
        // Lines in the diff already have git's context.
        if (first..=last).all(is_shown) {
            continue;
        }
        let around = first.saturating_sub(CONTEXT).max(1)..=last + CONTEXT;
        lines.extend(around.filter(|&line| !is_shown(line) && unchanged(raw, Side::Additions, line).is_some()));
    }
    lines
}

/// The shown hunks with the unchanged `lines` of `text` (the new version) added, merged where
/// they touch.
fn with_context(shown: Vec<Hunk>, raw: &[Hunk], lines: &BTreeSet<u32>, text: &str) -> Vec<Hunk> {
    let rows: Vec<&str> = text.split_inclusive('\n').collect();
    let mut pieces = shown;
    for &line in lines {
        let (Some(row), Some(old)) = (rows.get(line as usize - 1), unchanged(raw, Side::Additions, line)) else { continue };
        pieces.push(Hunk::context(old, line, row));
    }
    // A hunk that only removes lines comes before the unchanged line after them.
    pieces.sort_by_key(|h| (h.new, h.old));

    let mut hunks: Vec<Hunk> = Vec::with_capacity(pieces.len());
    for piece in pieces {
        match hunks.last_mut() {
            Some(last) if last.old_end() == piece.old && last.new_end() == piece.new => {
                if last.heading == "\n" {
                    last.heading = piece.heading;
                }
                last.old_count += piece.old_count;
                last.new_count += piece.new_count;
                last.rows.extend(piece.rows);
            }
            _ => hunks.push(piece),
        }
    }
    hunks
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hunks(patch: &str) -> Vec<Hunk> {
        parse_hunks(&split_files(patch)[0]).unwrap()
    }

    fn render(hunks: &[Hunk]) -> String {
        let mut out = String::new();
        hunks.iter().for_each(|h| h.write(&mut out));
        out
    }

    fn additions(start: u32, end: u32) -> LineRange {
        LineRange { start_side: Side::Additions, start_line: start, end_side: Side::Additions, end_line: end }
    }

    fn deletions(start: u32, end: u32) -> LineRange {
        LineRange { start_side: Side::Deletions, start_line: start, end_side: Side::Deletions, end_line: end }
    }

    fn numbered(count: u32) -> String {
        (1..=count).map(|n| format!("line {n}\n")).collect()
    }

    /// Line 3 changed and line 20 removed, out of 30 lines (29 in the new version).
    const PATCH: &str = "diff --git a/f b/f\n--- a/f\n+++ b/f\n\
        @@ -2,3 +2,3 @@ heading\n line 2\n-line 3\n+changed 3\n line 4\n\
        @@ -19,3 +19,2 @@\n line 19\n-line 20\n line 21\n";

    fn new_text() -> String {
        numbered(30).replace("line 3\n", "changed 3\n").replace("line 20\n", "")
    }

    fn kept(ranges: &[LineRange]) -> String {
        let raw = hunks(PATCH);
        let lines = wanted_lines(&raw, &raw, ranges);
        render(&with_context(raw.clone(), &raw, &lines, &new_text()))
    }

    #[test]
    fn maps_unchanged_lines_between_sides() {
        let raw = hunks(PATCH);
        assert_eq!(unchanged(&raw, Side::Additions, 1), Some(1));
        assert_eq!(unchanged(&raw, Side::Additions, 3), None);
        assert_eq!(unchanged(&raw, Side::Additions, 10), Some(10));
        assert_eq!(unchanged(&raw, Side::Additions, 20), Some(21));
        assert_eq!(unchanged(&raw, Side::Additions, 25), Some(26));
        assert_eq!(unchanged(&raw, Side::Deletions, 20), None);
        assert_eq!(unchanged(&raw, Side::Deletions, 26), Some(25));
    }

    #[test]
    fn adds_unchanged_lines_as_their_own_hunk() {
        assert_eq!(
            kept(&[additions(11, 12)]),
            "@@ -2,3 +2,3 @@ heading\n line 2\n-line 3\n+changed 3\n line 4\n\
             @@ -8,8 +8,8 @@\n line 8\n line 9\n line 10\n line 11\n line 12\n line 13\n line 14\n line 15\n\
             @@ -19,3 +19,2 @@\n line 19\n-line 20\n line 21\n"
        );
    }

    #[test]
    fn merges_lines_that_touch_a_hunk() {
        // Lines 5–11 join the first hunk; on the old side, 24 is 23 in the new version.
        assert_eq!(
            kept(&[additions(8, 8), deletions(24, 24)]),
            "@@ -2,10 +2,10 @@ heading\n line 2\n-line 3\n+changed 3\n line 4\n line 5\n line 6\n line 7\n line 8\n line 9\n line 10\n line 11\n\
             @@ -19,9 +19,8 @@\n line 19\n-line 20\n line 21\n line 22\n line 23\n line 24\n line 25\n line 26\n line 27\n"
        );
    }

    #[test]
    fn keeps_lines_up_to_the_end_of_the_file() {
        let raw = hunks(PATCH);
        let text = new_text().trim_end().to_string();
        let lines = wanted_lines(&raw, &raw, &[additions(29, 29)]);
        let out = render(&with_context(raw.clone(), &raw, &lines, &text));
        assert!(out.ends_with("@@ -27,4 +26,4 @@\n line 27\n line 28\n line 29\n line 30\n\\ No newline at end of file\n"), "{out}");
    }

    #[test]
    fn leaves_lines_already_shown() {
        assert_eq!(kept(&[additions(3, 3), deletions(20, 20)]), PATCH.split_once("@@").map(|(_, rest)| format!("@@{rest}")).unwrap());
    }
}
