//! Agent sessions working on a worktree: those the reviewer can send comments to, and what each
//! has seen of them.
//!
//! Sessions are found two ways. Every running Claude Code session (terminal or desktop app)
//! describes itself in `~/.claude/sessions/<pid>.json`: its id, folder, title, whether it's busy,
//! and the Unix socket that is its inbox. Writing one stream-json `user` frame to that socket hands
//! the session a message, which it takes as its next turn (the same mechanism Spock uses to pair
//! sessions). The format is Claude Code's own and undocumented, and the sender gets no confirmation.
//! And any agent that runs a `piccolo` command from a session the command can name (see
//! [`Caller`]) leaves a trace, so Codex sessions, and sessions in a folder above several
//! repositories, show up too. Codex has no inbox socket: `codex queue --thread <id>` queues a
//! message for a thread, which a session that has it open takes as its next turn (as Spock sends
//! to Codex). That needs the Codex CLI, which the ChatGPT app ships even when it isn't installed.
//!
//! Comments aren't sent as a batch: they're posted for every agent to read. What's new for a
//! session is what changed in open threads since it last saw them: by listing them with `piccolo
//! comments`, by writing in them, or by being sent them to address (requests.rs).

use crate::comments::{blocking, now_ms, sql, Store, Target};
use crate::git::{self, Result};
use crate::programs;
use crate::requests::{self, Request};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::os::unix::fs::{FileTypeExt, MetadataExt};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

/// An agent session that works in, or on, a worktree.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    /// Who runs it: `claude`, `codex`, or the name another agent gave.
    pub agent: String,
    /// The session's title, as its app shows it.
    pub title: Option<String>,
    /// `busy` while a turn runs (a message waits until it ends), else `idle`; running sessions only.
    pub status: Option<String>,
    /// Whether it runs now: known for Claude Code sessions; `None` for other agents' sessions.
    pub running: Option<bool>,
    /// The folder it runs in, when running: the worktree, or a folder above it.
    pub cwd: Option<String>,
    /// Whether it runs in the worktree itself rather than above it.
    pub in_worktree: bool,
    pub started_at: Option<i64>,
    /// When it last ran a `piccolo` command on the worktree.
    pub last_seen: Option<i64>,
    /// Whether Piccolo can send it messages: a running Claude Code session has an inbox, and a
    /// Codex thread a queue when the Codex CLI is found.
    pub reachable: bool,
    #[serde(skip)]
    inbox: Option<Inbox>,
}

/// How a message reaches a session.
#[derive(Debug, Clone)]
enum Inbox {
    /// A Claude Code session's inbox socket.
    Socket(PathBuf),
    /// A Codex thread, queued with this Codex CLI.
    CodexQueue(PathBuf),
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

/// Worktrees sessions ran `piccolo` commands on, and what each session has seen of each thread.
pub(crate) const SCHEMA: &str = "
    CREATE TABLE IF NOT EXISTS session_worktrees (
        session_id TEXT NOT NULL,
        worktree TEXT NOT NULL,
        seen_at INTEGER NOT NULL,
        agent TEXT,
        PRIMARY KEY (session_id, worktree)
    );
    CREATE TABLE IF NOT EXISTS session_threads (
        session_id TEXT NOT NULL,
        thread_id INTEGER NOT NULL REFERENCES threads (id) ON DELETE CASCADE,
        seen_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, thread_id)
    );";

/// Traces older than this are forgotten; sessions rarely live that long.
const TRACE_DAYS: i64 = 30;

/// The agent session a `piccolo` command runs in, as far as its environment tells:
/// `PICCOLO_SESSION` (any agent, named by `PICCOLO_AUTHOR`), Claude Code's session id, or Codex's
/// thread id.
#[derive(Debug, Clone, PartialEq)]
pub struct Caller {
    pub id: String,
    pub agent: String,
}

