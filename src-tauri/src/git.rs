//! Thin wrapper around the `git` CLI. Shelling out (rather than using libgit2) keeps behaviour
//! identical to the user's terminal: same config, attributes, hooks-free reads, and worktree semantics.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::UNIX_EPOCH;

pub type Result<T> = std::result::Result<T, String>;

pub fn git(cwd: &Path, args: &[&str]) -> Result<String> {
    let out = Command::new("git")
        .current_dir(cwd)
        .args(["-c", "core.quotePath=false"])
        .args(args)
        // Read-only commands like `status` otherwise refresh the index and take its lock,
        // which can make an agent's concurrent `git commit` in the same worktree fail.
        .env("GIT_OPTIONAL_LOCKS", "0")
        .output()
        .map_err(|e| format!("failed to run git: {e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!("git {}: {}", args.join(" "), stderr.trim()));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

// ---------------------------------------------------------------------------------------------
// Worktrees

#[derive(Debug, Clone, PartialEq)]
pub struct WorktreeEntry {
    pub path: String,
    pub head: String,
    /// Short branch name; `None` when HEAD is detached.
    pub branch: Option<String>,
    pub bare: bool,
    /// Registered but its directory is gone (`git worktree prune` would remove it).
    pub prunable: bool,
}

/// All worktrees of the repository containing `path`. The first entry is always the main worktree.
pub fn list_worktrees(path: &Path) -> Result<Vec<WorktreeEntry>> {
    Ok(parse_worktree_list(&git(path, &["worktree", "list", "--porcelain", "-z"])?))
}

fn parse_worktree_list(out: &str) -> Vec<WorktreeEntry> {
    let mut entries = Vec::new();
    let mut current: Option<WorktreeEntry> = None;
    for token in out.split('\0') {
        if token.is_empty() {
            entries.extend(current.take());
            continue;
        }
        let (key, value) = token.split_once(' ').unwrap_or((token, ""));
        if key == "worktree" {
            entries.extend(current.take());
            current = Some(WorktreeEntry {
                path: value.to_string(),
                head: String::new(),
                branch: None,
                bare: false,
                prunable: false,
            });
            continue;
        }
        let Some(entry) = current.as_mut() else { continue };
        match key {
            "HEAD" => entry.head = value.to_string(),
            "branch" => entry.branch = Some(value.strip_prefix("refs/heads/").unwrap_or(value).to_string()),
            "bare" => entry.bare = true,
            "prunable" => entry.prunable = true,
            _ => {}
        }
    }
    entries.extend(current);
    entries
}

/// The branch reviews are compared against: the remote's default branch if known, else
/// `main`/`master`. Prefers the local branch, since agent worktrees usually branch off it.
pub fn default_branch(repo: &Path) -> Option<String> {
    let remote_head = git(repo, &["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"])
        .ok()
        .and_then(|s| s.trim().strip_prefix("origin/").map(str::to_string));
    let candidates: Vec<String> = remote_head
        .into_iter()
        .chain(["main".to_string(), "master".to_string()])
        .collect();

    let exists = |r: &str| git(repo, &["rev-parse", "--verify", "--quiet", &format!("{r}^{{commit}}")]).is_ok();
    for name in &candidates {
        if exists(&format!("refs/heads/{name}")) {
            return Some(name.clone());
        }
    }
    candidates
        .iter()
        .map(|name| format!("origin/{name}"))
        .find(|r| exists(&format!("refs/remotes/{r}")))
}

// ---------------------------------------------------------------------------------------------
// Status

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeStatus {
    pub dirty: bool,
    /// Last time anything in the worktree changed (files or git state), epoch ms.
    pub updated_at: u64,
}

pub fn worktree_status(wt: &Path) -> Result<WorktreeStatus> {
    let out = git(wt, &["status", "--porcelain=v1", "-z", "--untracked-files=all"])?;
    let paths = parse_status_paths(&out);
    let mut updated_at = git_activity_time(wt);
    for path in &paths {
        updated_at = updated_at.max(mtime_ms(&wt.join(path)));
    }
    Ok(WorktreeStatus { dirty: !paths.is_empty(), updated_at })
}

fn parse_status_paths(out: &str) -> Vec<String> {
    let mut paths = Vec::new();
    let mut tokens = out.split('\0');
    while let Some(entry) = tokens.next() {
        if entry.len() < 4 {
            continue;
        }
        let (code, path) = entry.split_at(3);
        paths.push(path.to_string());
        // Renames and copies are followed by a token holding the original path.
        if code.starts_with('R') || code.starts_with('C') {
            tokens.next();
        }
    }
    paths
}

/// Most recent change to the worktree's git state: checkouts, staging, commits.
fn git_activity_time(wt: &Path) -> u64 {
    let Some(git_dir) = resolve_git_dir(wt) else { return 0 };
    ["HEAD", "index", "logs/HEAD"]
        .iter()
        .map(|f| mtime_ms(&git_dir.join(f)))
        .max()
        .unwrap_or(0)
}

/// `<wt>/.git` is a directory for the main worktree and a `gitdir: <path>` file for linked ones.
fn resolve_git_dir(wt: &Path) -> Option<PathBuf> {
    let dot_git = wt.join(".git");
    if dot_git.is_dir() {
        return Some(dot_git);
    }
    let contents = fs::read_to_string(&dot_git).ok()?;
    let dir = Path::new(contents.trim().strip_prefix("gitdir:")?.trim());
    Some(if dir.is_absolute() { dir.to_path_buf() } else { wt.join(dir) })
}

fn mtime_ms(path: &Path) -> u64 {
    fs::symlink_metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis() as u64)
}

/// The directory git keeps shared state in (`.git` of the main worktree).
pub fn common_git_dir(repo: &Path) -> Result<PathBuf> {
    let out = git(repo, &["rev-parse", "--path-format=absolute", "--git-common-dir"])?;
    Ok(PathBuf::from(out.trim()))
}

// ---------------------------------------------------------------------------------------------
// Diffs

#[derive(Debug, Clone, Copy, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Scope {
    /// Everything since the branch forked from base, including uncommitted work.
    All,
    Committed,
    Uncommitted,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum FileStatus {
    Added,
    Modified,
    Deleted,
    Renamed,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
    pub status: FileStatus,
    pub additions: u32,
    pub deletions: u32,
    pub binary: bool,
    /// Marked `linguist-generated` in `.gitattributes`.
    pub generated: bool,
}

pub fn merge_base(wt: &Path, base: &str) -> Result<String> {
    Ok(git(wt, &["merge-base", base, "HEAD"])?.trim().to_string())
}

/// Commits (ahead, behind) of HEAD relative to `base`.
pub fn ahead_behind(wt: &Path, base: &str) -> Result<(u32, u32)> {
    let out = git(wt, &["rev-list", "--left-right", "--count", &format!("{base}...HEAD")])?;
    let mut counts = out.split_whitespace().map(|n| n.parse().unwrap_or(0));
    let behind = counts.next().unwrap_or(0);
    let ahead = counts.next().unwrap_or(0);
    Ok((ahead, behind))
}

/// The two sides being compared. `new == None` means the working tree (including untracked files).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffRange {
    pub old_rev: String,
    pub new_rev: Option<String>,
}

impl DiffRange {
    /// Without a base, only uncommitted changes are compared.
    pub fn resolve(wt: &Path, base: Option<&str>, scope: Scope) -> Result<Self> {
        let head = git(wt, &["rev-parse", "HEAD"])?.trim().to_string();
        let fork_point = match base {
            Some(base) => merge_base(wt, base)?,
            None => head.clone(),
        };
        Ok(match scope {
            Scope::All => Self { old_rev: fork_point, new_rev: None },
            Scope::Committed => Self { old_rev: fork_point, new_rev: Some(head) },
            Scope::Uncommitted => Self { old_rev: head, new_rev: None },
        })
    }

    fn args(&self) -> Vec<&str> {
        std::iter::once(self.old_rev.as_str()).chain(self.new_rev.as_deref()).collect()
    }

    fn includes_untracked(&self) -> bool {
        self.new_rev.is_none()
    }
}

fn diff_flags(ignore_whitespace: bool) -> Vec<&'static str> {
    let mut flags = vec!["diff", "-M", "--no-ext-diff", "--no-color"];
    if ignore_whitespace {
        flags.push("--ignore-all-space");
    }
    flags
}

