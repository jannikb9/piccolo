//! What the reviewer asks agents to do: review the branch, or address comments on it (implement
//! them). A request names the agent, and the session once one takes it on: a running session is
//! sent a prompt, or the reviewer copies one to paste into any agent, to run `piccolo guide
//! --request <id>`, which claims the request for the session it runs in and prints the steps for
//! its kind, and the agent says it's finished with `piccolo done`.
//! In between, its comments and replies come in one by one like anyone's. An agent can do either
//! unasked, too: `done` then records what it did.
//!
//! A session's role on the branch follows from what it was last asked: reviewers review, and the
//! session building the branch, or asked to address comments, implements.

use crate::comments::{blocking, now_ms, sql, Store, Target};
use crate::git::{self, DiffOptions, Result, Scope};
use crate::sessions::{self, shell_quote, Caller, Session};
use rusqlite::{params, OptionalExtension, Row};
use serde::Serialize;
use std::collections::HashSet;
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

impl Store {
    /// Asks `session` for `kind` of work on `target`'s branch, at commit `head`, and hands it the
    /// prompt. The comments to address are `comments_to_send`, which count as seen once sent.
    /// Nothing is recorded when the prompt can't be handed over.
    pub fn ask(&self, target: &Target, kind: Kind, session: &Session, head: Option<&str>) -> Result<Request> {
        let (request, text) = self.prepare(target, kind, &session.agent, Some(&session.id), head)?;
        if let Err(e) = sessions::deliver(session, &text) {
            self.cancel_request(request.id)?;
            return Err(e);
        }
        self.mark_seen(&session.id, &request.threads)?;
        Ok(request)
    }

    /// Records a request to `agent` (in `session`, when it's running) for `kind` of work, and
    /// returns it with the prompt that hands it over.
    fn prepare(&self, target: &Target, kind: Kind, agent: &str, session: Option<&str>, head: Option<&str>) -> Result<(Request, String)> {
        let threads = match kind {
            Kind::Review => Vec::new(),
            Kind::Implement => self.comments_to_send(target, session)?,
        };
        if kind == Kind::Implement && threads.is_empty() {
            return Err("There are no comments to send".into());
        }
        let gist = match kind {
            Kind::Review => Gist { files: most_changed(target), comments: Vec::new() },
            Kind::Implement => self.gist_of(&threads)?,
        };
        let request = self.add_request(target, kind, agent, session, head, &threads)?;
        let again = kind == Kind::Review && self.previous_review(target, agent, session, request.id)?.is_some();
        let text = prompt(&request, &target.label(), &target.worktree, again, &gist);
        Ok((request, text))
    }

    /// What the comments `threads` are about: the files they're on and how each one opens.
    fn gist_of(&self, threads: &[i64]) -> Result<Gist> {
        let mut gist = Gist { files: Vec::new(), comments: Vec::new() };
        for &id in threads {
            let thread = self.thread(id)?;
            if let Some(path) = thread.path.filter(|p| !gist.files.contains(p)) {
                gist.files.push(path);
            }
            if let Some(first) = thread.messages.first() {
                gist.comments.push(opening(&first.body));
            }
        }
        Ok(gist)
    }