impl Caller {
    pub fn from_env() -> Option<Self> {
        let var = |name: &str| std::env::var(name).ok().map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
        if let Some(id) = var("PICCOLO_SESSION") {
            let agent = var("PICCOLO_AUTHOR").map(|a| a.to_lowercase()).unwrap_or_else(|| "agent".into());
            return Some(Self { id, agent });
        }
        if let Some(id) = var("CLAUDE_CODE_SESSION_ID") {
            return Some(Self { id, agent: "claude".into() });
        }
        var("CODEX_THREAD_ID").map(|id| Self { id, agent: "codex".into() })
    }
}

/// Where Claude Code registers its sessions; `CLAUDE_CONFIG_DIR` moves it, as it does for Claude Code.
pub fn registry_dir() -> PathBuf {
    let config = std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_default().join(".claude"));
    config.join("sessions")
}

/// Codex's list of thread titles; `CODEX_HOME` moves it, as it does for Codex.
fn codex_index() -> PathBuf {
    std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_default().join(".codex"))
        .join("session_index.jsonl")
}

/// Titles of Codex threads by id, from `index` (one JSON object per line; a later line renames).
fn codex_titles(index: &Path) -> HashMap<String, String> {
    #[derive(Deserialize)]
    struct Line {
        id: String,
        thread_name: Option<String>,
    }
    let text = std::fs::read_to_string(index).unwrap_or_default();
    text.lines()
        .filter_map(|l| serde_json::from_str::<Line>(l).ok())
        .filter_map(|l| Some((l.id, l.thread_name.filter(|n| !n.trim().is_empty())?)))
        .collect()
}

/// The Codex CLI: on the user's PATH, else the copy the ChatGPT app ships and runs for its own chats.
fn codex_binary() -> Option<PathBuf> {
    programs::find("codex").or_else(|| {
        let bundled = PathBuf::from("/Applications/ChatGPT.app/Contents/Resources/codex");
        programs::is_executable(&bundled).then_some(bundled)
    })
}

/// Whether `id` looks like a Codex thread id (a UUID), so it can't pass for an option.
fn is_thread_id(id: &str) -> bool {
    id.len() == 36 && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
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

/// A session that ran `piccolo` on a worktree.
struct Trace {
    agent: Option<String>,
    seen_at: i64,
}

/// For each of `worktrees`, the sessions working on it: the running Claude Code sessions in it
/// (not in a worktree nested inside it), then those that ran `piccolo` on it (`traces`: session id
/// → canonical worktree → trace), running or not. Running ones come first, the most recently
/// started first; then the others, most recently seen first. Codex threads can be sent messages
/// with the Codex CLI at `codex`.
fn match_sessions(
    live: &[Live],
    worktrees: &[String],
    traces: &HashMap<String, HashMap<PathBuf, Trace>>,
    titles: &HashMap<String, String>,
    codex: Option<&Path>,
) -> HashMap<String, Vec<Session>> {
    let canonical_worktrees: Vec<(String, PathBuf)> =
        worktrees.iter().filter_map(|w| canonical(w).map(|c| (w.clone(), c))).collect();
    let mut matched: HashMap<String, Vec<Session>> = HashMap::new();
    for (path, worktree) in &canonical_worktrees {
        let nested = |cwd: &Path| {
            canonical_worktrees.iter().any(|(_, other)| other != worktree && other.starts_with(worktree) && cwd.starts_with(other))
        };
        let trace = |id: &str| traces.get(id).and_then(|t| t.get(worktree));
        let mut sessions: Vec<Session> = live
            .iter()
            .filter_map(|l| {
                let in_worktree = l.cwd.starts_with(worktree) && !nested(&l.cwd);
                let trace = trace(&l.entry.session_id);
                (in_worktree || trace.is_some()).then(|| Session {
                    id: l.entry.session_id.clone(),
                    agent: "claude".into(),
                    title: l.entry.name.clone().filter(|n| !n.trim().is_empty()),
                    status: l.entry.status.clone(),
                    running: Some(true),
                    cwd: Some(l.cwd.to_string_lossy().into_owned()),
                    in_worktree,
                    started_at: l.entry.started_at,
                    last_seen: trace.map(|t| t.seen_at),
                    reachable: true,
                    inbox: Some(Inbox::Socket(l.socket.clone())),
                })
            })
            .collect();
        let running: HashSet<String> = sessions.iter().map(|s| s.id.clone()).collect();
        let mut others: Vec<Session> = traces
            .iter()
            .filter(|(id, _)| !running.contains(*id))
            .filter_map(|(id, worktrees)| {
                let trace = worktrees.get(worktree)?;
                let agent = trace.agent.clone().unwrap_or_else(|| "claude".into());
                let inbox = codex.filter(|_| agent == "codex" && is_thread_id(id)).map(|c| Inbox::CodexQueue(c.to_path_buf()));
                Some(Session {
                    id: id.clone(),
                    title: titles.get(id).cloned(),
                    status: None,
                    // Claude Code registers every running session, so one missing has ended.
                    running: (agent == "claude").then_some(false),
                    agent,
                    cwd: None,
                    in_worktree: false,
                    started_at: None,
                    last_seen: Some(trace.seen_at),
                    reachable: inbox.is_some(),
                    inbox,
                })
            })
            .collect();
        if sessions.is_empty() && others.is_empty() {
            continue;
        }
        sessions.sort_by_key(|s| std::cmp::Reverse((s.in_worktree, s.started_at)));
        others.sort_by_key(|s| std::cmp::Reverse(s.last_seen));
        sessions.extend(others);
        matched.insert(path.clone(), sessions);
    }
    matched
}

/// An agent a new session can be opened for, in its desktop app.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Agent {
    Claude,
    Codex,
}

