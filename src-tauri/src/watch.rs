//! Watches each repository's git directory so the sidebar updates when worktrees are added or
//! removed, a worktree switches branch or a branch gets a commit, and each worktree's files, so the
//! diff follows an agent's edits — typically done in a terminal. Also watches the comments
//! database, so replies written with the `piccolo` command show up right away, and Claude Code's
//! session registry, so sessions appear and go as they start and end.

use crate::{comments, git, sessions};
use notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

pub const REPO_CHANGED: &str = "repo-changed";
pub const COMMENTS_CHANGED: &str = "comments-changed";
pub const SESSIONS_CHANGED: &str = "sessions-changed";

#[derive(Default)]
pub struct Watchers {
    repos: Mutex<HashMap<String, Debouncer<RecommendedWatcher>>>,
    /// Each worktree's files by its path, with the repository it belongs to.
    trees: Mutex<HashMap<String, (String, Debouncer<RecommendedWatcher>)>>,
    comments: Mutex<Option<Debouncer<RecommendedWatcher>>>,
    sessions: Mutex<Option<Debouncer<RecommendedWatcher>>>,
}

impl Watchers {
    pub fn watch(&self, app: &AppHandle, repo: &str) {
        let Ok(git_dir) = git::common_git_dir(Path::new(repo)) else { return };
        let app_for_trees = app.clone();
        let app = app.clone();
        let repo_id = repo.to_string();
        let root = git_dir.clone();

        let debouncer = new_debouncer(Duration::from_millis(250), move |res: DebounceEventResult| {
            let Ok(events) = res else { return };
            if events.iter().any(|e| is_worktree_change(&root, &e.path)) {
                let _ = app.emit(REPO_CHANGED, &repo_id);
                // Worktrees may have come or gone.
                if let Some(watchers) = app.try_state::<Watchers>() {
                    watchers.watch_trees(&app, &repo_id);
                }
            }
        });
        let Ok(mut debouncer) = debouncer else { return };
        if debouncer.watcher().watch(&git_dir, RecursiveMode::Recursive).is_ok() {
            self.repos.lock().unwrap().insert(repo.to_string(), debouncer);
        }
        self.watch_trees(&app_for_trees, repo);
    }

    pub fn unwatch(&self, repo: &str) {
        self.repos.lock().unwrap().remove(repo);
        self.trees.lock().unwrap().retain(|_, (r, _)| r != repo);
    }

    /// Watches the files of each of `repo`'s worktrees, and stops watching those that are gone.
    fn watch_trees(&self, app: &AppHandle, repo: &str) {
        let Ok(entries) = git::list_worktrees(Path::new(repo)) else { return };
        let wanted: HashSet<String> = entries.into_iter().filter(|e| !e.bare && !e.prunable).map(|e| e.path).collect();
        let mut trees = self.trees.lock().unwrap();
        trees.retain(|path, (r, _)| r != repo || wanted.contains(path));
        for path in wanted {
            if trees.contains_key(&path) {
                continue;
            }
            if let Some(debouncer) = watch_tree(app, repo, Path::new(&path)) {
                trees.insert(path, (repo.to_string(), debouncer));
            }
        }
    }

    pub fn watch_comments(&self, app: &AppHandle) {
        let db = comments::db_path();
        let Some(dir) = db.parent().map(Path::to_path_buf) else { return };
        if std::fs::create_dir_all(&dir).is_err() {
            return;
        }
        // Writes touch the database and its `-journal` file.
        let name = db.file_name().unwrap_or_default().to_string_lossy().into_owned();
        let app = app.clone();
        let debouncer = new_debouncer(Duration::from_millis(150), move |res: DebounceEventResult| {
            let Ok(events) = res else { return };
            let touched = events.iter().any(|e| {
                e.path.file_name().is_some_and(|n| n.to_string_lossy().starts_with(&name))
            });
            if touched {
                let _ = app.emit(COMMENTS_CHANGED, ());
            }
        });
        let Ok(mut debouncer) = debouncer else { return };
        if debouncer.watcher().watch(&dir, RecursiveMode::NonRecursive).is_ok() {
            *self.comments.lock().unwrap() = Some(debouncer);
        }
    }

