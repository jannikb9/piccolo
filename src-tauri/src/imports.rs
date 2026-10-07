//! Hiding the changes to import statements from a diff, so a review can focus on the code.
//!
//! Lines are judged in the context of the whole file, so the names inside a multi-line
//! `import { … } from "x"` count as part of the import. A run of changed lines that holds only
//! imports (and blanks) disappears whole; in a run that also changes code, only the import lines
//! do. Hunks are split around what was hidden and keep their real line numbers, so the rest of
//! the diff still lines up with the files.

use crate::git::{self, DiffRange, Result};
use std::path::Path;

/// Removes the changes to import statements from a `git diff` patch (with `a/` and `b/` prefixes).
/// Files that only changed imports are left without hunks, and so out of the patch.
pub fn filter_patch(wt: &Path, range: &DiffRange, patch: &str) -> Result<String> {
    let files = split_files(patch);
    let paths: Vec<Option<(Option<&str>, Option<&str>)>> = files.iter().map(FilePatch::paths).collect();

    // Both versions of every file with hunks, fetched in one `git cat-file` per side.
    let old_specs: Vec<String> = paths.iter().flatten().filter_map(|(old, _)| *old).map(|p| format!("{}:{p}", range.old_rev)).collect();
    let new_paths: Vec<&str> = paths.iter().flatten().filter_map(|(_, new)| *new).collect();
    let mut olds = git::blobs(wt, &old_specs)?.into_iter();
    let mut news = match &range.new_rev {
        Some(rev) => git::blobs(wt, &new_paths.iter().map(|p| format!("{rev}:{p}")).collect::<Vec<_>>())?,
        None => new_paths.iter().map(|p| git::worktree_file(wt, p).and_then(|p| git::read_text(&p))).collect(),
    }
    .into_iter();

    let mut out = String::with_capacity(patch.len());
    for (file, paths) in files.iter().zip(&paths) {
        let versions = paths.map(|(old, new)| {
            // An added or deleted file has nothing on one side.
            let old = old.map_or(Some(String::new()), |_| olds.next().expect("one blob per path"));
            let new = new.map_or(Some(String::new()), |_| news.next().expect("one blob per path"));
            (old, new)
        });
        let (Some((Some(old), Some(new))), true) = (versions, !file.hunks.is_empty()) else {
            out.push_str(&file.header.concat());
            file.hunks.iter().for_each(|hunk| out.push_str(&hunk.concat()));
            continue;
        };
        let (old, new) = (import_lines(&old), import_lines(&new));
        let hunks: Vec<String> = file.hunks.iter().flat_map(|hunk| without_imports(hunk, &old, &new)).collect();
        if !hunks.is_empty() {
            out.push_str(&file.header.concat());
            hunks.iter().for_each(|hunk| out.push_str(hunk));
        }
    }
    Ok(out)
}

/// One file's entry in a patch: its header lines, then each hunk's lines (header first).
struct FilePatch<'a> {
    header: Vec<&'a str>,
    hunks: Vec<Vec<&'a str>>,
}

impl<'a> FilePatch<'a> {
    /// The old and new path of a file with hunks, `None` on the side where the file doesn't exist
    /// (added and deleted files). `None` overall for files without hunks (binary, pure renames)
    /// and for paths git had to quote.
    #[allow(clippy::type_complexity)]
    fn paths(&self) -> Option<(Option<&'a str>, Option<&'a str>)> {
        if self.hunks.is_empty() {
            return None;
        }
        // Git appends a tab to names containing spaces.
        let path = |marker: &str, prefix: &str| {
            let name = self.header.iter().find_map(|l| l.strip_prefix(marker))?.trim_end_matches(['\n', '\t']);
            if name == "/dev/null" {
                return Some(None);
            }
            name.strip_prefix(prefix).map(Some)
        };
        Some((path("--- ", "a/")?, path("+++ ", "b/")?))
    }
}

fn split_files(patch: &str) -> Vec<FilePatch<'_>> {
    let mut files: Vec<FilePatch> = Vec::new();
    for line in patch.split_inclusive('\n') {
        if line.starts_with("diff --git ") || files.is_empty() {
            files.push(FilePatch { header: Vec::new(), hunks: Vec::new() });
        }
        let file = files.last_mut().unwrap();
        if line.starts_with("@@ ") {
            file.hunks.push(vec![line]);
        } else if let Some(hunk) = file.hunks.last_mut() {
            hunk.push(line);
        } else {
            file.header.push(line);
        }
    }
    files
}

/// A line of a hunk, with the line numbers its side(s) are at when it comes up.
struct Row<'a> {
    text: &'a str,
    old: usize,
    new: usize,
    hidden: bool,
}

impl Row<'_> {
    fn kind(&self) -> u8 {
        self.text.as_bytes()[0]
    }

    fn is_change(&self) -> bool {
        matches!(self.kind(), b'+' | b'-')
    }
}

