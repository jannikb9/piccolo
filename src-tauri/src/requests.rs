//! What the reviewer asks agents to do: review the branch, or address comments on it (implement
//! them). A request names the agent, and the session once one takes it on: a new session is opened
//! with a prompt to run `piccolo guide --request <id>`, which claims the request for the session it
//! runs in and prints the steps for its kind, and the agent says it's finished with `piccolo done`.
//! In between, its comments and replies come in one by one like anyone's. An agent can do either
//! unasked, too: `done` then records what it did.
//!
//! A session's role on the branch follows from what it was last asked: reviewers review, and the
//! session building the branch, or asked to address comments, implements.

use crate::comments::{blocking, now_ms, sql, Store, Target};
use crate::git::{self, Result};
use crate::sessions::{self, shell_quote, Agent, Caller, Session};
use crate::terminals::Launcher;
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
        finished_at INTEGER,
        kind TEXT NOT NULL DEFAULT 'review',
        threads TEXT
    );
    CREATE INDEX IF NOT EXISTS review_requests_by_branch ON review_requests (repo, branch);";

/// Who's asked when the prompt is copied: the agent it's pasted into, named once it takes it on.
pub const ANY_AGENT: &str = "agent";

/// Rows on `target`'s branch, with `?1` its repository, `?2` its branch and `?3` its worktree.
const ON_BRANCH: &str = "repo = ?1 AND (branch = ?2 OR (?2 IS NULL AND branch IS NULL AND worktree = ?3))";

/// What an agent is asked to do.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    /// Review the branch, commenting on it.
    Review,
    /// Address comments on the branch: change the code and answer them.
    Implement,
}

impl Kind {
    fn as_str(self) -> &'static str {
        match self {
            Kind::Review => "review",
            Kind::Implement => "implement",
        }
    }
}

/// A request to an agent.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub id: i64,
    pub kind: Kind,
    /// Who was asked: `claude`, `codex`, or another agent's name.
    pub agent: String,
    /// The session doing it, once it took it on (or when an existing one was asked).
    pub session_id: Option<String>,
    /// The commit the branch was at when it was asked for.
    pub head: Option<String>,
    /// The comments to address, for an implement request.
    pub threads: Vec<i64>,
    pub requested_at: i64,
    /// When the agent took it on (`piccolo guide --request`).
    pub started_at: Option<i64>,
    /// When the agent said it's done (`piccolo done`).
    pub finished_at: Option<i64>,
    /// Comments and replies the agent wrote on the branch meanwhile.
    pub comments: i64,
}

fn request_from_row(row: &Row) -> rusqlite::Result<Request> {
    let kind: String = row.get("kind")?;
    let threads: Option<String> = row.get("threads")?;
    Ok(Request {
        id: row.get("id")?,
        kind: if kind == "implement" { Kind::Implement } else { Kind::Review },
        agent: row.get("agent")?,
        session_id: row.get("session_id")?,
        head: row.get("head")?,
        threads: threads.unwrap_or_default().split_whitespace().filter_map(|id| id.parse().ok()).collect(),
        requested_at: row.get("requested_at")?,
        started_at: row.get("started_at")?,
        finished_at: row.get("finished_at")?,
        comments: 0,
    })
}

/// Requests on `target`'s branch, newest first, with the comments each brought.
pub fn list(store: &Store, target: &Target) -> Result<Vec<Request>> {
    let mut stmt = sql(store.conn.prepare(&format!("SELECT * FROM review_requests WHERE {ON_BRANCH} ORDER BY id DESC")))?;
    let rows = sql(stmt.query_map(params![target.repo, target.branch, target.worktree], request_from_row))?;
    let mut requests = sql(rows.collect::<rusqlite::Result<Vec<_>>>())?;
    for request in &mut requests {
        request.comments = store.written_during(target, request)?;
    }
    Ok(requests)
}

/// Who's asked: a session working on the worktree, or a new session of an agent, started where
/// the launcher says.
#[derive(Clone, Copy)]
pub enum Asked<'a> {
    Session(&'a Session),
    New(Agent, Launcher),
}

