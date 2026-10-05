//! Review comments. They live in a SQLite database shared by the app and the `piccolo` command, so
//! an agent working in a worktree can read and answer the comments on its branch.
//!
//! A thread is anchored to lines on one side of a diff. It keeps the text of those lines, so it can
//! follow them when the file is edited above them, and a snapshot of the diff around them, so it
//! still makes sense once the code has changed. A general thread has no lines: it's about the
//! branch as a whole, like the text of a review on GitHub.

use crate::git::{self, DiffLine, DiffRange, LineKind, Result, Scope};
use crate::{requests, sessions};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// Must match `identifier` in tauri.conf.json: the database sits in the app's data folder.
const APP_IDENTIFIER: &str = "dev.jb.piccolo";
const DB_FILE: &str = "comments.db";
/// Pasted images are saved as `<id>.png` in this folder next to the database.
const IMAGES_DIR: &str = "attachments";
/// A pasted image is a PNG the app already scaled down; this only guards against nonsense.
const MAX_IMAGE_BYTES: usize = 25 * 1024 * 1024;
const PNG_SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";
/// Unchanged lines shown around the commented ones in a thread's snapshot.
const EXCERPT_CONTEXT: usize = 3;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum Side {
    /// The old version: removed lines and unchanged ones.
    Deletions,
    /// The new version: added lines and unchanged ones.
    Additions,
}

impl Side {
    fn as_str(self) -> &'static str {
        match self {
            Side::Deletions => "deletions",
            Side::Additions => "additions",
        }
    }

    fn parse(s: &str) -> Self {
        if s == "deletions" {
            Side::Deletions
        } else {
            Side::Additions
        }
    }

    fn line_of(self, row: &DiffLine) -> Option<u32> {
        match self {
            Side::Deletions => row.old,
            Side::Additions => row.new,
        }
    }
}

/// Commented lines. In a unified diff a range can start on removed lines and end on added ones.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LineRange {
    pub start_side: Side,
    pub start_line: u32,
    pub end_side: Side,
    pub end_line: u32,
}

impl LineRange {
    fn shifted(self, delta: i64) -> Self {
        let shift = |line: u32| (i64::from(line) + delta).max(1) as u32;
        Self {
            // The start moves with the end only when both are on the same version of the file.
            start_line: if self.start_side == self.end_side { shift(self.start_line) } else { self.start_line },
            end_line: shift(self.end_line),
            ..self
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExcerptRow {
    pub kind: LineKind,
    pub old: Option<u32>,
    pub new: Option<u32>,
    pub text: String,
    pub commented: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Author {
    Reviewer,
    Agent,
}

/// Who writes a message: the reviewer, or an agent, under the name it gives (`codex`, `claude`),
/// from its session when the `piccolo` command could tell which one.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct By<'a> {
    pub author: Author,
    pub name: Option<&'a str>,
    pub session: Option<&'a str>,
}

impl<'a> By<'a> {
    pub const REVIEWER: By<'static> = By { author: Author::Reviewer, name: None, session: None };

    #[cfg(test)]
    pub fn agent(name: Option<&'a str>) -> Self {
        By { author: Author::Agent, name, session: None }
    }
}

/// An image pasted into a message, saved as a file the agent can open.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    pub id: i64,
    pub width: u32,
    pub height: u32,
    pub path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub id: i64,
    pub author: Author,
    /// The agent's name, when it gave one.
    pub author_name: Option<String>,
    pub body: String,
    pub attachments: Vec<Attachment>,
    pub created_at: i64,
    /// When the text was last changed, if it was.
    pub edited_at: Option<i64>,
    /// The reviewer gave an agent's message a thumbs up.
    pub thumbs_up: bool,
}

/// A PNG to attach to a new message.
pub struct NewImage {
    pub width: u32,
    pub height: u32,
    pub data: Vec<u8>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Thread {
    pub id: i64,
    /// The commented file; `None` for a general comment, which is about the whole branch.
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
    /// Where the comment was made; `None` for a general comment.
    pub range: Option<LineRange>,
    /// Where those lines are now; `None` when they changed (the thread is outdated), or for a
    /// general comment.
    pub position: Option<LineRange>,
    /// Closed: resolved, or dismissed.
    pub resolved: bool,
    /// Closed as not worth acting on, so it stays on record (`resolved` is set too, which keeps it
    /// out of everything open) and an agent reviewing again doesn't raise it twice.
    pub dismissed: bool,
    /// The diff around the commented lines when the comment was made.
    pub excerpt: Vec<ExcerptRow>,
    pub messages: Vec<Message>,
    pub created_at: i64,
    pub updated_at: i64,
    /// First line number and text of the commented lines on the end side, for relocating them.
    #[serde(skip)]
    anchor_start: u32,
    #[serde(skip)]
    anchor_lines: Vec<String>,
}

/// The branch a set of comments belongs to. Comments follow the branch, so they survive the
/// worktree being removed; with a detached HEAD they belong to the worktree instead.
#[derive(Debug, Clone)]
pub struct Target {
    /// The repository's main worktree, as the app identifies repositories.
    pub repo: String,
    pub branch: Option<String>,
    pub worktree: String,
}

impl Target {
    /// The target for the worktree containing `path`.
    pub fn of(path: &Path) -> Result<Self> {
        let worktree = git::git(path, &["rev-parse", "--show-toplevel"])?.trim().to_string();
        let repo = git::list_worktrees(path)?
            .into_iter()
            .next()
            .map(|e| e.path)
            .ok_or("No worktrees found")?;
        let branch = git::git(path, &["symbolic-ref", "--quiet", "--short", "HEAD"])
            .ok()
            .map(|s| s.trim().to_string());
        Ok(Self { repo, branch, worktree })
    }

    pub fn label(&self) -> String {
        self.branch.clone().unwrap_or_else(|| format!("detached HEAD in {}", self.worktree))
    }
}

pub struct NewThread<'a> {
    pub by: By<'a>,
    pub path: &'a str,
    pub old_path: Option<&'a str>,
    pub range: LineRange,
    pub body: &'a str,
    pub images: &'a [NewImage],
}

pub(crate) fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}

pub(crate) fn sql<T>(result: rusqlite::Result<T>) -> Result<T> {
    result.map_err(|e| format!("comments database: {e}"))
}

pub fn db_path() -> PathBuf {
    if let Some(path) = std::env::var_os("PICCOLO_DB") {
        return PathBuf::from(path);
    }
    app_data_dir().join(DB_FILE)
}

/// Where the app keeps its data: the comments and its settings. `PICCOLO_DATA_DIR` moves it, to
/// try the `piccolo` command without touching the real data.
pub fn app_data_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("PICCOLO_DATA_DIR") {
        return PathBuf::from(dir);
    }
    dirs::data_dir().unwrap_or_else(std::env::temp_dir).join(APP_IDENTIFIER)
}

