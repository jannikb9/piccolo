//! Code navigation: where a name is defined and used, found by searching the worktree (or a
//! revision) with `git grep`, like GitHub's search-based code navigation. Definitions are told
//! apart from uses by the shape of the line (`fn name`, `class Name`, `const name =`, …), not by a
//! compiler, so a common name can have several candidates.

use crate::git::{self, Result};
use crate::imports;
use crate::repos::blocking;
use regex::Regex;
use serde::Serialize;
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Command, Stdio};

/// Output lines read from `git grep`; a name this common isn't worth listing in full.
const MAX_LINES: usize = 20_000;
/// References returned. Definitions are always kept.
const MAX_REFERENCES: usize = 500;
/// Longer lines are cut around the name.
const MAX_TEXT_CHARS: usize = 200;
/// Lines longer than this are minified or generated code, not worth navigating to.
const MAX_LINE_BYTES: usize = 1000;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SymbolHit {
    pub path: String,
    pub line: u32,
    /// The line without its indentation, cut around the name when it's long.
    pub text: String,
    pub definition: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SymbolSearch {
    /// In `git grep` order: by path, then line.
    pub hits: Vec<SymbolHit>,
    /// Some references were left out.
    pub truncated: bool,
}

/// Lines mentioning `name` as a whole word in files of the same language as `from`, in the
/// working tree (including untracked files) or at `rev`.
pub fn search(wt: &Path, rev: Option<&str>, name: &str, from: &str) -> Result<SymbolSearch> {
    if !is_identifier(name) {
        return Err(format!("not a name: {name}"));
    }
    let lang = Lang::of(from);
    let definitions = Definitions::new(name, lang);

    let mut args = vec!["-c", "core.quotePath=false", "grep", "-n", "-z", "-I", "-w", "-F", "--full-name", "--no-color"];
    if rev.is_none() {
        args.push("--untracked");
    }
    args.extend(["-e", name]);
    if let Some(rev) = rev {
        args.extend(["--end-of-options", rev]);
    }
    args.push("--");
    let specs = lang.pathspecs(from);
    args.extend(specs.iter().map(String::as_str));

    let mut child = Command::new("git")
        .current_dir(wt)
        .args(&args)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to run git: {e}"))?;
    let stdout = child.stdout.take().expect("stdout is piped");

    // `path\0line\0text\n`; at a revision the path reads `rev:path`.
    let prefix = rev.map(|r| format!("{r}:")).unwrap_or_default();
    let mut hits = Vec::new();
    let mut references = 0;
    let mut truncated = false;
    for (i, line) in BufReader::new(stdout).split(b'\n').enumerate() {
        if i == MAX_LINES {
            truncated = true;
            break;
        }
        let Ok(line) = line else { break };
        let line = String::from_utf8_lossy(&line);
        let mut fields = line.splitn(3, '\0');
        let (Some(path), Some(number), Some(text)) = (fields.next(), fields.next(), fields.next()) else { continue };
        let Ok(number) = number.parse() else { continue };
        if text.len() > MAX_LINE_BYTES {
            continue;
        }
        let definition = definitions.matches(text);
        if !definition {
            references += 1;
            if references > MAX_REFERENCES {
                truncated = true;
                continue;
            }
        }
        hits.push(SymbolHit {
            path: path.strip_prefix(&prefix).unwrap_or(path).to_string(),
            line: number,
            text: snippet(text, name),
            definition,
        });
    }
    if truncated {
        let _ = child.kill();
    }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    // Exit code 1 means nothing matched.
    if !truncated && !out.status.success() && out.status.code() != Some(1) {
        return Err(format!("git grep: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    Ok(SymbolSearch { hits, truncated })
}

/// A name in any common language: letters, digits, `_` and `$`, not starting with a digit.
fn is_identifier(name: &str) -> bool {
    let mut chars = name.chars();
    chars.next().is_some_and(|c| c.is_alphabetic() || c == '_' || c == '$')
        && chars.all(|c| c.is_alphanumeric() || c == '_' || c == '$')
        && name.len() <= 200
}

/// `text` without indentation, cut to a window around the first mention of `name` when long.
fn snippet(text: &str, name: &str) -> String {
    let text = text.trim();
    if text.chars().count() <= MAX_TEXT_CHARS {
        return text.to_string();
    }
    let at = text.find(name).map_or(0, |byte| text[..byte].chars().count());
    let start = at.saturating_sub(MAX_TEXT_CHARS / 3);
    let cut: String = text.chars().skip(start).take(MAX_TEXT_CHARS).collect();
    format!("{}{cut}…", if start > 0 { "…" } else { "" })
}

// ---------------------------------------------------------------------------------------------
// Languages

/// Families of files that refer to each other's names.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Lang {
    Js,
    Rust,
    Go,
    Python,
    Ruby,
    /// C, C++, Objective-C, Java, C#, Dart: declarations start with a type.
    CLike,
    Other,
}

const FAMILIES: &[(Lang, &[&str])] = &[
    (Lang::Js, &["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "vue", "svelte", "astro"]),
    (Lang::Rust, &["rs"]),
    (Lang::Go, &["go"]),
    (Lang::Python, &["py", "pyi"]),
    (Lang::Ruby, &["rb", "rake"]),
    (Lang::CLike, &["c", "h", "cc", "cpp", "cxx", "hpp", "hh", "hxx", "m", "mm"]),
    (Lang::CLike, &["java", "kt", "kts", "scala", "groovy"]),
    (Lang::CLike, &["cs"]),
    (Lang::CLike, &["dart"]),
    (Lang::Other, &["swift"]),
    (Lang::Other, &["ex", "exs"]),
    (Lang::Other, &["css", "scss", "sass", "less"]),
    (Lang::Other, &["sh", "bash", "zsh"]),
];

impl Lang {
    fn family(path: &str) -> Option<(Lang, &'static [&'static str])> {
        let ext = extension(path)?;
        FAMILIES.iter().find(|(_, exts)| exts.contains(&ext.as_str())).copied()
    }

    fn of(path: &str) -> Lang {
        Self::family(path).map_or(Lang::Other, |(lang, _)| lang)
    }

    /// Files to search: the family of `path`'s extension, that extension alone if it's in no
    /// family, or everything for files without one.
    fn pathspecs(self, path: &str) -> Vec<String> {
        let mut specs: Vec<String> = match (Self::family(path), extension(path)) {
            (Some((_, exts)), _) => exts.iter().map(|e| format!("*.{e}")).collect(),
            (None, Some(ext)) => vec![format!("*.{ext}")],
            (None, None) => Vec::new(),
        };
        if self == Lang::Js {
            // Bundles: minified builds and Yarn's checked-in releases.
            specs.extend([":(exclude)*.min.js".into(), ":(exclude).yarn".into()]);
        }
        specs
    }
}

fn extension(path: &str) -> Option<String> {
    let name = path.rsplit('/').next()?;
    let (stem, ext) = name.rsplit_once('.')?;
    (!stem.is_empty()).then(|| ext.to_ascii_lowercase())
}

// ---------------------------------------------------------------------------------------------
// Definitions

/// Line shapes that define `name` rather than use it.
struct Definitions {
    rules: Vec<Regex>,
    /// `Type name(`, `Type name =`: C-like declarations, which start with a type instead of a
    /// keyword. The captured type words mustn't include keywords like `return` or `new`.
    typed: Option<Regex>,
}

/// Words that can come before a name without declaring it: `return foo(…)`, `new Foo(…)`.
const NOT_TYPES: &[&str] = &[
    "return", "new", "throw", "throws", "else", "case", "delete", "await", "yield", "goto", "sizeof", "typeof",
    "instanceof", "in", "is", "as", "not", "and", "or", "if", "while", "for", "switch", "do", "echo", "print",
    "import", "package", "extends", "implements", "using",
];

impl Definitions {
    fn new(name: &str, lang: Lang) -> Self {
        let edge = |c: Option<char>| if c.is_some_and(|c| c.is_alphanumeric() || c == '_') { r"\b" } else { "" };
        let n = format!("{}{}{}", edge(name.chars().next()), regex::escape(name), edge(name.chars().last()));
        let mut rules = vec![
            // `fn name`, `class Name`, `const name`, `let mut name`, `function* name`, …
            format!(
                r"\b(?:function\*?|fn|def|defp|defmacro|defmodule|func|fun|class|struct|enum|trait|interface|type|typealias|protocol|module|mod|namespace|record|object|union|const|let|var|val|static|sub)\s+(?:mut\s+|\*\s*)?{n}"
            ),
            format!(r"#\s*define\s+{n}"),
            // Go methods: `func (s *Server) name(`
            format!(r"\bfunc\s*\([^)]*\)\s*{n}"),
            // Ruby class methods: `def self.name`
            format!(r"\bdef\s+self\.{n}"),
            // Kotlin generic and extension functions: `fun <T> List<T>.name(`
            format!(r"\bfun\s+(?:<[^>]*>\s*)?[\w.<>?]+\.{n}\s*\("),
        ];
        match lang {
            Lang::Js => {
                let modifiers = r"(?:(?:export|default|public|private|protected|static|async|override|readonly|abstract|declare|get|set)\s+)*";
                // Methods: `async name(a, b): Promise<T> {`
                rules.push(format!(r"^\s*{modifiers}\*?\s*{n}\s*(?:<[^>]*>)?\s*\([^()]*\)\s*(?::\s*[^={{}}]+)?\{{\s*$"));
                // Functions as properties or fields: `name: (a) =>`, `name = async () =>`, `name: function`
                rules.push(format!(
                    r"^\s*{modifiers}{n}\s*(?::\s*[^=]+?)?\s*[:=]\s*(?:async\s+)?(?:function\b|\([^()]*\)\s*(?::\s*[^=]+?)?\s*=>|[\w$]+\s*=>)"
                ));
                // Members of interfaces, types and classes: `name?: string;`, `name(a: T): U;`
                rules.push(format!(r"^\s*{modifiers}{n}\??\s*(?:<[^>]*>)?(?:\([^()]*\))?\s*:\s*[^;]+;\s*$"));
            }
            // Struct fields: `pub name: Type`
            Lang::Rust => rules.push(format!(r"^\s*pub(?:\([^)]*\))?\s+{n}\s*:")),
            // Struct fields: `Name string `json:"name"``
            Lang::Go => rules.push(format!(r"^\s+{n}\s+[\w*\[\].]+(?:\s+`[^`]*`)?\s*$")),
            Lang::Python | Lang::Ruby => {
                // Module-level assignments: `NAME = …`
                rules.push(format!(r"^{n}\s*(?::[^=]*)?=[^=]"));
                // Annotated attributes: `name: int = 0`
                if lang == Lang::Python {
                    rules.push(format!(r"^\s*{n}\s*:\s*[^=\s][^=]*(?:=[^=].*)?$"));
                }
            }
            Lang::CLike | Lang::Other => {}
        }
        let typed = (lang == Lang::CLike).then(|| {
            Regex::new(&format!(r"^\s*((?:[\w$:.]+(?:<[^()]*?>)?[*&\[\]?]*\s+)+)[*&]*{n}\s*(?:\(|=[^=]|;|\[|,|\{{|$)"))
                .expect("valid regex")
        });
        Self { rules: rules.iter().map(|r| Regex::new(r).expect("valid regex")).collect(), typed }
    }

    fn matches(&self, line: &str) -> bool {
        let t = line.trim_start();
        let comment = t.starts_with("//") || t.starts_with("/*") || t.starts_with("* ") || (t.starts_with('#') && !t[1..].trim_start().starts_with("define"));
        if comment || imports::starts_import(line) {
            return false;
        }
        self.rules.iter().any(|r| r.is_match(line))
            || self.typed.as_ref().is_some_and(|r| {
                r.captures(line).is_some_and(|c| {
                    !c[1].split(|ch: char| !(ch.is_alphanumeric() || ch == '_')).any(|w| NOT_TYPES.contains(&w))
                })
            })
    }
}

// ---------------------------------------------------------------------------------------------
// Commands

/// Where `name` is defined and used. `rev == None` searches the working tree.
#[tauri::command]
pub async fn find_symbol(path: String, rev: Option<String>, name: String, from: String) -> Result<SymbolSearch> {
    blocking(move || search(Path::new(&path), rev.as_deref(), &name, &from)).await
}

/// One file at `rev`, or in the working tree; `None` if it doesn't exist there or isn't text.
#[tauri::command]
pub async fn file_text(path: String, rev: Option<String>, file: String) -> Result<Option<String>> {
    blocking(move || git::file_contents(Path::new(&path), rev.as_deref(), &file)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn is_def(lang: Lang, name: &str, line: &str) -> bool {
        Definitions::new(name, lang).matches(line)
    }

    #[test]
    fn recognises_keyword_definitions_in_any_language() {
        for (name, line) in [
            ("getSession", "export async function getSession(req: Request) {"),
            ("Session", "export interface Session {"),
            ("Session", "export type Session = { id: string };"),
            ("SESSION_COOKIE", "const SESSION_COOKIE = \"sid\";"),
            ("parse", "pub(crate) fn parse(input: &str) -> Result<()> {"),
            ("Repos", "pub struct Repos(Mutex<Vec<String>>);"),
            ("count", "    let mut count = 0;"),
            ("load", "def load(path):"),
            ("Loader", "class Loader(Base):"),
            ("Serve", "func (s *Server) Serve(ctx context.Context) error {"),
            ("New", "func New() *Server {"),
            ("find", "  def self.find(id)"),
            ("names", "fun <T> List<T>.names(): List<String> {"),
            ("MAX", "#define MAX 10"),
        ] {
            assert!(is_def(Lang::Other, name, line), "{name} in {line:?}");
        }
    }

    #[test]
    fn recognises_js_members() {
        for (name, line) in [
            ("refresh", "  async refresh(token: Token): Promise<void> {"),
            ("constructor", "  constructor(private db: Db) {"),
            ("onScroll", "  const onScroll = useCallback((top: number) => {"),
            ("handle", "  handle = async (event) => {"),
            ("toJSON", "  toJSON: function () {"),
            ("sessionId", "  sessionId: string;"),
            ("expiresAt", "  readonly expiresAt?: number;"),
            ("find", "  find(id: string): Promise<User>;"),
        ] {
            assert!(is_def(Lang::Js, name, line), "{name} in {line:?}");
        }
    }

    #[test]
    fn leaves_uses_as_references() {
        for (lang, name, line) in [
            (Lang::Js, "getSession", "  const session = await getSession(req);"),
            (Lang::Js, "useEffect", "  useEffect(() => {"),
            (Lang::Js, "getSession", "import { getSession } from \"./session\";"),
            (Lang::Js, "Session", "import type Session from \"./types\";"),
            (Lang::Js, "sessionId", "    sessionId: token.sid,"),
            (Lang::Js, "load", "// function load was removed"),
            (Lang::Rust, "parse", "    let value = parse(&input)?;"),
            (Lang::Rust, "Repos", "use crate::repos::Repos;"),
            (Lang::Python, "load", "    data = load(path)"),
            (Lang::CLike, "run", "    return run(args);"),
            (Lang::CLike, "Foo", "    Foo foo = new Foo();"),
        ] {
            assert!(!is_def(lang, name, line), "{name} in {line:?}");
        }
    }

    #[test]
    fn recognises_typed_declarations_in_c_like_languages() {
        assert!(is_def(Lang::CLike, "main", "public static void main(String[] args) {"));
        assert!(is_def(Lang::CLike, "cache", "    private final Map<String, Entry> cache = new HashMap<>();"));
        assert!(is_def(Lang::CLike, "next", "static struct node *next;"));
        assert!(is_def(Lang::CLike, "area", "double area(const Shape& s);"));
    }

    #[test]
    fn recognises_field_definitions() {
        assert!(is_def(Lang::Rust, "path", "    pub path: String,"));
        assert!(!is_def(Lang::Rust, "path", "        path: entry.path.clone(),"));
        assert!(is_def(Lang::Go, "Name", "\tName string `json:\"name\"`"));
        assert!(is_def(Lang::Python, "TIMEOUT", "TIMEOUT = 30"));
        assert!(is_def(Lang::Python, "name", "    name: str = \"\""));
    }

    #[test]
    fn searches_the_language_family_of_the_file() {
        assert_eq!(Lang::of("src/App.tsx"), Lang::Js);
        assert_eq!(Lang::Js.pathspecs("a.ts")[..2], ["*.ts", "*.tsx"]);
        assert_eq!(Lang::Other.pathspecs("main.tf"), ["*.tf"]);
        assert!(Lang::Other.pathspecs("Makefile").is_empty());
        assert!(Lang::Other.pathspecs(".gitignore").is_empty());
    }

    #[test]
    fn cuts_long_lines_around_the_name() {
        let line = format!("{}needle{}", "a ".repeat(200), " b".repeat(200));
        let text = snippet(&line, "needle");
        assert!(text.starts_with('…') && text.ends_with('…'));
        assert!(text.contains("needle"));
        assert_eq!(snippet("    short line", "short"), "short line");
    }

    /// End-to-end against a real repository: the working tree (with untracked files) and a revision.
    #[test]
    fn finds_definitions_and_references_with_git_grep() {
        let root = std::env::temp_dir().join(format!("review-navigate-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("src")).unwrap();
        let run = |args: &[&str]| git::git(&root, args).unwrap();
        run(&["init", "-q", "-b", "main"]);
        run(&["config", "user.email", "t@example.com"]);
        run(&["config", "user.name", "Test"]);
        fs::write(root.join("src/tokens.ts"), "export function readToken(cookie: string) {\n  return cookie;\n}\n").unwrap();
        fs::write(root.join("src/notes.md"), "readToken is documented here\n").unwrap();
        run(&["add", "."]);
        run(&["commit", "-q", "-m", "init"]);
        let base = run(&["rev-parse", "HEAD"]).trim().to_string();
        // Uncommitted: a new, untracked caller.
        fs::write(root.join("src/session.ts"), "import { readToken } from \"./tokens\";\nconst t = readToken(c);\n").unwrap();

        let found = search(&root, None, "readToken", "src/session.ts").unwrap();
        let summary: Vec<_> = found.hits.iter().map(|h| (h.path.as_str(), h.line, h.definition)).collect();
        assert_eq!(summary, [("src/session.ts", 1, false), ("src/session.ts", 2, false), ("src/tokens.ts", 1, true)]);
        assert_eq!(found.hits[1].text, "const t = readToken(c);");

        // At the base revision the caller doesn't exist yet.
        let found = search(&root, Some(&base), "readToken", "src/tokens.ts").unwrap();
        assert_eq!(found.hits.iter().map(|h| h.path.as_str()).collect::<Vec<_>>(), ["src/tokens.ts"]);

        assert!(search(&root, None, "nothing_like_this", "src/a.ts").unwrap().hits.is_empty());
        assert!(search(&root, None, "--output=x", "src/a.ts").is_err());
        let _ = fs::remove_dir_all(&root);
    }
}