/// Files changed in the worktree relative to where it forked from `base`.
pub fn changed_files(wt: &Path, base: Option<&str>, scope: Scope, ignore_whitespace: bool) -> Result<Vec<ChangedFile>> {
    let range = DiffRange::resolve(wt, base, scope)?;
    let diff = |format: &str| {
        let mut args = diff_flags(ignore_whitespace);
        args.extend(["-z", format]);
        args.extend(range.args());
        args.push("--");
        git(wt, &args)
    };

    let counts = parse_numstat(&diff("--numstat")?);
    let mut files: Vec<ChangedFile> = parse_name_status(&diff("--name-status")?)
        .into_iter()
        .map(|(path, status, old_path)| {
            let (additions, deletions, binary) = counts.get(&path).copied().unwrap_or_default();
            ChangedFile { path, old_path, status, additions, deletions, binary, generated: false }
        })
        // With whitespace ignored, files whose only changes were whitespace have no lines left.
        .filter(|f| !ignore_whitespace || f.binary || f.additions + f.deletions > 0 || f.status != FileStatus::Modified)
        .collect();

    if range.includes_untracked() {
        for path in untracked_files(wt)? {
            let (additions, binary) = count_lines(&wt.join(&path));
            files.push(ChangedFile {
                path,
                old_path: None,
                status: FileStatus::Added,
                additions,
                deletions: 0,
                binary,
                generated: false,
            });
        }
    }

    let generated = generated_paths(wt, files.iter().map(|f| f.path.as_str()))?;
    for file in &mut files {
        file.generated = generated.contains(&file.path);
    }
    Ok(files)
}