pub struct Store {
    /// Shared with sessions.rs and requests.rs: sessions leave traces and see comments, and
    /// reviews are requested and finished.
    pub(crate) conn: Connection,
    images_dir: PathBuf,
}

impl Store {
    pub fn open() -> Result<Self> {
        Self::open_at(&db_path())
    }

    pub fn open_at(path: &Path) -> Result<Self> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        }
        let conn = sql(Connection::open(path))?;
        // The app and `piccolo` processes can write at the same time. The default rollback journal
        // (not WAL) keeps reads from touching the disk, so the app's file watcher only sees writes.
        sql(conn.busy_timeout(std::time::Duration::from_secs(5)))?;
        sql(conn.pragma_update(None, "foreign_keys", true))?;
        // General threads are stored with an empty path and no anchor (lines 0, no anchor lines).
        sql(conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS threads (
                id INTEGER PRIMARY KEY,
                repo TEXT NOT NULL,
                branch TEXT,
                worktree TEXT NOT NULL,
                path TEXT NOT NULL,
                old_path TEXT,
                start_side TEXT NOT NULL,
                start_line INTEGER NOT NULL,
                end_side TEXT NOT NULL,
                end_line INTEGER NOT NULL,
                anchor_start INTEGER NOT NULL,
                anchor_lines TEXT NOT NULL,
                excerpt TEXT NOT NULL,
                resolved INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS threads_by_branch ON threads (repo, branch);
            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY,
                thread_id INTEGER NOT NULL REFERENCES threads (id) ON DELETE CASCADE,
                author TEXT NOT NULL,
                body TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS messages_by_thread ON messages (thread_id);
            CREATE TABLE IF NOT EXISTS attachments (
                id INTEGER PRIMARY KEY,
                message_id INTEGER NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
                width INTEGER NOT NULL,
                height INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS attachments_by_message ON attachments (message_id);",
        ))?;
        sql(conn.execute_batch(sessions::SCHEMA))?;
        sql(conn.execute_batch(requests::SCHEMA))?;
        let has_column = |table: &str, column: &str| -> Result<bool> {
            sql(conn.query_row(
                "SELECT COUNT(*) > 0 FROM pragma_table_info(?1) WHERE name = ?2",
                [table, column],
                |r| r.get(0),
            ))
        };
        // Columns added after the first release.
        for (table, column, definition) in [
            ("messages", "edited_at", "INTEGER"),
            ("messages", "author_name", "TEXT"),
            ("messages", "thumbs_up", "INTEGER NOT NULL DEFAULT 0"),
            ("messages", "session_id", "TEXT"),
            ("threads", "dismissed", "INTEGER NOT NULL DEFAULT 0"),
            ("session_worktrees", "agent", "TEXT"),
        ] {
            if !has_column(table, column)? {
                sql(conn.execute(&format!("ALTER TABLE {table} ADD COLUMN {column} {definition}"), []))?;
            }
        }
        // Gone with sending comments as a batch, and submitting reviews: what each session has
        // seen (sessions.rs) and review requests (requests.rs) took their place.
        if has_column("messages", "sent_at")? {
            sql(conn.execute("ALTER TABLE messages DROP COLUMN sent_at", []))?;
        }
        sql(conn.execute_batch("DROP TABLE IF EXISTS reviews"))?;
        let images_dir = path.parent().unwrap_or(Path::new(".")).join(IMAGES_DIR);
        Ok(Self { conn, images_dir })
    }

    /// Threads on `target`'s branch: general ones first, then by file and line. Positions are left as created;
    /// see [`locate_in_view`] and [`locate_in_worktree`].
    pub fn threads(&self, target: &Target, include_resolved: bool) -> Result<Vec<Thread>> {
        let mut stmt = sql(self.conn.prepare(
            "SELECT * FROM threads
             WHERE repo = ?1 AND (branch = ?2 OR (?2 IS NULL AND branch IS NULL AND worktree = ?3))
               AND (?4 OR resolved = 0)
             ORDER BY path, end_line, id",
        ))?;
        let rows = sql(stmt.query_map(
            params![target.repo, target.branch, target.worktree, include_resolved],
            thread_from_row,
        ))?;
        let mut threads = sql(rows.collect::<rusqlite::Result<Vec<_>>>())?;
        let mut messages = self.messages(threads.iter().map(|t| t.id))?;
        for thread in &mut threads {
            thread.messages = messages.remove(&thread.id).unwrap_or_default();
        }
        Ok(threads)
    }

    pub fn thread(&self, id: i64) -> Result<Thread> {
        let thread = sql(self.conn.query_row("SELECT * FROM threads WHERE id = ?1", [id], thread_from_row).optional())?;
        let mut thread = thread.ok_or_else(|| format!("No comment #{id}"))?;
        thread.messages = self.messages([id])?.remove(&id).unwrap_or_default();
        Ok(thread)
    }

    fn messages(&self, thread_ids: impl IntoIterator<Item = i64>) -> Result<HashMap<i64, Vec<Message>>> {
        let ids: Vec<String> = thread_ids.into_iter().map(|id| id.to_string()).collect();
        let mut map: HashMap<i64, Vec<Message>> = HashMap::new();
        if ids.is_empty() {
            return Ok(map);
        }
        // Ids are integers, so inlining them is safe.
        let mut stmt = sql(self.conn.prepare(&format!(
            "SELECT id, thread_id, author, body, created_at, edited_at, author_name, thumbs_up FROM messages WHERE thread_id IN ({}) ORDER BY id",
            ids.join(",")
        )))?;
        let rows = sql(stmt.query_map([], |row| {
            let author: String = row.get(2)?;
            Ok((
                row.get::<_, i64>(1)?,
                Message {
                    id: row.get(0)?,
                    author: if author == "agent" { Author::Agent } else { Author::Reviewer },
                    author_name: row.get(6)?,
                    body: row.get(3)?,
                    attachments: Vec::new(),
                    created_at: row.get(4)?,
                    edited_at: row.get(5)?,
                    thumbs_up: row.get(7)?,
                },
            ))
        }))?;
        let mut messages = Vec::new();
        for row in rows {
            messages.push(sql(row)?);
        }
        drop(stmt);

        let mut attachments = self.attachments(ids.join(","))?;
        for (thread_id, mut message) in messages {
            message.attachments = attachments.remove(&message.id).unwrap_or_default();
            map.entry(thread_id).or_default().push(message);
        }
        Ok(map)
    }

    /// Images of the messages in `thread_ids` (comma-separated integers), by message id.
    fn attachments(&self, thread_ids: String) -> Result<HashMap<i64, Vec<Attachment>>> {
        let mut stmt = sql(self.conn.prepare(&format!(
            "SELECT a.id, a.message_id, a.width, a.height FROM attachments a
             JOIN messages m ON m.id = a.message_id
             WHERE m.thread_id IN ({thread_ids}) ORDER BY a.id"
        )))?;
        let rows = sql(stmt.query_map([], |row| {
            let id: i64 = row.get(0)?;
            Ok((
                row.get::<_, i64>(1)?,
                Attachment {
                    id,
                    width: row.get(2)?,
                    height: row.get(3)?,
                    path: self.image_path(id).to_string_lossy().into_owned(),
                },
            ))
        }))?;
        let mut map: HashMap<i64, Vec<Attachment>> = HashMap::new();
        for row in rows {
            let (message_id, attachment) = sql(row)?;
            map.entry(message_id).or_default().push(attachment);
        }
        Ok(map)
    }

    fn image_path(&self, id: i64) -> PathBuf {
        image_path(&self.images_dir, id)
    }

    /// The bytes of an attached image.
    pub fn image(&self, id: i64) -> Result<Vec<u8>> {
        std::fs::read(self.image_path(id)).map_err(|e| format!("Image #{id} isn't available: {e}"))
    }

    /// Creates a thread on lines of the diff `range` shows in `wt`.
    pub fn add_thread(&mut self, target: &Target, wt: &Path, range: &DiffRange, new: NewThread) -> Result<i64> {
        let body = new.body.trim();
        if body.is_empty() && new.images.is_empty() {
            return Err("A comment can't be empty".into());
        }
        let rows = git::full_file_diff(wt, range, new.old_path.unwrap_or(new.path), new.path)?;
        let snapshot = Snapshot::build(new.path, &rows, new.range)?;
        let range = snapshot.range;
        let now = now_ms();
        let tx = sql(self.conn.transaction())?;
        sql(tx.execute(
            "INSERT INTO threads (repo, branch, worktree, path, old_path, start_side, start_line, end_side, end_line,
                                  anchor_start, anchor_lines, excerpt, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13)",
            params![
                target.repo,
                target.branch,
                target.worktree,
                new.path,
                new.old_path.filter(|p| *p != new.path),
                range.start_side.as_str(),
                range.start_line,
                range.end_side.as_str(),
                range.end_line,
                snapshot.anchor_start,
                serde_json::to_string(&snapshot.anchor_lines).unwrap_or_default(),
                serde_json::to_string(&snapshot.excerpt).unwrap_or_default(),
                now,
            ],
        ))?;
        let id = tx.last_insert_rowid();
        let message = insert_message(&tx, id, new.by, body, now)?;
        save_images(&tx, &self.images_dir, message, new.images)?;
        sql(tx.commit())?;
        Ok(id)
    }

    /// Creates a general thread on `target`'s branch: one about the change as a whole.
    pub fn add_general_thread(&mut self, target: &Target, by: By, body: &str, images: &[NewImage]) -> Result<i64> {
        let body = body.trim();
        if body.is_empty() && images.is_empty() {
            return Err("A comment can't be empty".into());
        }
        let tx = sql(self.conn.transaction())?;
        let (id, message) = insert_general_thread(&tx, target, by, body, now_ms())?;
        save_images(&tx, &self.images_dir, message, images)?;
        sql(tx.commit())?;
        Ok(id)
    }

    pub fn reply(&mut self, thread_id: i64, by: By, body: &str, images: &[NewImage]) -> Result<()> {
        let body = body.trim();
        if body.is_empty() && images.is_empty() {
            return Err("A reply can't be empty".into());
        }
        self.thread(thread_id)?;
        let now = now_ms();
        let tx = sql(self.conn.transaction())?;
        let message = insert_message(&tx, thread_id, by, body, now)?;
        save_images(&tx, &self.images_dir, message, images)?;
        sql(tx.execute("UPDATE threads SET updated_at = ?2 WHERE id = ?1", params![thread_id, now]))?;
        sql(tx.commit())
    }

    /// Replaces a message's text and attaches more images; the ones it has stay.
    pub fn edit_message(&mut self, message_id: i64, body: &str, images: &[NewImage]) -> Result<()> {
        let body = body.trim();
        let thread_id: Option<i64> = sql(self
            .conn
            .query_row("SELECT thread_id FROM messages WHERE id = ?1", [message_id], |r| r.get(0))
            .optional())?;
        let Some(thread_id) = thread_id else { return Err(format!("No message #{message_id}")) };
        if body.is_empty() && images.is_empty() && self.image_ids("m.id", message_id)?.is_empty() {
            return Err("A comment can't be empty".into());
        }
        let now = now_ms();
        let tx = sql(self.conn.transaction())?;
        // `edited_at` makes a changed comment new again to sessions that saw it (see sessions.rs).
        sql(tx.execute(
            "UPDATE messages SET body = ?2, edited_at = ?3 WHERE id = ?1",
            params![message_id, body, now],
        ))?;
        save_images(&tx, &self.images_dir, message_id, images)?;
        sql(tx.execute("UPDATE threads SET updated_at = ?2 WHERE id = ?1", params![thread_id, now]))?;
        sql(tx.commit())
    }

    /// Gives an agent's message a thumbs up, or takes it back. It doesn't touch `updated_at`:
    /// a reaction isn't a change to the conversation.
    pub fn set_thumbs_up(&self, message_id: i64, thumbs_up: bool) -> Result<()> {
        let changed = sql(self.conn.execute(
            "UPDATE messages SET thumbs_up = ?2 WHERE id = ?1 AND author = 'agent'",
            params![message_id, thumbs_up],
        ))?;
        if changed == 0 {
            return Err(format!("No agent message #{message_id}"));
        }
        Ok(())
    }

    /// Resolves a thread, or reopens it (also when it was dismissed).
    pub fn set_resolved(&self, thread_id: i64, resolved: bool) -> Result<()> {
        self.close(thread_id, resolved, false)
    }

    /// Dismisses a thread: closed without being acted on, kept so it isn't raised again. Undone by
    /// reopening it.
    pub fn set_dismissed(&self, thread_id: i64, dismissed: bool) -> Result<()> {
        self.close(thread_id, dismissed, dismissed)
    }

    fn close(&self, thread_id: i64, resolved: bool, dismissed: bool) -> Result<()> {
        let changed = sql(self.conn.execute(
            "UPDATE threads SET resolved = ?2, dismissed = ?3, updated_at = ?4 WHERE id = ?1",
            params![thread_id, resolved, dismissed, now_ms()],
        ))?;
        if changed == 0 {
            return Err(format!("No comment #{thread_id}"));
        }
        Ok(())
    }

    /// Deletes one message; deleting a thread's first message deletes the whole thread.
    pub fn delete_message(&self, message_id: i64) -> Result<()> {
        let thread_id: Option<i64> = sql(self
            .conn
            .query_row("SELECT thread_id FROM messages WHERE id = ?1", [message_id], |r| r.get(0))
            .optional())?;
        let Some(thread_id) = thread_id else { return Ok(()) };
        let first: i64 = sql(self.conn.query_row(
            "SELECT MIN(id) FROM messages WHERE thread_id = ?1",
            [thread_id],
            |r| r.get(0),
        ))?;
        let deleting_thread = first == message_id;
        let images = self.image_ids(if deleting_thread { "m.thread_id" } else { "m.id" }, if deleting_thread { thread_id } else { message_id })?;
        if deleting_thread {
            sql(self.conn.execute("DELETE FROM threads WHERE id = ?1", [thread_id]))?;
        } else {
            sql(self.conn.execute("DELETE FROM messages WHERE id = ?1", [message_id]))?;
        }
        for id in images {
            let _ = std::fs::remove_file(self.image_path(id));
        }
        Ok(())
    }

    /// Ids of the images on messages where `column` (`m.id` or `m.thread_id`) equals `value`.
    fn image_ids(&self, column: &str, value: i64) -> Result<Vec<i64>> {
        let mut stmt = sql(self.conn.prepare(&format!(
            "SELECT a.id FROM attachments a JOIN messages m ON m.id = a.message_id WHERE {column} = ?1"
        )))?;
        let rows = sql(stmt.query_map([value], |r| r.get(0)))?;
        sql(rows.collect())
    }
}

