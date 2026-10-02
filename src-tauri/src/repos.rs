//! The user's list of repositories and the Tauri commands the UI uses to read them.

use crate::git::{self, ChangedFile, Commit, DiffOptions, DiffPatch, RemoteBranch, Result, Scope};
use crate::watch::Watchers;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::thread;
use tauri::{AppHandle, State};
use tauri_plugin_store::StoreExt;

const STORE_FILE: &str = "settings.json";
const STORE_KEY: &str = "repos";

/// Root paths of the main worktree of each added repository, in the order they were added.
pub struct Repos(Mutex<Vec<String>>);

impl Repos {
    pub fn load(app: &AppHandle) -> Self {
        let saved = app
            .store(STORE_FILE)
            .ok()
            .and_then(|store| store.get(STORE_KEY))
            .and_then(|value| serde_json::from_value(value).ok())
            .unwrap_or_default();
        Self(Mutex::new(saved))
    }

    pub fn paths(&self) -> Vec<String> {
        self.0.lock().unwrap().clone()
    }

    fn update(&self, app: &AppHandle, f: impl FnOnce(&mut Vec<String>)) -> Result<()> {
        let mut paths = self.0.lock().unwrap();
        f(&mut paths);
        let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
        store.set(STORE_KEY, serde_json::json!(*paths));
        store.save().map_err(|e| e.to_string())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoInfo {
    /// The repository's root path doubles as its id.
    id: String,
    name: String,
    path: String,
    default_branch: Option<String>,
    worktrees: Vec<WorktreeInfo>,
    /// Set when the repository can't be read, e.g. it was moved or deleted.
    error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeInfo {
    /// The worktree's path doubles as its id.
    id: String,
    repo_id: String,
    path: String,
    name: String,
    branch: Option<String>,
    head: String,
    is_main: bool,
    dirty: bool,
    updated_at: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeStats {
    ahead: u32,
    behind: u32,
    additions: u32,
    deletions: u32,
    /// Its commits are in the base branch, so the worktree can go.
    merged: bool,
}

fn folder_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map_or_else(|| path.to_string(), |n| n.to_string_lossy().into_owned())
}

fn load_repo(path: &str) -> RepoInfo {
    let mut repo = RepoInfo {
        id: path.to_string(),
        name: folder_name(path),
        path: path.to_string(),
        default_branch: None,
        worktrees: Vec::new(),
        error: None,
    };
    if !Path::new(path).is_dir() {
        repo.error = Some("Folder not found".into());
        return repo;
    }
    let entries = match git::list_worktrees(Path::new(path)) {
        Ok(entries) => entries,
        Err(e) => {
            repo.error = Some(e);
            return repo;
        }
    };
    repo.default_branch = git::default_branch(Path::new(path));

    let usable: Vec<_> = entries
        .into_iter()
        .enumerate()
        .filter(|(_, e)| !e.bare && !e.prunable)
        .collect();
    // `git status` is the slow part; run it for all worktrees at once.
    repo.worktrees = thread::scope(|s| {
        let handles: Vec<_> = usable
            .iter()
            .map(|(_, e)| s.spawn(|| git::worktree_status(Path::new(&e.path))))
            .collect();
        usable
            .iter()
            .zip(handles)
            .map(|((index, e), handle)| {
                let status = handle.join().ok().and_then(|r| r.ok());
                WorktreeInfo {
                    id: e.path.clone(),
                    repo_id: path.to_string(),
                    path: e.path.clone(),
                    name: folder_name(&e.path),
                    branch: e.branch.clone(),
                    head: e.head.chars().take(7).collect(),
                    is_main: *index == 0,
                    dirty: status.as_ref().is_some_and(|s| s.dirty),
                    updated_at: status.map_or(0, |s| s.updated_at),
                }
            })
            .collect()
    });
    repo
}

pub(crate) async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T> + Send + 'static) -> Result<T> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn list_repos(repos: State<'_, Repos>) -> Result<Vec<RepoInfo>> {
    let paths = repos.paths();
    blocking(move || {
        Ok(thread::scope(|s| {
            let handles: Vec<_> = paths.iter().map(|p| s.spawn(|| load_repo(p))).collect();
            handles.into_iter().filter_map(|h| h.join().ok()).collect()
        }))
    })
    .await
}

#[tauri::command]
pub async fn add_repo(
    app: AppHandle,
    repos: State<'_, Repos>,
    watchers: State<'_, Watchers>,
    path: String,
) -> Result<String> {
    // Any folder inside any worktree resolves to the repository's main worktree.
    let root = blocking(move || {
        let entries = git::list_worktrees(Path::new(&path))
            .map_err(|_| format!("{path} is not inside a git repository"))?;
        entries.first().map(|e| e.path.clone()).ok_or_else(|| "No worktrees found".to_string())
    })
    .await?;

    if !repos.paths().contains(&root) {
        repos.update(&app, |paths| paths.push(root.clone()))?;
        watchers.watch(&app, &root);
    }
    Ok(root)
}

#[tauri::command]
pub fn remove_repo(app: AppHandle, repos: State<'_, Repos>, watchers: State<'_, Watchers>, id: String) -> Result<()> {
    watchers.unwatch(&id);
    repos.update(&app, |paths| paths.retain(|p| *p != id))
}

/// `paths` in the order of `ids`; unknown ids are ignored and paths missing from `ids` go last.
fn reordered(paths: &[String], ids: Vec<String>) -> Vec<String> {
    let mut ordered: Vec<String> = Vec::with_capacity(paths.len());
    for id in ids.into_iter().chain(paths.iter().cloned()) {
        if paths.contains(&id) && !ordered.contains(&id) {
            ordered.push(id);
        }
    }
    ordered
}

/// Saves the sidebar order of repositories.
#[tauri::command]
pub fn reorder_repos(app: AppHandle, repos: State<'_, Repos>, ids: Vec<String>) -> Result<()> {
    repos.update(&app, |paths| *paths = reordered(paths, ids))
}

#[tauri::command]
pub async fn worktree_stats(path: String, base: Option<String>) -> Result<WorktreeStats> {
    blocking(move || {
        let wt = PathBuf::from(&path);
        let (ahead, behind) = match &base {
            Some(base) => git::ahead_behind(&wt, base)?,
            None => (0, 0),
        };
        let files = git::changed_files(&wt, base.as_deref(), Scope::All, DiffOptions::default())?;
        // A branch without commits of its own is new, not merged.
        let merged = ahead > 0 && base.as_deref().is_some_and(|base| git::is_merged(&wt, base));
        Ok(WorktreeStats {
            ahead,
            behind,
            merged,
            additions: files.iter().map(|f| f.additions).sum(),
            deletions: files.iter().map(|f| f.deletions).sum(),
        })
    })
    .await
}

#[tauri::command]
pub async fn changed_files(
    path: String,
    base: Option<String>,
    scope: Scope,
    options: DiffOptions,
) -> Result<Vec<ChangedFile>> {
    blocking(move || git::changed_files(Path::new(&path), base.as_deref(), scope, options)).await
}

#[tauri::command]
pub async fn diff_patch(path: String, base: Option<String>, scope: Scope, options: DiffOptions) -> Result<DiffPatch> {
    blocking(move || git::diff_patch(Path::new(&path), base.as_deref(), scope, options)).await
}

/// The branch's own commits, newest first.
#[tauri::command]
pub async fn commits(path: String, base: Option<String>) -> Result<Vec<Commit>> {
    blocking(move || git::commits(Path::new(&path), base.as_deref())).await
}

/// Remote branches as of the last fetch, most recently committed first.
#[tauri::command]
pub async fn remote_branches(repo: String) -> Result<Vec<RemoteBranch>> {
    blocking(move || git::remote_branches(Path::new(&repo))).await
}

#[tauri::command]
pub async fn fetch_remotes(repo: String) -> Result<()> {
    blocking(move || git::fetch(Path::new(&repo))).await
}

/// Checks out a branch in a new worktree; resolves to the worktree's path, which is its id.
#[tauri::command]
pub async fn add_worktree(repo: String, branch: String, remote_ref: String) -> Result<String> {
    blocking(move || git::add_worktree(Path::new(&repo), &branch, &remote_ref)).await
}

#[tauri::command]
pub async fn remove_worktree(repo: String, path: String, force: bool) -> Result<()> {
    blocking(move || git::remove_worktree(Path::new(&repo), &path, force)).await
}

/// Full contents of one file on both sides of a diff, for expanding unchanged lines.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileVersions {
    old: Option<String>,
    new: Option<String>,
}

#[tauri::command]
pub async fn file_versions(
    path: String,
    old_rev: String,
    new_rev: Option<String>,
    old_path: String,
    new_path: String,
) -> Result<FileVersions> {
    blocking(move || {
        let wt = Path::new(&path);
        Ok(FileVersions {
            old: git::file_contents(wt, Some(&old_rev), &old_path)?,
            new: git::file_contents(wt, new_rev.as_deref(), &new_path)?,
        })
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reorders_known_paths_and_keeps_the_rest() {
        let paths: Vec<String> = ["/a", "/b", "/c"].map(String::from).to_vec();
        let ids = ["/c", "/x", "/a", "/c"].map(String::from).to_vec();
        assert_eq!(reordered(&paths, ids), ["/c", "/a", "/b"]);
    }
}