impl Agent {
    pub fn name(self) -> &'static str {
        match self {
            Agent::Claude => "claude",
            Agent::Codex => "codex",
        }
    }

    /// The desktop app its sessions open in: Claude's, or the ChatGPT app, which runs Codex.
    fn app(self) -> &'static str {
        match self {
            Agent::Claude => "Claude",
            Agent::Codex => "ChatGPT",
        }
    }

    /// Whether its app is installed, wherever Launch Services knows it from.
    fn is_installed(self) -> bool {
        Command::new("open")
            .args(["-Ra", self.app()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|s| s.success())
    }
}

/// `value` as one shell word.
pub(crate) fn shell_quote(value: &str) -> String {
    if !value.is_empty() && value.chars().all(|c| c.is_ascii_alphanumeric() || "/._-~+=:@".contains(c)) {
        value.to_string()
    } else {
        format!("'{}'", value.replace('\'', "'\\''"))
    }
}

/// Opens a new session of `agent` in its desktop app, in `worktree`, with `text` as its prompt,
/// through the apps' own links (undocumented): Claude's `claude://code/new?folder=&q=`, Codex's
/// `codex://threads/new?path=&prompt=` (in the ChatGPT app).
pub(crate) fn open_new_session(agent: Agent, worktree: &str, text: &str) -> Result<()> {
    let url = match agent {
        Agent::Claude => format!("claude://code/new?folder={}&q={}", percent_encode(worktree), percent_encode(text)),
        Agent::Codex => format!("codex://threads/new?path={}&prompt={}", percent_encode(worktree), percent_encode(text)),
    };
    let app = match agent {
        Agent::Claude => "Claude",
        Agent::Codex => "ChatGPT (for Codex)",
    };
    let status = std::process::Command::new("open")
        .arg(&url)
        .status()
        .map_err(|e| format!("Couldn't open {app}: {e}"))?;
    if !status.success() {
        return Err(format!("Couldn't open a new session: is the {app} app installed?"));
    }
    Ok(())
}