fn image_path(dir: &Path, id: i64) -> PathBuf {
    dir.join(format!("{id}.png"))
}

/// Saves `images` for `message_id`. Files are written as the rows are inserted; if one fails,
/// the ones already written are removed, and the caller's transaction rolls the rows back.
fn save_images(conn: &Connection, dir: &Path, message_id: i64, images: &[NewImage]) -> Result<()> {
    let mut written: Vec<PathBuf> = Vec::new();
    let result = (|| {
        for image in images {
            if !image.data.starts_with(PNG_SIGNATURE) || image.width == 0 || image.height == 0 {
                return Err("The pasted image isn't a PNG".to_string());
            }
            if image.data.len() > MAX_IMAGE_BYTES {
                return Err("The pasted image is too large".to_string());
            }
            std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
            sql(conn.execute(
                "INSERT INTO attachments (message_id, width, height) VALUES (?1, ?2, ?3)",
                params![message_id, image.width, image.height],
            ))?;
            let path = image_path(dir, conn.last_insert_rowid());
            std::fs::write(&path, &image.data).map_err(|e| format!("{}: {e}", path.display()))?;
            written.push(path);
        }
        Ok(())
    })();
    if result.is_err() {
        for path in written {
            let _ = std::fs::remove_file(path);
        }
    }
    result
}

