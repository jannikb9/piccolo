//! Reviews agents submit. An agent reviewing a branch comments as it goes, then submits its
//! review like finishing one on GitHub: a summary, saved as a general comment, that says it's
//! done. Each review counts the comments its agent left since its previous one.

use crate::comments::{insert_general_thread, now_ms, sql, Author, By, Store, Target};
use crate::git::Result;
use rusqlite::params;

/// Reviews submitted on each branch; `thread_id` is the summary's general thread.
pub(crate) const SCHEMA: &str = "
    CREATE TABLE IF NOT EXISTS reviews (
        id INTEGER PRIMARY KEY,
        repo TEXT NOT NULL,
        branch TEXT,
        worktree TEXT NOT NULL,
        reviewer TEXT NOT NULL,
        thread_id INTEGER REFERENCES threads (id) ON DELETE SET NULL,
        comments INTEGER NOT NULL,
        submitted_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS reviews_by_branch ON reviews (repo, branch);";

/// Rows on `target`'s branch, with `?1` its repository, `?2` its branch and `?3` its worktree.
const ON_BRANCH: &str = "repo = ?1 AND (branch = ?2 OR (?2 IS NULL AND branch IS NULL AND worktree = ?3))";

/// A review as it was submitted.
#[derive(Debug, Clone, PartialEq)]
pub struct Review {
    pub id: i64,
    /// The general thread holding the summary.
    pub thread: i64,
    /// Comments and replies the reviewer wrote on the branch since its previous review.
    pub comments: i64,
}

impl Store {
    /// Submits `reviewer`'s review of `target`'s branch with `summary`, which is posted as a
    /// general comment signed by the agent.
    pub fn submit_review(&mut self, target: &Target, reviewer: &str, summary: &str) -> Result<Review> {
        let summary = summary.trim();
        if summary.is_empty() {
            return Err("A review needs a summary: your verdict and the most important points".into());
        }
        let now = now_ms();
        let tx = sql(self.conn.transaction())?;
        let since: Option<i64> = sql(tx.query_row(
            &format!("SELECT MAX(submitted_at) FROM reviews WHERE {ON_BRANCH} AND reviewer = ?4"),
            params![target.repo, target.branch, target.worktree, reviewer],
            |r| r.get(0),
        ))?;
        let comments: i64 = sql(tx.query_row(
            &format!(
                "SELECT COUNT(*) FROM messages
                 WHERE author = 'agent' AND author_name = ?4 AND created_at > ?5
                   AND thread_id IN (SELECT id FROM threads WHERE {ON_BRANCH})"
            ),
            params![target.repo, target.branch, target.worktree, reviewer, since.unwrap_or(0)],
            |r| r.get(0),
        ))?;
        let (thread, _) = insert_general_thread(&tx, target, By { author: Author::Agent, name: Some(reviewer) }, summary, now)?;
        sql(tx.execute(
            "INSERT INTO reviews (repo, branch, worktree, reviewer, thread_id, comments, submitted_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![target.repo, target.branch, target.worktree, reviewer, thread, comments, now],
        ))?;
        let id = tx.last_insert_rowid();
        sql(tx.commit())?;
        Ok(Review { id, thread, comments })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::comments::tests::{additions, fixture};
    use crate::comments::NewThread;
    use crate::git::{DiffRange, Scope};

    #[test]
    fn submits_reviews_with_a_summary_counting_the_reviewers_comments() {
        let (root, wt, mut store) = fixture("reviews");
        let target = Target::of(&wt).unwrap();
        let range = DiffRange::resolve(&wt, Some("main"), &Scope::All).unwrap();
        let codex = By { author: Author::Agent, name: Some("codex") };
        let comment = |store: &mut Store, by: By, line| {
            let new = NewThread { by, path: "a.txt", old_path: None, range: additions(line, line), body: "Why?", images: &[] };
            store.add_thread(&target, &wt, &range, new).unwrap()
        };
        let first = comment(&mut store, codex, 3);
        comment(&mut store, codex, 4);
        // Others' comments don't count, nor do the reviewer's.
        comment(&mut store, By { author: Author::Agent, name: Some("claude") }, 4);
        let mine = comment(&mut store, By::REVIEWER, 6);
        store.reply(mine, codex, "Agreed", &[]).unwrap();

        assert!(store.submit_review(&target, "codex", "  ").is_err());
        let review = store.submit_review(&target, "codex", " Two bugs in the parser. ").unwrap();
        assert_eq!(review.comments, 3);

        // The summary is a general comment by the agent, not waiting to be sent.
        let summary = store.thread(review.thread).unwrap();
        assert_eq!(summary.path, None);
        let message = &summary.messages[0];
        assert_eq!((message.author, message.author_name.as_deref(), message.body.as_str()), (Author::Agent, Some("codex"), "Two bugs in the parser."));
        assert!(!summary.pending);

        // A second review counts only what came after the first, its summary excluded.
        std::thread::sleep(std::time::Duration::from_millis(2));
        store.reply(first, codex, "Still there", &[]).unwrap();
        assert_eq!(store.submit_review(&target, "codex", "One left.").unwrap().comments, 1);
        assert_eq!(store.submit_review(&target, "claude", "Fine.").unwrap().comments, 1);

        // The main branch has its own reviews.
        let main = Target::of(&root.join("repo")).unwrap();
        assert_eq!(store.submit_review(&main, "codex", "Nothing to see.").unwrap().comments, 0);

        std::fs::remove_dir_all(&root).unwrap();
    }
}
