import { getVersion } from "@tauri-apps/api/app";
import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask, message, open } from "@tauri-apps/plugin-dialog";
import {
  mockAddGeneralThread,
  mockAddThread,
  mockAttachmentData,
  mockCheckUpdate,
  mockInstallUpdate,
  mockInstallWorktrunk,
  mockWorktrunkInstalled,
  mockAddWorktree,
  mockChangedFiles,
  mockCommits,
  mockDeleteComment,
  mockDiffPatch,
  mockEditComment,
  mockSetThumbsUp,
  mockFileText,
  mockFileVersions,
  mockFindSymbol,
  mockRemoteBranches,
  mockReorderRepos,
  mockReply,
  mockCopyPrompt,
  mockRequestReview,
  mockSendComments,
  mockSessionActivity,
  mockSessions,
  mockRepos,
  mockSetDismissed,
  mockSetResolved,
  mockThreads,
  mockWorktreeStats,
} from "../mock";
import type { ImageUpload } from "./images";
import type {
  AgentSession,
  AvailableUpdate,
  ChangedFile,
  Commit,
  DiffOptions,
  DiffPatch,
  DiffScope,
  DownloadProgress,
  FileVersions,
  GeneralThread,
  LineRange,
  RemoteBranch,
  Repo,
  ReviewRequest,
  SessionActivity,
  SymbolSearch,
  Thread,
  WorktreeStats,
} from "../types";

export const isTauri = "__TAURI_INTERNALS__" in window;

