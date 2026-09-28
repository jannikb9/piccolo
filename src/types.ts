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

export type DiffScope = "all" | "committed" | "uncommitted";
export type DiffLayout = "split" | "unified";
