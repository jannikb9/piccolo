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

/** Which of the branch's changes to show; chosen with the toolbar's segmented control. */
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
  /** When the reviewer sent it to an agent's session; `null` until then (and for agents'). */
  sentAt: number | null;
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
  resolved: boolean;
  /** The diff around the commented lines when the comment was made. */
  excerpt: ExcerptRow[];
  messages: CommentMessage[];
  /** Open, and the reviewer has the last word but hasn't sent it to an agent yet. */
  pending: boolean;
  createdAt: number;
  updatedAt: number;
};

/** An agent comments can be sent to in a new session. */
export type AgentKind = "claude" | "codex";

/** A running Claude Code session that works on a worktree, from Claude Code's session registry. */
export type AgentSession = {
  id: string;
  /** Who runs it; only `claude` so far. */
  agent: string;
  /** Its title, as Claude Code shows it in its sidebar. */
  title: string | null;
  /** `busy` while a turn runs (comments sent then wait for it to end), else `idle`. */
  status: string | null;
  /** The folder it runs in: the worktree, or a folder above it holding several repositories. */
  cwd: string;
  inWorktree: boolean;
  startedAt: number;
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