/** Backend commands. In a plain browser (UI development) they resolve to placeholder data. */
export const api = {
  // A copy, as the backend returns fresh data: a worktree added to the mock shows up everywhere.
  listRepos: (): Promise<Repo[]> => (isTauri ? invoke("list_repos") : Promise.resolve(structuredClone(mockRepos))),

  /** Resolves to the repository root, which is also the id of its main worktree. */
  addRepo: (path: string): Promise<string> => invoke("add_repo", { path }),

  removeRepo: (id: string): Promise<void> => (isTauri ? invoke("remove_repo", { id }) : Promise.resolve()),

  /** Saves the sidebar order of repositories. */
  reorderRepos: (ids: string[]): Promise<void> => (isTauri ? invoke("reorder_repos", { ids }) : mockReorderRepos(ids)),

  worktreeStats: (path: string, base: string | null): Promise<WorktreeStats> =>
    isTauri ? invoke("worktree_stats", { path, base }) : mockWorktreeStats(path),

  changedFiles: (path: string, base: string | null, scope: DiffScope, options: DiffOptions): Promise<ChangedFile[]> =>
    isTauri ? invoke("changed_files", { path, base, scope, options }) : mockChangedFiles(path, scope),

  diffPatch: (path: string, base: string | null, scope: DiffScope, options: DiffOptions): Promise<DiffPatch> =>
    isTauri ? invoke("diff_patch", { path, base, scope, options }) : mockDiffPatch(path, scope),

  /** The branch's own commits (not in `base`), newest first. */
  commits: (path: string, base: string | null): Promise<Commit[]> =>
    isTauri ? invoke("commits", { path, base }) : mockCommits(path),

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
  listThreads: (path: string, base: string | null, scope: DiffScope): Promise<(Thread | GeneralThread)[]> =>
    isTauri ? invoke("list_threads", { path, base, scope }) : mockThreads(path),

  /** Remote branches as of the last fetch, most recently committed first. */
  remoteBranches: (repo: string): Promise<RemoteBranch[]> =>
    isTauri ? invoke("remote_branches", { repo }) : mockRemoteBranches(),

  /** `git fetch` from every remote. */
  fetchRemotes: (repo: string): Promise<void> =>
    isTauri ? invoke("fetch_remotes", { repo }) : new Promise((resolve) => setTimeout(resolve, 1200)),

  /** Checks out a branch in a new worktree (or finds the one it's in); resolves to the worktree's id. */
  addWorktree: (repo: string, branch: RemoteBranch): Promise<string> =>
    isTauri ? invoke("add_worktree", { repo, branch: branch.name, remoteRef: branch.remoteRef }) : mockAddWorktree(repo, branch.name),

  /** Deletes a linked worktree's folder; its branch stays. `force` discards uncommitted changes. */
  removeWorktree: (repo: string, path: string, force: boolean): Promise<void> =>
    isTauri ? invoke("remove_worktree", { repo, path, force }) : Promise.resolve(),

  /** Resolves to the new thread's id. */
  addThread: (args: {
    path: string;
    base: string | null;
    scope: DiffScope;
    file: string;
    oldFile: string | null;
    range: LineRange;
    body: string;
    images: ImageUpload[];
  }): Promise<number> =>
    isTauri ? invoke("add_thread", args) : mockAddThread(args.path, args.file, args.range, args.body, args.images),

  /** A comment on the worktree's branch as a whole; resolves to the new thread's id. */
  addGeneralThread: (path: string, body: string, images: ImageUpload[]): Promise<number> =>
    isTauri ? invoke("add_general_thread", { path, body, images }) : mockAddGeneralThread(path, body, images),

  replyThread: (id: number, body: string, images: ImageUpload[]): Promise<void> =>
    isTauri ? invoke("reply_thread", { id, body, images }) : mockReply(id, body, images),

  /** Replaces a message's text and attaches more images. */
  editComment: (id: number, body: string, images: ImageUpload[]): Promise<void> =>
    isTauri ? invoke("edit_comment", { id, body, images }) : mockEditComment(id, body, images),

  /** Gives an agent's message a thumbs up, or takes it back. */
  setThumbsUp: (id: number, thumbsUp: boolean): Promise<void> =>
    isTauri ? invoke("set_thumbs_up", { id, thumbsUp }) : mockSetThumbsUp(id, thumbsUp),

  /** An attached image as base64. */
  attachmentData: (id: number): Promise<string> =>
    isTauri ? invoke("attachment_data", { id }) : mockAttachmentData(id),

  setThreadResolved: (id: number, resolved: boolean): Promise<void> =>
    isTauri ? invoke("set_thread_resolved", { id, resolved }) : mockSetResolved(id, resolved),

  /** Closes a thread without acting on it (kept, so agents don't raise it again), or reopens it. */
  setThreadDismissed: (id: number, dismissed: boolean): Promise<void> =>
    isTauri ? invoke("set_thread_dismissed", { id, dismissed }) : mockSetDismissed(id, dismissed),

  /** Asks any agent for `kind` of work and returns the prompt, to copy into one. */
  copyPrompt: (path: string, kind: ReviewRequest["kind"]): Promise<string> =>
    isTauri ? invoke("copy_prompt", { path, kind }) : mockCopyPrompt(path, kind),

  /** Agent sessions working on each worktree (by path); worktrees without one are left out. */
  listSessions: (paths: string[]): Promise<Record<string, AgentSession[]>> =>
    isTauri ? invoke("list_sessions", { paths }) : mockSessions(paths),

  /** What each session on the worktree hasn't seen, and the reviews requested there. */
  sessionActivity: (path: string): Promise<SessionActivity> =>
    isTauri ? invoke("session_activity", { path }) : mockSessionActivity(path),

  /** Sends the comments the running `session` hasn't seen to it, to address. */
  sendComments: (path: string, session: string): Promise<ReviewRequest> =>
    isTauri ? invoke("send_comments", { path, session }) : mockSendComments(path, session),

  /** Asks the running `session` to review the worktree. */
  requestReview: (path: string, session: string): Promise<ReviewRequest> =>
    isTauri ? invoke("request_review", { path, session }) : mockRequestReview(path, session),


  /** Deletes a message; deleting a thread's first message deletes the thread. */
  deleteComment: (id: number): Promise<void> => (isTauri ? invoke("delete_comment", { id }) : mockDeleteComment(id)),

  /** Lines mentioning `name` in files of the same language as `from`, at `rev` (`null`: the working tree). */
  findSymbol: (path: string, rev: string | null, name: string, from: string): Promise<SymbolSearch> =>
    isTauri ? invoke("find_symbol", { path, rev, name, from }) : mockFindSymbol(path, rev, name, from),

  /** `null` when the file doesn't exist at `rev` or isn't text. */
  fileText: (path: string, rev: string | null, file: string): Promise<string | null> =>
    isTauri ? invoke("file_text", { path, rev, file }) : mockFileText(path, rev, file),

  /** The newest release on GitHub when it's newer than the running app. */
  checkUpdate: (): Promise<AvailableUpdate | null> => (isTauri ? invoke("check_update") : mockCheckUpdate()),

  /** Downloads and installs the release `checkUpdate` found, then restarts the app into it. */
  installUpdate: (onProgress: (progress: DownloadProgress) => void): Promise<void> => {
    if (!isTauri) return mockInstallUpdate(onProgress);
    const channel = new Channel<DownloadProgress>();
    channel.onmessage = onProgress;
    return invoke("install_update", { onProgress: channel });
  },

  /** Whether worktrunk (`wt`), which Piccolo uses for creating and removing worktrees, is installed. */
  worktrunkInstalled: (): Promise<boolean> => (isTauri ? invoke("worktrunk_installed") : mockWorktrunkInstalled()),

  /** `brew install worktrunk`, or without Homebrew a download of `wt` into `~/.local/bin`. */
  installWorktrunk: (): Promise<void> => (isTauri ? invoke("install_worktrunk") : mockInstallWorktrunk()),

  appVersion: (): Promise<string> => (isTauri ? getVersion() : Promise.resolve("0.0.0")),
};

