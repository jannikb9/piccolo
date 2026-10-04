import { focusManager, QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { useStore } from "../store";
import type { DraftImage } from "./images";
import { toUpload } from "./images";
import type { AgentKind, AgentSession, SessionActivity, DiffOptions, DiffScope, GeneralThread, LineRange, RemoteBranch, Repo, Thread, Worktree } from "../types";
import {
  api,
  confirmAction,
  onCommentsChanged,
  onRepoChanged,
  onSessionsChanged,
  onWindowFocusChanged,
  pickRepoFolder,
  showError,
} from "./api";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Cached data renders immediately when switching back to a worktree; it refreshes in the background.
      staleTime: 5_000,
      retry: 1,
    },
  },
});

export const keys = {
  repos: ["repos"] as const,
  stats: (path: string, base: string | null) => ["stats", path, base] as const,
  commits: (path: string, base: string | null) => ["commits", path, base] as const,
  files: (path: string, base: string | null, scope: DiffScope, options: DiffOptions) =>
    ["files", path, base, scope, options] as const,
  patch: (path: string, base: string | null, scope: DiffScope, options: DiffOptions) =>
    ["patch", path, base, scope, options] as const,
  /** `revision` identifies the diff; threads are re-positioned whenever it changes. */
  threads: (path: string, base: string | null, scope: DiffScope, revision: number) =>
    ["threads", path, base, scope, revision] as const,
  sessions: (paths: string[]) => ["sessions", paths] as const,
  activity: (path: string) => ["sessions", "activity", path] as const,
  symbol: (path: string, rev: string | null, name: string, from: string) => ["symbol", path, rev, name, from] as const,
  fileText: (path: string, rev: string | null, file: string) => ["file-text", path, rev, file] as const,
  branches: (repoId: string) => ["branches", repoId] as const,
  fetch: (repoId: string) => ["fetch", repoId] as const,
};

/** Keeps showing the previous result while switching scope or diff options, but never another worktree's. */
const sameWorktree =
  (path: string | undefined) =>
  <T>(previous: T | undefined, previousQuery?: { queryKey: readonly unknown[] }) =>
    previousQuery?.queryKey[1] === path ? previous : undefined;

export function useRepos() {
  return useQuery({ queryKey: keys.repos, queryFn: api.listRepos });
}

export function useWorktreeStats(worktree: Worktree, base: string | null) {
  return useQuery({
    queryKey: keys.stats(worktree.path, base),
    queryFn: () => api.worktreeStats(worktree.path, base),
  });
}

/** The branch's own commits, newest first. */
export function useCommits(worktree: Worktree | undefined, base: string | null) {
  return useQuery({
    queryKey: keys.commits(worktree?.path ?? "", base),
    queryFn: () => api.commits(worktree!.path, base),
    enabled: !!worktree,
  });
}

/**
 * What the diff shows: the commit chosen for this worktree, or else the scope mode. A commit that
 * left the branch (amended, rebased away) falls back to the mode.
 */
export function useDiffScope(worktree: Worktree | undefined, base: string | null): DiffScope {
  const mode = useStore((s) => s.scope);
  const sha = useStore((s) => (worktree ? s.commits[worktree.id] : undefined));
  const commits = useCommits(worktree, base).data;
  const known = !!sha && (!commits || commits.some((c) => c.sha === sha));
  return useMemo(() => (known ? { commit: sha! } : mode), [known, sha, mode]);
}

export function useChangedFiles(worktree: Worktree | undefined, base: string | null, scope: DiffScope, options: DiffOptions) {
  return useQuery({
    queryKey: keys.files(worktree?.path ?? "", base, scope, options),
    queryFn: () => api.changedFiles(worktree!.path, base, scope, options),
    enabled: !!worktree,
    placeholderData: sameWorktree(worktree?.path),
  });
}

export function useDiffPatch(worktree: Worktree | undefined, base: string | null, scope: DiffScope, options: DiffOptions) {
  return useQuery({
    queryKey: keys.patch(worktree?.path ?? "", base, scope, options),
    queryFn: () => api.diffPatch(worktree!.path, base, scope, options),
    enabled: !!worktree,
    placeholderData: sameWorktree(worktree?.path),
  });
}

