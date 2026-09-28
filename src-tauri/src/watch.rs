//! Watches each repository's git directory so the sidebar updates when worktrees are added or
//! removed, or a worktree switches branch — typically done by an agent in a terminal.

use crate::git;
use notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};
use std::collections::HashMap;
use std::path::{Component, Path};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

pub const REPO_CHANGED: &str = "repo-changed";

#[derive(Default)]
pub struct Watchers(Mutex<HashMap<String, Debouncer<RecommendedWatcher>>>);

impl Watchers {
    pub fn watch(&self, app: &AppHandle, repo: &str) {
        let Ok(git_dir) = git::common_git_dir(Path::new(repo)) else { return };
        let app = app.clone();
        let repo_id = repo.to_string();
        let root = git_dir.clone();

        let debouncer = new_debouncer(Duration::from_millis(250), move |res: DebounceEventResult| {
            let Ok(events) = res else { return };
            if events.iter().any(|e| is_worktree_change(&root, &e.path)) {
                let _ = app.emit(REPO_CHANGED, &repo_id);
            }
        });
        let Ok(mut debouncer) = debouncer else { return };
        if debouncer.watcher().watch(&git_dir, RecursiveMode::Recursive).is_ok() {
            self.0.lock().unwrap().insert(repo.to_string(), debouncer);
        }
    }

    pub fn unwatch(&self, repo: &str) {
        self.0.lock().unwrap().remove(repo);
    }
}

/// Only worktree registrations (`worktrees/<name>`) and HEAD files (branch switches) matter here;
/// the git directory also sees constant churn from objects, refs and the index that we ignore.
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
        assert!(!is_worktree_change(root, Path::new("/r/.git/refs/heads/main")));
    }
}
