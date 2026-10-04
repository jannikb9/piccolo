//! Reviews by agents that speak the Agent Client Protocol (ACP, agentclientprotocol.com): Gemini
//! CLI, Qwen Code, OpenCode, Cursor, goose and others. Piccolo starts the user's own installed CLI
//! in the background, with the user's own sign-in, and drives one prompt turn over ACP's JSON-RPC
//! on stdin/stdout: the agent is asked to run `piccolo guide --request <id>`, and comments as any
//! agent does through the `piccolo` command. Its session id is `acp-<request id>`, given to it as
//! `PICCOLO_SESSION`, so its comments and the request are tied to the run.
//!
//! Piccolo offers the agent no file system or terminal of its own, so the agent uses its own tools
//! and asks before running anything it wants approved: Piccolo allows reading and read-only
//! commands (`piccolo`, `git diff`, `grep`, …) and refuses edits (see [`permitted`]). Agents that
//! don't ask (some allow edits by default) are only held back by the prompt.
//!
//! What the agent says and does goes to a log next to the comments database.

use crate::comments::{app_data_dir, blocking, Store, Target};
use crate::git::Result;
use crate::programs;
use crate::requests::Request;
use crate::sessions::{shell_quote, Caller};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

/// An agent that speaks ACP, and how its CLI starts in ACP mode (from the ACP registry).
#[derive(Debug, Clone, Copy)]
pub struct AcpAgent {
    pub id: &'static str,
    pub name: &'static str,
    /// The name its comments are signed with.
    pub author: &'static str,
    program: &'static str,
    args: &'static [&'static str],
}

/// Agents with ACP built into their CLI. Claude and Codex aren't here: Piccolo talks to them
/// through their own apps and inboxes (sessions.rs).
pub const CATALOG: &[AcpAgent] = &[
    AcpAgent { id: "gemini", name: "Gemini CLI", author: "gemini", program: "gemini", args: &["--acp"] },
    AcpAgent { id: "qwen-code", name: "Qwen Code", author: "qwen", program: "qwen", args: &["--acp"] },
    AcpAgent { id: "opencode", name: "OpenCode", author: "opencode", program: "opencode", args: &["acp"] },
    AcpAgent { id: "cursor", name: "Cursor", author: "cursor", program: "cursor-agent", args: &["acp"] },
    AcpAgent { id: "goose", name: "goose", author: "goose", program: "goose", args: &["acp"] },
    AcpAgent { id: "github-copilot-cli", name: "GitHub Copilot", author: "copilot", program: "copilot", args: &["--acp"] },
    AcpAgent { id: "kimi", name: "Kimi CLI", author: "kimi", program: "kimi", args: &["acp"] },
    AcpAgent { id: "kilo", name: "Kilo", author: "kilo", program: "kilo", args: &["acp"] },
    AcpAgent { id: "mistral-vibe", name: "Mistral Vibe", author: "vibe", program: "vibe-acp", args: &[] },
    AcpAgent { id: "auggie", name: "Auggie CLI", author: "auggie", program: "auggie", args: &["--acp"] },
    AcpAgent { id: "cline", name: "Cline", author: "cline", program: "cline", args: &["--acp"] },
    AcpAgent { id: "factory-droid", name: "Factory Droid", author: "droid", program: "droid", args: &["exec", "--output-format", "acp-daemon"] },
    AcpAgent { id: "amp-acp", name: "Amp", author: "amp", program: "amp-acp", args: &[] },
    AcpAgent { id: "junie", name: "Junie", author: "junie", program: "junie", args: &["--acp=true"] },
];

/// An agent from the catalog that's installed.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledAgent {
    pub id: String,
    pub name: String,
    pub author: String,
}

/// How long a review may take before it's stopped.
const REVIEW_TIMEOUT: Duration = Duration::from_secs(45 * 60);
/// How long a cancelled turn gets to wind down before the agent is stopped.
const CANCEL_GRACE: Duration = Duration::from_secs(10);
/// How long an agent gets to start up and answer `initialize`. One that isn't signed in may show
/// a sign-in screen instead (Cursor does), and never answer.
const START_TIMEOUT: Duration = Duration::from_secs(30);

/// The ACP version this client speaks.
const PROTOCOL_VERSION: i64 = 1;
/// ACP's "authentication required" error.
const AUTH_REQUIRED: i64 = -32000;
const METHOD_NOT_FOUND: i64 = -32601;
/// Marks a request that got no answer in time (not an ACP code).
const TIMED_OUT: i64 = -1;

/// The session id of the run for request `id`.
fn session_of(request: i64) -> String {
    format!("acp-{request}")
}

