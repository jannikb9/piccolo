//! The functions, classes and types a diff changes, and which of them use each other, so the
//! reviewer can follow a change from its callers to what it calls.
//!
//! Both versions of each changed file are parsed with tree-sitter. A changed line belongs to the
//! innermost definition around it, leaving out definitions inside functions (callbacks, local
//! helpers), which count as part of their function. One changed symbol uses another when its
//! code mentions the other's name, like GitHub's search-based code navigation, so a common name
//! can link to the wrong one. Files of other languages have no symbols.

use crate::comments::Side;
use crate::git::{self, DiffRange, Result};
use crate::imports::{hunk_rows, split_files};
use serde::Serialize;
use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::Path;
use std::sync::OnceLock;
use streaming_iterator::StreamingIterator;
use tree_sitter::{Language, Node, Parser, Query, QueryCursor, Tree};

/// Changed files of supported languages, at most; more get no symbols.
const MAX_FILES: usize = 200;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Function,
    Method,
    Class,
    Type,
    /// A top-level constant or static.
    Value,
    /// Rust's `impl` blocks and modules: they hold symbols but aren't used by name.
    Module,
}

impl Kind {
    fn from_capture(name: &str) -> Option<Kind> {
        Some(match name {
            "definition.function" => Kind::Function,
            "definition.method" => Kind::Method,
            "definition.class" => Kind::Class,
            "definition.type" => Kind::Type,
            "definition.value" => Kind::Value,
            "definition.module" | "definition.impl" => Kind::Module,
            _ => return None,
        })
    }

    fn is_function(self) -> bool {
        matches!(self, Kind::Function | Kind::Method)
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Symbol {
    /// `path#Container.name`, the same for both versions of the symbol.
    pub id: String,
    pub path: String,
    pub name: String,
    /// The class, `impl` or module it's in.
    pub container: Option<String>,
    pub kind: Kind,
    /// The version its lines are from: the new one, unless the diff deletes it.
    pub side: Side,
    pub start: u32,
    pub end: u32,
    /// Other changed symbols its code mentions.
    pub uses: Vec<String>,
}

/// A grammar and the query that finds its definitions.
#[derive(Clone, Copy)]
enum Lang {
    TypeScript,
    Tsx,
    JavaScript,
    Rust,
    Python,
    Go,
}

impl Lang {
    fn of(path: &str) -> Option<Lang> {
        let ext = path.rsplit_once('.')?.1;
        Some(match ext {
            "ts" | "mts" | "cts" => Lang::TypeScript,
            "tsx" => Lang::Tsx,
            "js" | "jsx" | "mjs" | "cjs" => Lang::JavaScript,
            "rs" => Lang::Rust,
            "py" | "pyi" => Lang::Python,
            "go" => Lang::Go,
            _ => return None,
        })
    }

    /// Languages whose symbols can use each other.
    fn family(self) -> u8 {
        match self {
            Lang::TypeScript | Lang::Tsx | Lang::JavaScript => 0,
            Lang::Rust => 1,
            Lang::Python => 2,
            Lang::Go => 3,
        }
    }

    fn language(self) -> Language {
        match self {
            Lang::TypeScript => tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
            Lang::Tsx => tree_sitter_typescript::LANGUAGE_TSX.into(),
            Lang::JavaScript => tree_sitter_javascript::LANGUAGE.into(),
            Lang::Rust => tree_sitter_rust::LANGUAGE.into(),
            Lang::Python => tree_sitter_python::LANGUAGE.into(),
            Lang::Go => tree_sitter_go::LANGUAGE.into(),
        }
    }

    fn query(self) -> &'static Query {
        static QUERIES: [OnceLock<Query>; 6] = [const { OnceLock::new() }; 6];
        let (index, source) = match self {
            Lang::TypeScript => (0, [JS_QUERY, TS_QUERY].concat()),
            Lang::Tsx => (1, [JS_QUERY, TS_QUERY].concat()),
            Lang::JavaScript => (2, JS_QUERY.to_string()),
            Lang::Rust => (3, RUST_QUERY.to_string()),
            Lang::Python => (4, PYTHON_QUERY.to_string()),
            Lang::Go => (5, GO_QUERY.to_string()),
        };
        QUERIES[index].get_or_init(|| Query::new(&self.language(), &source).expect("definition queries are valid"))
    }
}

const JS_QUERY: &str = r#"
(function_declaration name: (identifier) @name) @definition.function
(generator_function_declaration name: (identifier) @name) @definition.function
(class_declaration name: (_) @name) @definition.class
(method_definition name: (_) @name) @definition.method
(variable_declarator name: (identifier) @name value: [(arrow_function) (function_expression)]) @definition.function
(program (lexical_declaration (variable_declarator name: (identifier) @name)) @definition.value)
(program (export_statement declaration: (lexical_declaration (variable_declarator name: (identifier) @name)) @definition.value))
"#;

const TS_QUERY: &str = r#"
(function_signature name: (identifier) @name) @definition.function
(abstract_class_declaration name: (_) @name) @definition.class
(abstract_method_signature name: (_) @name) @definition.method
(interface_declaration name: (_) @name) @definition.type
(type_alias_declaration name: (_) @name) @definition.type
(enum_declaration name: (_) @name) @definition.type
"#;

const RUST_QUERY: &str = r#"
(function_item name: (identifier) @name) @definition.function
(function_signature_item name: (identifier) @name) @definition.function
(macro_definition name: (identifier) @name) @definition.function
(struct_item name: (type_identifier) @name) @definition.type
(enum_item name: (type_identifier) @name) @definition.type
(union_item name: (type_identifier) @name) @definition.type
(trait_item name: (type_identifier) @name) @definition.type
(type_item name: (type_identifier) @name) @definition.type
(const_item name: (identifier) @name) @definition.value
(static_item name: (identifier) @name) @definition.value
(impl_item type: (_) @name) @definition.impl
(mod_item name: (identifier) @name) @definition.module
"#;

const PYTHON_QUERY: &str = r#"
(function_definition name: (identifier) @name) @definition.function
(class_definition name: (identifier) @name) @definition.class
"#;

const GO_QUERY: &str = r#"
(function_declaration name: (identifier) @name) @definition.function
(method_declaration name: (field_identifier) @name) @definition.method
(type_spec name: (type_identifier) @name) @definition.type
"#;

/// A definition in one version of a file.
#[derive(Debug, Clone)]
struct Def {
    key: String,
    name: String,
    container: Option<String>,
    kind: Kind,
    /// Lines, from 1.
    start: u32,
    end: u32,
    bytes: std::ops::Range<usize>,
    /// A class, trait or `impl`, whose functions are methods (unlike a module's).
    holds_methods: bool,
}

/// One version of a file, parsed.
struct Version {
    text: String,
    tree: Tree,
    defs: Vec<Def>,
}

impl Version {
    fn parse(lang: Lang, text: String) -> Option<Version> {
        let mut parser = Parser::new();
        parser.set_language(&lang.language()).ok()?;
        let tree = parser.parse(&text, None)?;
        let defs = definitions(lang, &tree, &text);
        Some(Version { text, tree, defs })
    }