/// Inserts a general thread with its first message; returns the ids of both.
pub(crate) fn insert_general_thread(conn: &Connection, target: &Target, by: By, body: &str, now: i64) -> Result<(i64, i64)> {
    sql(conn.execute(
        "INSERT INTO threads (repo, branch, worktree, path, start_side, start_line, end_side, end_line,
                              anchor_start, anchor_lines, excerpt, created_at, updated_at)
         VALUES (?1, ?2, ?3, '', 'additions', 0, 'additions', 0, 0, '[]', '[]', ?4, ?4)",
        params![target.repo, target.branch, target.worktree, now],
    ))?;
    let id = conn.last_insert_rowid();
    Ok((id, insert_message(conn, id, by, body, now)?))
}

/// Inserts a message and returns its id. A session writing in a thread has read it.
fn insert_message(conn: &Connection, thread_id: i64, by: By, body: &str, now: i64) -> Result<i64> {
    let author = match by.author {
        Author::Reviewer => "reviewer",
        Author::Agent => "agent",
    };
    sql(conn.execute(
        "INSERT INTO messages (thread_id, author, author_name, session_id, body, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![thread_id, author, by.name, by.session, body, now],
    ))?;
    let id = conn.last_insert_rowid();
    if let Some(session) = by.session {
        sessions::mark_seen(conn, session, &[thread_id], now)?;
    }
    Ok(id)
}