/// `value` with everything but unreserved URL characters percent-encoded.
fn percent_encode(value: &str) -> String {
    value
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// Hands `text` to `session`: as one stream-json `user` frame to a Claude Code session's inbox, or
/// queued for a Codex thread.
pub(crate) fn deliver(session: &Session, text: &str) -> Result<()> {
    match session.inbox.as_ref().ok_or("Piccolo can't send messages to that session")? {
        Inbox::Socket(socket) => write_to_socket(socket, text),
        Inbox::CodexQueue(codex) => queue_for_codex(codex, &session.id, text),
    }
}

fn write_to_socket(socket: &Path, text: &str) -> Result<()> {
    let frame = serde_json::json!({ "type": "user", "message": { "role": "user", "content": text } });
    let mut stream = UnixStream::connect(socket).map_err(|e| format!("The session isn't reachable any more ({e})"))?;
    stream.set_write_timeout(Some(Duration::from_secs(5))).map_err(|e| e.to_string())?;
    stream
        .write_all(format!("{frame}\n").as_bytes())
        .map_err(|e| format!("Couldn't send to the session ({e})"))
}

/// How long `codex queue` gets to confirm; past that, whether the message was queued is unknown.
const QUEUE_TIMEOUT: Duration = Duration::from_secs(60);

/// Queues `text` for Codex thread `thread` with the Codex CLI at `codex`.
fn queue_for_codex(codex: &Path, thread: &str, text: &str) -> Result<()> {
    let mut child = Command::new(codex)
        .args(["queue", "--thread", thread, "--message", text])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Couldn't run Codex ({}): {e}", codex.display()))?;
    let mut stderr = child.stderr.take();
    let (done, finished) = std::sync::mpsc::channel();
    let pid = child.id();
    std::thread::spawn(move || {
        let mut errors = String::new();
        if let Some(stderr) = stderr.as_mut() {
            let _ = stderr.read_to_string(&mut errors);
        }
        let _ = done.send((child.wait(), errors));
    });
    match finished.recv_timeout(QUEUE_TIMEOUT) {
        Ok((Ok(status), _)) if status.success() => Ok(()),
        Ok((Ok(_), errors)) => Err(format!("Codex couldn't queue the message: {}", errors.trim())),
        Ok((Err(e), _)) => Err(format!("Codex couldn't queue the message: {e}")),
        Err(_) => {
            unsafe { libc::kill(pid as libc::pid_t, libc::SIGKILL) };
            Err("Codex didn't confirm within a minute, so the message may or may not be queued".into())
        }
    }
}

/// Records that `session` has seen `threads` as they are at `now`.
pub(crate) fn mark_seen(conn: &Connection, session: &str, threads: &[i64], now: i64) -> Result<()> {
    for thread in threads {
        sql(conn.execute(
            "INSERT INTO session_threads (session_id, thread_id, seen_at) VALUES (?1, ?2, ?3)
             ON CONFLICT (session_id, thread_id) DO UPDATE SET seen_at = MAX(seen_at, ?3)",
            params![session, thread, now],
        ))?;
    }
    Ok(())
}

impl Store {
    /// Records that `caller` worked on `worktree` (it ran `piccolo` there).
    pub fn note_session(&self, caller: &Caller, worktree: &str) -> Result<()> {
        let now = now_ms();
        sql(self.conn.execute(
            "INSERT OR REPLACE INTO session_worktrees (session_id, worktree, seen_at, agent) VALUES (?1, ?2, ?3, ?4)",
            params![caller.id, worktree, now, caller.agent],
        ))?;
        sql(self.conn.execute("DELETE FROM session_worktrees WHERE seen_at < ?1", [now - TRACE_DAYS * 86_400_000]))?;
        Ok(())
    }

    /// The worktrees each session ran `piccolo` on, by canonical path.
    fn traces(&self) -> Result<HashMap<String, HashMap<PathBuf, Trace>>> {
        let mut stmt = sql(self.conn.prepare("SELECT session_id, worktree, agent, seen_at FROM session_worktrees"))?;
        let rows = sql(stmt.query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, Trace { agent: r.get(2)?, seen_at: r.get(3)? }))
        }))?;
        let mut traces: HashMap<String, HashMap<PathBuf, Trace>> = HashMap::new();
        for row in rows {
            let (session, worktree, trace) = sql(row)?;
            if let Some(worktree) = canonical(&worktree) {
                traces.entry(session).or_default().insert(worktree, trace);
            }
        }
        Ok(traces)
    }

    /// Records that `session` has seen `threads` as they are now.
    pub fn mark_seen(&self, session: &str, threads: &[i64]) -> Result<()> {
        mark_seen(&self.conn, session, threads, now_ms())
    }

    /// Open threads on `target`'s branch with something `session` hasn't seen: a message someone
    /// else wrote or edited after it last saw the thread. With no session, every open thread.
    pub fn unseen(&self, target: &Target, session: Option<&str>) -> Result<Vec<i64>> {
        let mut stmt = sql(self.conn.prepare(
            "SELECT t.id FROM threads t
             WHERE t.repo = ?1 AND (t.branch = ?2 OR (?2 IS NULL AND t.branch IS NULL AND t.worktree = ?3))
               AND t.resolved = 0
               AND (?4 IS NULL OR EXISTS (
                 SELECT 1 FROM messages m
                 WHERE m.thread_id = t.id AND m.session_id IS NOT ?4
                   AND COALESCE(m.edited_at, m.created_at) > COALESCE(
                     (SELECT s.seen_at FROM session_threads s WHERE s.session_id = ?4 AND s.thread_id = t.id), 0)))
             ORDER BY t.id",
        ))?;
        let rows = sql(stmt.query_map(params![target.repo, target.branch, target.worktree, session], |r| r.get(0)))?;
        sql(rows.collect())
    }

    /// Who started each open thread on `target`'s branch: the agent's name, or `None` for the
    /// reviewer.
    fn started_by(&self, target: &Target) -> Result<HashMap<i64, Option<String>>> {
        let mut stmt = sql(self.conn.prepare(
            "SELECT t.id, m.author, m.author_name FROM threads t
             JOIN messages m ON m.id = (SELECT MIN(id) FROM messages WHERE thread_id = t.id)
             WHERE t.repo = ?1 AND (t.branch = ?2 OR (?2 IS NULL AND t.branch IS NULL AND t.worktree = ?3))
               AND t.resolved = 0",
        ))?;
        let rows = sql(stmt.query_map(params![target.repo, target.branch, target.worktree], |r| {
            let (author, name): (String, Option<String>) = (r.get(1)?, r.get(2)?);
            Ok((r.get(0)?, (author == "agent").then(|| name.unwrap_or_else(|| "agent".into()))))
        }))?;
        sql(rows.collect())
    }

    /// Comments and replies each session wrote on `target`'s branch, by session id.
    fn written(&self, target: &Target) -> Result<HashMap<String, i64>> {
        let mut stmt = sql(self.conn.prepare(
            "SELECT m.session_id, COUNT(*) FROM messages m JOIN threads t ON t.id = m.thread_id
             WHERE m.session_id IS NOT NULL
               AND t.repo = ?1 AND (t.branch = ?2 OR (?2 IS NULL AND t.branch IS NULL AND t.worktree = ?3))
             GROUP BY m.session_id",
        ))?;
        let rows = sql(stmt.query_map(params![target.repo, target.branch, target.worktree], |r| Ok((r.get(0)?, r.get(1)?))))?;
        sql(rows.collect())
    }
}

