//! Claude Code sessions the reviewer can send comments to.
//!
//! Every running Claude Code session (terminal or desktop app) describes itself in
//! `~/.claude/sessions/<pid>.json`: its id, folder, title, whether it's busy, and the Unix socket
//! that is its inbox. Writing one stream-json `user` frame to that socket hands the session a
//! message, which it takes as its next turn (the same mechanism Spock uses to pair sessions).
//! The format is Claude Code's own and undocumented, and the sender gets no confirmation.
//!
//! A session belongs to a worktree when it runs in it, or when it has run a `review` command on
//! it (which records a trace, see `note_session`): sessions often run in a folder above several
//! repositories and work on whichever one a task needs.

use crate::comments::{now_ms, sql, Store, Target};
use crate::git::{self, Result};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::os::unix::fs::{FileTypeExt, MetadataExt};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// A Claude Code session that works in, or above, a worktree.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    /// Who runs it; only `claude` so far.
    pub agent: String,
    /// The session's title, as Claude Code shows it in its sidebar.
    pub title: Option<String>,
    /// `busy` while a turn runs (a message waits until it ends), else `idle`.
    pub status: Option<String>,
    /// The folder it runs in: the worktree, or a folder above it holding several repositories.
    pub cwd: String,
    /// Whether it runs in the worktree itself rather than above it.
    pub in_worktree: bool,
    pub started_at: i64,
    #[serde(skip)]
    socket: PathBuf,
}

/// A session's file in the registry, as far as it's used here.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    pid: i64,
    session_id: String,
    cwd: String,
    kind: Option<String>,
    name: Option<String>,
    status: Option<String>,
    started_at: Option<i64>,
    messaging_socket_path: Option<String>,
}

/// Worktrees sessions ran `review` commands on, by Claude Code session id.
pub(crate) const SCHEMA: &str = "
    CREATE TABLE IF NOT EXISTS session_worktrees (
        session_id TEXT NOT NULL,
        worktree TEXT NOT NULL,
        seen_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, worktree)
    );";

/// Traces older than this are forgotten; sessions rarely live that long.
const TRACE_DAYS: i64 = 30;

/// Where Claude Code registers its sessions; `CLAUDE_CONFIG_DIR` moves it, as it does for Claude Code.
pub fn registry_dir() -> PathBuf {
    let config = std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_default().join(".claude"));
    config.join("sessions")
}

/// Whether the process `pid` still runs: a session that crashed leaves its file behind.
fn is_alive(pid: i64) -> bool {
    let Ok(pid) = libc::pid_t::try_from(pid) else { return false };
    // Signal 0 only checks; EPERM means it exists but belongs to someone else.
    let exists = unsafe { libc::kill(pid, 0) } == 0;
    exists || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// Whether `path` is a socket owned by the current user, as an inbox must be.
fn is_own_socket(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_socket() && m.uid() == unsafe { libc::getuid() })
}

fn canonical(path: &str) -> Option<PathBuf> {
    Path::new(path).canonicalize().ok()
}

/// A running session as the registry describes it.
struct Live {
    entry: Entry,
    cwd: PathBuf,
    socket: PathBuf,
}

/// The interactive sessions in `registry` that still run; headless ones (`claude -p`, SDK hosts)
/// aren't someone's session to talk to, and a crashed session leaves its file behind.
fn live_sessions(registry: &Path) -> Vec<Live> {
    let mut live = Vec::new();
    for file in std::fs::read_dir(registry).into_iter().flatten().flatten() {
        let path = file.path();
        if path.extension().is_none_or(|e| e != "json") {
            continue;
        }
        let Some(entry) = std::fs::read_to_string(&path).ok().and_then(|t| serde_json::from_str::<Entry>(&t).ok()) else {
            continue;
        };
        let (Some(cwd), Some(socket)) = (canonical(&entry.cwd), entry.messaging_socket_path.clone().map(PathBuf::from)) else {
            continue;
        };
        if entry.kind.as_deref().is_some_and(|k| k != "interactive") || !is_alive(entry.pid) || !is_own_socket(&socket) {
            continue;
        }
        live.push(Live { entry, cwd, socket });
    }
    live
}