fn thread_from_row(row: &Row) -> rusqlite::Result<Thread> {
    let path: String = row.get("path")?;
    let range = (!path.is_empty())
        .then(|| -> rusqlite::Result<LineRange> {
            Ok(LineRange {
                start_side: Side::parse(&row.get::<_, String>("start_side")?),
                start_line: row.get("start_line")?,
                end_side: Side::parse(&row.get::<_, String>("end_side")?),
                end_line: row.get("end_line")?,
            })
        })
        .transpose()?;
    let json = |column: &str| row.get::<_, String>(column);
    Ok(Thread {
        id: row.get("id")?,
        path: (!path.is_empty()).then_some(path),
        old_path: row.get("old_path")?,
        range,
        position: range,
        resolved: row.get("resolved")?,
        dismissed: row.get("dismissed")?,
        excerpt: serde_json::from_str(&json("excerpt")?).unwrap_or_default(),
        messages: Vec::new(),
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        anchor_start: row.get("anchor_start")?,
        anchor_lines: serde_json::from_str(&json("anchor_lines")?).unwrap_or_default(),
    })
}

// ---------------------------------------------------------------------------------------------
// Anchoring

struct Snapshot {
    /// The range ordered top to bottom (a selection dragged upwards ends above where it started).
    range: LineRange,
    anchor_start: u32,
    anchor_lines: Vec<String>,
    excerpt: Vec<ExcerptRow>,
}

impl Snapshot {
    fn build(path: &str, rows: &[DiffLine], range: LineRange) -> Result<Self> {
        let find = |side: Side, line: u32| {
            rows.iter().position(|r| side.line_of(r) == Some(line)).ok_or_else(|| {
                let version = if side == Side::Deletions { " in its old version" } else { "" };
                format!("{path} has no line {line}{version} (any more)")
            })
        };
        let not_found = || format!("{path} has no lines to comment on");
        let a = find(range.start_side, range.start_line)?;
        let b = find(range.end_side, range.end_line)?;
        let (first, last) = (a.min(b), a.max(b));
        let range = if a <= b {
            range
        } else {
            LineRange {
                start_side: range.end_side,
                start_line: range.end_line,
                end_side: range.start_side,
                end_line: range.start_line,
            }
        };

        let anchored: Vec<&DiffLine> = rows[first..=last]
            .iter()
            .filter(|r| range.end_side.line_of(r).is_some())
            .collect();
        let anchor_start = anchored.first().and_then(|r| range.end_side.line_of(r)).ok_or_else(not_found)?;
        let from = first.saturating_sub(EXCERPT_CONTEXT);
        let to = (last + EXCERPT_CONTEXT).min(rows.len() - 1);
        Ok(Self {
            range,
            anchor_start,
            anchor_lines: anchored.iter().map(|r| r.text.clone()).collect(),
            excerpt: rows[from..=to]
                .iter()
                .enumerate()
                .map(|(i, r)| ExcerptRow {
                    kind: r.kind,
                    old: r.old,
                    new: r.new,
                    text: r.text.clone(),
                    commented: (first..=last).contains(&(from + i)),
                })
                .collect(),
        })
    }
}

/// Where the thread's lines are in `contents` (the end side's file): unchanged, moved by edits
/// above them (nearest match wins), or `None` when they no longer exist.
fn relocate(thread: &Thread, contents: &str) -> Option<LineRange> {
    let range = thread.range?;
    let lines: Vec<&str> = contents.lines().collect();
    let anchor = &thread.anchor_lines;
    if anchor.is_empty() {
        return None;
    }
    let matches_at = |start: usize| {
        anchor
            .iter()
            .enumerate()
            .all(|(i, text)| lines.get(start + i).is_some_and(|l| l.trim_end() == text.trim_end()))
    };
    let original = thread.anchor_start.saturating_sub(1) as usize;
    let found = if matches_at(original) {
        Some(original)
    } else {
        (0..lines.len()).filter(|&s| matches_at(s)).min_by_key(|s| s.abs_diff(original))
    };
    found.map(|start| range.shifted(start as i64 - original as i64))
}