/// Whether `session` is a run Piccolo started.
pub fn is_run(session: &str) -> bool {
    session.strip_prefix("acp-").is_some_and(|id| id.parse::<i64>().is_ok())
}

/// Runs going on, by session id, with the flag that stops each.
fn runs() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    static RUNS: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
    RUNS.get_or_init(Default::default)
}

/// Stops the run for request `id`; false when it isn't running.
pub fn stop(request: i64) -> bool {
    let runs = runs().lock();
    match runs.ok().and_then(|runs| runs.get(&session_of(request)).cloned()) {
        Some(flag) => {
            flag.store(true, Ordering::SeqCst);
            true
        }
        None => false,
    }
}

/// Where the run for request `id` logs what the agent says and does.
pub fn log_path(request: i64) -> PathBuf {
    app_data_dir().join("reviews").join(format!("{request}.log"))
}

/// The catalog's agents whose CLI is installed.
pub fn installed() -> Vec<InstalledAgent> {
    CATALOG
        .iter()
        .filter(|a| programs::find(a.program).is_some())
        .map(|a| InstalledAgent { id: a.id.into(), name: a.name.into(), author: a.author.into() })
        .collect()
}

/// The prompt for review `request` of `worktree`.
fn prompt(request: i64, worktree: &str) -> String {
    format!(
        "Review the changes in the worktree {worktree}: run `piccolo -C {} guide --request {request}` and follow the \
         steps it prints. You run in the background for Piccolo, a code review app: nobody can answer questions, so \
         don't ask any. Don't change any files; Piccolo refuses edits, and commands that aren't read-only.",
        shell_quote(worktree)
    )
}

/// Starts a background review of `target`'s branch by the catalog agent `id`.
pub fn start(store: &Store, target: &Target, id: &str, head: Option<&str>) -> Result<Request> {
    let agent = *CATALOG.iter().find(|a| a.id == id).ok_or_else(|| format!("Piccolo doesn't know the agent {id}"))?;
    let program = programs::find(agent.program).ok_or_else(|| format!("{} isn't installed (no `{}` found)", agent.name, agent.program))?;
    let request = store.request_review(target, agent.author, None, head)?;
    let session = session_of(request.id);
    store.set_request_session(request.id, &session)?;
    store.note_session(&Caller { id: session.clone(), agent: agent.author.into() }, &target.worktree)?;

    let log_file = log_path(request.id);
    let started = (|| -> Result<(Child, Log)> {
        std::fs::create_dir_all(log_file.parent().unwrap_or(Path::new("."))).map_err(|e| e.to_string())?;
        let file = File::create(&log_file).map_err(|e| format!("{}: {e}", log_file.display()))?;
        let stderr = file.try_clone().map_err(|e| e.to_string())?;
        let child = spawn(&program, agent.args, &target.worktree, &session, agent.author, stderr)
            .map_err(|e| format!("Couldn't start {}: {e}", agent.name))?;
        Ok((child, Log::new(file)))
    })();
    let (child, log) = match started {
        Ok(started) => started,
        Err(e) => {
            store.cancel_request(request.id)?;
            return Err(e);
        }
    };

    let cancel = Arc::new(AtomicBool::new(false));
    if let Ok(mut runs) = runs().lock() {
        runs.insert(session.clone(), cancel.clone());
    }
    let (target, request_id, text) = (target.clone(), request.id, prompt(request.id, &target.worktree));
    std::thread::spawn(move || {
        let outcome = run(child, log, agent.program, &target.worktree, &text, &cancel);
        let finished = Store::open().and_then(|store| {
            store.finish_review(&target, agent.author, Some(&session), Some(request_id))?;
            match outcome {
                Ok(stop) if stop == "end_turn" => Ok(()),
                Ok(stop) if stop == "cancelled" => store.set_request_error(request_id, "Stopped"),
                Ok(stop) => store.set_request_error(request_id, &format!("The agent stopped early ({})", stop.replace('_', " "))),
                Err(e) => store.set_request_error(request_id, &e),
            }
        });
        if let Err(e) = finished {
            eprintln!("piccolo: couldn't record the end of review #{request_id}: {e}");
        }
        if let Ok(mut runs) = runs().lock() {
            runs.remove(&session);
        }
    });
    store.request(request.id)
}

fn spawn(program: &Path, args: &[&str], worktree: &str, session: &str, author: &str, stderr: File) -> std::io::Result<Child> {
    // The agent runs `piccolo`: this binary is it, so its folder goes first on the PATH.
    let mut path = std::env::current_exe().ok().and_then(|e| e.parent().map(Path::to_path_buf)).into_iter().collect::<Vec<_>>();
    path.extend(programs::search_path().iter().cloned());
    Command::new(program)
        .args(args)
        .current_dir(worktree)
        .env("PATH", std::env::join_paths(path).unwrap_or_else(|_| programs::path_variable()))
        .env("PICCOLO_SESSION", session)
        .env("PICCOLO_AUTHOR", author)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::from(stderr))
        .spawn()
}