/// For each of `worktrees`, the sessions of `live` working on it: those running in it (not in a
/// worktree nested inside it), then those that ran `review` on it (`traces`: session id →
/// worktrees) from elsewhere; each group most recently started first.
fn match_sessions(live: &[Live], worktrees: &[String], traces: &HashMap<String, HashSet<PathBuf>>) -> HashMap<String, Vec<Session>> {
    let canonical_worktrees: Vec<(String, PathBuf)> =
        worktrees.iter().filter_map(|w| canonical(w).map(|c| (w.clone(), c))).collect();
    let mut matched: HashMap<String, Vec<Session>> = HashMap::new();
    for (path, worktree) in &canonical_worktrees {
        let nested = |cwd: &Path| {
            canonical_worktrees.iter().any(|(_, other)| other != worktree && other.starts_with(worktree) && cwd.starts_with(other))
        };
        let mut sessions: Vec<Session> = live
            .iter()
            .filter_map(|l| {
                let in_worktree = l.cwd.starts_with(worktree) && !nested(&l.cwd);
                let traced = traces.get(&l.entry.session_id).is_some_and(|t| t.contains(worktree));
                (in_worktree || traced).then(|| Session {
                    id: l.entry.session_id.clone(),
                    agent: "claude".into(),
                    title: l.entry.name.clone().filter(|n| !n.trim().is_empty()),
                    status: l.entry.status.clone(),
                    cwd: l.cwd.to_string_lossy().into_owned(),
                    in_worktree,
                    started_at: l.entry.started_at.unwrap_or_default(),
                    socket: l.socket.clone(),
                })
            })
            .collect();
        if sessions.is_empty() {
            continue;
        }
        sessions.sort_by_key(|s| std::cmp::Reverse((s.in_worktree, s.started_at)));
        matched.insert(path.clone(), sessions);
    }
    matched
}

/// The message a session gets for `threads` on the worktree at `worktree`.
fn message(worktree: &str, threads: &[i64]) -> String {
    let ids: Vec<String> = threads.iter().map(i64::to_string).collect();
    let hashes: Vec<String> = threads.iter().map(|id| format!("#{id}")).collect();
    let what = if threads.len() == 1 { "a review comment" } else { "review comments" };
    let quoted = if worktree.chars().all(|c| c.is_ascii_alphanumeric() || "/._-~+=:@".contains(c)) {
        worktree.to_string()
    } else {
        format!("'{}'", worktree.replace('\'', "'\\''"))
    };
    format!(
        "The reviewer sent you {what} from the Review app: {}, on the worktree {worktree}. Address them with the \
         local-review skill: `review -C {quoted} comments {}` lists them, and `review -C {quoted} reply <id> \"...\"` \
         answers one.",
        hashes.join(", "),
        ids.join(" "),
    )
}

/// Hands `text` to the session listening on `socket`, as one stream-json `user` frame.
fn deliver(socket: &Path, text: &str) -> Result<()> {
    let frame = serde_json::json!({ "type": "user", "message": { "role": "user", "content": text } });
    let mut stream = UnixStream::connect(socket).map_err(|e| format!("The session isn't reachable any more ({e})"))?;
    stream.set_write_timeout(Some(Duration::from_secs(5))).map_err(|e| e.to_string())?;
    stream
        .write_all(format!("{frame}\n").as_bytes())
        .map_err(|e| format!("Couldn't send to the session ({e})"))
}

impl Store {
    /// Records that Claude Code session `session` worked on `worktree` (it ran `review` there).
    pub fn note_session(&self, session: &str, worktree: &str) -> Result<()> {
        let now = now_ms();
        sql(self.conn.execute(
            "INSERT OR REPLACE INTO session_worktrees (session_id, worktree, seen_at) VALUES (?1, ?2, ?3)",
            params![session, worktree, now],
        ))?;
        sql(self.conn.execute("DELETE FROM session_worktrees WHERE seen_at < ?1", [now - TRACE_DAYS * 86_400_000]))?;
        Ok(())
    }

