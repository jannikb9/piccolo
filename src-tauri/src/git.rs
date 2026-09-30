//! Thin wrapper around the `git` CLI. Shelling out (rather than using libgit2) keeps behaviour
//! identical to the user's terminal: same config, attributes, hooks-free reads, and worktree semantics.

use crate::imports;
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
/// `main`/`master`. Prefers `origin/<name>` since local branches go stale unless pulled, which
/// would show teammates' merged commits as part of the review; falls back to the local branch.
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
        let remote = format!("origin/{name}");
        if exists(&format!("refs/remotes/{remote}")) {
            return Some(remote);
        }
    }
    candidates.into_iter().find(|name| exists(&format!("refs/heads/{name}")))
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

/// Whether HEAD's changes are already in `base`, however they got there: merged, squash-merged or
/// rebased. Merging HEAD into `base` would then leave `base` as it is. Changesets don't count:
/// releasing consumes them on `base` after the merge, so merging again would bring them back.
pub fn is_merged(wt: &Path, base: &str) -> bool {
    // Exits non-zero when the merge conflicts, which means the branch has something new.
    let Ok(out) = git(wt, &["merge-tree", "--write-tree", base, "HEAD"]) else { return false };
    let tree = out.lines().next().unwrap_or_default().trim();
    git(wt, &["diff", "--quiet", base, tree, "--", ".", ":(exclude).changeset"]).is_ok()
}

/// Deletes a linked worktree. `force` also discards uncommitted changes; `repo` is any other
/// worktree of the same repository.
///
/// Uses worktrunk's `wt remove` when it's installed: it moves the folder aside and deletes it in
/// the background (a checkout with `node_modules` takes a while to delete), and deletes the branch
/// too once it's merged. Otherwise `git worktree remove`, which deletes before returning and
/// keeps the branch.
pub fn remove_worktree(repo: &Path, path: &str, force: bool) -> Result<()> {
    let Some(wt) = worktrunk() else { return git_remove_worktree(repo, path, force) };
    let mut args = vec!["-C", path_str(repo)?, "remove"];
    if force {
        args.push("--force");
    }
    args.push(path);
    let out = Command::new(wt)
        .args(&args)
        // Apps started from the Dock get a minimal PATH; hooks may need the user's tools.
        .env("PATH", format!("/opt/homebrew/bin:/usr/local/bin:{}", std::env::var("PATH").unwrap_or_default()))
        .stdin(std::process::Stdio::null())
        .output()
        .map_err(|e| format!("failed to run wt: {e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if stderr.is_empty() { String::from_utf8_lossy(&out.stdout).trim().to_string() } else { stderr });
    }
    Ok(())
}

/// worktrunk's `wt`, looked up where package managers install it: apps started from the Dock
/// don't get the user's shell PATH.
fn worktrunk() -> Option<PathBuf> {
    let home = dirs::home_dir().unwrap_or_default();
    ["/opt/homebrew/bin/wt", "/usr/local/bin/wt"]
        .map(PathBuf::from)
        .into_iter()
        .chain([home.join(".cargo/bin/wt"), home.join(".local/bin/wt")])
        .find(|p| p.is_file())
}

fn path_str(path: &Path) -> Result<&str> {
    path.to_str().ok_or_else(|| format!("not a UTF-8 path: {}", path.display()))
}

fn git_remove_worktree(repo: &Path, path: &str, force: bool) -> Result<()> {
    let mut args = vec!["worktree", "remove"];
    if force {
        args.push("--force");
    }
    args.push(path);
    git(repo, &args).map(drop)
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

/// Changes the reviewer chose to leave out of the diff.
#[derive(Debug, Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffOptions {
    pub ignore_whitespace: bool,
    /// Leave out hunks that only change import statements.
    pub hide_imports: bool,
}

fn diff_flags(ignore_whitespace: bool) -> Vec<&'static str> {
    let mut flags = vec!["diff", "-M", "--no-ext-diff", "--no-color"];
    if ignore_whitespace {
        flags.push("--ignore-all-space");
    }
    flags
}