    /// The innermost definition holding `line`.
    fn def_at(&self, line: u32) -> Option<&Def> {
        self.defs.iter().filter(|d| d.start <= line && line <= d.end).min_by_key(|d| d.end - d.start)
    }

    /// Names mentioned in `bytes`, outside the definitions in it (a class's methods have their
    /// own), and not as the name of what is declared (a field, a variable).
    fn names(&self, bytes: &std::ops::Range<usize>) -> HashSet<&str> {
        let mut names = HashSet::new();
        let Some(node) = self.tree.root_node().descendant_for_byte_range(bytes.start, bytes.end) else { return names };
        let inner: Vec<&std::ops::Range<usize>> =
            self.defs.iter().map(|d| &d.bytes).filter(|b| b.start >= bytes.start && b.end <= bytes.end && *b != bytes).collect();
        let mut stack = vec![node];
        while let Some(node) = stack.pop() {
            if node.end_byte() <= bytes.start || node.start_byte() >= bytes.end {
                continue;
            }
            if inner.iter().any(|b| b.start == node.start_byte() && b.end == node.end_byte()) {
                continue;
            }
            let declared = node.parent().and_then(|p| p.child_by_field_name("name")).is_some_and(|n| n.id() == node.id());
            if node.child_count() == 0 && node.kind().ends_with("identifier") && !declared {
                if let Ok(name) = node.utf8_text(self.text.as_bytes()) {
                    names.insert(name);
                }
            }
            let mut cursor = node.walk();
            stack.extend(node.children(&mut cursor));
        }
        names
    }
}

/// The definitions in a file that aren't inside a function, each keyed by its containers and name
/// (repeats get a number).
fn definitions(lang: Lang, tree: &Tree, text: &str) -> Vec<Def> {
    let query = lang.query();
    let names = query.capture_names();
    let mut cursor = QueryCursor::new();
    let mut matches = cursor.matches(query, tree.root_node(), text.as_bytes());
    // Its node, name, kind, and whether functions in it are methods.
    let mut found: Vec<(Node, String, Kind, bool)> = Vec::new();
    while let Some(m) = matches.next() {
        let mut def = None;
        let mut name = None;
        for capture in m.captures() {
            match names[capture.index as usize] {
                "name" => name = capture.node.utf8_text(text.as_bytes()).ok(),
                other => def = Kind::from_capture(other).map(|kind| (capture.node, kind, other != "definition.module")),
            }
        }
        let (Some((node, kind, holds_methods)), Some(name)) = (def, name) else { continue };
        // `impl<T> Foo<T>` is about `Foo`.
        let name = name.split('<').next().unwrap_or(name).trim().to_string();
        found.push((node, name, kind, holds_methods));
    }
    found.sort_by_key(|(node, ..)| (node.start_byte(), std::cmp::Reverse(node.end_byte())));
    found.dedup_by_key(|(node, ..)| node.id());
    // `const f = () => …` is a function, not also a value.
    let functions: Vec<(usize, usize, String)> =
        found.iter().filter(|(_, _, k, _)| k.is_function()).map(|(n, name, ..)| (n.start_byte(), n.end_byte(), name.clone())).collect();
    found.retain(|(node, name, kind, _)| {
        *kind != Kind::Value || !functions.iter().any(|(s, e, f)| f == name && *s >= node.start_byte() && *e <= node.end_byte())
    });

    let mut defs: Vec<Def> = Vec::new();
    let mut counts: HashMap<String, u32> = HashMap::new();
    for (node, name, kind, holds_methods) in &found {
        let range = node.start_byte()..node.end_byte();
        let outer: Vec<&Def> = defs.iter().filter(|d| d.bytes.start <= range.start && range.end <= d.bytes.end).collect();
        // Helpers and callbacks inside a function are part of it.
        if outer.iter().any(|d| d.kind.is_function()) {
            continue;
        }
        let parent = outer.iter().max_by_key(|d| d.bytes.start);
        let container = parent.map(|d| d.key.clone());
        let kind = match kind {
            Kind::Function if parent.is_some_and(|d| d.holds_methods) => Kind::Method,
            kind => *kind,
        };
        let base = match &container {
            Some(c) => format!("{c}.{name}"),
            None => name.clone(),
        };
        let count = counts.entry(base.clone()).or_default();
        *count += 1;
        let key = if *count == 1 { base } else { format!("{base}~{count}") };
        defs.push(Def {
            key,
            name: name.clone(),
            container: outer.iter().max_by_key(|d| d.bytes.start).map(|d| d.name.clone()),
            kind,
            start: node.start_position().row as u32 + 1,
            end: node.end_position().row as u32 + 1,
            bytes: range,
            holds_methods: !kind.is_function() && *holds_methods,
        });
    }
    defs
}

/// The symbols the shown `patch` changes, with the other changed symbols each one uses.
pub fn changed(wt: &Path, range: &DiffRange, patch: &str) -> Result<Vec<Symbol>> {
    let files = split_files(patch);
    // Changed lines per file of a language with a grammar, on each side.
    let mut plans = Vec::new();
    for file in &files {
        let Some((old, new)) = file.paths() else { continue };
        let Some(lang) = new.or(old).and_then(Lang::of) else { continue };
        let (mut old_lines, mut new_lines) = (BTreeSet::new(), BTreeSet::new());
        for hunk in &file.hunks {
            let Some((rows, _)) = hunk_rows(hunk) else { continue };
            // A blank line or a lone `}` doesn't change what's around it.
            for row in rows.iter().filter(|r| r.text[1..].chars().any(char::is_alphanumeric)) {
                match row.kind() {
                    b'-' => old_lines.insert(row.old as u32),
                    b'+' => new_lines.insert(row.new as u32),
                    _ => false,
                };
            }
        }
        if !old_lines.is_empty() || !new_lines.is_empty() {
            plans.push((old, new, lang, old_lines, new_lines));
        }
    }
    // A codemod across hundreds of files has too many to follow, and takes long to parse.
    if plans.len() > MAX_FILES {
        return Ok(Vec::new());
    }

    let old_specs: Vec<String> = plans.iter().filter_map(|(old, ..)| *old).map(|p| format!("{}:{p}", range.old_rev)).collect();
    let new_paths: Vec<&str> = plans.iter().filter_map(|(_, new, ..)| *new).collect();
    let mut olds = git::blobs(wt, &old_specs)?.into_iter();
    let mut news = match &range.new_rev {
        Some(rev) => git::blobs(wt, &new_paths.iter().map(|p| format!("{rev}:{p}")).collect::<Vec<_>>())?,
        None => new_paths.iter().map(|p| git::worktree_file(wt, p).and_then(|p| git::read_text(&p))).collect(),
    }
    .into_iter();

    // Per file: its symbols, and the version and byte range their names are read from.
    let mut parsed: Vec<(Lang, Option<Version>, Option<Version>)> = Vec::new();
    let mut symbols: Vec<(Symbol, usize, Side, std::ops::Range<usize>)> = Vec::new();
    for (old, new, lang, old_lines, new_lines) in plans {
        let old_version = old.and_then(|_| olds.next().expect("one blob per path")).and_then(|t| Version::parse(lang, t));
        let new_version = new.and_then(|_| news.next().expect("one blob per path")).and_then(|t| Version::parse(lang, t));
        let path = new.or(old).expect("a file has a path on one side").to_string();
        let mut keys: Vec<String> = Vec::new();
        let take = |def: &Def, keys: &mut Vec<String>| {
            if !keys.contains(&def.key) {
                keys.push(def.key.clone());
            }
        };
        if let Some(v) = &new_version {
            new_lines.iter().filter_map(|&l| v.def_at(l)).for_each(|d| take(d, &mut keys));
        }
        if let Some(v) = &old_version {
            old_lines.iter().filter_map(|&l| v.def_at(l)).for_each(|d| take(d, &mut keys));
        }
        let index = parsed.len();
        for key in keys {
            let in_new = new_version.as_ref().and_then(|v| v.defs.iter().find(|d| d.key == key));
            let (def, side) = match in_new {
                Some(def) => (def, Side::Additions),
                None => match old_version.as_ref().and_then(|v| v.defs.iter().find(|d| d.key == key)) {
                    Some(def) => (def, Side::Deletions),
                    None => continue,
                },
            };
            let symbol = Symbol {
                id: format!("{path}#{key}"),
                path: path.clone(),
                name: def.name.clone(),
                container: def.container.clone(),
                kind: def.kind,
                side,
                start: def.start,
                end: def.end,
                uses: Vec::new(),
            };
            symbols.push((symbol, index, side, def.bytes.clone()));
        }
        parsed.push((lang, old_version, new_version));
    }

    // Who uses whom, by name.
    let mut by_name: HashMap<&str, Vec<usize>> = HashMap::new();
    for (i, (symbol, ..)) in symbols.iter().enumerate() {
        if symbol.kind != Kind::Module {
            by_name.entry(symbol.name.as_str()).or_default().push(i);
        }
    }
    let mut uses = vec![Vec::new(); symbols.len()];
    for (i, (symbol, file, side, bytes)) in symbols.iter().enumerate() {
        let (lang, old, new) = &parsed[*file];
        let Some(version) = (if *side == Side::Additions { new } else { old }) else { continue };
        for name in version.names(bytes) {
            let Some(candidates) = by_name.get(name) else { continue };
            let candidates: Vec<usize> = candidates
                .iter()
                .copied()
                // `impl Foo` isn't a use of the `Foo` it's for.
                .filter(|&j| j != i && parsed[symbols[j].1].0.family() == lang.family())
                .filter(|&j| !(symbols[j].0.name == symbol.name && symbols[j].0.path == symbol.path))
                // A class and its methods aren't each other's uses.
                .filter(|&j| {
                    let (other, other_file, other_side, other_bytes) = &symbols[j];
                    !(other_file == file
                        && other_side == side
                        && ((other_bytes.start >= bytes.start && other_bytes.end <= bytes.end)
                            || (bytes.start >= other_bytes.start && bytes.end <= other_bytes.end)))
                        || other.path != symbol.path
                })
                .collect();
            // A name defined in the same file most likely means that one.
            let same_file: Vec<usize> = candidates.iter().copied().filter(|&j| symbols[j].1 == *file).collect();
            uses[i].extend(if same_file.is_empty() { candidates } else { same_file });
        }
    }
    let ids: Vec<String> = symbols.iter().map(|(s, ..)| s.id.clone()).collect();
    Ok(symbols
        .into_iter()
        .zip(uses)
        .map(|((mut symbol, ..), mut used)| {
            used.sort();
            used.dedup();
            symbol.uses = used.into_iter().map(|j| ids[j].clone()).collect();
            symbol
        })
        .collect())
}

/// The first line of each changed symbol of the new version and the line above it, by path: kept
/// in the diff so the reviewer sees what a change is in, and the symbol's note has a place.
pub fn header_lines(symbols: &[Symbol]) -> HashMap<String, BTreeSet<u32>> {
    let mut lines: HashMap<String, BTreeSet<u32>> = HashMap::new();
    for symbol in symbols.iter().filter(|s| s.side == Side::Additions) {
        let entry = lines.entry(symbol.path.clone()).or_default();
        entry.insert(symbol.start);
        if symbol.start > 1 {
            entry.insert(symbol.start - 1);
        }
    }
    lines
}

#[cfg(test)]
mod tests {
    use super::*;

