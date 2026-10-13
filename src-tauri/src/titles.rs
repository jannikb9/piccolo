//! Names for the work on a branch that read like a title, for the sidebar and to open agent
//! prompts with (agents name a new session after its first message): the one the user gave it,
//! or one made from the branch. Like comments, a name follows the branch, or with a detached HEAD
//! the worktree.

use crate::comments::{blocking, sql, Store, Target};
use crate::git::Result;
use rusqlite::{params, OptionalExtension};
use std::path::Path;

pub(crate) const SCHEMA: &str = "
    CREATE TABLE IF NOT EXISTS titles (
        repo TEXT NOT NULL,
        branch TEXT,
        worktree TEXT NOT NULL,
        title TEXT NOT NULL
    );";

/// The row for `target`, with `?1` its repository, `?2` its branch and `?3` its worktree.
const OF_TARGET: &str = "repo = ?1 AND (branch = ?2 OR (?2 IS NULL AND branch IS NULL AND worktree = ?3))";

/// The work on `target` named like a title, after its branch without prefixes like `codex/`, or
/// with a detached HEAD after its worktree folder without the repository's name: `Dispatch cmdk
/// search` for `codex/dispatch-cmdk-search` or the folder `web-apps.dispatch-cmdk-search`.
pub fn auto_title(target: &Target) -> String {
    let folder = |path: &str| Path::new(path).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let name = match &target.branch {
        Some(branch) => branch.rsplit('/').next().unwrap_or(branch).to_string(),
        None => {
            let worktree = folder(&target.worktree);
            worktree.strip_prefix(&format!("{}.", folder(&target.repo))).map_or(worktree.clone(), str::to_string)
        }
    };
    let words = name.split(['-', '_']).filter(|w| !w.is_empty()).collect::<Vec<_>>().join(" ");
    let mut chars = words.chars();
    chars.next().map(|first| first.to_uppercase().chain(chars).collect()).unwrap_or(name)
}

impl Store {
    /// The name the user gave the work on `target`, if any.
    pub fn custom_title(&self, target: &Target) -> Result<Option<String>> {
        sql(self
            .conn
            .query_row(
                &format!("SELECT title FROM titles WHERE {OF_TARGET}"),
                params![target.repo, target.branch, target.worktree],
                |r| r.get(0),
            )
            .optional())
    }

    /// The name of the work on `target`: the user's, or else [`auto_title`].
    pub fn title(&self, target: &Target) -> Result<String> {
        Ok(self.custom_title(target)?.unwrap_or_else(|| auto_title(target)))
    }

    /// Names the work on `target` `title`; a blank one, or [`auto_title`], goes back to that.
    pub fn set_title(&self, target: &Target, title: &str) -> Result<()> {
        let title = title.split_whitespace().collect::<Vec<_>>().join(" ");
        sql(self.conn.execute(&format!("DELETE FROM titles WHERE {OF_TARGET}"), params![target.repo, target.branch, target.worktree]))?;
        if !title.is_empty() && title != auto_title(target) {
            sql(self.conn.execute(
                "INSERT INTO titles (repo, branch, worktree, title) VALUES (?1, ?2, ?3, ?4)",
                params![target.repo, target.branch, target.worktree, title],
            ))?;
        }
        Ok(())
    }
}

/// Names the work on the worktree at `path`; a blank name goes back to the one from its branch.
#[tauri::command]
pub async fn rename_worktree(path: String, title: String) -> Result<()> {
    blocking(move || Store::open()?.set_title(&Target::of(Path::new(&path))?, &title)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::comments::tests::fixture;

    fn target(branch: Option<&str>, worktree: &str) -> Target {
        Target { repo: "/src/web-apps".into(), branch: branch.map(str::to_string), worktree: worktree.into() }
    }

    #[test]
    fn titles_the_work_after_the_branch_or_worktree() {
        assert_eq!(auto_title(&target(Some("codex/dispatch-cmdk-search"), "/src/x")), "Dispatch cmdk search");
        assert_eq!(auto_title(&target(Some("fix_login--redirect"), "/src/x")), "Fix login redirect");
        assert_eq!(auto_title(&target(Some("main"), "/src/web-apps")), "Main");
        assert_eq!(auto_title(&target(None, "/src/web-apps.dispatch-cmdk-search")), "Dispatch cmdk search");
        assert_eq!(auto_title(&target(Some("feat/---"), "/src/x")), "---");
    }

    #[test]
    fn keeps_the_name_the_user_gave_a_branch() {
        let (root, _, store) = fixture("titles");
        let (feat, moved) = (target(Some("feat/x"), "/src/a"), target(Some("feat/x"), "/src/b"));
        let (detached, elsewhere) = (target(None, "/src/a"), target(None, "/src/b"));
        assert_eq!(store.title(&feat).unwrap(), "X");

        // It follows the branch to any worktree; with a detached HEAD it stays with the worktree.
        store.set_title(&feat, "  Command   menu search ").unwrap();
        assert_eq!(store.title(&moved).unwrap(), "Command menu search");
        assert_eq!(store.custom_title(&detached).unwrap(), None);
        store.set_title(&detached, "Bisecting").unwrap();
        assert_eq!((store.title(&detached).unwrap().as_str(), store.custom_title(&elsewhere).unwrap()), ("Bisecting", None));

        // Renaming replaces it; a blank name, or the automatic one, clears it.
        store.set_title(&feat, "Search").unwrap();
        assert_eq!(store.title(&feat).unwrap(), "Search");
        store.set_title(&feat, " ").unwrap();
        assert_eq!(store.custom_title(&feat).unwrap(), None);
        store.set_title(&detached, "A").unwrap();
        assert_eq!(store.custom_title(&detached).unwrap(), None);

        std::fs::remove_dir_all(&root).unwrap();
    }
}