/// Files changed in the worktree relative to where it forked from `base`.
pub fn changed_files(wt: &Path, base: Option<&str>, scope: Scope, options: DiffOptions) -> Result<Vec<ChangedFile>> {
    let range = DiffRange::resolve(wt, base, scope)?;
    let diff = |format: &str| {
        let mut args = diff_flags(options.ignore_whitespace);
        args.extend(["-z", format]);
        args.extend(range.args());
        args.push("--");
        git(wt, &args)
    };

    let counts = parse_numstat(&diff("--numstat")?);
    let hidden = if options.hide_imports { tracked_patch(wt, &range, options)?.1 } else { HashMap::new() };
    let mut files: Vec<ChangedFile> = parse_name_status(&diff("--name-status")?)
        .into_iter()
        .map(|(path, status, old_path)| {
            let (additions, deletions, binary) = counts.get(&path).copied().unwrap_or_default();
            let (hidden_additions, hidden_deletions) = hidden.get(&path).copied().unwrap_or_default();
            let (additions, deletions) = (additions.saturating_sub(hidden_additions), deletions.saturating_sub(hidden_deletions));
            ChangedFile { path, old_path, status, additions, deletions, binary, generated: false }
        })
        // Files whose only changes were whitespace or imports have no lines left.
        .filter(|f| {
            !(options.ignore_whitespace || options.hide_imports)
                || f.binary
                || f.additions + f.deletions > 0
                || f.status != FileStatus::Modified
        })
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
    Ok(String::from_utf8_lossy(&git_bytes_with_input(cwd, args, input)?).into_owned())
}

