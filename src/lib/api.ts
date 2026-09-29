import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import {
  mockAddThread,
  mockChangedFiles,
  mockDeleteComment,
  mockDiffPatch,
  mockFileVersions,
  mockReorderRepos,
  mockReply,
  mockRepos,
  mockSetResolved,
  mockThreads,
  mockWorktreeStats,
} from "../mock";
import type { ChangedFile, DiffPatch, DiffScope, FileVersions, LineRange, Repo, Thread, WorktreeStats } from "../types";

export const isTauri = "__TAURI_INTERNALS__" in window;

/** Backend commands. In a plain browser (UI development) they resolve to placeholder data. */
export const api = {
  listRepos: (): Promise<Repo[]> => (isTauri ? invoke("list_repos") : Promise.resolve(mockRepos)),

  /** Resolves to the repository root, which is also the id of its main worktree. */
  addRepo: (path: string): Promise<string> => invoke("add_repo", { path }),

  removeRepo: (id: string): Promise<void> => (isTauri ? invoke("remove_repo", { id }) : Promise.resolve()),

  /** Saves the sidebar order of repositories. */
  reorderRepos: (ids: string[]): Promise<void> => (isTauri ? invoke("reorder_repos", { ids }) : mockReorderRepos(ids)),

  worktreeStats: (path: string, base: string | null): Promise<WorktreeStats> =>
    isTauri ? invoke("worktree_stats", { path, base }) : mockWorktreeStats(path),

  changedFiles: (path: string, base: string | null, scope: DiffScope, ignoreWhitespace: boolean): Promise<ChangedFile[]> =>
    isTauri ? invoke("changed_files", { path, base, scope, ignoreWhitespace }) : mockChangedFiles(path, scope),

  diffPatch: (path: string, base: string | null, scope: DiffScope, ignoreWhitespace: boolean): Promise<DiffPatch> =>
    isTauri ? invoke("diff_patch", { path, base, scope, ignoreWhitespace }) : mockDiffPatch(path, scope),

  fileVersions: (
    path: string,
    range: Pick<DiffPatch, "oldRev" | "newRev">,
    oldPath: string,
    newPath: string,
  ): Promise<FileVersions> =>
    isTauri
      ? invoke("file_versions", { path, oldRev: range.oldRev, newRev: range.newRev, oldPath, newPath })
      : mockFileVersions(),

  /** Comment threads on the worktree's branch, positioned for this diff. */
  listThreads: (path: string, base: string | null, scope: DiffScope): Promise<Thread[]> =>
    isTauri ? invoke("list_threads", { path, base, scope }) : mockThreads(path),

  /** Resolves to the new thread's id. */
  addThread: (args: {
    path: string;
    base: string | null;
    scope: DiffScope;
    file: string;
    oldFile: string | null;
    range: LineRange;
    body: string;
  }): Promise<number> => (isTauri ? invoke("add_thread", args) : mockAddThread(args.path, args.file, args.range, args.body)),

  replyThread: (id: number, body: string): Promise<void> =>
    isTauri ? invoke("reply_thread", { id, body }) : mockReply(id, body),

  setThreadResolved: (id: number, resolved: boolean): Promise<void> =>
    isTauri ? invoke("set_thread_resolved", { id, resolved }) : mockSetResolved(id, resolved),

  /** Deletes a message; deleting a thread's first message deletes the thread. */
  deleteComment: (id: number): Promise<void> => (isTauri ? invoke("delete_comment", { id }) : mockDeleteComment(id)),
};

export async function pickRepoFolder(): Promise<string | null> {
  if (!isTauri) return null;
  const path = await open({ directory: true, title: "Add repository" });
  return typeof path === "string" ? path : null;
}

/** Fires when worktrees are added/removed or a worktree switches branch. */
export function onRepoChanged(callback: (repoId: string) => void): () => void {
  if (!isTauri) return () => {};
  const unlisten = listen<string>("repo-changed", (e) => callback(e.payload));
  return () => void unlisten.then((fn) => fn());
}

/** Fires when comments change, including replies an agent writes with the `review` command. */
export function onCommentsChanged(callback: () => void): () => void {
  if (!isTauri) return () => {};
  const unlisten = listen("comments-changed", () => callback());
  return () => void unlisten.then((fn) => fn());
}

/** Fires when "Settings…" is chosen from the app menu (⌘,). */
export function onOpenSettings(callback: () => void): () => void {
  if (!isTauri) return () => {};
  const unlisten = listen("open-settings", () => callback());
  return () => void unlisten.then((fn) => fn());
}

export function onWindowFocusChanged(callback: (focused: boolean) => void): () => void {
  if (!isTauri) return () => {};
  const unlisten = getCurrentWindow().onFocusChanged((e) => callback(e.payload));
  return () => void unlisten.then((fn) => fn());
}