export async function pickRepoFolder(): Promise<string | null> {
  if (!isTauri) return null;
  const path = await open({ directory: true, title: "Add repository" });
  return typeof path === "string" ? path : null;
}

/** A native yes/no alert: `title` is its headline, `text` (optional) the detail below it. */
export function confirmAction(title: string, text: string, okLabel: string): Promise<boolean> {
  if (!isTauri) return Promise.resolve(window.confirm(text ? `${title}\n\n${text}` : title));
  return ask(text, { title, kind: "warning", okLabel, cancelLabel: "Cancel" });
}

export async function showInfo(title: string, text: string): Promise<void> {
  if (!isTauri) return window.alert(`${title}\n\n${text}`);
  await message(text, { title, kind: "info" });
}

export async function showError(title: string, text: string): Promise<void> {
  if (!isTauri) return window.alert(`${title}\n\n${text}`);
  await message(text, { title, kind: "error" });
}

/** Fires when worktrees are added/removed or a worktree switches branch. */
export function onRepoChanged(callback: (repoId: string) => void): () => void {
  if (!isTauri) return () => {};
  const unlisten = listen<string>("repo-changed", (e) => callback(e.payload));
  return () => void unlisten.then((fn) => fn());
}

/** Fires when comments change, including replies an agent writes with the `piccolo` command. */
export function onCommentsChanged(callback: () => void): () => void {
  if (!isTauri) return () => {};
  const unlisten = listen("comments-changed", () => callback());
  return () => void unlisten.then((fn) => fn());
}

/** Fires when Claude Code sessions start, end, or change status or title. */
export function onSessionsChanged(callback: () => void): () => void {
  if (!isTauri) return () => {};
  const unlisten = listen("sessions-changed", () => callback());
  return () => void unlisten.then((fn) => fn());
}

/** Fires when Settings is chosen in the app menu (⌘,), or opened from inside the app (`openSettings`). */
export function onOpenSettings(callback: () => void): () => void {
  const onEvent = () => callback();
  window.addEventListener("open-settings", onEvent);
  const unlisten = isTauri ? listen("open-settings", onEvent) : null;
  return () => {
    window.removeEventListener("open-settings", onEvent);
    void unlisten?.then((fn) => fn());
  };
}

/** Opens Settings, e.g. from a link in a menu. */
export const openSettings = () => window.dispatchEvent(new Event("open-settings"));

/** Fires when Piccolo > Check for Updates… is chosen. */
export function onCheckForUpdates(callback: () => void): () => void {
  if (!isTauri) return () => {};
  const unlisten = listen("check-for-updates", () => callback());
  return () => void unlisten.then((fn) => fn());
}

/** Fires when View > Toggle Sidebar is chosen (⌃⌘S). */
export function onToggleSidebar(callback: () => void): () => void {
  if (!isTauri) return () => {};
  const unlisten = listen("toggle-sidebar", () => callback());
  return () => void unlisten.then((fn) => fn());
}

export function onWindowFocusChanged(callback: (focused: boolean) => void): () => void {
  if (!isTauri) return () => {};
  const unlisten = getCurrentWindow().onFocusChanged((e) => callback(e.payload));
  return () => void unlisten.then((fn) => fn());
}
