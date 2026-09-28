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

/// Files changed in the worktree relative to where it forked from `base`.
/// Without a base, only uncommitted changes are reported.
pub fn changed_files(wt: &Path, base: Option<&str>, scope: Scope) -> Result<Vec<ChangedFile>> {
    let fork_point = match base {
        Some(base) => merge_base(wt, base)?,
        None => "HEAD".to_string(),
    };
    let range: Vec<&str> = match scope {
        Scope::All => vec![&fork_point],
        Scope::Committed => vec![&fork_point, "HEAD"],
        Scope::Uncommitted => vec!["HEAD"],
    };
    let diff = |format: &str| {
        let mut args = vec!["diff", "-M", "--no-ext-diff", "-z", format];
        args.extend(&range);
        args.push("--");
        git(wt, &args)
    };

    let counts = parse_numstat(&diff("--numstat")?);
    let mut files: Vec<ChangedFile> = parse_name_status(&diff("--name-status")?)
        .into_iter()
        .map(|(path, status, old_path)| {
            let (additions, deletions, binary) = counts.get(&path).copied().unwrap_or_default();
            ChangedFile { path, old_path, status, additions, deletions, binary }
        })
        .collect();

    if scope != Scope::Committed {
        let untracked = git(wt, &["ls-files", "--others", "--exclude-standard", "-z"])?;
        for path in untracked.split('\0').filter(|p| !p.is_empty()) {
            let (additions, binary) = count_lines(&wt.join(path));
            files.push(ChangedFile {
                path: path.to_string(),
                old_path: None,
                status: FileStatus::Added,
                additions,
                deletions: 0,
                binary,
            });
        }
    }
    Ok(files)
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
        let all = changed_files(&wt, Some("main"), Scope::All).unwrap();
        assert_eq!(all.len(), 3);
        let renamed = find(&all, "new.txt").unwrap();
        assert_eq!(renamed.status, FileStatus::Renamed);
        assert_eq!(renamed.old_path.as_deref(), Some("old.txt"));
        let modified = find(&all, "a.txt").unwrap();
        assert_eq!((modified.additions, modified.deletions), (2, 1));
        assert_eq!(find(&all, "untracked.md").unwrap().additions, 2);

        let committed = changed_files(&wt, Some("main"), Scope::Committed).unwrap();
        assert_eq!(committed.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), vec!["new.txt"]);
        let uncommitted = changed_files(&wt, Some("main"), Scope::Uncommitted).unwrap();
        assert_eq!(uncommitted.len(), 2);

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