    /// Each session's file there is written when it starts, changes status or title, and removed
    /// when it ends. Without Claude Code installed there's nothing to watch.
    pub fn watch_sessions(&self, app: &AppHandle) {
        let dir = sessions::registry_dir();
        let app = app.clone();
        let debouncer = new_debouncer(Duration::from_millis(200), move |res: DebounceEventResult| {
            if res.is_ok() {
                let _ = app.emit(SESSIONS_CHANGED, ());
            }
        });
        let Ok(mut debouncer) = debouncer else { return };
        if debouncer.watcher().watch(&dir, RecursiveMode::NonRecursive).is_ok() {
            *self.sessions.lock().unwrap() = Some(debouncer);
        }
    }
}

/// How many changed paths a batch has asked git about; a build or an install can touch far more,
/// and nearly all of it is ignored.
const MAX_CHECKED_PATHS: usize = 5000;

/// Watches the files of the worktree at `root`, and tells the frontend when ones that show in its
/// diff change: not the git directory, `node_modules` or anything the repository ignores.
fn watch_tree(app: &AppHandle, repo: &str, root: &Path) -> Option<Debouncer<RecommendedWatcher>> {
    // Events carry real paths.
    let root = std::fs::canonicalize(root).ok()?;
    let (app, repo, base) = (app.clone(), repo.to_string(), root.clone());
    let throttle = Arc::new(Throttle::default());
    // Longer than the git directory's: an agent writes files all the time while it works.
    let mut debouncer = new_debouncer(Duration::from_millis(800), move |res: DebounceEventResult| {
        let Ok(events) = res else { return };
        if shows_in_diff(&base, events.iter().map(|e| e.path.as_path())) {
            throttle.fire(&app, &repo);
        }
    })
    .ok()?;
    debouncer.watcher().watch(&root, RecursiveMode::Recursive).ok()?;
    Some(debouncer)
}

/// Each change of a worktree's files makes the frontend read every repository's status again, so
/// while an agent keeps writing, it's told about once a second, and about the last change after.
#[derive(Default)]
struct Throttle {
    last: Mutex<Option<Instant>>,
    /// A notification is already waiting for its turn, which will see this change too.
    pending: AtomicBool,
}

const NOTIFY_GAP: Duration = Duration::from_secs(1);

impl Throttle {
    fn fire(self: &Arc<Self>, app: &AppHandle, repo: &str) {
        let wait = self.last.lock().unwrap().map_or(Duration::ZERO, |at| NOTIFY_GAP.saturating_sub(at.elapsed()));
        if wait.is_zero() {
            *self.last.lock().unwrap() = Some(Instant::now());
            let _ = app.emit(REPO_CHANGED, repo);
        } else if !self.pending.swap(true, Ordering::SeqCst) {
            let (this, app, repo) = (Arc::clone(self), app.clone(), repo.to_string());
            std::thread::spawn(move || {
                std::thread::sleep(wait);
                // Cleared first: a change from here on asks for another notification.
                *this.last.lock().unwrap() = Some(Instant::now());
                this.pending.store(false, Ordering::SeqCst);
                let _ = app.emit(REPO_CHANGED, &repo);
            });
        }
    }
}

/// Whether any of the changed `paths` in the worktree at `root` is one a diff can show.
fn shows_in_diff<'a>(root: &Path, paths: impl Iterator<Item = &'a Path>) -> bool {
    let candidates = tree_changes(root, paths);
    if candidates.is_empty() {
        return false;
    }
    let ignored = git::ignored_paths(root, &candidates);
    candidates.iter().any(|p| !ignored.contains(p))
}

/// The distinct paths among `paths` in the worktree at `root` that could be part of a diff, before
/// asking git what it ignores. Capped at `MAX_CHECKED_PATHS`.
fn tree_changes<'a>(root: &Path, paths: impl Iterator<Item = &'a Path>) -> Vec<PathBuf> {
    let skipped = |c: Component| matches!(c, Component::Normal(s) if s == ".git" || s == "node_modules");
    paths
        .filter(|p| p.strip_prefix(root).is_ok_and(|rel| !rel.components().any(skipped)))
        .map(Path::to_path_buf)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .take(MAX_CHECKED_PATHS)
        .collect()
}