    fn defs(lang: Lang, src: &str) -> Vec<(String, Kind, u32, u32)> {
        let v = Version::parse(lang, src.to_string()).unwrap();
        v.defs.iter().map(|d| (d.key.clone(), d.kind, d.start, d.end)).collect()
    }

    #[test]
    fn finds_typescript_definitions_but_not_local_ones() {
        let src = "export function useUnread(ids: number[]) {\n  const flush = () => mark(ids);\n  return flush;\n}\n\
                   export const mark = (ids: number[]) => invoke(ids);\n\
                   const LIMIT = 3;\n\
                   type Message = { unread: boolean };\n\
                   class View {\n  draw() {}\n}\n";
        assert_eq!(
            defs(Lang::TypeScript, src),
            vec![
                ("useUnread".into(), Kind::Function, 1, 4),
                ("mark".into(), Kind::Function, 5, 5),
                ("LIMIT".into(), Kind::Value, 6, 6),
                ("Message".into(), Kind::Type, 7, 7),
                ("View".into(), Kind::Class, 8, 10),
                ("View.draw".into(), Kind::Method, 9, 9),
            ]
        );
    }

    #[test]
    fn finds_rust_methods_in_impls() {
        let src = "struct Store;\nimpl<T> Store {\n    fn open() {}\n}\nfn main() {\n    fn inner() {}\n}\n";
        assert_eq!(
            defs(Lang::Rust, src),
            vec![
                ("Store".into(), Kind::Type, 1, 1),
                ("Store~2".into(), Kind::Module, 2, 4),
                ("Store~2.open".into(), Kind::Method, 3, 3),
                ("main".into(), Kind::Function, 5, 7),
            ]
        );
    }