/// Drives the agent (started as `program`) through one review turn; returns why the turn stopped.
/// The agent is stopped at the end either way.
fn run(mut child: Child, log: Log, program: &str, worktree: &str, text: &str, cancel: &Arc<AtomicBool>) -> Result<String> {
    let (Some(stdin), Some(stdout)) = (child.stdin.take(), child.stdout.take()) else {
        let _ = child.kill();
        return Err("The agent's input or output isn't available".into());
    };
    let (sender, lines) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            if sender.send(line).is_err() {
                break;
            }
        }
    });
    let mut client = Client::new(stdin, lines, cancel.clone(), log);
    let outcome = client.review(program, worktree, text);
    if let Err(e) = &outcome {
        client.log.line(&format!("[error] {e}"));
    }
    drop(client);
    // With its input closed an agent should exit; one that doesn't is stopped.
    for _ in 0..20 {
        if child.try_wait().ok().flatten().is_some() {
            return outcome;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    let _ = child.kill();
    let _ = child.wait();
    outcome
}

/// What went wrong with a request to the agent.
#[derive(Debug)]
struct Failure {
    code: Option<i64>,
    message: String,
}

impl From<String> for Failure {
    fn from(message: String) -> Self {
        Self { code: None, message }
    }
}

/// A tool call as the agent described it so far.
#[derive(Debug, Default, Clone)]
struct ToolCall {
    kind: Option<String>,
    title: Option<String>,
    raw_input: Option<Value>,
}

impl ToolCall {
    fn merge(&mut self, update: &Value) {
        if let Some(kind) = update["kind"].as_str() {
            self.kind = Some(kind.into());
        }
        if let Some(title) = update["title"].as_str() {
            self.title = Some(title.into());
        }
        if !update["rawInput"].is_null() {
            self.raw_input = Some(update["rawInput"].clone());
        }
    }

    /// The shell command it runs, as far as its input or title tell.
    fn command(&self) -> Option<String> {
        let input = self.raw_input.as_ref();
        let from_input = input.and_then(|i| {
            let command = if i["command"].is_null() { &i["cmd"] } else { &i["command"] };
            match command {
                Value::String(s) => Some(s.clone()),
                Value::Array(parts) => Some(parts.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(" ")),
                _ => None,
            }
        });
        from_input.or_else(|| self.title.as_ref().map(|t| t.trim_matches('`').to_string()))
    }
}

struct Client {
    stdin: ChildStdin,
    lines: Receiver<String>,
    cancel: Arc<AtomicBool>,
    log: Log,
    next_id: i64,
    deadline: Instant,
    session: Option<String>,
    /// When a `session/cancel` was sent, so the turn gets a moment to end.
    cancelled_at: Option<Instant>,
    tools: HashMap<String, ToolCall>,
}

impl Client {
    fn new(stdin: ChildStdin, lines: Receiver<String>, cancel: Arc<AtomicBool>, log: Log) -> Self {
        Self {
            stdin,
            lines,
            cancel,
            log,
            next_id: 0,
            deadline: Instant::now() + START_TIMEOUT,
            session: None,
            cancelled_at: None,
            tools: HashMap::new(),
        }
    }

    fn review(&mut self, program: &str, worktree: &str, text: &str) -> Result<String> {
        let signed_out = format!("The agent isn't signed in: run `{program}` in a terminal once and sign in, then ask again");
        let init = self
            .request(
                "initialize",
                json!({
                    "protocolVersion": PROTOCOL_VERSION,
                    "clientCapabilities": { "fs": { "readTextFile": false, "writeTextFile": false }, "terminal": false },
                    "clientInfo": { "name": "piccolo", "title": "Piccolo", "version": env!("CARGO_PKG_VERSION") },
                }),
            )
            .map_err(|f| {
                if f.code == Some(TIMED_OUT) || f.message == "The agent exited" {
                    format!("The agent didn't start. It may need you to sign in: run `{program}` in a terminal once, then ask again")
                } else {
                    f.message
                }
            })?;
        if let Some(agent) = init["agentInfo"]["title"].as_str().or(init["agentInfo"]["name"].as_str()) {
            self.log.line(&format!("[agent] {agent} {}", init["agentInfo"]["version"].as_str().unwrap_or("")));
        }
        self.deadline = Instant::now() + REVIEW_TIMEOUT;
        let session = self.request("session/new", json!({ "cwd": worktree, "mcpServers": [] })).map_err(|f| {
            if f.code == Some(AUTH_REQUIRED) {
                signed_out.clone()
            } else {
                f.message
            }
        })?;
        let id = session["sessionId"].as_str().ok_or("The agent didn't start a session")?.to_string();
        self.session = Some(id.clone());
        let result = self
            .request("session/prompt", json!({ "sessionId": id, "prompt": [{ "type": "text", "text": text }] }))
            .map_err(|f| f.message)?;
        self.log.end_paragraph();
        Ok(result["stopReason"].as_str().unwrap_or("end_turn").to_string())
    }

    fn send(&mut self, message: Value) -> std::result::Result<(), Failure> {
        let line = format!("{message}\n");
        self.stdin
            .write_all(line.as_bytes())
            .and_then(|_| self.stdin.flush())
            .map_err(|e| Failure::from(format!("The agent stopped reading ({e})")))
    }

    /// Sends a request and handles what the agent sends meanwhile, until its response comes.
    fn request(&mut self, method: &str, params: Value) -> std::result::Result<Value, Failure> {
        self.next_id += 1;
        let id = self.next_id;
        self.send(json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }))?;
        loop {
            if self.cancel.load(Ordering::SeqCst) || Instant::now() > self.deadline {
                match (self.cancelled_at, &self.session) {
                    (None, Some(session)) => {
                        let session = session.clone();
                        self.send(json!({ "jsonrpc": "2.0", "method": "session/cancel", "params": { "sessionId": session } }))?;
                        self.cancelled_at = Some(Instant::now());
                    }
                    (Some(at), _) if at.elapsed() < CANCEL_GRACE => {}
                    _ if self.cancel.load(Ordering::SeqCst) => return Err(Failure::from("Stopped".to_string())),
                    _ => return Err(Failure { code: Some(TIMED_OUT), message: "The review took too long".into() }),
                }
            }
            let line = match self.lines.recv_timeout(Duration::from_millis(200)) {
                Ok(line) => line,
                Err(RecvTimeoutError::Timeout) => continue,
                Err(RecvTimeoutError::Disconnected) => return Err(Failure::from("The agent exited".to_string())),
            };
            let Ok(message) = serde_json::from_str::<Value>(&line) else {
                self.log.line(&format!("[output] {}", line.trim()));
                continue;
            };
            if message["id"].as_i64() == Some(id) && message.get("method").is_none() {
                if let Some(error) = message.get("error") {
                    return Err(Failure {
                        code: error["code"].as_i64(),
                        message: error["message"].as_str().unwrap_or("The agent refused").to_string(),
                    });
                }
                return Ok(message["result"].clone());
            }
            self.handle(message)?;
        }
    }

    /// Something the agent sent that isn't the awaited response: an update, or a request.
    fn handle(&mut self, message: Value) -> std::result::Result<(), Failure> {
        let method = message["method"].as_str().unwrap_or_default().to_string();
        let params = &message["params"];
        if method == "session/update" {
            self.update(&params["update"]);
            return Ok(());
        }
        let Some(id) = message.get("id").cloned() else { return Ok(()) };
        if method.is_empty() {
            return Ok(()); // A response to nothing this client asked.
        }
        let response = if method == "session/request_permission" {
            json!({ "jsonrpc": "2.0", "id": id, "result": { "outcome": self.decide(params) } })
        } else {
            json!({ "jsonrpc": "2.0", "id": id, "error": { "code": METHOD_NOT_FOUND, "message": format!("Piccolo doesn't offer {method}") } })
        };
        self.send(response)
    }

    fn update(&mut self, update: &Value) {
        match update["sessionUpdate"].as_str().unwrap_or_default() {
            "agent_message_chunk" => {
                if let Some(text) = update["content"]["text"].as_str() {
                    self.log.text(text);
                }
            }
            "tool_call" => {
                let id = update["toolCallId"].as_str().unwrap_or_default().to_string();
                let tool = self.tools.entry(id).or_default();
                tool.merge(update);
                let title = tool.title.clone().unwrap_or_else(|| "a tool".into());
                self.log.line(&format!("[tool] {title}"));
            }
            "tool_call_update" => {
                let id = update["toolCallId"].as_str().unwrap_or_default().to_string();
                let tool = self.tools.entry(id).or_default();
                tool.merge(update);
                if update["status"].as_str() == Some("failed") {
                    let title = tool.title.clone().unwrap_or_else(|| "a tool".into());
                    self.log.line(&format!("[failed] {title}"));
                }
            }
            _ => {}
        }
    }

    /// Answers a permission request: reading and read-only commands are allowed, the rest refused.
    fn decide(&mut self, params: &Value) -> Value {
        let call = &params["toolCall"];
        let id = call["toolCallId"].as_str().unwrap_or_default().to_string();
        let tool = self.tools.entry(id).or_default();
        tool.merge(call);
        let tool = tool.clone();
        let allow = permitted(tool.kind.as_deref(), tool.command().as_deref());
        let what = tool.command().or(tool.title).unwrap_or_else(|| "a tool".into());
        self.log.line(&format!("[{}] {what}", if allow { "allowed" } else { "refused" }));
        let kinds: &[&str] = if allow { &["allow_once", "allow_always"] } else { &["reject_once", "reject_always"] };
        let options = params["options"].as_array().cloned().unwrap_or_default();
        let choice = kinds.iter().find_map(|kind| options.iter().find(|o| o["kind"].as_str() == Some(kind)));
        match choice.and_then(|o| o["optionId"].as_str()) {
            Some(option) => json!({ "outcome": "selected", "optionId": option }),
            None => json!({ "outcome": "cancelled" }),
        }
    }
}

