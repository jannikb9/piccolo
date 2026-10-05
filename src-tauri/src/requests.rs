//! Reviews the reviewer asks agents for. A request names the agent, and the session once one takes
//! it on: a new session is opened with a prompt to run `piccolo guide --request <id>`, which claims
//! the request for the session it runs in, and the agent says it's finished with `piccolo done`.
//! In between, its comments come in one by one like anyone's. An agent can review unasked, too:
//! `done` then records the review it did.

use crate::comments::{blocking, now_ms, sql, Store, Target};
use crate::git::{self, Result};
use crate::sessions::{self, shell_quote, Agent, Caller};
use rusqlite::{params, OptionalExtension, Row};
use serde::Serialize;
use std::path::Path;

pub(crate) const SCHEMA: &str = "
    CREATE TABLE IF NOT EXISTS review_requests (
        id INTEGER PRIMARY KEY,
        repo TEXT NOT NULL,
        branch TEXT,
        worktree TEXT NOT NULL,
        agent TEXT NOT NULL,
        session_id TEXT,
        head TEXT,
        requested_at INTEGER NOT NULL,
        started_at INTEGER,
        finished_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS review_requests_by_branch ON review_requests (repo, branch);";

/// Rows on `target`'s branch, with `?1` its repository, `?2` its branch and `?3` its worktree.
const ON_BRANCH: &str = "repo = ?1 AND (branch = ?2 OR (?2 IS NULL AND branch IS NULL AND worktree = ?3))";

/// A requested review.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub id: i64,
    /// Who was asked: `claude`, `codex`, or another agent's name.
    pub agent: String,
    /// The session doing the review, once it took it on (or when an existing one was asked).
    pub session_id: Option<String>,
    /// The commit the branch was at when it was asked for.
    pub head: Option<String>,
    pub requested_at: i64,
    /// When the agent took it on (`piccolo guide --request`).
    pub started_at: Option<i64>,
    /// When the agent said it's done (`piccolo done`).
    pub finished_at: Option<i64>,
    /// Comments and replies the agent wrote on the branch while reviewing.
    pub comments: i64,
}

fn request_from_row(row: &Row) -> rusqlite::Result<Request> {
    Ok(Request {
        id: row.get("id")?,
        agent: row.get("agent")?,
        session_id: row.get("session_id")?,
        head: row.get("head")?,
        requested_at: row.get("requested_at")?,
        started_at: row.get("started_at")?,
        finished_at: row.get("finished_at")?,
        comments: 0,
    })
}

/// Reviews requested on `target`'s branch, newest first, with the comments each brought.
pub fn list(store: &Store, target: &Target) -> Result<Vec<Request>> {
    let mut stmt = sql(store.conn.prepare(&format!("SELECT * FROM review_requests WHERE {ON_BRANCH} ORDER BY id DESC")))?;
    let rows = sql(stmt.query_map(params![target.repo, target.branch, target.worktree], request_from_row))?;
    let mut requests = sql(rows.collect::<rusqlite::Result<Vec<_>>>())?;
    for request in &mut requests {
        request.comments = store.review_comments(target, request)?;
    }
    Ok(requests)
}

impl Store {
    /// Asks `agent` for a review of `target`'s branch, at commit `head`; `session` when an existing
    /// session is asked.
    pub fn request_review(&self, target: &Target, agent: &str, session: Option<&str>, head: Option<&str>) -> Result<Request> {
        let now = now_ms();
        sql(self.conn.execute(
            "INSERT INTO review_requests (repo, branch, worktree, agent, session_id, head, requested_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![target.repo, target.branch, target.worktree, agent, session, head, now],
        ))?;
        self.request(self.conn.last_insert_rowid())
    }

    pub fn request(&self, id: i64) -> Result<Request> {
        let request = sql(self.conn.query_row("SELECT * FROM review_requests WHERE id = ?1", [id], request_from_row).optional())?;
        request.ok_or_else(|| format!("No review request #{id}"))
    }

    /// Takes on request `id` for `target`'s branch, from `caller`'s session when known.
    pub fn start_review(&self, target: &Target, id: i64, caller: Option<&Caller>) -> Result<Request> {
        let on_branch: bool = sql(self.conn.query_row(
            &format!("SELECT COUNT(*) > 0 FROM review_requests WHERE id = ?4 AND {ON_BRANCH}"),
            params![target.repo, target.branch, target.worktree, id],
            |r| r.get(0),
        ))?;
        if !on_branch {
            return Err(format!("review request #{id} isn't for {}", target.label()));
        }
        sql(self.conn.execute(
            "UPDATE review_requests SET started_at = COALESCE(started_at, ?2), session_id = COALESCE(session_id, ?3)
             WHERE id = ?1",
            params![id, now_ms(), caller.map(|c| c.id.as_str())],
        ))?;
        self.request(id)
    }