export function useThreads(worktree: Worktree | undefined, base: string | null, scope: DiffScope, revision: number) {
  return useQuery({
    queryKey: keys.threads(worktree?.path ?? "", base, scope, revision),
    queryFn: () => api.listThreads(worktree!.path, base, scope),
    enabled: !!worktree,
    placeholderData: sameWorktree(worktree?.path),
  });
}

const NO_SESSIONS: AgentSession[] = [];

/**
 * Agent sessions working on each worktree, read again whenever Claude Code's registry or the
 * comments database changes (see `useLiveGitData`). The slow poll only catches sessions that
 * crashed, which leave their registry file behind.
 */
function useAllSessions() {
  const repos = useRepos().data;
  const paths = useMemo(() => repos?.flatMap((r) => r.worktrees.map((w) => w.path)).sort() ?? [], [repos]);
  return useQuery({
    queryKey: keys.sessions(paths),
    queryFn: () => api.listSessions(paths),
    enabled: paths.length > 0,
    refetchInterval: 30_000,
    placeholderData: (previous) => previous,
  });
}

/** Agent sessions working on the worktree: running in it, or having run `piccolo` on it. */
export function useSessions(worktree: Worktree): AgentSession[] {
  return useAllSessions().data?.[worktree.path] ?? NO_SESSIONS;
}

const NO_ACTIVITY: SessionActivity = { unseen: {}, open: [], requests: [] };

/** What each of the worktree's sessions hasn't seen, and the reviews requested on it. */
export function useSessionActivity(worktree: Worktree): SessionActivity {
  return (
    useQuery({
      queryKey: keys.activity(worktree.path),
      queryFn: () => api.sessionActivity(worktree.path),
      placeholderData: sameWorktree(worktree.path),
    }).data ?? NO_ACTIVITY
  );
}

/** Where comments go: a running session, or a new one of an agent. */
export type SendTarget = { session: string } | { newAgent: AgentKind };

/**
 * Sends `threads`, or else what the session hasn't seen (all open comments for a new one), to a
 * session or a new one.
 */
export function useSendComments(worktree: Worktree) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ to, threads }: { to: SendTarget; threads: number[] | null }) =>
      "session" in to
        ? api.sendComments(worktree.path, to.session, threads)
        : api.startSession(worktree.path, to.newAgent, threads),
    onError: (error) => showError("Couldn't send the comments", String(error)),
    onSettled: () => client.invalidateQueries({ queryKey: ["sessions"] }),
  });
}

/** Asks a running session, or a new session of an agent, to review the worktree. */
export function useRequestReview(worktree: Worktree) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (to: { session: string } | { agent: AgentKind }) => api.requestReview(worktree.path, to),
    onError: (error) => showError("Couldn't request a review", String(error)),
    onSettled: () => client.invalidateQueries({ queryKey: ["sessions"] }),
  });
}

/** Withdraws a review request, or removes a finished review from the list. */
export function useCancelReviewRequest() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.cancelReviewRequest(id),
    onSettled: () => client.invalidateQueries({ queryKey: ["sessions"] }),
  });
}

/** Where `name` is defined and used, at `rev` (`null`: the working tree). */
export function useSymbolSearch(worktreePath: string, rev: string | null, name: string, from: string) {
  return useQuery({
    queryKey: keys.symbol(worktreePath, rev, name, from),
    queryFn: () => api.findSymbol(worktreePath, rev, name, from),
  });
}

/** One file's contents at `rev` (`null`: the working tree). */
export function useFileText(worktreePath: string, rev: string | null, file: string) {
  return useQuery({
    queryKey: keys.fileText(worktreePath, rev, file),
    queryFn: () => api.fileText(worktreePath, rev, file),
  });
}

/** Wraps a comment mutation so the threads refresh once it lands. */
function useCommentMutation<T>(mutationFn: (args: T) => Promise<unknown>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn,
    onSettled: () => {
      client.invalidateQueries({ queryKey: ["threads"] });
      // What sessions haven't seen changes with every comment.
      client.invalidateQueries({ queryKey: ["sessions", "activity"] });
    },
  });
}