/// The run's log: what the agent says, and a line per tool call and permission.
struct Log {
    file: File,
    at_line_start: bool,
}

impl Log {
    fn new(file: File) -> Self {
        Self { file, at_line_start: true }
    }

    fn text(&mut self, text: &str) {
        let _ = self.file.write_all(text.as_bytes());
        if !text.is_empty() {
            self.at_line_start = text.ends_with('\n');
        }
    }

    fn end_paragraph(&mut self) {
        if !self.at_line_start {
            self.text("\n");
        }
    }

    fn line(&mut self, line: &str) {
        self.end_paragraph();
        self.text(&format!("{line}\n"));
    }
}

// ---------------------------------------------------------------------------------------------
// What a reviewer may do

/// Whether a reviewer may run a tool of `kind` running `command`: reading, searching and thinking,
/// and shell commands that only read. Edits, deletes and moves aren't.
pub fn permitted(kind: Option<&str>, command: Option<&str>) -> bool {
    match kind {
        Some("read" | "search" | "think" | "fetch") => true,
        Some("edit" | "delete" | "move" | "switch_mode") => false,
        _ => command.is_some_and(read_only),
    }
}

/// Whether the shell `command` only reads: every command in it is a known reader, nothing is
/// written to a file, and nothing is substituted in that could run something else.
pub fn read_only(command: &str) -> bool {
    match split_commands(command) {
        Some(commands) => !commands.is_empty() && commands.iter().all(|words| reads_only(words)),
        None => false,
    }
}