/// Only worktree registrations (`worktrees/<name>`), HEAD files (branch switches) and branches
/// (commits) matter here; the git directory also sees constant churn from objects, the index and
/// remote refs that we ignore.
fn is_worktree_change(git_dir: &Path, path: &Path) -> bool {
    let Ok(rel) = path.strip_prefix(git_dir) else { return false };
    let parts: Vec<_> = rel
        .components()
        .filter_map(|c| match c {
            Component::Normal(s) => s.to_str(),
            _ => None,
        })
        .collect();
    match parts.as_slice() {
        ["HEAD"] | ["worktrees"] | ["worktrees", _] => true,
        ["refs", "heads", ..] => true,
        ["worktrees", _, file] => matches!(*file, "HEAD" | "gitdir"),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filters_git_dir_events() {
        let root = Path::new("/r/.git");
        assert!(is_worktree_change(root, Path::new("/r/.git/HEAD")));
        assert!(is_worktree_change(root, Path::new("/r/.git/worktrees/feat")));
        assert!(is_worktree_change(root, Path::new("/r/.git/worktrees/feat/HEAD")));
        assert!(is_worktree_change(root, Path::new("/r/.git/worktrees/feat/gitdir")));
        assert!(!is_worktree_change(root, Path::new("/r/.git/worktrees/feat/index")));
        assert!(!is_worktree_change(root, Path::new("/r/.git/objects/ab/cdef")));
        assert!(is_worktree_change(root, Path::new("/r/.git/refs/heads/main")));
        assert!(is_worktree_change(root, Path::new("/r/.git/refs/heads/feat/x")));
        assert!(!is_worktree_change(root, Path::new("/r/.git/refs/remotes/origin/main")));
        assert!(!is_worktree_change(root, Path::new("/r/.git/index")));
    }

    #[test]
    fn filters_worktree_file_events() {
        let root = Path::new("/wt");
        let paths = ["/wt/src/a.ts", "/wt/.git/index", "/wt/node_modules/x/y.js", "/wt/web/node_modules/z.js", "/elsewhere/b.ts", "/wt/src/a.ts"];
        let kept = tree_changes(root, paths.iter().map(Path::new));
        assert_eq!(kept, [PathBuf::from("/wt/src/a.ts")]);
    }

    /// Real file system events, which on macOS carry resolved paths.
    #[test]
    fn reports_edits_but_not_ignored_files() {
        use std::fs;
        use std::sync::mpsc;
        let root = std::env::temp_dir().join(format!("review-watch-live-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("target")).unwrap();
        git::git(&root, &["init", "-q", "-b", "main"]).unwrap();
        fs::write(root.join(".gitignore"), "target/\n").unwrap();
        let root = fs::canonicalize(&root).unwrap();

        let (tx, rx) = mpsc::channel();
        let base = root.clone();
        let mut debouncer = new_debouncer(Duration::from_millis(100), move |res: DebounceEventResult| {
            let Ok(events) = res else { return };
            let _ = tx.send(shows_in_diff(&base, events.iter().map(|e| e.path.as_path())));
        })
        .unwrap();
        debouncer.watcher().watch(&root, RecursiveMode::Recursive).unwrap();
        let wait = || rx.recv_timeout(Duration::from_secs(3));

        fs::write(root.join("target/out.o"), "x").unwrap();
        while let Ok(shows) = wait() {
            assert!(!shows, "an ignored file was reported");
            if rx.try_recv().is_err() {
                break;
            }
        }
        fs::write(root.join("src.rs"), "fn main() {}").unwrap();
        let reported = std::iter::from_fn(|| wait().ok()).take(3).any(|shows| shows);
        assert!(reported, "an edit wasn't reported");
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn ignores_what_the_repository_ignores() {
        use std::fs;
        let root = std::env::temp_dir().join(format!("review-watch-ignored-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("target")).unwrap();
        let run = |args: &[&str]| git::git(&root, args).unwrap();
        run(&["init", "-q", "-b", "main"]);
        fs::write(root.join(".gitignore"), "target/\n*.log\n").unwrap();
        for file in ["target/out.o", "build.log", "src.rs", "tracked.log"] {
            fs::write(root.join(file), "x").unwrap();
        }
        // A tracked file counts, though a pattern matches it.
        run(&["add", "-f", "tracked.log"]);
        let root = fs::canonicalize(&root).unwrap();
        let paths: Vec<PathBuf> = ["target/out.o", "build.log", "src.rs", "tracked.log"].iter().map(|f| root.join(f)).collect();
        let ignored = git::ignored_paths(&root, &paths);
        assert_eq!(ignored, HashSet::from([root.join("target/out.o"), root.join("build.log")]));
        // Nothing is ignored, or git can't say: nothing is reported.
        assert!(git::ignored_paths(&root, &[root.join("src.rs")]).is_empty());
        assert!(git::ignored_paths(&root.join("missing"), &paths).is_empty());
        fs::remove_dir_all(&root).unwrap();
    }
}