    /// The review `agent` (in session `session`, when known) did of `target`'s branch before
    /// request `before`, if any.
    pub fn previous_review(&self, target: &Target, agent: &str, session: Option<&str>, before: i64) -> Result<Option<Request>> {
        sql(self
            .conn
            .query_row(
                &format!(
                    "SELECT * FROM review_requests
                     WHERE {ON_BRANCH} AND id < ?6 AND finished_at IS NOT NULL
                       AND (session_id = ?5 OR (?5 IS NULL AND agent = ?4))
                     ORDER BY id DESC LIMIT 1"
                ),
                params![target.repo, target.branch, target.worktree, agent, session, before],
                request_from_row,
            )
            .optional())
    }

    /// Finishes the review `agent` is doing of `target`'s branch: request `id`, else the one its
    /// session took on, else the latest one asked of it. Without any, records the review it did
    /// unasked, from its first comment since its previous review.
    pub fn finish_review(&self, target: &Target, agent: &str, session: Option<&str>, id: Option<i64>) -> Result<Request> {
        let now = now_ms();
        let open: Option<i64> = match id {
            Some(id) => Some(self.start_review(target, id, None)?.id),
            None => sql(self
                .conn
                .query_row(
                    &format!(
                        "SELECT id FROM review_requests
                         WHERE {ON_BRANCH} AND finished_at IS NULL
                           AND ((?5 IS NOT NULL AND session_id = ?5) OR (session_id IS NULL AND agent = ?4))
                         ORDER BY session_id IS NULL, id DESC LIMIT 1"
                    ),
                    params![target.repo, target.branch, target.worktree, agent, session],
                    |r| r.get(0),
                )
                .optional())?,
        };
        let id = match open {
            Some(id) => id,
            None => {
                let since = self.previous_review(target, agent, session, i64::MAX)?.and_then(|r| r.finished_at).unwrap_or(0);
                let first: Option<i64> = sql(self.conn.query_row(
                    &format!(
                        "SELECT MIN(created_at) FROM messages
                         WHERE author = 'agent' AND created_at > ?6
                           AND ((?5 IS NOT NULL AND session_id = ?5) OR author_name = ?4)
                           AND thread_id IN (SELECT id FROM threads WHERE {ON_BRANCH})"
                    ),
                    params![target.repo, target.branch, target.worktree, agent, session, since],
                    |r| r.get(0),
                ))?;
                let request = self.request_review(target, agent, session, None)?;
                sql(self.conn.execute(
                    "UPDATE review_requests SET requested_at = ?2, started_at = ?2 WHERE id = ?1",
                    params![request.id, first.unwrap_or(now)],
                ))?;
                request.id
            }
        };
        sql(self.conn.execute(
            "UPDATE review_requests SET finished_at = ?2, started_at = COALESCE(started_at, ?2),
                session_id = COALESCE(session_id, ?3)
             WHERE id = ?1",
            params![id, now, session],
        ))?;
        let mut request = self.request(id)?;
        request.comments = self.review_comments(target, &request)?;
        Ok(request)
    }

    /// Withdraws a request.
    pub fn cancel_request(&self, id: i64) -> Result<()> {
        sql(self.conn.execute("DELETE FROM review_requests WHERE id = ?1", [id]))?;
        Ok(())
    }

    /// Messages the reviewing agent wrote on `target`'s branch while `request` ran: from its
    /// session, or signed with its name when the session isn't known.
    fn review_comments(&self, target: &Target, request: &Request) -> Result<i64> {
        let Some(from) = request.started_at else { return Ok(0) };
        sql(self.conn.query_row(
            &format!(
                "SELECT COUNT(*) FROM messages
                 WHERE author = 'agent' AND created_at >= ?6 AND created_at <= ?7
                   AND (session_id = ?5 OR (?5 IS NULL AND author_name = ?4))
                   AND thread_id IN (SELECT id FROM threads WHERE {ON_BRANCH})"
            ),
            params![
                target.repo,
                target.branch,
                target.worktree,
                request.agent,
                request.session_id,
                from,
                request.finished_at.unwrap_or(i64::MAX)
            ],
            |r| r.get(0),
        ))
    }
}

/// The prompt that asks an agent for review `request` of the worktree at `worktree`.
fn prompt(request: &Request, worktree: &str, again: bool) -> String {
    let again = if again { " again, now that it has changed" } else { "" };
    format!(
        "Piccolo asks you to review the changes in the worktree {worktree}{again}. Run `piccolo -C {} guide --request {}` \
         and follow the steps it prints.",
        shell_quote(worktree),
        request.id,
    )
}

// ---------------------------------------------------------------------------------------------
// Tauri commands