/// Programs that only read (with the exceptions [`reads_only`] checks).
const READERS: &[&str] = &[
    "piccolo", "cd", "ls", "cat", "head", "tail", "wc", "grep", "egrep", "fgrep", "rg", "sort", "uniq", "cut", "tr",
    "nl", "file", "stat", "pwd", "echo", "printf", "true", "which", "tree", "jq", "diff", "cmp", "basename", "dirname",
    "realpath", "date", "find", "sed", "git",
];
/// Read-only git commands.
const GIT_READERS: &[&str] = &[
    "diff", "log", "show", "status", "blame", "grep", "ls-files", "ls-tree", "rev-parse", "merge-base", "cat-file",
    "describe", "shortlog", "rev-list", "name-rev", "branch",
];

fn reads_only(words: &[String]) -> bool {
    let Some(first) = words.first() else { return true };
    let program = first.rsplit('/').next().unwrap_or(first);
    if !READERS.contains(&program) {
        return false;
    }
    let args = &words[1..];
    match program {
        "find" => !args.iter().any(|a| a.starts_with("-exec") || a.starts_with("-ok") || a == "-delete" || a.starts_with("-fprint") || a == "-fls"),
        // Only printing lines: `sed -n 10,20p file`.
        "sed" => {
            args.iter().any(|a| a == "-n")
                && args.iter().filter(|a| !a.starts_with('-')).take(1).all(|script| {
                    script.strip_suffix('p').is_some_and(|range| range.chars().all(|c| c.is_ascii_digit() || c == ',' || c == '$'))
                })
        }
        "git" => git_reads_only(args),
        _ => true,
    }
}

fn git_reads_only(args: &[String]) -> bool {
    let mut args = args.iter();
    let command = loop {
        match args.next().map(String::as_str) {
            Some("--no-pager") => {}
            Some("-C") => {
                args.next();
            }
            Some(command) => break command,
            None => return true,
        }
    };
    let rest: Vec<&String> = args.collect();
    if !GIT_READERS.contains(&command) || rest.iter().any(|a| a.starts_with("--output") || *a == "-O" || a.starts_with("--open-files-in-pager")) {
        return false;
    }
    // `git branch` lists; with other arguments it creates, renames or deletes.
    command != "branch" || rest.iter().all(|a| matches!(a.as_str(), "-a" | "-r" | "-v" | "-vv" | "--list" | "--show-current" | "--all" | "--remotes"))
}

