// Shapes returned by the Rust backend (src-tauri/src/repos.rs, git.rs).

export type Repo = {
  /** Root path of the main worktree. */
  id: string;
  name: string;
  path: string;
  /** Branch changes are compared against; `null` if none could be found. */
  defaultBranch: string | null;
  worktrees: Worktree[];
  /** Set when the repository can't be read, e.g. it was moved or deleted. */
  error: string | null;
};

export type Worktree = {
  /** Worktree path. */
  id: string;
  repoId: string;
  path: string;
  /** Folder name of the worktree checkout. */
  name: string;
  /** `null` when HEAD is detached. */
  branch: string | null;
  head: string;
  isMain: boolean;
  /** Has uncommitted changes. */
  dirty: boolean;
  /** Last time anything in the worktree changed, epoch ms. */
  updatedAt: number;
};

export type WorktreeStats = {
  ahead: number;
  behind: number;
  additions: number;
  deletions: number;
  /** Its commits are in the base branch (merged, squash-merged or rebased), so the worktree can go. */
  merged: boolean;
};

export type FileStatus = "added" | "modified" | "deleted" | "renamed";

export type ChangedFile = {
  path: string;
  oldPath?: string;
  status: FileStatus;
  additions: number;
  deletions: number;
  binary: boolean;
  /** Marked `linguist-generated` in `.gitattributes`. */
  generated: boolean;
};

/** A unified patch of all changes, and the two sides it compares. */
export type DiffPatch = {
  oldRev: string;
  /** `null` means the working tree. */
  newRev: string | null;
  patch: string;
};

/** Full contents of one file on both sides; `null` where it doesn't exist or isn't text. */
export type FileVersions = {
  old: string | null;
  new: string | null;
};

/** Which of the branch's changes to show; chosen in the toolbar's commit picker. */
export type ScopeMode = "all" | "committed" | "uncommitted";
/** A scope mode, or what a single commit changed. */
export type DiffScope = ScopeMode | { commit: string };

/** A commit on the branch under review (src-tauri/src/git.rs). */
export type Commit = {
  sha: string;
  shortSha: string;
  subject: string;
  author: string;
  /** Commit date, epoch ms. */
  time: number;
};

/** Changes the reviewer chose to leave out of the diff. */
export type DiffOptions = { ignoreWhitespace: boolean; hideImports: boolean };
export type DiffLayout = "split" | "unified";

/** A side of a diff: the old version (removed + unchanged lines) or the new one (added + unchanged). */
export type Side = "deletions" | "additions";

/** Commented lines. In the unified layout a range can start on removed lines and end on added ones. */
export type LineRange = { startSide: Side; startLine: number; endSide: Side; endLine: number };

export type ExcerptRow = {
  kind: "context" | "add" | "del";
  old: number | null;
  new: number | null;
  text: string;
  commented: boolean;
};

/** An image pasted into a message, saved as a file the agent can open. */
export type Attachment = {
  id: number;
  width: number;
  height: number;
  /** Where the PNG is on disk. */
  path: string;
};

export type CommentMessage = {
  id: number;
  author: "reviewer" | "agent";
  /** The agent's name when it gave one (`piccolo … --as codex`); Claude Code signs as `claude`. */
  authorName: string | null;
  body: string;
  attachments: Attachment[];
  createdAt: number;
  /** When the text was last changed, if it was. */
  editedAt: number | null;
  /** The reviewer gave an agent's message a thumbs up. */
  thumbsUp: boolean;
};

/** A comment on some lines and its replies. Stored per branch; agents answer via the `piccolo` CLI. */
export type Thread = {
  id: number;
  path: string;
  oldPath?: string;
  /** Where the comment was made. */
  range: LineRange;
  /** Where those lines are in the current diff; `null` when they changed (outdated). */
  position: LineRange | null;
  /** Closed: resolved, or dismissed. */
  resolved: boolean;
  /** Closed as not worth acting on; kept so an agent reviewing again doesn't raise it twice. Implies `resolved`. */
  dismissed: boolean;
  /** The diff around the commented lines when the comment was made. */
  excerpt: ExcerptRow[];
  messages: CommentMessage[];
  createdAt: number;
  updatedAt: number;
};

/**
 * A comment on the branch as a whole rather than some lines, like the text of a GitHub review
 * (`piccolo comment --general`). It has no file, lines or excerpt; replies work as on any thread.
 */
export type GeneralThread = Omit<Thread, "path" | "oldPath" | "range" | "position"> & {
  path: null;
  range: null;
  position: null;
};

/**
 * An agent session working on a worktree: a running Claude Code session in it (from Claude Code's
 * session registry), or any session that ran `piccolo` on it (src-tauri/src/sessions.rs).
 */
export type AgentSession = {
  id: string;
  /** Who runs it: `claude`, `codex`, or the name another agent gave. */
  agent: string;
  /** Its title, as its app shows it. */
  title: string | null;
  /** `busy` while a turn runs (comments sent then wait for it to end), else `idle`; running sessions only. */
  status: string | null;
  /** Whether it runs now: known for Claude Code sessions, `null` for other agents'. */
  running: boolean | null;
  /** The folder it runs in, when running: the worktree, or a folder above it holding several repositories. */
  cwd: string | null;
  inWorktree: boolean;
  startedAt: number | null;
  /** When it last ran a `piccolo` command on the worktree. */
  lastSeen: number | null;
  /** Piccolo can send it messages: a running Claude Code session, or a Codex thread (queued with the Codex CLI). */
  reachable: boolean;
  /** The model it last answered with, as its API names it (e.g. `claude-opus-5-5`), when its transcript says. */
  model: string | null;
};

/**
 * What an agent was asked to do (src-tauri/src/requests.rs): review the branch, or address comments
 * on it. A session's role follows from the latest one it was asked.
 */
export type ReviewRequest = {
  id: number;
  kind: "review" | "implement";
  /** Who was asked: `claude`, `codex`, or another agent's name. */
  agent: string;
  /** The session doing it, once it took the request on. */
  sessionId: string | null;
  /** The commit the branch was at when it was asked. */
  head: string | null;
  /** The comments to address, for an implement request. */
  threads: number[];
  requestedAt: number;
  /** When the agent took it on; `null` while waiting for it to start. */
  startedAt: number | null;
  /** When the agent said it's done. */
  finishedAt: number | null;
  /** Comments and replies the agent wrote meanwhile. */
  comments: number;
};

/** What's going on in a worktree's sessions. */
export type SessionActivity = {
  /** Open threads each session hasn't seen, by session id. */
  unseen: Record<string, number[]>;
  /** All open threads, which a new session is given. */
  open: number[];
  /** Who started each open thread: an agent's name, or `null` for the reviewer. */
  startedBy: Record<number, string | null>;
  /** Comments and replies each session wrote on the branch, by session id. */
  written: Record<string, number>;
  /** Newest first. */
  requests: ReviewRequest[];
};

/** A line mentioning a name, from a whole-word search (src-tauri/src/navigate.rs). */
export type SymbolHit = {
  path: string;
  line: number;
  /** The line without indentation, cut around the name when long. */
  text: string;
  /** The line looks like it defines the name (`function name`, `class Name`, …). */
  definition: boolean;
};

export type SymbolSearch = {
  hits: SymbolHit[];
  /** Some references were left out. */
  truncated: boolean;
};

/** A branch on a remote, to check out in a new worktree. */
export type RemoteBranch = {
  /** The local branch name, e.g. `feat/x` for `origin/feat/x`. */
  name: string;
  remoteRef: string;
  author: string;
  subject: string;
  /** Commit date of the tip, epoch ms. */
  updatedAt: number;
};