    /// The worktrees each session ran `review` on, as canonical paths.
    fn traces(&self) -> Result<HashMap<String, HashSet<PathBuf>>> {
        let mut stmt = sql(self.conn.prepare("SELECT session_id, worktree FROM session_worktrees"))?;
        let rows = sql(stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))))?;
        let mut traces: HashMap<String, HashSet<PathBuf>> = HashMap::new();
        for row in rows {
            let (session, worktree) = sql(row)?;
            if let Some(worktree) = canonical(&worktree) {
                traces.entry(session).or_default().insert(worktree);
            }
        }
        Ok(traces)
    }

    /// Sends `target`'s pending threads (or those of `only` that are pending) to session `session`,
    /// one of `sessions`, and marks them sent. Returns the threads sent.
    fn send(&mut self, sessions: &[Session], session: &str, target: &Target, only: Option<&[i64]>) -> Result<Vec<i64>> {
        let session = sessions.iter().find(|s| s.id == session).ok_or("That session isn't running any more")?;
        let threads: Vec<_> = self
            .threads(target, false)?
            .into_iter()
            .filter(|t| t.pending && only.is_none_or(|ids| ids.contains(&t.id)))
            .collect();
        if threads.is_empty() {
            return Err("There are no comments to send".into());
        }
        let ids: Vec<i64> = threads.iter().map(|t| t.id).collect();
        deliver(&session.socket, &message(&target.worktree, &ids))?;
        let now = now_ms();
        let tx = sql(self.conn.transaction())?;
        for thread in &threads {
            if let Some(message) = thread.messages.last() {
                sql(tx.execute("UPDATE messages SET sent_at = ?2 WHERE id = ?1", params![message.id, now]))?;
            }
        }
        sql(tx.commit())?;
        Ok(ids)
    }
}

/// The sessions working on each of `worktrees`, from the registry and the traces in `store`.
fn sessions_by_worktree(store: &Store, worktrees: &[String]) -> Result<HashMap<String, Vec<Session>>> {
    Ok(match_sessions(&live_sessions(&registry_dir()), worktrees, &store.traces()?))
}

// ---------------------------------------------------------------------------------------------
// Tauri commands

/// Claude Code sessions working on each of the worktrees at `paths` (worktrees without one are left out).
#[tauri::command]
pub async fn list_sessions(paths: Vec<String>) -> Result<HashMap<String, Vec<Session>>> {
    tauri::async_runtime::spawn_blocking(move || sessions_by_worktree(&Store::open()?, &paths))
        .await
        .map_err(|e| e.to_string())?
}