/// The commands in a shell command line, each as its words; `None` when it does something that
/// isn't plain commands: substitution (`$(…)`, backticks), subshells, or writing to a file.
/// Heredoc bodies are skipped: they're input, not commands.
fn split_commands(line: &str) -> Option<Vec<Vec<String>>> {
    let chars: Vec<char> = line.chars().collect();
    let mut commands: Vec<Vec<String>> = vec![Vec::new()];
    let mut word: Option<String> = None;
    let mut heredocs: Vec<String> = Vec::new();
    let mut i = 0;
    let end_word = |word: &mut Option<String>, commands: &mut Vec<Vec<String>>| {
        if let Some(w) = word.take() {
            commands.last_mut().unwrap().push(w);
        }
    };
    while i < chars.len() {
        let c = chars[i];
        match c {
            ' ' | '\t' => end_word(&mut word, &mut commands),
            '\'' => {
                let close = chars[i + 1..].iter().position(|&c| c == '\'')? + i + 1;
                word.get_or_insert_with(String::new).extend(&chars[i + 1..close]);
                i = close;
            }
            '"' => {
                let mut j = i + 1;
                let text = word.get_or_insert_with(String::new);
                loop {
                    match chars.get(j)? {
                        '"' => break,
                        '\\' => {
                            text.push(*chars.get(j + 1)?);
                            j += 1;
                        }
                        '`' => return None,
                        '$' if chars.get(j + 1) == Some(&'(') => return None,
                        c => text.push(*c),
                    }
                    j += 1;
                }
                i = j;
            }
            '\\' => {
                if let Some(&next) = chars.get(i + 1) {
                    if next != '\n' {
                        word.get_or_insert_with(String::new).push(next);
                    }
                    i += 1;
                }
            }
            '`' | '(' | ')' => return None,
            '$' if chars.get(i + 1) == Some(&'(') => return None,
            ';' | '|' | '&' | '\n' => {
                end_word(&mut word, &mut commands);
                // `&&`, `||`
                if (c == '&' || c == '|') && chars.get(i + 1) == Some(&c) {
                    i += 1;
                }
                commands.push(Vec::new());
                if c == '\n' && !heredocs.is_empty() {
                    // Skip each heredoc's body, up to its delimiter line.
                    let rest: String = chars[i + 1..].iter().collect();
                    let mut consumed = 0;
                    let mut lines = rest.split_inclusive('\n');
                    for delimiter in heredocs.drain(..) {
                        loop {
                            let line = lines.next()?;
                            consumed += line.chars().count();
                            if line.trim() == delimiter {
                                break;
                            }
                        }
                    }
                    i += consumed;
                }
            }
            '<' => {
                if chars.get(i + 1) == Some(&'(') {
                    return None;
                }
                if chars.get(i + 1) == Some(&'<') && chars.get(i + 2) != Some(&'<') {
                    // A heredoc: `<<EOF`, `<<-'EOF'`, `<< "EOF"`.
                    end_word(&mut word, &mut commands);
                    let mut j = i + 2;
                    if chars.get(j) == Some(&'-') {
                        j += 1;
                    }
                    while chars.get(j) == Some(&' ') {
                        j += 1;
                    }
                    let start = j;
                    while chars.get(j).is_some_and(|c| !c.is_whitespace() && !";|&".contains(*c)) {
                        j += 1;
                    }
                    let delimiter: String = chars[start..j].iter().filter(|c| **c != '\'' && **c != '"').collect();
                    if delimiter.is_empty() {
                        return None;
                    }
                    heredocs.push(delimiter);
                    i = j;
                    continue;
                }
                // Reading from a file (`<`) or a string (`<<<`) is fine.
                end_word(&mut word, &mut commands);
                while chars.get(i + 1) == Some(&'<') {
                    i += 1;
                }
            }
            '>' => {
                // Only to nowhere, or into another output: `2>&1`, `>/dev/null`, `2> /dev/null`.
                if word.as_deref().is_some_and(|w| w.chars().all(|c| c.is_ascii_digit())) {
                    word = None;
                }
                end_word(&mut word, &mut commands);
                let mut j = i + 1;
                if chars.get(j) == Some(&'>') {
                    j += 1;
                }
                if chars.get(j) == Some(&'&') {
                    let start = j + 1;
                    j = start;
                    while chars.get(j).is_some_and(|c| c.is_ascii_digit()) {
                        j += 1;
                    }
                    if j == start {
                        return None;
                    }
                } else {
                    while chars.get(j) == Some(&' ') {
                        j += 1;
                    }
                    let target: String = chars[j..].iter().take_while(|c| !c.is_whitespace() && !";|&".contains(**c)).collect();
                    if target != "/dev/null" {
                        return None;
                    }
                    j += target.chars().count();
                }
                i = j;
                continue;
            }
            c => word.get_or_insert_with(String::new).push(c),
        }
        i += 1;
    }
    if !heredocs.is_empty() {
        return None;
    }
    end_word(&mut word, &mut commands);
    commands.retain(|c| !c.is_empty());
    Some(commands)
}