    /// The open comments a request to address them brings `session` (every open one for any agent):
    /// those it hasn't been asked to address, which for a session asked for the first time is all of
    /// them, even those it wrote itself (a reviewer can be asked to make the changes it suggested),
    /// and those with something new since it saw them. None once it has been sent everything, until
    /// a comment is added or the request it was sent in is stopped.
    pub fn comments_to_send(&self, target: &Target, session: Option<&str>) -> Result<Vec<i64>> {
        let open = self.unseen(target, None)?;
        let Some(session) = session else { return Ok(open) };
        let mut stmt = sql(self.conn.prepare(&format!(
            "SELECT threads FROM review_requests WHERE kind = 'implement' AND session_id = ?4 AND {ON_BRANCH}"
        )))?;
        let rows = sql(stmt.query_map(params![target.repo, target.branch, target.worktree, session], |r| r.get::<_, Option<String>>(0)))?;
        let mut sent = HashSet::new();
        for threads in sql(rows.collect::<rusqlite::Result<Vec<_>>>())? {
            sent.extend(threads.unwrap_or_default().split_whitespace().filter_map(|id| id.parse::<i64>().ok()));
        }
        let new: HashSet<i64> = self.unseen(target, Some(session))?.into_iter().collect();
        Ok(open.into_iter().filter(|id| !sent.contains(id) || new.contains(id)).collect())
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

    /// Stops waiting for request `id`, for when its agent won't say it's done. A review the agent
    /// took on counts as finished now; one it never took on is withdrawn. A request to address
    /// comments is withdrawn either way, and its comments count as unsent again: stopping it is how
    /// the same comments go out again, to the same session or another.
    pub fn stop_request(&self, id: i64) -> Result<()> {
        let request = self.request(id)?;
        if request.finished_at.is_some() {
            return Ok(());
        }
        if request.kind == Kind::Implement {
            if let Some(session) = &request.session_id {
                self.forget_seen(session, &request.threads)?;
            }
            return self.cancel_request(id);
        }
        if request.started_at.is_none() {
            return self.cancel_request(id);
        }
        sql(self.conn.execute("UPDATE review_requests SET finished_at = ?2 WHERE id = ?1", params![id, now_ms()]))?;
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

/// What a prompt says the work is about, so the agent sees at a glance what it's asked (and can
/// name its session after it).
struct Gist {
    /// The files involved, most relevant first.
    files: Vec<String>,
    /// How each comment to address opens.
    comments: Vec<String>,
}

/// The files changed on `target`'s branch, most changed first and generated ones last; none when
/// git can't tell.
fn most_changed(target: &Target) -> Vec<String> {
    let base = git::default_branch(Path::new(&target.repo));
    let Ok(mut files) = git::changed_files(Path::new(&target.worktree), base.as_deref(), Scope::All, DiffOptions::default()) else {
        return Vec::new();
    };
    files.sort_by_key(|f| (f.generated, std::cmp::Reverse(f.additions + f.deletions)));
    files.into_iter().map(|f| f.path).collect()
}

/// The first words of a comment, to quote: its first line without Markdown markers, cut short.
fn opening(body: &str) -> String {
    const MAX: usize = 50;
    let line = body.lines().map(|l| l.trim_start_matches(['#', '>', '-', '*', ' ']).trim()).find(|l| !l.is_empty()).unwrap_or_default();
    let words = line.split_whitespace().collect::<Vec<_>>().join(" ");
    if words.chars().count() <= MAX {
        return words;
    }
    let cut: String = words.chars().take(MAX).collect();
    let kept = match cut.rsplit_once(' ') {
        Some((head, _)) => head,
        None => &cut,
    };
    format!("{}…", kept.trim_end_matches([',', '.', ':', ';']))
}

/// The first `shown` of `names` and how many others there are, as prose: "a, b and 3 more".
fn some_of(names: &[String], shown: usize, others: impl Fn(usize) -> String) -> String {
    let mut parts = names[..names.len().min(shown)].to_vec();
    if names.len() > shown {
        parts.push(others(names.len() - shown));
    }
    match parts.split_last() {
        Some((last, [])) => last.clone(),
        Some((last, init)) => format!("{} and {last}", init.join(", ")),
        None => String::new(),
    }
}

/// `files` by their names alone, each once, as prose.
fn file_names(files: &[String]) -> String {
    let mut names: Vec<String> = Vec::new();
    for file in files {
        let name = Path::new(file).file_name().map_or_else(|| file.clone(), |n| n.to_string_lossy().into_owned());
        if !names.contains(&name) {
            names.push(name);
        }
    }
    some_of(&names, 3, |n| if n == 1 { "1 other file".to_string() } else { format!("{n} other files") })
}

/// The prompt that hands `request` on `branch`, in the worktree at `worktree`, to an agent. It
/// opens with what the work is about, since agents name a new session after its first message.
fn prompt(request: &Request, branch: &str, worktree: &str, again: bool, gist: &Gist) -> String {
    let guide = format!("Run `piccolo -C {} guide --request {}` and follow the steps it prints.", shell_quote(worktree), request.id);
    let task = match request.kind {
        Kind::Review => {
            let again = if again { " again, now that it has changed" } else { "" };
            let files = if gist.files.is_empty() { String::new() } else { format!(" They touch {}.", file_names(&gist.files)) };
            format!("Review the changes on {branch} for Piccolo{again}.{files}")
        }
        Kind::Implement => {
            let what = match request.threads.len() {
                1 => "a review comment".to_string(),
                n => format!("{n} review comments"),
            };
            let files = if gist.files.is_empty() { String::new() } else { format!(" in {}", file_names(&gist.files)) };
            let quotes: Vec<String> = gist.comments.iter().map(|c| format!("“{c}”")).collect();
            let quotes = if quotes.is_empty() { String::new() } else { format!(": {}", some_of(&quotes, 2, |n| format!("{n} more"))) };
            format!("Address {what} from Piccolo on {branch}{files}{quotes}.")
        }
    };
    format!("{task} The worktree is {worktree}. {guide}")
}

// ---------------------------------------------------------------------------------------------
// Tauri commands

/// The commit the worktree at `path` is at.
fn head_of(path: &str) -> Option<String> {
    git::git(Path::new(path), &["rev-parse", "HEAD"]).ok().map(|h| h.trim().to_string())
}

/// Asks the session `session` working on the worktree at `path` for `kind` of work.
async fn ask(path: String, kind: Kind, session: String) -> Result<Request> {
    blocking(move || {
        let store = Store::open()?;
        let target = Target::of(Path::new(&path))?;
        let sessions = sessions::sessions_of(&store, &path)?;
        let session = sessions.iter().find(|s| s.id == session).ok_or("That session isn't running any more")?;
        store.ask(&target, kind, session, head_of(&path).as_deref())
    })
    .await
}

/// Asks the session `session` for a review of the worktree at `path`.
#[tauri::command]
pub async fn request_review(path: String, session: String) -> Result<Request> {
    ask(path, Kind::Review, session).await
}

/// Sends the comments on the worktree at `path` that the session `session` hasn't seen to it, to
/// address.
#[tauri::command]
pub async fn send_comments(path: String, session: String) -> Result<Request> {
    ask(path, Kind::Implement, session).await
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

/// Stops waiting for request `id`, for when its agent won't say it's done.
#[tauri::command]
pub async fn stop_request(id: i64) -> Result<()> {
    blocking(move || Store::open()?.stop_request(id)).await
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
        let files = Gist { files: vec!["src/a.rs".into(), "lib/a.rs".into(), "b.ts".into(), "c.ts".into(), "d.ts".into()], comments: Vec::new() };
        let text = prompt(&again, "feat", "/wt/a b", true, &files);
        assert!(text.starts_with("Review the changes on feat for Piccolo again, now that it has changed. They touch a.rs, b.ts, c.ts and 1 other file."), "{text}");
        assert!(text.contains("`piccolo -C '/wt/a b' guide --request "), "{text}");

        // Asked to address comments: the comments are kept, and a review asked afterwards isn't
        // taken for a second one.
        let implement = store.add_request(&target, Kind::Implement, "claude", None, None, &[first, 9]).unwrap();
        assert_eq!((implement.kind, implement.threads.clone()), (Kind::Implement, vec![first, 9]));
        let gist = Gist { files: vec!["a.txt".into()], comments: vec!["Why?".into(), "Rename this".into(), "Test it".into()] };
        let text = prompt(&implement, "feat", "/wt", false, &gist);
        assert!(text.starts_with("Address 2 review comments from Piccolo on feat in a.txt: “Why?”, “Rename this” and 1 more. The worktree is /wt."), "{text}");
        assert!(text.contains("guide --request "), "{text}");
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
        assert!(text.contains(&format!("guide --request {}", copied.id)) && text.contains("They touch a.txt"), "{text}");
        assert_eq!(copied.agent, ANY_AGENT);
        let gemini = Caller { id: "gemini-1".into(), agent: "gemini".into() };
        assert_eq!(store.start_request(&target, copied.id, Some(&gemini)).unwrap().agent, "gemini");

        // Stopping a request the agent took on finishes it, so it counts as a previous review;
        // one it never took on is withdrawn.
        store.stop_request(copied.id).unwrap();
        let stopped = store.request(copied.id).unwrap();
        assert!(stopped.finished_at.is_some());
        assert_eq!(store.previous_review(&target, "gemini", Some("gemini-1"), i64::MAX).unwrap().unwrap().id, copied.id);
        store.stop_request(copied.id).unwrap();
        assert_eq!(store.request(copied.id).unwrap().finished_at, stopped.finished_at);
        let never = store.add_request(&target, Kind::Review, "codex", Some("thread-1"), None, &[]).unwrap();
        store.stop_request(never.id).unwrap();
        assert!(store.request(never.id).is_err());

        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn quotes_the_opening_of_a_comment() {
        assert_eq!(opening("\n## Why?\n\nBecause"), "Why?");
        assert_eq!(opening("> quoted  text"), "quoted text");
        assert_eq!(opening("Debounce the query before searching, or every keystroke hits the index"), "Debounce the query before searching, or every…");
        assert_eq!(some_of(&[], 2, |n| format!("{n} more")), "");
        assert_eq!(some_of(&["a".into()], 2, |n| format!("{n} more")), "a");
        assert_eq!(some_of(&["a".into(), "b".into(), "c".into()], 2, |n| format!("{n} more")), "a, b and 1 more");
    }

    #[test]
    fn comments_to_send_cover_what_a_session_was_not_asked_yet() {
        let (root, wt, mut store) = fixture("requests-send");
        let target = Target::of(&wt).unwrap();
        let range = DiffRange::resolve(&wt, Some("main"), &Scope::All).unwrap();
        let by_codex = By { session: Some("thread-1"), ..By::agent(Some("codex")) };
        let mut comment = |by: By, line| {
            let new = NewThread { by, path: "a.txt", old_path: None, range: additions(line, line), body: "Why?", images: &[] };
            store.add_thread(&target, &wt, &range, new).unwrap()
        };
        let (suggested, mine) = (comment(by_codex, 3), comment(By::REVIEWER, 4));
        let wait = || std::thread::sleep(std::time::Duration::from_millis(2));

        // Any agent gets every open comment; a reviewer not yet asked to address them gets its own
        // too, though it has seen them.
        assert_eq!(store.comments_to_send(&target, None).unwrap(), [suggested, mine]);
        assert_eq!(store.unseen(&target, Some("thread-1")).unwrap(), [mine]);
        assert_eq!(store.comments_to_send(&target, Some("thread-1")).unwrap(), [suggested, mine]);

        // Once asked, what it has seen isn't sent again: nothing is left to send.
        let asked = store.add_request(&target, Kind::Implement, "codex", Some("thread-1"), None, &[suggested, mine]).unwrap();
        wait();
        store.mark_seen("thread-1", &asked.threads).unwrap();
        assert!(store.comments_to_send(&target, Some("thread-1")).unwrap().is_empty());

        // A reply in a thread, or a new comment, even one it wrote itself, brings just that.
        wait();
        store.reply(mine, By::REVIEWER, "Still open", &[]).unwrap();
        assert_eq!(store.comments_to_send(&target, Some("thread-1")).unwrap(), [mine]);
        let new = NewThread { by: by_codex, path: "a.txt", old_path: None, range: additions(5, 5), body: "Why?", images: &[] };
        let later = store.add_thread(&target, &wt, &range, new).unwrap();
        assert_eq!(store.comments_to_send(&target, Some("thread-1")).unwrap(), [mine, later]);

        // Sending them records the request and what was seen; stopping it puts them back to unsent,
        // whether or not the agent took it on.
        wait();
        let second = store.add_request(&target, Kind::Implement, "codex", Some("thread-1"), None, &[mine, later]).unwrap();
        store.mark_seen("thread-1", &second.threads).unwrap();
        assert!(store.comments_to_send(&target, Some("thread-1")).unwrap().is_empty());
        store.stop_request(second.id).unwrap();
        assert!(store.request(second.id).is_err());
        assert_eq!(store.comments_to_send(&target, Some("thread-1")).unwrap(), [mine, later]);

        std::fs::remove_dir_all(&root).unwrap();
    }
}