/// Updates positions for the diff `range` in `wt`, as the app shows it.
pub fn locate_in_view(threads: &mut [Thread], wt: &Path, range: &DiffRange) {
    let mut cache: HashMap<(Side, String), Option<String>> = HashMap::new();
    for thread in threads {
        let (Some(lines), Some(path)) = (thread.range, thread.path.clone()) else { continue };
        let side = lines.end_side;
        let (rev, path) = match side {
            Side::Additions => (range.new_rev.clone(), path),
            Side::Deletions => (Some(range.old_rev.clone()), thread.old_path.clone().unwrap_or(path)),
        };
        let contents = cache
            .entry((side, path.clone()))
            .or_insert_with(|| git::file_contents(wt, rev.as_deref(), &path).ok().flatten());
        thread.position = contents.as_deref().and_then(|c| relocate(thread, c));
    }
}

/// Updates positions of threads on added or unchanged lines against the files on disk, which is
/// what an agent edits. Comments on removed lines keep their original position.
pub fn locate_in_worktree(threads: &mut [Thread], wt: &Path) {
    for thread in threads.iter_mut() {
        let on_new_lines = thread.range.is_some_and(|r| r.end_side == Side::Additions);
        let Some(path) = thread.path.as_ref().filter(|_| on_new_lines) else { continue };
        thread.position = std::fs::read_to_string(wt.join(path)).ok().and_then(|c| relocate(thread, &c));
    }
}

// ---------------------------------------------------------------------------------------------
// Tauri commands

pub(crate) async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T> + Send + 'static) -> Result<T> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn list_threads(path: String, base: Option<String>, scope: Scope) -> Result<Vec<Thread>> {
    blocking(move || {
        let wt = Path::new(&path);
        let mut threads = Store::open()?.threads(&Target::of(wt)?, true)?;
        let range = DiffRange::resolve(wt, base.as_deref(), &scope)?;
        locate_in_view(&mut threads, wt, &range);
        Ok(threads)
    })
    .await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn add_thread(
    path: String,
    base: Option<String>,
    scope: Scope,
    file: String,
    old_file: Option<String>,
    range: LineRange,
    body: String,
    images: Vec<ImageUpload>,
) -> Result<i64> {
    blocking(move || {
        let wt = Path::new(&path);
        let diff_range = DiffRange::resolve(wt, base.as_deref(), &scope)?;
        let images = decode_images(images)?;
        let new = NewThread { by: By::REVIEWER, path: &file, old_path: old_file.as_deref(), range, body: &body, images: &images };
        Store::open()?.add_thread(&Target::of(wt)?, wt, &diff_range, new)
    })
    .await
}

#[tauri::command]
pub async fn add_general_thread(path: String, body: String, images: Vec<ImageUpload>) -> Result<i64> {
    blocking(move || {
        let images = decode_images(images)?;
        Store::open()?.add_general_thread(&Target::of(Path::new(&path))?, By::REVIEWER, &body, &images)
    })
    .await
}

#[tauri::command]
pub async fn reply_thread(id: i64, body: String, images: Vec<ImageUpload>) -> Result<()> {
    blocking(move || Store::open()?.reply(id, By::REVIEWER, &body, &decode_images(images)?)).await
}

/// A pasted image as the app sends it: a base64 PNG.
#[derive(Deserialize)]
pub struct ImageUpload {
    width: u32,
    height: u32,
    data: String,
}

fn decode_images(uploads: Vec<ImageUpload>) -> Result<Vec<NewImage>> {
    uploads
        .into_iter()
        .map(|u| {
            let data = BASE64.decode(u.data).map_err(|_| "The pasted image is damaged".to_string())?;
            Ok(NewImage { width: u.width, height: u.height, data })
        })
        .collect()
}

/// An attached image as base64.
#[tauri::command]
pub async fn attachment_data(id: i64) -> Result<String> {
    blocking(move || Ok(BASE64.encode(Store::open()?.image(id)?))).await
}

#[tauri::command]
pub async fn edit_comment(id: i64, body: String, images: Vec<ImageUpload>) -> Result<()> {
    blocking(move || Store::open()?.edit_message(id, &body, &decode_images(images)?)).await
}

#[tauri::command]
pub async fn set_thumbs_up(id: i64, thumbs_up: bool) -> Result<()> {
    blocking(move || Store::open()?.set_thumbs_up(id, thumbs_up)).await
}

#[tauri::command]
pub async fn set_thread_resolved(id: i64, resolved: bool) -> Result<()> {
    blocking(move || Store::open()?.set_resolved(id, resolved)).await
}

#[tauri::command]
pub async fn set_thread_dismissed(id: i64, dismissed: bool) -> Result<()> {
    blocking(move || Store::open()?.set_dismissed(id, dismissed)).await
}