/// The sessions working on each of `worktrees`, from the registry and the traces in `store`.
fn sessions_by_worktree(store: &Store, worktrees: &[String]) -> Result<HashMap<String, Vec<Session>>> {
    let codex = codex_binary();
    Ok(match_sessions(&live_sessions(&registry_dir()), worktrees, &store.traces()?, &codex_titles(&codex_index()), codex.as_deref()))
}

/// The sessions working on the worktree at `path`.
pub(crate) fn sessions_of(store: &Store, path: &str) -> Result<Vec<Session>> {
    // Its siblings too, so a session in a nested worktree isn't taken for this one's.
    let worktrees: Vec<String> = git::list_worktrees(Path::new(path))?.into_iter().map(|w| w.path).collect();
    Ok(sessions_by_worktree(store, &worktrees)?
        .into_iter()
        .find(|(w, _)| canonical(w) == canonical(path))
        .map(|(_, sessions)| sessions)
        .unwrap_or_default())
}

/// What's going on in a worktree's sessions, beyond the sessions themselves.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Activity {
    /// Open threads each session hasn't seen, by session id.
    pub unseen: HashMap<String, Vec<i64>>,
    /// All open threads, which a new session would be given.
    pub open: Vec<i64>,
    /// Who started each open thread: an agent's name, or `None` for the reviewer.
    pub started_by: HashMap<i64, Option<String>>,
    /// Comments and replies each session wrote on the branch, by session id.
    pub written: HashMap<String, i64>,
    /// Requests to agents on the branch, newest first.
    pub requests: Vec<Request>,
}