    #[test]
    fn links_changed_symbols_that_use_each_other() {
        let dir = std::env::temp_dir().join(format!("piccolo-symbols-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let run = |args: &[&str]| {
            let out = std::process::Command::new("git").current_dir(&dir).args(args).output().unwrap();
            assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
            String::from_utf8_lossy(&out.stdout).into_owned()
        };
        run(&["init", "-q"]);
        run(&["config", "user.email", "t@t"]);
        run(&["config", "user.name", "t"]);
        std::fs::write(dir.join("a.ts"), "export function caller() {\n  return 1;\n}\n").unwrap();
        std::fs::write(dir.join("b.ts"), "export function helper() {\n  return 1;\n}\n\nexport function other() {}\n").unwrap();
        run(&["add", "."]);
        run(&["commit", "-qm", "base"]);
        std::fs::write(dir.join("a.ts"), "export function caller() {\n  return helper() + 1;\n}\n").unwrap();
        std::fs::write(dir.join("b.ts"), "export function helper() {\n  return 2;\n}\n\nexport function other() {}\n").unwrap();
        let patch = run(&["diff", "--src-prefix=a/", "--dst-prefix=b/"]);
        let range = DiffRange { old_rev: "HEAD".into(), new_rev: None };

        let symbols = changed(&dir, &range, &patch).unwrap();
        let summary: Vec<(&str, Vec<&str>)> = symbols.iter().map(|s| (s.id.as_str(), s.uses.iter().map(String::as_str).collect())).collect();
        assert_eq!(summary, vec![("a.ts#caller", vec!["b.ts#helper"]), ("b.ts#helper", vec![])]);
        assert_eq!(header_lines(&symbols).get("a.ts"), Some(&BTreeSet::from([1])));
        let _ = std::fs::remove_dir_all(&dir);
    }
}