// ---------------------------------------------------------------------------------------------
// Tauri commands

/// ACP agents installed on this computer.
#[tauri::command]
pub async fn list_agents() -> Result<Vec<InstalledAgent>> {
    blocking(|| Ok(installed())).await
}

/// Opens the log of review request `id` in the default text editor.
#[tauri::command]
pub async fn open_review_log(id: i64) -> Result<()> {
    let path = log_path(id);
    if !path.exists() {
        return Err("This review has no log".into());
    }
    let status = Command::new("open").arg("-t").arg(&path).status().map_err(|e| e.to_string())?;
    if !status.success() {
        return Err(format!("Couldn't open {}", path.display()));
    }
    Ok(())
}

/// Sessions Piccolo runs, for marking them running or not.
pub fn running_sessions() -> HashSet<String> {
    runs().lock().map(|runs| runs.keys().cloned().collect()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn commands(line: &str) -> Option<Vec<Vec<String>>> {
        split_commands(line)
    }

    #[test]
    fn splits_command_lines() {
        assert_eq!(
            commands("git diff main && piccolo comments --all | head -5; ls 'a b'").unwrap(),
            [vec!["git", "diff", "main"], vec!["piccolo", "comments", "--all"], vec!["head", "-5"], vec!["ls", "a b"]]
        );
        assert_eq!(commands("echo \"a; b\" 2>&1 >/dev/null").unwrap(), [vec!["echo", "a; b"]]);
        // A heredoc's body isn't commands.
        let heredoc = "piccolo comment --general - <<'EOF'\nThis; is | not > a command\nEOF\ngit status";
        assert_eq!(commands(heredoc).unwrap(), [vec!["piccolo", "comment", "--general", "-"], vec!["git", "status"]]);
        assert_eq!(commands("cat <<EOF\nunfinished"), None);
        for unsafe_line in ["echo $(rm -rf x)", "echo \"`id`\"", "(cd x; ls)", "cat a > b", "ls >> log", "diff <(ls) x"] {
            assert_eq!(commands(unsafe_line), None, "{unsafe_line}");
        }
    }

    #[test]
    fn allows_reading_and_refuses_changes() {
        for allowed in [
            "piccolo -C /wt comment --as gemini src/a.ts:3 \"Why?\"",
            "git -C /wt --no-pager diff abc123",
            "/usr/bin/git log --oneline -5",
            "rg -n 'fn main' src | head -20",
            "sed -n 10,40p src/a.rs",
            "find . -name '*.rs'",
            "git branch --show-current",
        ] {
            assert!(read_only(allowed), "{allowed}");
        }
        for refused in [
            "rm -rf src",
            "git commit -am x",
            "git branch -D main",
            "git diff --output=x",
            "sed -i s/a/b/ f",
            "sed -n 'w out' f",
            "find . -delete",
            "npm test",
            "FOO=1 ls",
            "",
        ] {
            assert!(!read_only(refused), "{refused}");
        }
        assert!(permitted(Some("read"), None));
        assert!(!permitted(Some("edit"), Some("ls")));
        assert!(permitted(Some("execute"), Some("git status")));
        assert!(!permitted(Some("execute"), Some("make")));
        assert!(!permitted(Some("other"), None));
    }

    /// A stand-in agent: answers ACP as `mode` says, asks permission for `rm -rf src` and
    /// `git diff`, and writes the answers it got to `answers`.
    const FAKE_AGENT: &str = r#"
import json, sys
mode, answers = sys.argv[1], open(sys.argv[2], "w")
def send(m): print(json.dumps(m), flush=True)
pending = {}
for line in sys.stdin:
    m = json.loads(line)
    if "method" not in m:
        answers.write(json.dumps(m.get("result") or {"error": m["error"]["code"]}, separators=(",", ":"), sort_keys=True) + "\n"); answers.flush(); continue
    if m["method"] == "initialize":
        send({"jsonrpc": "2.0", "id": m["id"], "result": {"protocolVersion": 1, "agentInfo": {"name": "fake", "version": "1"}, "authMethods": []}})
    elif m["method"] == "session/new":
        if mode == "signed-out":
            send({"jsonrpc": "2.0", "id": m["id"], "error": {"code": -32000, "message": "Authentication required"}})
        else:
            send({"jsonrpc": "2.0", "id": m["id"], "result": {"sessionId": "s1"}})
    elif m["method"] == "session/prompt":
        u = lambda update: send({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": "s1", "update": update}})
        answers.write(m["params"]["prompt"][0]["text"] + "\n")
        u({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "Looking at "}})
        u({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "the diff."}})
        u({"sessionUpdate": "tool_call", "toolCallId": "t1", "title": "Shell", "kind": "execute", "rawInput": {"command": "rm -rf src"}})
        options = [{"optionId": "yes", "name": "Allow", "kind": "allow_once"}, {"optionId": "no", "name": "Reject", "kind": "reject_once"}]
        send({"jsonrpc": "2.0", "id": 100, "method": "session/request_permission", "params": {"sessionId": "s1", "toolCall": {"toolCallId": "t1"}, "options": options}})
        send({"jsonrpc": "2.0", "id": 101, "method": "session/request_permission", "params": {"sessionId": "s1", "toolCall": {"toolCallId": "t2", "kind": "execute", "title": "git diff main"}, "options": options}})
        send({"jsonrpc": "2.0", "id": 102, "method": "fs/read_text_file", "params": {"sessionId": "s1", "path": "/etc/hosts"}})
        if mode == "slow":
            pending["prompt"] = m["id"]
        else:
            send({"jsonrpc": "2.0", "id": m["id"], "result": {"stopReason": "end_turn"}})
    elif m["method"] == "session/cancel":
        send({"jsonrpc": "2.0", "id": pending["prompt"], "result": {"stopReason": "cancelled"}})
"#;

    fn fake_run(name: &str, mode: &str, cancel: bool) -> (Result<String>, String, String) {
        let dir = std::env::temp_dir().join(format!("piccolo-acp-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let (script, answers, log) = (dir.join("agent.py"), dir.join("answers"), dir.join("log"));
        std::fs::write(&script, FAKE_AGENT).unwrap();
        let child = Command::new("python3")
            .args([script.as_os_str(), mode.as_ref(), answers.as_os_str()])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let flag = Arc::new(AtomicBool::new(false));
        if cancel {
            let flag = flag.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(500));
                flag.store(true, Ordering::SeqCst);
            });
        }
        let outcome = run(child, Log::new(File::create(&log).unwrap()), "fake", "/wt", "Review it", &flag);
        let read = |p: &Path| std::fs::read_to_string(p).unwrap_or_default();
        let result = (outcome, read(&answers), read(&log));
        std::fs::remove_dir_all(&dir).unwrap();
        result
    }

    #[test]
    fn drives_an_agent_through_a_review() {
        let (outcome, answers, log) = fake_run("review", "ok", false);
        assert_eq!(outcome.unwrap(), "end_turn");
        // The prompt, then: `rm` refused, `git diff` allowed, and no file system offered.
        let lines: Vec<&str> = answers.lines().collect();
        assert_eq!(
            lines,
            [
                "Review it",
                r#"{"outcome":{"optionId":"no","outcome":"selected"}}"#,
                r#"{"outcome":{"optionId":"yes","outcome":"selected"}}"#,
                r#"{"error":-32601}"#,
            ],
            "{answers}"
        );
        assert!(log.contains("[agent] fake 1\nLooking at the diff.\n[tool] Shell\n[refused] rm -rf src\n[allowed] git diff main\n"), "{log}");
    }

    #[test]
    fn says_when_the_agent_isnt_signed_in_and_stops_on_request() {
        let (outcome, _, _) = fake_run("auth", "signed-out", false);
        assert!(outcome.unwrap_err().contains("isn't signed in: run `fake` in a terminal"));
        let (outcome, _, _) = fake_run("cancel", "slow", true);
        assert_eq!(outcome.unwrap(), "cancelled");
    }

    #[test]
    fn reads_commands_from_tool_calls() {
        let mut tool = ToolCall::default();
        tool.merge(&json!({ "kind": "execute", "title": "`ls`", "rawInput": { "command": ["git", "status"] } }));
        assert_eq!(tool.command().as_deref(), Some("git status"));
        let titled = ToolCall { title: Some("`git log`".into()), ..Default::default() };
        assert_eq!(titled.command().as_deref(), Some("git log"));
        assert!(is_run("acp-12") && !is_run("acp-x") && !is_run("019a-…"));
    }
}