// ---------------------------------------------------------------------------------------------
// Tauri commands

/// Agents a new session can be opened for: those whose app is installed.
#[tauri::command]
pub async fn available_agents() -> Result<Vec<Agent>> {
    blocking(|| Ok([Agent::Claude, Agent::Codex].into_iter().filter(|a| a.is_installed()).collect())).await
}

/// Sessions working on each of the worktrees at `paths` (worktrees without one are left out).
#[tauri::command]
pub async fn list_sessions(paths: Vec<String>) -> Result<HashMap<String, Vec<Session>>> {
    blocking(move || sessions_by_worktree(&Store::open()?, &paths)).await
}

/// What each session on the worktree at `path` hasn't seen, and the reviews requested there.
#[tauri::command]
pub async fn session_activity(path: String) -> Result<Activity> {
    blocking(move || {
        let store = Store::open()?;
        let target = Target::of(Path::new(&path))?;
        let mut unseen = HashMap::new();
        for session in sessions_of(&store, &path)? {
            unseen.insert(session.id.clone(), store.unseen(&target, Some(&session.id))?);
        }
        Ok(Activity {
            unseen,
            open: store.unseen(&target, None)?,
            started_by: store.started_by(&target)?,
            written: store.written(&target)?,
            requests: requests::list(&store, &target)?,
        })
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::comments::tests::{additions, fixture};
    use crate::comments::{By, NewThread};
    use crate::git::{DiffRange, Scope};
    use crate::requests::{Asked, Kind};
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

    fn caller(id: &str, agent: &str) -> Caller {
        Caller { id: id.into(), agent: agent.into() }
    }

    #[test]
    fn finds_sessions_in_a_worktree_or_that_worked_on_it() {
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
        let titles = HashMap::from([("codex-1".to_string(), "Review the parser".to_string())]);

        let found = |store: &Store| match_sessions(&live_sessions(&registry), &worktrees, &store.traces().unwrap(), &titles, None);
        let ids = |store: &Store, worktree: &str| -> Vec<String> {
            found(store).get(worktree).map(|s| s.iter().map(|s| s.id.clone()).collect()).unwrap_or_default()
        };
        // A session in a folder above only counts once it ran `piccolo` on the worktree.
        assert_eq!(ids(&store, &worktrees[1]), ["here"]);
        assert_eq!(ids(&store, &worktrees[0]), ["main"]);
        let worktree = Target::of(&wt).unwrap().worktree;
        store.note_session(&caller("above", "claude"), &worktree).unwrap();
        assert_eq!(ids(&store, &worktrees[1]), ["here", "above"]);
        assert_eq!(ids(&store, &worktrees[0]), ["main"]);
        let sessions = &found(&store)[&worktrees[1]];
        assert_eq!((sessions[0].title.as_deref(), sessions[0].in_worktree), (Some("Session here"), true));
        assert!(!sessions[1].in_worktree && sessions[1].reachable && sessions[1].last_seen.is_some());

        // Sessions that aren't running are listed after those that are: a Claude Code session
        // that ended, and a Codex one, which may or may not run.
        store.note_session(&caller("gone", "claude"), &worktree).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(2));
        store.note_session(&caller("codex-1", "codex"), &worktree).unwrap();
        assert_eq!(ids(&store, &worktrees[1]), ["here", "above", "codex-1", "gone"]);
        let sessions = &found(&store)[&worktrees[1]];
        assert_eq!((sessions[2].agent.as_str(), sessions[2].running, sessions[2].title.as_deref()), ("codex", None, Some("Review the parser")));
        assert_eq!((sessions[3].running, sessions[3].reachable), (Some(false), false));

        for id in ["here", "above", "main"] {
            let _ = std::fs::remove_file(format!("/tmp/review-test-{}-{id}.sock", std::process::id()));
        }
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn queues_messages_for_codex_threads() {
        let (root, wt, mut store) = fixture("sessions-codex");
        let target = Target::of(&wt).unwrap();
        // A stand-in for the Codex CLI that records what it was asked, and fails for one thread.
        let codex = root.join("codex");
        let log = root.join("queued.txt");
        std::fs::write(
            &codex,
            format!(
                "#!/bin/sh\ncase \"$3\" in 00000000-*) echo 'no such thread' >&2; exit 1;; esac\nprintf '%s\\n' \"$@\" >> '{}'\n",
                log.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&codex, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
        let thread = "019a1b2c-3d4e-7f80-9a1b-2c3d4e5f6a7b";
        let worktree = target.worktree.clone();
        store.note_session(&caller(thread, "codex"), &worktree).unwrap();
        store.note_session(&caller("not-a-thread", "codex"), &worktree).unwrap();
        store.note_session(&caller("00000000-0000-0000-0000-000000000000", "codex"), &worktree).unwrap();
        let sessions = |codex: Option<&Path>| {
            match_sessions(&[], std::slice::from_ref(&worktree), &store.traces().unwrap(), &HashMap::new(), codex).remove(&worktree).unwrap()
        };

        // Without the Codex CLI, or with an id that isn't a thread's, there's no way to send.
        assert!(sessions(None).iter().all(|s| !s.reachable));
        let found = sessions(Some(&codex));
        let reachable: Vec<&str> = found.iter().filter(|s| s.reachable).map(|s| s.id.as_str()).collect();
        assert_eq!(reachable.len(), 2);
        assert!(reachable.contains(&thread));

        let range = DiffRange::resolve(&wt, Some("main"), &Scope::All).unwrap();
        let new = NewThread { by: By::REVIEWER, path: "a.txt", old_path: None, range: additions(3, 3), body: "x", images: &[] };
        let id = store.add_thread(&target, &wt, &range, new).unwrap();
        let session = found.iter().find(|s| s.id == thread).unwrap();
        let send = |store: &Store, session| store.ask(&target, Kind::Implement, Asked::Session(session), None);
        assert_eq!(send(&store, session).unwrap().threads, [id]);
        let queued = std::fs::read_to_string(&log).unwrap();
        assert!(queued.starts_with(&format!("queue\n--thread\n{thread}\n--message\n")), "{queued}");
        assert!(queued.contains("guide --request "), "{queued}");
        assert!(store.unseen(&target, Some(thread)).unwrap().is_empty());

        // A failure says why, and leaves the comment unseen.
        let failing = found.iter().find(|s| s.id.starts_with("00000000")).unwrap();
        let error = send(&store, failing).unwrap_err();
        assert!(error.contains("no such thread"), "{error}");
        assert_eq!(store.unseen(&target, Some(&failing.id)).unwrap(), [id]);

        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn reads_codex_titles() {
        let dir = std::env::temp_dir().join(format!("piccolo-codex-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let index = dir.join("session_index.jsonl");
        std::fs::write(&index, "{\"id\":\"a\",\"thread_name\":\"First\"}\nnot json\n{\"id\":\"a\",\"thread_name\":\"Renamed\"}\n{\"id\":\"b\",\"thread_name\":\" \"}\n").unwrap();
        assert_eq!(codex_titles(&index), HashMap::from([("a".to_string(), "Renamed".to_string())]));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn tracks_what_each_session_has_seen() {
        let (root, wt, mut store) = fixture("sessions-seen");
        let target = Target::of(&wt).unwrap();
        let range = DiffRange::resolve(&wt, Some("main"), &Scope::All).unwrap();
        let mut comment = |by: By, line| {
            let new = NewThread { by, path: "a.txt", old_path: None, range: additions(line, line), body: "x", images: &[] };
            store.add_thread(&target, &wt, &range, new).unwrap()
        };
        let codex = By { session: Some("codex-1"), ..By::agent(Some("codex")) };
        let claude = By { session: Some("claude-1"), ..By::agent(Some("claude")) };
        let (mine, codexs) = (comment(By::REVIEWER, 3), comment(codex, 4));
        let unseen = |store: &Store, session| store.unseen(&target, session).unwrap();
        let wait = || std::thread::sleep(std::time::Duration::from_millis(2));

        // Everything's new to Claude; Codex wrote its own comment.
        assert_eq!(unseen(&store, Some("claude-1")), [mine, codexs]);
        assert_eq!(unseen(&store, Some("codex-1")), [mine]);
        assert_eq!(unseen(&store, None), [mine, codexs]);
        let started_by = store.started_by(&target).unwrap();
        assert_eq!((&started_by[&mine], started_by[&codexs].as_deref()), (&None, Some("codex")));

        // Seen by listing them, or by answering.
        store.mark_seen("claude-1", &[mine]).unwrap();
        wait();
        store.reply(codexs, claude, "Fixed", &[]).unwrap();
        assert!(unseen(&store, Some("claude-1")).is_empty());
        assert_eq!(unseen(&store, Some("codex-1")), [mine, codexs]);

        // New again when someone else writes or edits; closed threads drop out.
        wait();
        store.reply(mine, By::REVIEWER, "And the other one", &[]).unwrap();
        assert_eq!(unseen(&store, Some("claude-1")), [mine]);
        store.mark_seen("claude-1", &[mine]).unwrap();
        wait();
        let first = store.thread(mine).unwrap().messages[0].id;
        store.edit_message(first, "y", &[]).unwrap();
        assert_eq!(unseen(&store, Some("claude-1")), [mine]);
        store.set_dismissed(mine, true).unwrap();
        assert!(unseen(&store, Some("claude-1")).is_empty());
        assert_eq!(unseen(&store, None), [codexs]);

        // What each session wrote counts, closed threads too; the reviewer has no session.
        let written = store.written(&target).unwrap();
        assert_eq!((written.len(), written["codex-1"], written["claude-1"]), (2, 1, 1));

        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn sends_unseen_comments_to_a_session_inbox() {
        let (root, wt, mut store) = fixture("sessions-send");
        let registry = root.join("registry");
        std::fs::create_dir_all(&registry).unwrap();
        let listener = register(&registry, "s1", &wt, 1);
        let target = Target::of(&wt).unwrap();
        let sessions = match_sessions(&live_sessions(&registry), std::slice::from_ref(&target.worktree), &HashMap::new(), &HashMap::new(), None)
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

        // What it hasn't seen, as a request to address them; then nothing's left to send.
        let session = &sessions[0];
        let send = |store: &Store| store.ask(&target, Kind::Implement, Asked::Session(session), None);
        let request = send(&store).unwrap();
        assert_eq!((request.kind, request.threads.clone(), request.session_id.as_deref()), (Kind::Implement, vec![first, second], Some("s1")));
        let text = received();
        assert!(text.contains(&format!("review comments from Piccolo to address: #{first}, #{second}")), "{text}");
        assert!(text.contains(&format!("piccolo -C {} guide --request {}", target.worktree, request.id)), "{text}");
        assert!(send(&store).is_err());
        assert_eq!(percent_encode("a b/é&q=1"), "a%20b%2F%C3%A9%26q%3D1");

        // Nothing is counted as seen when the session can't be reached.
        std::thread::sleep(std::time::Duration::from_millis(2));
        store.reply(first, By::REVIEWER, "Not quite", &[]).unwrap();
        drop(listener);
        std::fs::remove_file(format!("/tmp/review-test-{}-s1.sock", std::process::id())).unwrap();
        assert!(send(&store).is_err());
        assert_eq!(store.unseen(&target, Some("s1")).unwrap(), [first]);
        // The failed request isn't kept.
        assert_eq!(crate::requests::list(&store, &target).unwrap().len(), 1);

        std::fs::remove_dir_all(&root).unwrap();
    }
}
