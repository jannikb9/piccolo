// Shapes the Rust backend will return from milestone 2 onwards. Mock data conforms to them for now.

export type Repo = {
  id: string;
  name: string;
  path: string;
  defaultBranch: string;
  worktrees: Worktree[];
};

export type Worktree = {
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
  ahead: number;
  behind: number;
  additions: number;
  deletions: number;
  /** Last time anything in the worktree changed, epoch ms. */
  updatedAt: number;
};

export type FileStatus = "added" | "modified" | "deleted" | "renamed";

export type ChangedFile = {
  path: string;
  oldPath?: string;
  status: FileStatus;
  additions: number;
  deletions: number;
  binary?: boolean;
};

export type DiffScope = "all" | "committed" | "uncommitted";
export type DiffLayout = "split" | "unified";