/// Sends the worktree's pending comments, or `threads` of them, to session `session`.
#[tauri::command]
pub async fn send_comments(path: String, session: String, threads: Option<Vec<i64>>) -> Result<Vec<i64>> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut store = Store::open()?;
        // Its siblings too, so a session in a nested worktree isn't taken for this one's.
        let worktrees: Vec<String> = git::list_worktrees(Path::new(&path))?.into_iter().map(|w| w.path).collect();
        let sessions = sessions_by_worktree(&store, &worktrees)?
            .into_iter()
            .find(|(w, _)| canonical(w) == canonical(&path))
            .map(|(_, sessions)| sessions)
            .unwrap_or_default();
        let target = Target::of(Path::new(&path))?;
        store.send(&sessions, &session, &target, threads.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::comments::tests::{additions, fixture};
    use crate::comments::{Author, By, NewThread};
    use crate::git::{DiffRange, Scope};
    use std::io::{BufRead, BufReader};
    use std::os::unix::net::UnixListener;

    /// Registers a session running in `cwd`, with an inbox socket the test listens on.
    fn register(registry: &Path, id: &str, cwd: &Path, started_at: i64) -> UnixListener {
        std::fs::create_dir_all(cwd).unwrap();
        // Socket paths must stay short (104 bytes on macOS), shorter than the test's temp folder.
        let socket = PathBuf::from(format!("/tmp/review-test-{}-{id}.sock", std::process::id()));
        let _ = std::fs::remove_file(&socket);
        let listener = UnixListener::bind(&socket).unwrap();
        let entry = serde_json::json!({
            "pid": std::process::id(), "sessionId": id, "cwd": cwd, "kind": "interactive",
            "name": format!("Session {id}"), "status": "idle", "startedAt": started_at,
            "messagingSocketPath": socket,
        });
        std::fs::write(registry.join(format!("{id}.json")), entry.to_string()).unwrap();
        listener
    }

    #[test]
    fn finds_sessions_in_a_worktree_or_that_reviewed_it() {
        let (root, wt, store) = fixture("sessions-find");
        let registry = root.join("registry");
        std::fs::create_dir_all(&registry).unwrap();
        let repo = root.join("repo");
        let worktrees = [repo.to_string_lossy().into_owned(), wt.to_string_lossy().into_owned()];
        let _here = register(&registry, "here", &wt.join("src"), 1);
        let _above = register(&registry, "above", &root, 2);
        let _main = register(&registry, "main", &repo, 3);
        // A session whose process ended is left out.
        let gone = serde_json::json!({"pid": 999_999, "sessionId": "gone", "cwd": wt, "messagingSocketPath": "/nope"});
        std::fs::write(registry.join("gone.json"), gone.to_string()).unwrap();

        let found = |store: &Store| match_sessions(&live_sessions(&registry), &worktrees, &store.traces().unwrap());
        let ids = |store: &Store, worktree: &str| -> Vec<String> {
            found(store).get(worktree).map(|s| s.iter().map(|s| s.id.clone()).collect()).unwrap_or_default()
        };
        // A session in a folder above only counts once it ran `review` on the worktree.
        assert_eq!(ids(&store, &worktrees[1]), ["here"]);
        assert_eq!(ids(&store, &worktrees[0]), ["main"]);
        store.note_session("above", &Target::of(&wt).unwrap().worktree).unwrap();
        assert_eq!(ids(&store, &worktrees[1]), ["here", "above"]);
        assert_eq!(ids(&store, &worktrees[0]), ["main"]);
        let sessions = &found(&store)[&worktrees[1]];
        assert_eq!((sessions[0].title.as_deref(), sessions[0].in_worktree), (Some("Session here"), true));
        assert!(!sessions[1].in_worktree);

        for id in ["here", "above", "main"] {
            let _ = std::fs::remove_file(format!("/tmp/review-test-{}-{id}.sock", std::process::id()));
        }
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn sends_pending_comments_to_a_session_inbox() {
        let (root, wt, mut store) = fixture("sessions-send");
        let registry = root.join("registry");
        std::fs::create_dir_all(&registry).unwrap();
        let listener = register(&registry, "s1", &wt, 1);
        let target = Target::of(&wt).unwrap();
        let sessions = match_sessions(&live_sessions(&registry), std::slice::from_ref(&target.worktree), &HashMap::new())
            .remove(&target.worktree)
            .unwrap();
        let range = DiffRange::resolve(&wt, Some("main"), &Scope::All).unwrap();
        let mut comment = |line| {
            let new = NewThread { by: By::REVIEWER, path: "a.txt", old_path: None, range: additions(line, line), body: "x", images: &[] };
            store.add_thread(&target, &wt, &range, new).unwrap()
        };
        let (first, second) = (comment(3), comment(4));
        let received = || {
            let (stream, _) = listener.accept().unwrap();
            let mut line = String::new();
            BufReader::new(stream).read_line(&mut line).unwrap();
            let frame: serde_json::Value = serde_json::from_str(&line).unwrap();
            assert_eq!((frame["type"].as_str(), frame["message"]["role"].as_str()), (Some("user"), Some("user")));
            frame["message"]["content"].as_str().unwrap().to_string()
        };

        // One comment, then the rest.
        assert_eq!(store.send(&sessions, "s1", &target, Some(&[second])).unwrap(), [second]);
        let text = received();
        assert!(text.contains(&format!("a review comment from the Review app: #{second}")), "{text}");
        assert!(text.contains(&format!("review -C {} comments {second}", target.worktree)), "{text}");
        assert_eq!(store.send(&sessions, "s1", &target, None).unwrap(), [first]);
        assert!(received().contains(&format!("#{first}")));
        assert!(store.send(&sessions, "s1", &target, None).is_err());
        assert!(store.send(&sessions, "other", &target, None).is_err());

        // An agent's reply settles a thread; the reviewer answering, or editing, makes it pending again.
        store.reply(first, By { author: Author::Agent, name: Some("claude") }, "Done", &[]).unwrap();
        assert!(!store.thread(first).unwrap().pending);
        store.reply(first, By::REVIEWER, "Not quite", &[]).unwrap();
        assert!(store.thread(first).unwrap().pending);
        let sent = store.thread(second).unwrap().messages[0].id;
        assert!(!store.thread(second).unwrap().pending);
        store.edit_message(sent, "y", &[]).unwrap();
        assert!(store.thread(second).unwrap().pending);

        // Nothing is marked sent when the session can't be reached.
        drop(listener);
        std::fs::remove_file(format!("/tmp/review-test-{}-s1.sock", std::process::id())).unwrap();
        assert!(store.send(&sessions, "s1", &target, None).is_err());
        assert!(store.thread(first).unwrap().pending);

        std::fs::remove_dir_all(&root).unwrap();
    }
}
