//! Hiding diff hunks that only change import statements, so a review can focus on the code.
//!
//! Like `git diff -I<regex>`, a hunk is left out only when every line it changes is an import (or
//! blank); hunks that mix imports with other code stay whole. Unlike a regex, lines are judged in
//! the context of the whole file, so the names inside a multi-line `import { … } from "x"` count
//! as part of the import.

use crate::git::{self, DiffRange, Result};
use std::collections::HashMap;
use std::path::Path;

/// Removes import-only hunks from a `git diff` patch (with `a/` and `b/` prefixes). Also returns,
/// per file (by new path), the added and deleted lines that were left out.
pub fn filter_patch(wt: &Path, range: &DiffRange, patch: &str) -> Result<(String, HashMap<String, (u32, u32)>)> {
    let files = split_files(patch);

    // Both versions of every modified file, fetched in one `git cat-file` per side.
    let modified: Vec<(&str, &str)> = files.iter().filter_map(|f| f.paths()).collect();
    let old_specs: Vec<String> = modified.iter().map(|(old, _)| format!("{}:{old}", range.old_rev)).collect();
    let olds = git::blobs(wt, &old_specs)?;
    let news = match &range.new_rev {
        Some(rev) => git::blobs(wt, &modified.iter().map(|(_, new)| format!("{rev}:{new}")).collect::<Vec<_>>())?,
        None => modified.iter().map(|(_, new)| git::read_text(&wt.join(new))).collect(),
    };
    let mut versions = modified.iter().zip(olds.into_iter().zip(news));

    let mut out = String::with_capacity(patch.len());
    let mut hidden = HashMap::new();
    for file in &files {
        out.push_str(&file.header.concat());
        let Some((_, new_path)) = file.paths() else {
            file.hunks.iter().for_each(|hunk| out.push_str(&hunk.concat()));
            continue;
        };
        let (_, (old, new)) = versions.next().expect("one version pair per modified file");
        let (Some(old), Some(new)) = (old, new) else {
            file.hunks.iter().for_each(|hunk| out.push_str(&hunk.concat()));
            continue;
        };
        let (old, new) = (import_lines(&old), import_lines(&new));
        for hunk in &file.hunks {
            if only_imports(hunk, &old, &new) {
                let counts: &mut (u32, u32) = hidden.entry(new_path.to_string()).or_default();
                counts.0 += hunk.iter().filter(|l| l.starts_with('+')).count() as u32;
                counts.1 += hunk.iter().filter(|l| l.starts_with('-')).count() as u32;
            } else {
                out.push_str(&hunk.concat());
            }
        }
    }
    Ok((out, hidden))
}

/// One file's entry in a patch: its header lines, then each hunk's lines (header first).
struct FilePatch<'a> {
    header: Vec<&'a str>,
    hunks: Vec<Vec<&'a str>>,
}

impl<'a> FilePatch<'a> {
    /// (old path, new path) of a modified or renamed file with hunks; `None` for added, deleted
    /// and binary files, and for paths git had to quote.
    fn paths(&self) -> Option<(&'a str, &'a str)> {
        if self.hunks.is_empty() {
            return None;
        }
        // Git appends a tab to names containing spaces.
        let path = |prefix: &str| {
            self.header
                .iter()
                .find_map(|l| l.strip_prefix(prefix))
                .map(|p| p.trim_end_matches(['\n', '\t']))
                .filter(|p| !p.starts_with('"'))
        };
        Some((path("--- a/")?, path("+++ b/")?))
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

/// Whether every line a hunk changes is an import or blank, and at least one is an import.
/// `old` and `new` flag the import lines of each version of the file.
fn only_imports(hunk: &[&str], old: &[bool], new: &[bool]) -> bool {
    // `@@ -12,5 +12,7 @@`
    let mut starts = hunk[0].split(' ').skip(1).take(2).map(|part| {
        part.get(1..).and_then(|p| p.split(',').next()).and_then(|n| n.parse::<usize>().ok())
    });
    let (Some(Some(mut o)), Some(Some(mut n))) = (starts.next(), starts.next()) else { return false };
    let is_import = |marks: &[bool], line: usize| line.checked_sub(1).and_then(|i| marks.get(i)).copied().unwrap_or(false);

    let mut any = false;
    for line in &hunk[1..] {
        let blank = line[1..].trim().is_empty();
        match line.as_bytes()[0] {
            b' ' => {
                o += 1;
                n += 1;
            }
            b'-' => {
                if !blank && !is_import(old, o) {
                    return false;
                }
                any |= !blank;
                o += 1;
            }
            b'+' => {
                if !blank && !is_import(new, n) {
                    return false;
                }
                any |= !blank;
                n += 1;
            }
            _ => {} // `\ No newline at end of file`
        }
    }
    any
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

fn starts_import(line: &str) -> bool {
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
    fn hides_only_import_hunks() {
        let old = import_lines("import {\n  a,\n} from \"x\";\n\nrun(a);\n");
        let new = import_lines("import {\n  a,\n  b,\n} from \"x\";\n\nrun(a, b);\n");
        // Adding a name inside a multi-line import.
        assert!(only_imports(&["@@ -2,2 +2,3 @@\n", "   a,\n", "+  b,\n", " } from \"x\";\n"], &old, &new));
        // A hunk that also changes code stays.
        assert!(!only_imports(
            &["@@ -2,4 +2,5 @@\n", "   a,\n", "+  b,\n", " } from \"x\";\n", " \n", "-run(a);\n", "+run(a, b);\n"],
            &old,
            &new,
        ));
        // Blank lines alone aren't import changes.
        assert!(!only_imports(&["@@ -4,1 +4,2 @@\n", " \n", "+\n"], &old, &new));
    }
}