/// A hunk without its import changes: split into the pieces between them, each with a header
/// for its own lines. Empty when nothing but imports (and unchanged lines) was left.
/// `old` and `new` flag the import lines of each version of the file.
fn without_imports(hunk: &[&str], old: &[bool], new: &[bool]) -> Vec<String> {
    // `@@ -12,5 +12,7 @@ fn heading`
    let Some((ranges, heading)) = hunk[0][2..].split_once("@@") else { return vec![hunk.concat()] };
    let mut starts = ranges.split_whitespace().map(|range| {
        let (start, count) = range[1..].split_once(',').unwrap_or((&range[1..], "1"));
        Some((start.parse::<usize>().ok()?, count.parse::<usize>().ok()?))
    });
    let (Some(Some((mut o, old_count))), Some(Some((mut n, new_count)))) = (starts.next(), starts.next()) else {
        return vec![hunk.concat()];
    };
    // An empty range starts after the line it names.
    if old_count == 0 {
        o += 1;
    }
    if new_count == 0 {
        n += 1;
    }

    let mut rows: Vec<Row> = Vec::with_capacity(hunk.len());
    for &text in &hunk[1..] {
        rows.push(Row { text, old: o, new: n, hidden: false });
        match text.as_bytes()[0] {
            b' ' => (o, n) = (o + 1, n + 1),
            b'-' => o += 1,
            b'+' => n += 1,
            _ => {}
        }
    }

    let is_import = |marks: &[bool], line: usize| line.checked_sub(1).and_then(|i| marks.get(i)).copied().unwrap_or(false);
    let is_import_row = |row: &Row| match row.kind() {
        b'-' => !row.text[1..].trim().is_empty() && is_import(old, row.old),
        b'+' => !row.text[1..].trim().is_empty() && is_import(new, row.new),
        _ => false,
    };
    // Per run of changed lines: all of it goes when it only holds imports and blanks, else just
    // the imports.
    let mut start = 0;
    while start < rows.len() {
        if !rows[start].is_change() {
            start += 1;
            continue;
        }
        let end = rows[start..].iter().position(|r| !r.is_change() && r.kind() != b'\\').map_or(rows.len(), |p| start + p);
        let run = &mut rows[start..end];
        let imports = run.iter().filter(|r| is_import_row(r)).count();
        let others = run.iter().filter(|r| r.is_change() && !r.text[1..].trim().is_empty()).count() - imports;
        for row in run.iter_mut().filter(|r| r.is_change()) {
            row.hidden = imports > 0 && (others == 0 || is_import_row(row));
        }
        start = end;
    }
    // The blank lines that set the imports apart go with them.
    let spaces = |rows: &[Row], i: usize| rows[i].is_change() && rows[i].text[1..].trim().is_empty();
    for i in 1..rows.len() {
        rows[i].hidden |= spaces(&rows, i) && rows[i - 1].hidden && rows[i - 1].kind() == rows[i].kind();
    }
    for i in (0..rows.len().saturating_sub(1)).rev() {
        rows[i].hidden |= spaces(&rows, i) && rows[i + 1].hidden && rows[i + 1].kind() == rows[i].kind();
    }
    // `\ No newline at end of file` belongs to the line before it.
    for i in 1..rows.len() {
        if rows[i].kind() == b'\\' {
            rows[i].hidden = rows[i - 1].hidden;
        }
    }

    let mut pieces = Vec::new();
    for piece in rows.chunk_by(|a, b| a.hidden == b.hidden).filter(|piece| !piece[0].hidden) {
        if !piece.iter().any(Row::is_change) {
            continue;
        }
        let count = |kinds: [u8; 2]| piece.iter().filter(|r| kinds.contains(&r.kind())).count();
        let (old_count, new_count) = (count([b' ', b'-']), count([b' ', b'+']));
        let start = |line: usize, count: usize| if count == 0 { line - 1 } else { line };
        let mut text = format!("@@ -{},{old_count} +{},{new_count} @@{heading}", start(piece[0].old, old_count), start(piece[0].new, new_count));
        piece.iter().for_each(|r| text.push_str(r.text));
        pieces.push(text);
    }
    pieces
}

/// Flags, per line of `src`, whether it is part of an import statement. Statements that open a
/// bracket continue until it closes: `import {` … `} from "x"`, Go's `import (` … `)`,
/// `use a::{` … `};`.
pub fn import_lines(src: &str) -> Vec<bool> {
    let mut marks = Vec::new();
    let mut depth = 0;
    let mut continued = false;
    for line in src.lines() {
        let inside = depth > 0 || continued || starts_import(line);
        if inside {
            depth = (depth + bracket_balance(line)).max(0);
            // Python's `from x import a, \`
            continued = line.trim_end().ends_with('\\');
        }
        marks.push(inside);
    }
    marks
}

pub fn starts_import(line: &str) -> bool {
    let t = line.trim_start();
    keyword(t, "import") // JS/TS, Python, Java, Kotlin, Go, Swift, Scala, Dart, Haskell
        || (t.starts_with("from ") && t.contains(" import")) // Python
        || keyword(without_visibility(t), "use") // Rust, PHP, Perl
        || t.starts_with("extern crate ")
        || ["#include", "#import", "@import", "@use"].iter().any(|kw| keyword(t, kw)) // C, Obj-C, CSS
        || keyword(t, "require") || keyword(t, "require_relative") || t.starts_with("require(") // Ruby, Lua, CommonJS
        || (["const", "let", "var", "local"].iter().any(|kw| keyword(t, kw)) && t.contains("require(")) // CommonJS
        || (keyword(t, "using") && t.trim_end().ends_with(';') && !t.contains('(') && !t.starts_with("using var ")) // C#
}