fn untracked_files(wt: &Path) -> Result<Vec<String>> {
    let out = git(wt, &["ls-files", "--others", "--exclude-standard", "-z"])?;
    Ok(out.split('\0').filter(|p| !p.is_empty()).map(str::to_string).collect())
}

/// Paths marked `linguist-generated` in `.gitattributes`, the convention GitHub uses to collapse
/// generated files in reviews.
fn generated_paths<'a>(wt: &Path, paths: impl Iterator<Item = &'a str>) -> Result<std::collections::HashSet<String>> {
    let input: String = paths.map(|p| format!("{p}\0")).collect();
    if input.is_empty() {
        return Ok(Default::default());
    }
    let out = git_with_input(wt, &["check-attr", "-z", "--stdin", "linguist-generated"], &input)?;
    // Output: `path\0attribute\0value\0` per path.
    let tokens: Vec<&str> = out.split('\0').collect();
    Ok(tokens
        .chunks(3)
        .filter(|c| c.len() == 3 && matches!(c[2], "set" | "true"))
        .map(|c| c[0].to_string())
        .collect())
}

fn git_with_input(cwd: &Path, args: &[&str], input: &str) -> Result<String> {
    use std::io::Write;
    use std::process::Stdio;
    let mut child = Command::new("git")
        .current_dir(cwd)
        .args(args)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to run git: {e}"))?;
    // Written from a thread so a large input can't deadlock against a full stdout pipe.
    let mut stdin = child.stdin.take().expect("stdin is piped");
    let input = input.to_string();
    let writer = std::thread::spawn(move || stdin.write_all(input.as_bytes()));
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    let _ = writer.join();
    if !out.status.success() {
        return Err(format!("git {}: {}", args.join(" "), String::from_utf8_lossy(&out.stderr).trim()));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffPatch {
    #[serde(flatten)]
    pub range: DiffRange,
    /// Unified diff of every changed file, including untracked text files.
    pub patch: String,
}

pub fn diff_patch(wt: &Path, base: Option<&str>, scope: Scope, ignore_whitespace: bool) -> Result<DiffPatch> {
    let range = DiffRange::resolve(wt, base, scope)?;
    let mut args = diff_flags(ignore_whitespace);
    // Explicit prefixes override `diff.noprefix` / `diff.mnemonicPrefix` in the user's config.
    args.extend(["--src-prefix=a/", "--dst-prefix=b/"]);
    args.extend(range.args());
    args.push("--");
    let mut patch = git(wt, &args)?;

    if range.includes_untracked() {
        for path in untracked_files(wt)? {
            if let Some(contents) = read_text(&wt.join(&path)) {
                patch.push_str(&new_file_patch(&path, &contents));
            }
        }
    }
    Ok(DiffPatch { range, patch })
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum LineKind {
    Context,
    Add,
    Del,
}

/// One row of a diff, with its line number on each side it exists on.
#[derive(Debug, Clone, PartialEq)]
pub struct DiffLine {
    pub kind: LineKind,
    pub old: Option<u32>,
    pub new: Option<u32>,
    pub text: String,
}

/// Every line of one file across `range`: a diff with unlimited context, so unchanged lines the
/// reviewer expanded are included too. `old_path` differs from `path` for renames.
pub fn full_file_diff(wt: &Path, range: &DiffRange, old_path: &str, path: &str) -> Result<Vec<DiffLine>> {
    let mut args = diff_flags(false);
    args.extend(["--unified=100000000", "--src-prefix=a/", "--dst-prefix=b/"]);
    args.extend(range.args());
    args.push("--");
    args.push(path);
    if old_path != path {
        args.push(old_path);
    }
    let rows = parse_file_diff(&git(wt, &args)?, path);
    if !rows.is_empty() {
        return Ok(rows);
    }
    // No textual diff: untracked (all added) or unchanged (all context).
    let contents = match &range.new_rev {
        None => read_text(&wt.join(path)),
        rev => file_contents(wt, rev.as_deref(), path)?,
    };
    let Some(contents) = contents else { return Ok(Vec::new()) };
    let untracked = file_contents(wt, Some(&range.old_rev), old_path)?.is_none();
    Ok(contents
        .lines()
        .enumerate()
        .map(|(i, text)| {
            let n = i as u32 + 1;
            if untracked {
                DiffLine { kind: LineKind::Add, old: None, new: Some(n), text: text.to_string() }
            } else {
                DiffLine { kind: LineKind::Context, old: Some(n), new: Some(n), text: text.to_string() }
            }
        })
        .collect())
}

/// Rows of the file entry for `path` in a unified diff.
fn parse_file_diff(patch: &str, path: &str) -> Vec<DiffLine> {
    let header_suffix = format!(" b/{path}");
    let mut rows = Vec::new();
    let (mut in_file, mut in_hunk) = (false, false);
    let (mut old, mut new) = (0u32, 0u32);
    for line in patch.lines() {
        if line.starts_with("diff --git ") {
            if in_file {
                break;
            }
            in_file = line.ends_with(&header_suffix);
            in_hunk = false;
            continue;
        }
        if !in_file {
            continue;
        }
        if let Some(header) = line.strip_prefix("@@ ") {
            // `@@ -12,5 +12,7 @@`
            let mut starts = header.split(' ').take(2).map(|part| {
                part[1..].split(',').next().and_then(|n| n.parse::<u32>().ok()).unwrap_or(1)
            });
            old = starts.next().unwrap_or(1);
            new = starts.next().unwrap_or(1);
            in_hunk = true;
            continue;
        }
        if !in_hunk {
            continue;
        }
        let (kind, text) = match line.split_at_checked(1) {
            Some(("+", text)) => (LineKind::Add, text),
            Some(("-", text)) => (LineKind::Del, text),
            Some((" ", text)) => (LineKind::Context, text),
            _ => continue, // `\ No newline at end of file`
        };
        let row = DiffLine {
            kind,
            old: (kind != LineKind::Add).then_some(old),
            new: (kind != LineKind::Del).then_some(new),
            text: text.to_string(),
        };
        old += u32::from(row.old.is_some());
        new += u32::from(row.new.is_some());
        rows.push(row);
    }
    rows
}

/// The patch `git diff` would print for a new file, for untracked files git doesn't diff.
fn new_file_patch(path: &str, contents: &str) -> String {
    let mut out = format!("diff --git a/{path} b/{path}\nnew file mode 100644\n");
    if contents.is_empty() {
        return out;
    }
    let lines: Vec<&str> = contents.split_inclusive('\n').collect();
    out.push_str(&format!("--- /dev/null\n+++ b/{path}\n@@ -0,0 +1,{} @@\n", lines.len()));
    for line in &lines {
        out.push('+');
        out.push_str(line);
    }
    if !contents.ends_with('\n') {
        out.push_str("\n\\ No newline at end of file\n");
    }
    out
}

/// Contents of `path` at `rev`, or in the working tree when `rev` is `None`.
/// `None` if the file doesn't exist there or isn't text.
pub fn file_contents(wt: &Path, rev: Option<&str>, path: &str) -> Result<Option<String>> {
    match rev {
        None => Ok(read_text(&wt.join(path))),
        Some(rev) => {
            let spec = format!("{rev}:{path}");
            if git(wt, &["cat-file", "-e", &spec]).is_err() {
                return Ok(None);
            }
            let out = Command::new("git")
                .current_dir(wt)
                .args(["cat-file", "blob", &spec])
                .output()
                .map_err(|e| e.to_string())?;
            Ok(text_from_bytes(out.stdout))
        }
    }
}

/// Large files are left out of patches; their diffs aren't reviewable line by line anyway.
const MAX_TEXT_BYTES: u64 = 4 * 1024 * 1024;

fn read_text(path: &Path) -> Option<String> {
    let meta = fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > MAX_TEXT_BYTES {
        return None;
    }
    text_from_bytes(fs::read(path).ok()?)
}

fn text_from_bytes(bytes: Vec<u8>) -> Option<String> {
    if bytes[..bytes.len().min(8000)].contains(&0) {
        return None;
    }
    Some(String::from_utf8(bytes).unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned()))
}

/// `git diff --numstat -z`: `add\tdel\tpath\0`, or `add\tdel\t\0old\0new\0` for renames.
/// Binary files report `-` for both counts.
fn parse_numstat(out: &str) -> HashMap<String, (u32, u32, bool)> {
    let mut map = HashMap::new();
    let mut tokens = out.split('\0');
    while let Some(token) = tokens.next() {
        if token.is_empty() {
            continue;
        }
        let mut parts = token.splitn(3, '\t');
        let (add, del, path) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""), parts.next().unwrap_or(""));
        let path = if path.is_empty() {
            tokens.next(); // old path
            tokens.next().unwrap_or("")
        } else {
            path
        };
        map.insert(path.to_string(), (add.parse().unwrap_or(0), del.parse().unwrap_or(0), add == "-"));
    }
    map
}