impl Store {
    /// Asks `to` for `kind` of work on `target`'s branch, at commit `head`, and hands it the prompt.
    /// Comments to address are those the session hasn't seen (every open one, for a new session),
    /// and count as seen once sent. Nothing is recorded when the prompt can't be handed over.
    pub fn ask(&self, target: &Target, kind: Kind, to: Asked, head: Option<&str>) -> Result<Request> {
        let (agent, session) = match to {
            Asked::Session(session) => (session.agent.as_str(), Some(session.id.as_str())),
            Asked::New(agent, _) => (agent.name(), None),
        };
        let (request, text) = self.prepare(target, kind, agent, session, head)?;
        let handed = match to {
            Asked::Session(session) => sessions::deliver(session, &text),
            Asked::New(agent, launcher) => sessions::start_session(agent, &target.worktree, &text, launcher),
        };
        if let Err(e) = handed {
            self.cancel_request(request.id)?;
            return Err(e);
        }
        if let Some(session) = session {
            self.mark_seen(session, &request.threads)?;
        }
        Ok(request)
    }

    /// Records a request to `agent` (in `session`, when it's running) for `kind` of work, and
    /// returns it with the prompt that hands it over.
    fn prepare(&self, target: &Target, kind: Kind, agent: &str, session: Option<&str>, head: Option<&str>) -> Result<(Request, String)> {
        let threads = match kind {
            Kind::Review => Vec::new(),
            Kind::Implement => self.unseen(target, session)?,
        };
        if kind == Kind::Implement && threads.is_empty() {
            return Err("There are no comments to send".into());
        }
        let request = self.add_request(target, kind, agent, session, head, &threads)?;
        let again = kind == Kind::Review && self.previous_review(target, agent, session, request.id)?.is_some();
        let text = prompt(&request, &target.worktree, again);
        Ok((request, text))
    }

    /// Records a request for `kind` of work for whichever agent is given its prompt, and returns
    /// the prompt, for the user to paste into any agent. The agent that takes it on claims it.
    pub fn prompt_for(&self, target: &Target, kind: Kind, head: Option<&str>) -> Result<String> {
        Ok(self.prepare(target, kind, ANY_AGENT, None, head)?.1)
    }

    /// Records a request to `agent` for `kind` of work on `target`'s branch, at commit `head`;
    /// `session` when an existing session is asked, `threads` the comments to address.
    pub fn add_request(
        &self,
        target: &Target,
        kind: Kind,
        agent: &str,
        session: Option<&str>,
        head: Option<&str>,
        threads: &[i64],
    ) -> Result<Request> {
        let threads = (!threads.is_empty()).then(|| threads.iter().map(i64::to_string).collect::<Vec<_>>().join(" "));
        sql(self.conn.execute(
            "INSERT INTO review_requests (repo, branch, worktree, kind, agent, session_id, head, threads, requested_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![target.repo, target.branch, target.worktree, kind.as_str(), agent, session, head, threads, now_ms()],
        ))?;
        self.request(self.conn.last_insert_rowid())
    }

    pub fn request(&self, id: i64) -> Result<Request> {
        let request = sql(self.conn.query_row("SELECT * FROM review_requests WHERE id = ?1", [id], request_from_row).optional())?;
        request.ok_or_else(|| format!("No request #{id}"))
    }