#[tauri::command]
pub async fn delete_comment(id: i64) -> Result<()> {
    blocking(move || Store::open()?.delete_message(id)).await
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::fs;

    fn run(cwd: &Path, args: &[&str]) {
        git::git(cwd, args).unwrap();
    }

    /// A repository with a feature worktree that changed a few lines of `a.txt`.
    pub(crate) fn fixture(name: &str) -> (PathBuf, PathBuf, Store) {
        let root = std::env::temp_dir().join(format!("review-comments-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let repo = root.join("repo");
        let wt = root.join("feat");
        fs::create_dir_all(&repo).unwrap();
        run(&repo, &["init", "-q", "-b", "main"]);
        run(&repo, &["config", "user.email", "t@example.com"]);
        run(&repo, &["config", "user.name", "Test"]);
        fs::write(repo.join("a.txt"), "one\ntwo\nthree\nfour\nfive\nsix\n").unwrap();
        run(&repo, &["add", "."]);
        run(&repo, &["commit", "-q", "-m", "init"]);
        run(&repo, &["worktree", "add", "-q", "-b", "feat/x", wt.to_str().unwrap()]);
        fs::write(wt.join("a.txt"), "one\ntwo\nTHREE\nFOUR\nfive\nsix\n").unwrap();
        let store = Store::open_at(&root.join("comments.db")).unwrap();
        (root, wt, store)
    }

    pub(crate) fn additions(start: u32, end: u32) -> LineRange {
        LineRange { start_side: Side::Additions, start_line: start, end_side: Side::Additions, end_line: end }
    }

    #[test]
    fn stores_threads_per_branch_and_follows_edits() {
        let (root, wt, mut store) = fixture("follow");
        let target = Target::of(&wt).unwrap();
        assert_eq!(target.branch.as_deref(), Some("feat/x"));
        let range = DiffRange::resolve(&wt, Some("main"), &Scope::All).unwrap();

        let new = NewThread { by: By::REVIEWER, path: "a.txt", old_path: None, range: additions(3, 4), body: " Why uppercase? ", images: &[] };
        let id = store.add_thread(&target, &wt, &range, new).unwrap();
        store.reply(id, By::agent(Some("codex")), "Changed it back", &[]).unwrap();

        let threads = store.threads(&target, false).unwrap();
        assert_eq!(threads.len(), 1);
        let thread = &threads[0];
        assert_eq!(thread.messages.iter().map(|m| m.body.as_str()).collect::<Vec<_>>(), ["Why uppercase?", "Changed it back"]);
        assert_eq!(thread.messages[1].author, Author::Agent);
        assert_eq!(thread.messages[1].author_name.as_deref(), Some("codex"));
        assert_eq!(thread.messages[0].author_name, None);
        // Snapshot: the removed and added lines, marked, with context around them.
        let commented: Vec<_> = thread.excerpt.iter().filter(|r| r.commented).map(|r| r.text.as_str()).collect();
        assert_eq!(commented, ["THREE", "FOUR"]);
        assert_eq!(thread.excerpt.first().unwrap().text, "two");
        assert_eq!(thread.excerpt.iter().filter(|r| r.kind == LineKind::Del).count(), 2);

        // Lines inserted above move the thread down.
        fs::write(wt.join("a.txt"), "zero\none\ntwo\nTHREE\nFOUR\nfive\nsix\n").unwrap();
        let mut threads = store.threads(&target, false).unwrap();
        locate_in_worktree(&mut threads, &wt);
        assert_eq!(threads[0].position, Some(additions(4, 5)));

        // Changing the commented lines outdates it.
        fs::write(wt.join("a.txt"), "one\ntwo\nthree\nfour\nfive\nsix\n").unwrap();
        let mut threads = store.threads(&target, false).unwrap();
        locate_in_worktree(&mut threads, &wt);
        assert_eq!(threads[0].position, None);

        // Other branches don't see it; resolved threads are hidden unless asked for.
        let main = Target::of(&root.join("repo")).unwrap();
        assert!(store.threads(&main, true).unwrap().is_empty());
        store.set_resolved(id, true).unwrap();
        assert!(store.threads(&target, false).unwrap().is_empty());
        assert_eq!(store.threads(&target, true).unwrap().len(), 1);

        // Dismissing closes a thread too, but keeps it apart from resolved ones until reopened.
        store.set_resolved(id, false).unwrap();
        store.set_dismissed(id, true).unwrap();
        let thread = store.thread(id).unwrap();
        assert!(thread.resolved && thread.dismissed);
        assert!(store.threads(&target, false).unwrap().is_empty());
        store.set_resolved(id, true).unwrap();
        assert!(!store.thread(id).unwrap().dismissed);
        store.set_dismissed(id, true).unwrap();
        store.set_resolved(id, false).unwrap();
        let thread = store.thread(id).unwrap();
        assert!(!thread.resolved && !thread.dismissed);

        // Deleting the first message deletes the thread and its replies.
        let first = store.thread(id).unwrap().messages[0].id;
        store.delete_message(first).unwrap();
        assert!(store.thread(id).is_err());

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn anchors_ranges_across_sides_and_untracked_files() {
        let (root, wt, mut store) = fixture("sides");
        let target = Target::of(&wt).unwrap();
        let range = DiffRange::resolve(&wt, Some("main"), &Scope::All).unwrap();

        // From the removed "three" to the added "FOUR", as a drag in the unified view would select.
        let across = LineRange { start_side: Side::Deletions, start_line: 3, end_side: Side::Additions, end_line: 4 };
        let id = store
            .add_thread(&target, &wt, &range, NewThread { by: By::REVIEWER, path: "a.txt", old_path: None, range: across, body: "x", images: &[] })
            .unwrap();
        let thread = store.thread(id).unwrap();
        let commented: Vec<_> = thread.excerpt.iter().filter(|r| r.commented).map(|r| r.text.as_str()).collect();
        assert_eq!(commented, ["three", "four", "THREE", "FOUR"]);
        assert_eq!(thread.anchor_lines, ["THREE", "FOUR"]);

        // A selection dragged upwards is stored top to bottom.
        let upwards = LineRange { start_side: Side::Additions, start_line: 4, end_side: Side::Deletions, end_line: 3 };
        let id = store
            .add_thread(&target, &wt, &range, NewThread { by: By::REVIEWER, path: "a.txt", old_path: None, range: upwards, body: "x", images: &[] })
            .unwrap();
        assert_eq!(store.thread(id).unwrap().range, Some(across));

        fs::write(wt.join("new.md"), "hello\nworld\n").unwrap();
        let id = store
            .add_thread(&target, &wt, &range, NewThread { by: By::REVIEWER, path: "new.md", old_path: None, range: additions(2, 2), body: "y", images: &[] })
            .unwrap();
        let mut threads = vec![store.thread(id).unwrap()];
        assert!(threads[0].excerpt.iter().all(|r| r.kind == LineKind::Add));
        locate_in_view(&mut threads, &wt, &range);
        assert_eq!(threads[0].position, Some(additions(2, 2)));

        let missing = NewThread { by: By::REVIEWER, path: "a.txt", old_path: None, range: additions(40, 40), body: "z", images: &[] };
        assert!(store.add_thread(&target, &wt, &range, missing).is_err());

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn stores_general_threads_on_the_branch() {
        let (root, wt, mut store) = fixture("general");
        let target = Target::of(&wt).unwrap();
        let range = DiffRange::resolve(&wt, Some("main"), &Scope::All).unwrap();
        let new = NewThread { by: By::REVIEWER, path: "a.txt", old_path: None, range: additions(3, 3), body: "x", images: &[] };
        let line = store.add_thread(&target, &wt, &range, new).unwrap();
        let general = store.add_general_thread(&target, By::REVIEWER, " Split this into two PRs. ", &[]).unwrap();
        assert!(store.add_general_thread(&target, By::REVIEWER, "  ", &[]).is_err());

        // General threads come first, with no file, lines or snapshot, and nothing to relocate.
        let mut threads = store.threads(&target, false).unwrap();
        locate_in_view(&mut threads, &wt, &range);
        locate_in_worktree(&mut threads, &wt);
        assert_eq!(threads.iter().map(|t| t.id).collect::<Vec<_>>(), [general, line]);
        let thread = &threads[0];
        assert_eq!((thread.path.as_deref(), thread.range, thread.position), (None, None, None));
        assert!(thread.excerpt.is_empty());
        assert_eq!(thread.messages[0].body, "Split this into two PRs.");
        let json = serde_json::to_value(thread).unwrap();
        assert!(json["path"].is_null() && json["range"].is_null(), "{json}");

        // Answered and resolved like any thread; other branches don't see it.
        store.reply(general, By::agent(Some("claude")), "Done", &[]).unwrap();
        assert_eq!(store.thread(general).unwrap().messages.len(), 2);
        store.set_resolved(general, true).unwrap();
        assert_eq!(store.threads(&target, false).unwrap().len(), 1);
        assert!(store.threads(&Target::of(&root.join("repo")).unwrap(), true).unwrap().is_empty());

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn stores_pasted_images_as_files() {
        let (root, wt, mut store) = fixture("images");
        let target = Target::of(&wt).unwrap();
        let range = DiffRange::resolve(&wt, Some("main"), &Scope::All).unwrap();
        let png = |extra: &[u8]| NewImage { width: 4, height: 3, data: [PNG_SIGNATURE, extra].concat() };

        // A comment can be only an image.
        let images = [png(b"first")];
        let new = NewThread { by: By::REVIEWER, path: "a.txt", old_path: None, range: additions(3, 3), body: "  ", images: &images };
        let id = store.add_thread(&target, &wt, &range, new).unwrap();
        let reply = [png(b"second"), png(b"third")];
        store.reply(id, By::REVIEWER, "and these", &reply).unwrap();

        let thread = store.thread(id).unwrap();
        let attachments: Vec<_> = thread.messages.iter().map(|m| m.attachments.len()).collect();
        assert_eq!(attachments, [1, 2]);
        let first = &thread.messages[0].attachments[0];
        assert_eq!((first.width, first.height), (4, 3));
        assert_eq!(std::fs::read(&first.path).unwrap(), [PNG_SIGNATURE, b"first"].concat());
        assert_eq!(store.image(first.id).unwrap(), [PNG_SIGNATURE, b"first"].concat());

        // Anything but a PNG is refused, and nothing is left behind.
        let bad = [png(b"ok"), NewImage { width: 1, height: 1, data: b"GIF89a".to_vec() }];
        assert!(store.reply(id, By::REVIEWER, "x", &bad).is_err());
        assert_eq!(store.thread(id).unwrap().messages.len(), 2);
        let on_disk = || std::fs::read_dir(root.join(IMAGES_DIR)).unwrap().count();
        assert_eq!(on_disk(), 3);

        // Editing keeps the images and adds pasted ones; a message with images may lose its text.
        store.edit_message(thread.messages[1].id, "", &[png(b"fourth")]).unwrap();
        let edited = &store.thread(id).unwrap().messages[1];
        assert_eq!((edited.body.as_str(), edited.attachments.len()), ("", 3));
        assert!(edited.edited_at.is_some() && thread.messages[1].edited_at.is_none());
        assert_eq!(on_disk(), 4);

        // Only an agent's message can be given a thumbs up.
        store.reply(id, By::agent(Some("codex")), "done", &[]).unwrap();
        let agent = store.thread(id).unwrap().messages.last().unwrap().id;
        store.set_thumbs_up(agent, true).unwrap();
        assert!(store.thread(id).unwrap().messages.last().unwrap().thumbs_up);
        store.set_thumbs_up(agent, false).unwrap();
        assert!(!store.thread(id).unwrap().messages.last().unwrap().thumbs_up);
        assert!(store.set_thumbs_up(thread.messages[0].id, true).is_err());
        store.delete_message(agent).unwrap();

        // Deleting a reply removes its files; deleting the thread removes the rest.
        store.delete_message(thread.messages[1].id).unwrap();
        assert_eq!(on_disk(), 1);
        store.delete_message(thread.messages[0].id).unwrap();
        assert_eq!(on_disk(), 0);

        fs::remove_dir_all(&root).unwrap();
    }
}