/// `git diff --name-status -z`: `M\0path\0`, or `R087\0old\0new\0` for renames and copies.
fn parse_name_status(out: &str) -> Vec<(String, FileStatus, Option<String>)> {
    let mut entries = Vec::new();
    let mut tokens = out.split('\0');
    while let Some(code) = tokens.next() {
        let Some(kind) = code.chars().next() else { continue };
        match kind {
            'R' | 'C' => {
                let old = tokens.next().unwrap_or("").to_string();
                let new = tokens.next().unwrap_or("").to_string();
                if kind == 'R' {
                    entries.push((new, FileStatus::Renamed, Some(old)));
                } else {
                    entries.push((new, FileStatus::Added, None));
                }
            }
            _ => {
                let path = tokens.next().unwrap_or("").to_string();
                let status = match kind {
                    'A' => FileStatus::Added,
                    'D' => FileStatus::Deleted,
                    _ => FileStatus::Modified,
                };
                entries.push((path, status, None));
            }
        }
    }
    entries
}

/// Line count and binary flag for an untracked file, using git's heuristic (a NUL byte in the
/// first 8000 bytes means binary). Very large files are not counted.
fn count_lines(path: &Path) -> (u32, bool) {
    const MAX_BYTES: u64 = 8 * 1024 * 1024;
    let Ok(file) = fs::File::open(path) else { return (0, false) };
    let mut bytes = Vec::new();
    if file.take(MAX_BYTES).read_to_end(&mut bytes).is_err() {
        return (0, false);
    }
    if bytes[..bytes.len().min(8000)].contains(&0) {
        return (0, true);
    }
    let newlines = bytes.iter().filter(|&&b| b == b'\n').count();
    let trailing = usize::from(bytes.last().is_some_and(|&b| b != b'\n'));
    ((newlines + trailing) as u32, false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_worktree_list() {
        let out = "worktree /repo\0HEAD aaa\0branch refs/heads/main\0\0\
                   worktree /wt/feat\0HEAD bbb\0branch refs/heads/feat/x\0\0\
                   worktree /wt/detached\0HEAD ccc\0detached\0\0\
                   worktree /wt/gone\0HEAD ddd\0branch refs/heads/old\0prunable gitdir file points to non-existent location\0\0";
        let list = parse_worktree_list(out);
        assert_eq!(list.len(), 4);
        assert_eq!(list[0].path, "/repo");
        assert_eq!(list[0].branch.as_deref(), Some("main"));
        assert_eq!(list[1].branch.as_deref(), Some("feat/x"));
        assert_eq!(list[2].branch, None);
        assert_eq!(list[2].head, "ccc");
        assert!(list[3].prunable);
    }

    #[test]
    fn parses_status_paths_with_renames() {
        let out = " M src/a.ts\0R  new.ts\0old.ts\0?? notes.md\0";
        assert_eq!(parse_status_paths(out), vec!["src/a.ts", "new.ts", "notes.md"]);
    }

    #[test]
    fn parses_numstat_with_renames_and_binary() {
        let out = "3\t1\tsrc/a.ts\0-\t-\tlogo.png\0\
                   2\t0\t\0old/name.ts\0new/name.ts\0";
        let map = parse_numstat(out);
        assert_eq!(map["src/a.ts"], (3, 1, false));
        assert_eq!(map["logo.png"], (0, 0, true));
        assert_eq!(map["new/name.ts"], (2, 0, false));
    }

    /// End-to-end against a real repository with a linked worktree.
    #[test]
    fn reads_changes_from_real_worktree() {
        let root = std::env::temp_dir().join(format!("review-git-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let repo = root.join("repo");
        let wt = root.join("feat");
        fs::create_dir_all(&repo).unwrap();
        let run = |cwd: &Path, args: &[&str]| git(cwd, args).unwrap();

        run(&repo, &["init", "-q", "-b", "main"]);
        run(&repo, &["config", "user.email", "t@example.com"]);
        run(&repo, &["config", "user.name", "Test"]);
        fs::write(repo.join("a.txt"), "one\ntwo\n").unwrap();
        fs::write(repo.join("old.txt"), "keep\nthese\nlines\n").unwrap();
        run(&repo, &["add", "."]);
        run(&repo, &["commit", "-q", "-m", "init"]);
        run(&repo, &["worktree", "add", "-q", "-b", "feat/x", wt.to_str().unwrap()]);

        // Committed on the branch: a rename.
        run(&wt, &["mv", "old.txt", "new.txt"]);
        run(&wt, &["commit", "-q", "-m", "rename"]);
        // Uncommitted: a modification and an untracked file.
        fs::write(wt.join("a.txt"), "one\n2\nthree\n").unwrap();
        fs::write(wt.join("untracked.md"), "hello\nworld").unwrap();

        let list = list_worktrees(&repo).unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[1].branch.as_deref(), Some("feat/x"));
        assert_eq!(default_branch(&repo).as_deref(), Some("main"));
        assert_eq!(ahead_behind(&wt, "main").unwrap(), (1, 0));
        assert!(worktree_status(&wt).unwrap().dirty);
        assert!(!worktree_status(&repo).unwrap().dirty);

        let find = |files: &[ChangedFile], p: &str| files.iter().find(|f| f.path == p).cloned();
        let all = changed_files(&wt, Some("main"), Scope::All, false).unwrap();
        assert_eq!(all.len(), 3);
        let renamed = find(&all, "new.txt").unwrap();
        assert_eq!(renamed.status, FileStatus::Renamed);
        assert_eq!(renamed.old_path.as_deref(), Some("old.txt"));
        let modified = find(&all, "a.txt").unwrap();
        assert_eq!((modified.additions, modified.deletions), (2, 1));
        assert_eq!(find(&all, "untracked.md").unwrap().additions, 2);

        let committed = changed_files(&wt, Some("main"), Scope::Committed, false).unwrap();
        assert_eq!(committed.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), vec!["new.txt"]);
        let uncommitted = changed_files(&wt, Some("main"), Scope::Uncommitted, false).unwrap();
        assert_eq!(uncommitted.len(), 2);

        // Patch covers tracked changes and the untracked file; revs identify both sides.
        let diff = diff_patch(&wt, Some("main"), Scope::All, false).unwrap();
        assert!(diff.patch.contains("diff --git a/a.txt b/a.txt"));
        assert!(diff.patch.contains("rename from old.txt"));
        assert!(diff.patch.contains("+++ b/untracked.md\n@@ -0,0 +1,2 @@\n+hello\n+world\n\\ No newline at end of file\n"));
        assert_eq!(diff.range.new_rev, None);
        assert_eq!(file_contents(&wt, Some(&diff.range.old_rev), "a.txt").unwrap().as_deref(), Some("one\ntwo\n"));
        assert_eq!(file_contents(&wt, None, "a.txt").unwrap().as_deref(), Some("one\n2\nthree\n"));
        assert_eq!(file_contents(&wt, Some(&diff.range.old_rev), "new.txt").unwrap(), None);

        // Whitespace-only edits disappear when whitespace is ignored.
        fs::write(wt.join("a.txt"), "one\ntwo  \n").unwrap();
        let ws = changed_files(&wt, Some("main"), Scope::Uncommitted, true).unwrap();
        assert!(ws.iter().all(|f| f.path != "a.txt"));

        // `linguist-generated` files are flagged.
        fs::write(wt.join(".gitattributes"), "*.md linguist-generated\n").unwrap();
        let all = changed_files(&wt, Some("main"), Scope::All, false).unwrap();
        assert!(find(&all, "untracked.md").unwrap().generated);
        assert!(!find(&all, "new.txt").unwrap().generated);

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn parses_name_status() {
        let out = "M\0src/a.ts\0A\0b.ts\0D\0c.ts\0R090\0old.ts\0new.ts\0";
        let entries = parse_name_status(out);
        assert_eq!(
            entries,
            vec![
                ("src/a.ts".into(), FileStatus::Modified, None),
                ("b.ts".into(), FileStatus::Added, None),
                ("c.ts".into(), FileStatus::Deleted, None),
                ("new.ts".into(), FileStatus::Renamed, Some("old.ts".into())),
            ]
        );
    }
}