export function useAddThread(worktree: Worktree, base: string | null, scope: DiffScope) {
  return useCommentMutation(
    ({ images, ...args }: { file: string; oldFile: string | null; range: LineRange; body: string; images: DraftImage[] }) =>
      api.addThread({ path: worktree.path, base, scope, ...args, images: images.map(toUpload) }),
  );
}

/** A comment on the worktree's branch as a whole. */
export const useAddGeneralThread = (worktree: Worktree) =>
  useCommentMutation(({ body, images }: { body: string; images: DraftImage[] }) =>
    api.addGeneralThread(worktree.path, body, images.map(toUpload)),
  );

export const useReplyThread = () =>
  useCommentMutation((args: { id: number; body: string; images: DraftImage[] }) =>
    api.replyThread(args.id, args.body, args.images.map(toUpload)),
  );

/** A pasted image as a data URL. Attachments never change, so it's loaded once. */
export function useAttachment(id: number) {
  return useQuery({
    queryKey: ["attachment", id],
    queryFn: async () => `data:image/png;base64,${await api.attachmentData(id)}`,
    staleTime: Infinity,
  });
}

export const useEditComment = () =>
  useCommentMutation((args: { id: number; body: string; images: DraftImage[] }) =>
    api.editComment(args.id, args.body, args.images.map(toUpload)),
  );

/** Applied to the cached threads at once, so the thumb doesn't wait for the database. */
export function useSetThumbsUp() {
  const client = useQueryClient();
  const patch = (id: number, thumbsUp: boolean) =>
    client.setQueriesData<(Thread | GeneralThread)[]>({ queryKey: ["threads"] }, (threads) =>
      threads?.map((t) => ({ ...t, messages: t.messages.map((m) => (m.id === id ? { ...m, thumbsUp } : m)) })),
    );
  return useMutation({
    mutationFn: (args: { id: number; thumbsUp: boolean }) => api.setThumbsUp(args.id, args.thumbsUp),
    onMutate: (args) => patch(args.id, args.thumbsUp),
    onError: (_error, args) => patch(args.id, !args.thumbsUp),
    onSettled: () => client.invalidateQueries({ queryKey: ["threads"] }),
  });
}

export const useSetThreadResolved = () =>
  useCommentMutation((args: { id: number; resolved: boolean }) => api.setThreadResolved(args.id, args.resolved));

export const useSetThreadDismissed = () =>
  useCommentMutation((args: { id: number; dismissed: boolean }) => api.setThreadDismissed(args.id, args.dismissed));

export const useDeleteComment = () => useCommentMutation((id: number) => api.deleteComment(id));

/** Loading on hover makes the click feel instant. */
export function prefetchWorktree(worktree: Worktree, base: string | null, scope: DiffScope, options: DiffOptions) {
  queryClient.prefetchQuery({
    queryKey: keys.files(worktree.path, base, scope, options),
    queryFn: () => api.changedFiles(worktree.path, base, scope, options),
  });
  queryClient.prefetchQuery({
    queryKey: keys.patch(worktree.path, base, scope, options),
    queryFn: () => api.diffPatch(worktree.path, base, scope, options),
  });
}

/** Picks a folder, adds its repository and selects the repository's main worktree. */
export function useAddRepo() {
  const client = useQueryClient();
  const selectWorktree = useStore((s) => s.selectWorktree);
  return useMutation({
    mutationFn: async () => {
      const folder = await pickRepoFolder();
      return folder ? api.addRepo(folder) : null;
    },
    onSuccess: async (root) => {
      if (!root) return;
      await client.invalidateQueries({ queryKey: keys.repos });
      selectWorktree(root);
    },
  });
}

export function useRemoveRepo() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: api.removeRepo,
    onSuccess: (_, id) => client.setQueryData<Repo[]>(keys.repos, (repos) => repos?.filter((r) => r.id !== id)),
  });
}