    /// Takes on request `id` for `target`'s branch, from `caller`'s session when known, which names
    /// the agent of a request whose prompt was copied.
    pub fn start_request(&self, target: &Target, id: i64, caller: Option<&Caller>) -> Result<Request> {
        let on_branch: bool = sql(self.conn.query_row(
            &format!("SELECT COUNT(*) > 0 FROM review_requests WHERE id = ?4 AND {ON_BRANCH}"),
            params![target.repo, target.branch, target.worktree, id],
            |r| r.get(0),
        ))?;
        if !on_branch {
            return Err(format!("request #{id} isn't for {}", target.label()));
        }
        sql(self.conn.execute(
            "UPDATE review_requests SET started_at = COALESCE(started_at, ?2), session_id = COALESCE(session_id, ?3),
                agent = CASE WHEN agent = ?5 AND ?4 IS NOT NULL THEN ?4 ELSE agent END
             WHERE id = ?1",
            params![id, now_ms(), caller.map(|c| c.id.as_str()), caller.map(|c| c.agent.as_str()), ANY_AGENT],
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
                     WHERE {ON_BRANCH} AND kind = 'review' AND id < ?6 AND finished_at IS NOT NULL
                       AND (session_id = ?5 OR (?5 IS NULL AND agent = ?4))
                     ORDER BY id DESC LIMIT 1"
                ),
                params![target.repo, target.branch, target.worktree, agent, session, before],
                request_from_row,
            )
            .optional())
    }

    /// Finishes the work of `kind` `agent` is doing on `target`'s branch: request `id`, else the
    /// one its session took on, else the latest one asked of it. Without any, records what it did
    /// unasked, from its first comment since its previous review.
    pub fn finish_request(&self, target: &Target, kind: Kind, agent: &str, session: Option<&str>, id: Option<i64>) -> Result<Request> {
        let now = now_ms();
        let open: Option<i64> = match id {
            Some(id) => Some(self.start_request(target, id, None)?.id),
            None => sql(self
                .conn
                .query_row(
                    &format!(
                        "SELECT id FROM review_requests
                         WHERE {ON_BRANCH} AND kind = ?6 AND finished_at IS NULL
                           AND ((?5 IS NOT NULL AND session_id = ?5) OR (session_id IS NULL AND agent = ?4))
                         ORDER BY session_id IS NULL, id DESC LIMIT 1"
                    ),
                    params![target.repo, target.branch, target.worktree, agent, session, kind.as_str()],
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
                let request = self.add_request(target, kind, agent, session, None, &[])?;
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
        request.comments = self.written_during(target, &request)?;
        Ok(request)
    }

    /// Withdraws a request.
    pub fn cancel_request(&self, id: i64) -> Result<()> {
        sql(self.conn.execute("DELETE FROM review_requests WHERE id = ?1", [id]))?;
        Ok(())
    }

    /// Messages the agent wrote on `target`'s branch while `request` ran: from its session, or
    /// signed with its name when the session isn't known.
    fn written_during(&self, target: &Target, request: &Request) -> Result<i64> {
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

/// The prompt that hands `request` on the worktree at `worktree` to an agent.
fn prompt(request: &Request, worktree: &str, again: bool) -> String {
    let guide = format!("Run `piccolo -C {} guide --request {}` and follow the steps it prints.", shell_quote(worktree), request.id);
    match request.kind {
        Kind::Review => {
            let again = if again { " again, now that it has changed" } else { "" };
            format!("Piccolo asks you to review the changes in the worktree {worktree}{again}. {guide}")
        }
        Kind::Implement => {
            let what = if request.threads.len() == 1 { "a review comment" } else { "review comments" };
            let ids: Vec<String> = request.threads.iter().map(|id| format!("#{id}")).collect();
            format!("The reviewer sent you {what} from Piccolo to address: {}, on the worktree {worktree}. {guide}", ids.join(", "))
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Tauri commands

/// The commit the worktree at `path` is at.
fn head_of(path: &str) -> Option<String> {
    git::git(Path::new(path), &["rev-parse", "HEAD"]).ok().map(|h| h.trim().to_string())
}

/// Asks for `kind` of work on the worktree at `path`: from the session `session` working on it, or
/// from a new Claude or Codex session, started where `launcher` says.
async fn ask(path: String, kind: Kind, agent: Option<Agent>, session: Option<String>, launcher: Launcher) -> Result<Request> {
    blocking(move || {
        let store = Store::open()?;
        let target = Target::of(Path::new(&path))?;
        let head = head_of(&path);
        match (session, agent) {
            (Some(session), _) => {
                let sessions = sessions::sessions_of(&store, &path)?;
                let session = sessions.iter().find(|s| s.id == session).ok_or("That session isn't running any more")?;
                store.ask(&target, kind, Asked::Session(session), head.as_deref())
            }
            (None, Some(agent)) => store.ask(&target, kind, Asked::New(agent, launcher), head.as_deref()),
            (None, None) => Err("Say which agent to ask".into()),
        }
    })
    .await
}

/// Asks for a review of the worktree at `path`.
#[tauri::command]
pub async fn request_review(path: String, agent: Option<Agent>, session: Option<String>, launcher: Launcher) -> Result<Request> {
    ask(path, Kind::Review, agent, session, launcher).await
}

/// Sends the comments on the worktree at `path` to an agent to address: those a session hasn't
/// seen, or every open one for a new session.
#[tauri::command]
pub async fn send_comments(path: String, agent: Option<Agent>, session: Option<String>, launcher: Launcher) -> Result<Request> {
    ask(path, Kind::Implement, agent, session, launcher).await
}

/// Asks any agent for `kind` of work on the worktree at `path`, and returns the prompt, for the
/// user to paste into the agent of their choice.
#[tauri::command]
pub async fn copy_prompt(path: String, kind: Kind) -> Result<String> {
    blocking(move || {
        let store = Store::open()?;
        store.prompt_for(&Target::of(Path::new(&path))?, kind, head_of(&path).as_deref())
    })
    .await
}

/// Withdraws a request, or removes a finished one from the list.
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
        let request = store.add_request(&target, Kind::Review, "codex", None, Some("abc"), &[]).unwrap();
        assert_eq!((request.started_at, request.session_id.as_deref()), (None, None));
        let other = Target::of(&root.join("repo")).unwrap();
        assert!(store.start_request(&other, request.id, Some(&codex)).is_err());
        let started = store.start_request(&target, request.id, Some(&codex)).unwrap();
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
        let done = store.finish_request(&target, Kind::Review, "codex", Some("thread-1"), None).unwrap();
        assert_eq!((done.id, done.comments), (request.id, 2));
        assert!(done.finished_at.is_some());

        // Asked again: the previous review is found, and only new comments count.
        let again = store.add_request(&target, Kind::Review, "codex", Some("thread-1"), Some("def"), &[]).unwrap();
        let previous = store.previous_review(&target, "codex", Some("thread-1"), again.id).unwrap().unwrap();
        assert_eq!(previous.head.as_deref(), Some("abc"));
        store.start_request(&target, again.id, Some(&codex)).unwrap();
        wait();
        store.reply(first, by_codex, "Still there", &[]).unwrap();
        assert_eq!(store.finish_request(&target, Kind::Review, "codex", Some("thread-1"), None).unwrap().comments, 1);

        // A review nobody asked for is recorded when it's done, from its first comment.
        wait();
        comment(&mut store, By::agent(Some("gemini")), 5);
        wait();
        let unasked = store.finish_request(&target, Kind::Review, "gemini", None, None).unwrap();
        assert_eq!(unasked.comments, 1);
        assert!(unasked.started_at < unasked.finished_at);

        assert_eq!(list(&store, &target).unwrap().len(), 3);
        assert!(list(&store, &other).unwrap().is_empty());
        store.cancel_request(unasked.id).unwrap();
        assert_eq!(list(&store, &target).unwrap().len(), 2);
        let text = prompt(&again, "/wt/a b", true);
        assert!(text.contains("`piccolo -C '/wt/a b' guide --request ") && text.contains("again"), "{text}");

        // Asked to address comments: the comments are kept, and a review asked afterwards isn't
        // taken for a second one.
        let implement = store.add_request(&target, Kind::Implement, "claude", None, None, &[first, 9]).unwrap();
        assert_eq!((implement.kind, implement.threads.clone()), (Kind::Implement, vec![first, 9]));
        let text = prompt(&implement, "/wt", false);
        assert!(text.contains(&format!("to address: #{first}, #9, on the worktree /wt")) && text.contains("guide --request "), "{text}");
        let claude = Caller { id: "claude-1".into(), agent: "claude".into() };
        store.start_request(&target, implement.id, Some(&claude)).unwrap();
        // `done` for a review doesn't finish it; for the work it was asked, it does.
        assert_ne!(store.finish_request(&target, Kind::Review, "claude", Some("claude-1"), None).unwrap().id, implement.id);
        let finished = store.finish_request(&target, Kind::Implement, "claude", Some("claude-1"), None).unwrap();
        assert_eq!((finished.id, finished.kind), (implement.id, Kind::Implement));
        assert!(store.previous_review(&target, "claude", Some("claude-1"), i64::MAX).unwrap().unwrap().id != implement.id);

        // A copied prompt is for any agent: the one that takes it on is named.
        let text = store.prompt_for(&target, Kind::Review, None).unwrap();
        let copied = list(&store, &target).unwrap().remove(0);
        assert!(text.contains(&format!("guide --request {}", copied.id)), "{text}");
        assert_eq!(copied.agent, ANY_AGENT);
        let gemini = Caller { id: "gemini-1".into(), agent: "gemini".into() };
        assert_eq!(store.start_request(&target, copied.id, Some(&gemini)).unwrap().agent, "gemini");

        std::fs::remove_dir_all(&root).unwrap();
    }
}