/// Asks for a review of the worktree at `path`: from the running session `session`, or from a new
/// Claude or Codex session in its desktop app.
#[tauri::command]
pub async fn request_review(path: String, agent: Option<String>, session: Option<String>) -> Result<Request> {
    blocking(move || {
        let store = Store::open()?;
        let target = Target::of(Path::new(&path))?;
        let head = git::git(Path::new(&path), &["rev-parse", "HEAD"]).ok().map(|h| h.trim().to_string());
        match (session, agent) {
            (Some(session), _) => {
                let sessions = sessions::sessions_of(&store, &path)?;
                let session = sessions.iter().find(|s| s.id == session).ok_or("That session isn't running any more")?;
                let request = store.request_review(&target, &session.agent, Some(&session.id), head.as_deref())?;
                let again = store.previous_review(&target, &session.agent, Some(&session.id), request.id)?.is_some();
                if let Err(e) = sessions::deliver(session, &prompt(&request, &target.worktree, again)) {
                    store.cancel_request(request.id)?;
                    return Err(e);
                }
                Ok(request)
            }
            (None, Some(name)) => {
                let agent = match name.as_str() {
                    "claude" => Agent::Claude,
                    "codex" => Agent::Codex,
                    other => return Err(format!("Piccolo can't start a {other} session")),
                };
                let request = store.request_review(&target, &name, None, head.as_deref())?;
                if let Err(e) = sessions::open_new_session(agent, &target.worktree, &prompt(&request, &target.worktree, false)) {
                    store.cancel_request(request.id)?;
                    return Err(e);
                }
                Ok(request)
            }
            (None, None) => Err("Say who should review".into()),
        }
    })
    .await
}

/// Withdraws a request, or removes a finished review from the list.
#[tauri::command]
pub async fn cancel_review_request(id: i64) -> Result<()> {
    blocking(move || Store::open()?.cancel_request(id)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::comments::tests::{additions, fixture};
    use crate::comments::{By, NewThread};
    use crate::git::{DiffRange, Scope};

    #[test]
    fn tracks_requested_reviews_from_request_to_done() {
        let (root, wt, mut store) = fixture("requests");
        let target = Target::of(&wt).unwrap();
        let range = DiffRange::resolve(&wt, Some("main"), &Scope::All).unwrap();
        let codex = Caller { id: "thread-1".into(), agent: "codex".into() };
        let by_codex = By { session: Some("thread-1"), ..By::agent(Some("codex")) };
        let comment = |store: &mut Store, by: By, line| {
            let new = NewThread { by, path: "a.txt", old_path: None, range: additions(line, line), body: "Why?", images: &[] };
            store.add_thread(&target, &wt, &range, new).unwrap()
        };
        let wait = || std::thread::sleep(std::time::Duration::from_millis(2));

        // Asked, then taken on by the session that runs the guide.
        let request = store.request_review(&target, "codex", None, Some("abc")).unwrap();
        assert_eq!((request.started_at, request.session_id.as_deref()), (None, None));
        let other = Target::of(&root.join("repo")).unwrap();
        assert!(store.start_review(&other, request.id, Some(&codex)).is_err());
        let started = store.start_review(&target, request.id, Some(&codex)).unwrap();
        assert_eq!(started.session_id.as_deref(), Some("thread-1"));
        assert!(started.started_at.is_some());

        // Its comments count; others' don't.
        wait();
        let first = comment(&mut store, by_codex, 3);
        comment(&mut store, by_codex, 4);
        comment(&mut store, By::agent(Some("claude")), 4);
        comment(&mut store, By::REVIEWER, 6);
        assert_eq!(list(&store, &target).unwrap()[0].comments, 2);

        // `done` finishes the request the session took on.
        let done = store.finish_review(&target, "codex", Some("thread-1"), None).unwrap();
        assert_eq!((done.id, done.comments), (request.id, 2));
        assert!(done.finished_at.is_some());

        // Asked again: the previous review is found, and only new comments count.
        let again = store.request_review(&target, "codex", Some("thread-1"), Some("def")).unwrap();
        let previous = store.previous_review(&target, "codex", Some("thread-1"), again.id).unwrap().unwrap();
        assert_eq!(previous.head.as_deref(), Some("abc"));
        store.start_review(&target, again.id, Some(&codex)).unwrap();
        wait();
        store.reply(first, by_codex, "Still there", &[]).unwrap();
        assert_eq!(store.finish_review(&target, "codex", Some("thread-1"), None).unwrap().comments, 1);

        // A review nobody asked for is recorded when it's done, from its first comment.
        wait();
        comment(&mut store, By::agent(Some("gemini")), 5);
        wait();
        let unasked = store.finish_review(&target, "gemini", None, None).unwrap();
        assert_eq!(unasked.comments, 1);
        assert!(unasked.started_at < unasked.finished_at);

        assert_eq!(list(&store, &target).unwrap().len(), 3);
        assert!(list(&store, &other).unwrap().is_empty());
        store.cancel_request(unasked.id).unwrap();
        assert_eq!(list(&store, &target).unwrap().len(), 2);
        let text = prompt(&again, "/wt/a b", true);
        assert!(text.contains("`piccolo -C '/wt/a b' guide --request ") && text.contains("again"), "{text}");

        std::fs::remove_dir_all(&root).unwrap();
    }
}