/**
 * Deletes a worktree's folder (keeping its branch) and selects the repository's main worktree.
 * Asks first, unless the branch is merged and nothing uncommitted would be lost.
 */
export function useDeleteWorktree() {
  const client = useQueryClient();
  const selectWorktree = useStore((s) => s.selectWorktree);
  return useMutation({
    mutationFn: async ({ worktree, merged }: { worktree: Worktree; merged: boolean }) => {
      if (!merged || worktree.dirty) {
        const confirmed = await confirmAction(`Are you sure you want to delete ${worktree.name}?`, "", "Delete");
        if (!confirmed) return false;
      }
      await api.removeWorktree(worktree.repoId, worktree.path, worktree.dirty);
      return true;
    },
    onSuccess: async (deleted, { worktree }) => {
      if (!deleted) return;
      selectWorktree(worktree.repoId);
      await client.invalidateQueries({ queryKey: keys.repos });
    },
    onError: (error) => showError("Couldn't delete the worktree", String(error)),
  });
}

/**
 * A repository's remote branches: what's known locally right away, then again once `git fetch`
 * is done. `fetch.error` is set when fetching failed (e.g. offline); the list still shows.
 */
export function useRemoteBranches(repoId: string) {
  const client = useQueryClient();
  const branches = useQuery({ queryKey: keys.branches(repoId), queryFn: () => api.remoteBranches(repoId) });
  const fetch = useQuery({
    queryKey: keys.fetch(repoId),
    queryFn: async () => {
      await api.fetchRemotes(repoId);
      await client.invalidateQueries({ queryKey: keys.branches(repoId) });
      return true;
    },
    // Opening the picker again within a minute doesn't fetch again.
    staleTime: 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
  return { branches, fetch };
}

/** Checks out a branch in a new worktree and selects it. */
export function useAddWorktree(repoId: string) {
  const client = useQueryClient();
  const selectWorktree = useStore((s) => s.selectWorktree);
  return useMutation({
    mutationFn: (branch: RemoteBranch) => api.addWorktree(repoId, branch),
    onSuccess: async (path) => {
      await client.invalidateQueries({ queryKey: keys.repos });
      selectWorktree(path);
    },
  });
}

/** Moves repositories in the sidebar; the new order shows immediately and is saved in the background. */
export function useReorderRepos() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: api.reorderRepos,
    onMutate: (ids) => {
      client.setQueryData<Repo[]>(keys.repos, (repos) => {
        if (!repos) return repos;
        const byId = new Map(repos.map((r) => [r.id, r]));
        return [...ids.flatMap((id) => byId.get(id) ?? []), ...repos.filter((r) => !ids.includes(r.id))];
      });
    },
    onError: () => client.invalidateQueries({ queryKey: keys.repos }),
  });
}

/**
 * Keeps git data fresh: refetch when the window regains focus or a repository's worktrees change,
 * and reload comments when they change (an agent replying from the command line).
 */
export function useLiveGitData() {
  const client = useQueryClient();
  useEffect(() => {
    // The webview stays "visible" while another app is in front, so tell TanStack Query about
    // native window focus explicitly.
    const offFocus = onWindowFocusChanged((focused) => focusManager.setFocused(focused));
    const offRepo = onRepoChanged(() => {
      client.invalidateQueries({ queryKey: keys.repos });
      client.invalidateQueries({ queryKey: ["stats"] });
      client.invalidateQueries({ queryKey: ["commits"] });
      client.invalidateQueries({ queryKey: ["files"] });
      client.invalidateQueries({ queryKey: ["patch"] });
      client.invalidateQueries({ queryKey: ["threads"] });
    });
    // A `piccolo` command run by a session also records that it works on the worktree.
    const offComments = onCommentsChanged(() => {
      client.invalidateQueries({ queryKey: ["threads"] });
      client.invalidateQueries({ queryKey: ["sessions"] });
    });
    const offSessions = onSessionsChanged(() => client.invalidateQueries({ queryKey: ["sessions"] }));
    return () => {
      offFocus();
      offRepo();
      offComments();
      offSessions();
    };
  }, [client]);
}