fn git_bytes_with_input(cwd: &Path, args: &[&str], input: &str) -> Result<Vec<u8>> {
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
    Ok(out.stdout)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffPatch {
    #[serde(flatten)]
    pub range: DiffRange,
    /// Unified diff of every changed file, including untracked text files.
    pub patch: String,
}

pub fn diff_patch(wt: &Path, base: Option<&str>, scope: Scope, options: DiffOptions) -> Result<DiffPatch> {
    let range = DiffRange::resolve(wt, base, scope)?;
    let (mut patch, _) = tracked_patch(wt, &range, options)?;

    if range.includes_untracked() {
        for path in untracked_files(wt)? {
            if let Some(contents) = read_text(&wt.join(&path)) {
                patch.push_str(&new_file_patch(&path, &contents));
            }
        }
    }
    Ok(DiffPatch { range, patch })
}

/// `git diff` of tracked files, and the lines left out of each file's counts to hide imports.
fn tracked_patch(wt: &Path, range: &DiffRange, options: DiffOptions) -> Result<(String, HashMap<String, (u32, u32)>)> {
    let mut args = diff_flags(options.ignore_whitespace);
    // Explicit prefixes override `diff.noprefix` / `diff.mnemonicPrefix` in the user's config.
    args.extend(["--src-prefix=a/", "--dst-prefix=b/"]);
    args.extend(range.args());
    args.push("--");
    let patch = git(wt, &args)?;
    if options.hide_imports {
        imports::filter_patch(wt, range, &patch)
    } else {
        Ok((patch, HashMap::new()))
    }
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

/// Contents of each `rev:path` in `specs`, read with one `git cat-file`. `None` for paths that
/// don't exist there or aren't text.
pub fn blobs(wt: &Path, specs: &[String]) -> Result<Vec<Option<String>>> {
    if specs.is_empty() {
        return Ok(Vec::new());
    }
    let input: String = specs.iter().map(|s| format!("{s}\n")).collect();
    let out = git_bytes_with_input(wt, &["cat-file", "--batch"], &input)?;
    let mut rest = out.as_slice();
    let mut blobs = Vec::with_capacity(specs.len());
    while blobs.len() < specs.len() {
        let Some(eol) = rest.iter().position(|&b| b == b'\n') else { break };
        // `<oid> <type> <size>\n<contents>\n`, or `<spec> missing\n`.
        let header = String::from_utf8_lossy(&rest[..eol]).into_owned();
        rest = &rest[eol + 1..];
        let mut fields = header.rsplitn(3, ' ');
        let size = fields.next().and_then(|s| s.parse::<usize>().ok());
        match (size, fields.next()) {
            (Some(size), Some(kind)) if rest.len() > size => {
                blobs.push(if kind == "blob" { text_from_bytes(rest[..size].to_vec()) } else { None });
                rest = &rest[size + 1..];
            }
            _ => blobs.push(None),
        }
    }
    blobs.resize(specs.len(), None);
    Ok(blobs)
}

/// Large files are left out of patches; their diffs aren't reviewable line by line anyway.
const MAX_TEXT_BYTES: u64 = 4 * 1024 * 1024;

pub fn read_text(path: &Path) -> Option<String> {
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
        let all = changed_files(&wt, Some("main"), Scope::All, DiffOptions::default()).unwrap();
        assert_eq!(all.len(), 3);
        let renamed = find(&all, "new.txt").unwrap();
        assert_eq!(renamed.status, FileStatus::Renamed);
        assert_eq!(renamed.old_path.as_deref(), Some("old.txt"));
        let modified = find(&all, "a.txt").unwrap();
        assert_eq!((modified.additions, modified.deletions), (2, 1));
        assert_eq!(find(&all, "untracked.md").unwrap().additions, 2);

        let committed = changed_files(&wt, Some("main"), Scope::Committed, DiffOptions::default()).unwrap();
        assert_eq!(committed.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), vec!["new.txt"]);
        let uncommitted = changed_files(&wt, Some("main"), Scope::Uncommitted, DiffOptions::default()).unwrap();
        assert_eq!(uncommitted.len(), 2);

        // Patch covers tracked changes and the untracked file; revs identify both sides.
        let diff = diff_patch(&wt, Some("main"), Scope::All, DiffOptions::default()).unwrap();
        assert!(diff.patch.contains("diff --git a/a.txt b/a.txt"));
        assert!(diff.patch.contains("rename from old.txt"));
        assert!(diff.patch.contains("+++ b/untracked.md\n@@ -0,0 +1,2 @@\n+hello\n+world\n\\ No newline at end of file\n"));
        assert_eq!(diff.range.new_rev, None);
        assert_eq!(file_contents(&wt, Some(&diff.range.old_rev), "a.txt").unwrap().as_deref(), Some("one\ntwo\n"));
        assert_eq!(file_contents(&wt, None, "a.txt").unwrap().as_deref(), Some("one\n2\nthree\n"));
        assert_eq!(file_contents(&wt, Some(&diff.range.old_rev), "new.txt").unwrap(), None);

        // Whitespace-only edits disappear when whitespace is ignored.
        fs::write(wt.join("a.txt"), "one\ntwo  \n").unwrap();
        let ws = changed_files(&wt, Some("main"), Scope::Uncommitted, DiffOptions { ignore_whitespace: true, ..Default::default() }).unwrap();
        assert!(ws.iter().all(|f| f.path != "a.txt"));

        // Import-only hunks are left out; files with nothing else changed disappear.
        let src = |imports: &str, body: &str| format!("import {{\n  a,\n{imports}}} from \"x\";\n\n{body}");
        // The code change is far enough below the imports to be its own hunk.
        let body = "run(a);\n".repeat(12);
        fs::write(wt.join("app.ts"), src("", &body)).unwrap();
        fs::write(wt.join("util.ts"), src("", &body)).unwrap();
        run(&wt, &["add", "app.ts", "util.ts"]);
        run(&wt, &["commit", "-q", "-m", "ts"]);
        fs::write(wt.join("app.ts"), src("  b,\n", &format!("{}run(b);\n", "run(a);\n".repeat(11)))).unwrap();
        fs::write(wt.join("util.ts"), src("  b,\n", &body)).unwrap();
        let hide = DiffOptions { hide_imports: true, ..Default::default() };
        let files = changed_files(&wt, Some("main"), Scope::Uncommitted, hide).unwrap();
        assert!(find(&files, "util.ts").is_none(), "{files:?}");
        let app = find(&files, "app.ts").unwrap();
        assert_eq!((app.additions, app.deletions), (1, 1));
        let patch = diff_patch(&wt, Some("main"), Scope::Uncommitted, hide).unwrap().patch;
        assert!(!patch.contains("+  b,") && patch.contains("+run(b);"), "{patch}");
        let shown = changed_files(&wt, Some("main"), Scope::Uncommitted, DiffOptions::default()).unwrap();
        assert_eq!((find(&shown, "app.ts").unwrap().additions, find(&shown, "util.ts").unwrap().additions), (2, 1));

        // `linguist-generated` files are flagged.
        fs::write(wt.join(".gitattributes"), "*.md linguist-generated\n").unwrap();
        let all = changed_files(&wt, Some("main"), Scope::All, DiffOptions::default()).unwrap();
        assert!(find(&all, "untracked.md").unwrap().generated);
        assert!(!find(&all, "new.txt").unwrap().generated);

        fs::remove_dir_all(&root).unwrap();
    }

    /// A stale local `main` must not be the base: merging `origin/main` would otherwise make
    /// every upstream commit look like part of the branch.
    #[test]
    fn prefers_remote_default_branch() {
        let root = std::env::temp_dir().join(format!("review-git-base-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let repo = root.join("repo");
        fs::create_dir_all(&repo).unwrap();
        let run = |args: &[&str]| git(&repo, args).unwrap();
        run(&["init", "-q", "-b", "main"]);
        run(&["config", "user.email", "t@example.com"]);
        run(&["config", "user.name", "Test"]);
        run(&["commit", "-q", "--allow-empty", "-m", "init"]);
        assert_eq!(default_branch(&repo).as_deref(), Some("main"));

        // Upstream moves ahead of the local branch; the feature branch merges it.
        run(&["checkout", "-q", "-b", "feat"]);
        run(&["checkout", "-q", "main"]);
        fs::write(repo.join("upstream.txt"), "x").unwrap();
        run(&["add", "."]);
        run(&["commit", "-q", "-m", "upstream"]);
        run(&["update-ref", "refs/remotes/origin/main", "HEAD"]);
        run(&["reset", "-q", "--hard", "HEAD~1"]);
        run(&["checkout", "-q", "feat"]);
        run(&["merge", "-q", "--no-edit", "origin/main"]);

        assert_eq!(default_branch(&repo).as_deref(), Some("origin/main"));
        let files = changed_files(&repo, Some("origin/main"), Scope::All, DiffOptions::default()).unwrap();
        assert!(files.is_empty(), "{files:?}");
        let files = changed_files(&repo, Some("main"), Scope::All, DiffOptions::default()).unwrap();
        assert_eq!(files.len(), 1);
        let _ = fs::remove_dir_all(&root);
    }

    /// A squash merge, followed by a release that consumes the branch's changeset.
    #[test]
    fn detects_squash_merges_and_removes_worktrees() {
        let root = std::env::temp_dir().join(format!("review-git-merged-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let repo = root.join("repo");
        let wt = root.join("feat");
        fs::create_dir_all(&repo).unwrap();
        let run = |cwd: &Path, args: &[&str]| git(cwd, args).unwrap();
        run(&repo, &["init", "-q", "-b", "main"]);
        run(&repo, &["config", "user.email", "t@example.com"]);
        run(&repo, &["config", "user.name", "Test"]);
        fs::write(repo.join("a.txt"), "one\n").unwrap();
        run(&repo, &["add", "."]);
        run(&repo, &["commit", "-q", "-m", "init"]);
        run(&repo, &["worktree", "add", "-q", "-b", "feat", wt.to_str().unwrap()]);

        // Two commits on the branch, one adding a changeset.
        fs::write(wt.join("a.txt"), "one\ntwo\n").unwrap();
        run(&wt, &["commit", "-qam", "two"]);
        fs::create_dir_all(wt.join(".changeset")).unwrap();
        fs::write(wt.join(".changeset/two.md"), "patch\n").unwrap();
        run(&wt, &["add", "."]);
        run(&wt, &["commit", "-qm", "changeset"]);
        // Meanwhile on main.
        fs::write(repo.join("b.txt"), "b\n").unwrap();
        run(&repo, &["add", "."]);
        run(&repo, &["commit", "-qm", "other"]);
        assert!(!is_merged(&wt, "main"));

        // Squash-merged, then released.
        run(&repo, &["merge", "-q", "--squash", "feat"]);
        run(&repo, &["commit", "-qm", "two (#1)"]);
        run(&repo, &["rm", "-q", ".changeset/two.md"]);
        run(&repo, &["commit", "-qm", "Update versions"]);
        assert!(is_merged(&wt, "main"));

        // New work on the branch makes it unmerged again.
        fs::write(wt.join("a.txt"), "one\ntwo\nthree\n").unwrap();
        run(&wt, &["commit", "-qam", "three"]);
        assert!(!is_merged(&wt, "main"));

        // Uncommitted changes need `force`.
        fs::write(wt.join("a.txt"), "dirty\n").unwrap();
        assert!(git_remove_worktree(&repo, wt.to_str().unwrap(), false).is_err());
        git_remove_worktree(&repo, wt.to_str().unwrap(), true).unwrap();
        assert!(!wt.exists());
        assert_eq!(list_worktrees(&repo).unwrap().len(), 1);
        let _ = fs::remove_dir_all(&root);
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