/// `line` starts with the word `kw`. `import(` and `import.meta` are expressions, not imports.
fn keyword(line: &str, kw: &str) -> bool {
    line.strip_prefix(kw)
        .and_then(|rest| rest.chars().next())
        .is_some_and(|c| c.is_whitespace() || matches!(c, '{' | '"' | '\'' | '<'))
}

/// Strips Rust's `pub ` / `pub(crate) `.
fn without_visibility(t: &str) -> &str {
    let Some(rest) = t.strip_prefix("pub") else { return t };
    let rest = rest.strip_prefix('(').and_then(|r| r.split_once(')')).map_or(rest, |(_, r)| r);
    if rest.starts_with(char::is_whitespace) { rest.trim_start() } else { t }
}

/// Opened minus closed brackets, outside strings and trailing comments.
fn bracket_balance(line: &str) -> i32 {
    let mut balance = 0;
    let mut quote = None;
    let mut chars = line.trim_start().chars().enumerate().peekable();
    while let Some((i, c)) = chars.next() {
        match (quote, c) {
            (Some(_), '\\') => {
                chars.next();
            }
            (Some(q), c) if c == q => quote = None,
            (Some(_), _) => {}
            (None, '"' | '\'' | '`') => quote = Some(c),
            (None, '/') if chars.peek().is_some_and(|&(_, next)| next == '/') => break,
            (None, '#') if i > 0 => break,
            (None, '{' | '(' | '[') => balance += 1,
            (None, '}' | ')' | ']') => balance -= 1,
            _ => {}
        }
    }
    balance
}

#[cfg(test)]
mod tests {
    use super::*;

    fn marked(src: &str) -> Vec<&str> {
        src.lines().zip(import_lines(src)).filter(|(_, m)| *m).map(|(l, _)| l).collect()
    }

    #[test]
    fn marks_import_statements() {
        let ts = "import React from \"react\";\nimport {\n  a,\n  b, // (\n} from \"./x\";\n\nconst c = import(\"./c\");\nconsole.log(import.meta.url);\nexport const d = [\n  a,\n];\n";
        assert_eq!(marked(ts), ["import React from \"react\";", "import {", "  a,", "  b, // (", "} from \"./x\";"]);

        let go = "package main\n\nimport (\n\t\"fmt\"\n\t\"os\"\n)\n\nfunc main() {}\n";
        assert_eq!(marked(go), ["import (", "\t\"fmt\"", "\t\"os\"", ")"]);

        let py = "import os\nfrom a import (  # noqa\n    b,\n)\nfrom c import d, \\\n    e\nimported = 1\n";
        assert_eq!(marked(py), ["import os", "from a import (  # noqa", "    b,", ")", "from c import d, \\", "    e"]);

        let rs = "use std::{\n    fs,\n};\npub(crate) use a::b;\nfn user() {}\n";
        assert_eq!(marked(rs), ["use std::{", "    fs,", "};", "pub(crate) use a::b;"]);

        let misc = "#include <stdio.h>\nconst x = require(\"x\");\nusing System.Linq;\nusing (var f = open()) {}\n";
        assert_eq!(marked(misc), ["#include <stdio.h>", "const x = require(\"x\");", "using System.Linq;"]);
    }

    #[test]
    fn hides_import_changes_within_hunks() {
        let old = import_lines("import {\n  a,\n} from \"x\";\n\nrun(a);\n");
        let new = import_lines("import {\n  a,\n  b,\n} from \"x\";\n\nrun(a, b);\n");
        // Adding a name inside a multi-line import leaves nothing.
        assert!(without_imports(&["@@ -2,2 +2,3 @@\n", "   a,\n", "+  b,\n", " } from \"x\";\n"], &old, &new).is_empty());
        // A hunk that also changes code keeps the code, split around the import line.
        assert_eq!(
            without_imports(
                &["@@ -2,4 +2,5 @@ heading\n", "   a,\n", "+  b,\n", " } from \"x\";\n", " \n", "-run(a);\n", "+run(a, b);\n"],
                &old,
                &new,
            ),
            ["@@ -3,3 +4,3 @@ heading\n } from \"x\";\n \n-run(a);\n+run(a, b);\n"]
        );
        // Blank lines alone aren't import changes.
        assert!(without_imports(&["@@ -4,1 +4,2 @@\n", " \n", "+\n"], &old, &new).len() == 1);
        // A new file keeps its code and loses its imports, and the header counts what's left.
        let file = import_lines("import a from \"a\";\n\nrun(a);\n");
        assert_eq!(
            without_imports(&["@@ -0,0 +1,3 @@\n", "+import a from \"a\";\n", "+\n", "+run(a);\n"], &[], &file),
            ["@@ -0,0 +3,1 @@\n+run(a);\n"]
        );
    }
}
