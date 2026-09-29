import { focusManager, QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useStore } from "../store";
import type { DiffScope, LineRange, Repo, Worktree } from "../types";
import { api, onCommentsChanged, onRepoChanged, onWindowFocusChanged, pickRepoFolder } from "./api";

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
  files: (path: string, base: string | null, scope: DiffScope, ignoreWhitespace: boolean) =>
    ["files", path, base, scope, ignoreWhitespace] as const,
  patch: (path: string, base: string | null, scope: DiffScope, ignoreWhitespace: boolean) =>
    ["patch", path, base, scope, ignoreWhitespace] as const,
  /** `revision` identifies the diff; threads are re-positioned whenever it changes. */
  threads: (path: string, base: string | null, scope: DiffScope, revision: number) =>
    ["threads", path, base, scope, revision] as const,
};

/** Keeps showing the previous result while switching scope or whitespace, but never another worktree's. */
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

export function useChangedFiles(worktree: Worktree | undefined, base: string | null, scope: DiffScope, ignoreWhitespace: boolean) {
  return useQuery({
    queryKey: keys.files(worktree?.path ?? "", base, scope, ignoreWhitespace),
    queryFn: () => api.changedFiles(worktree!.path, base, scope, ignoreWhitespace),
    enabled: !!worktree,
    placeholderData: sameWorktree(worktree?.path),
  });
}

export function useDiffPatch(worktree: Worktree | undefined, base: string | null, scope: DiffScope, ignoreWhitespace: boolean) {
  return useQuery({
    queryKey: keys.patch(worktree?.path ?? "", base, scope, ignoreWhitespace),
    queryFn: () => api.diffPatch(worktree!.path, base, scope, ignoreWhitespace),
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

/** Wraps a comment mutation so the threads refresh once it lands. */
function useCommentMutation<T>(mutationFn: (args: T) => Promise<unknown>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn,
    onSettled: () => client.invalidateQueries({ queryKey: ["threads"] }),
  });
}

export function useAddThread(worktree: Worktree, base: string | null, scope: DiffScope) {
  return useCommentMutation((args: { file: string; oldFile: string | null; range: LineRange; body: string }) =>
    api.addThread({ path: worktree.path, base, scope, ...args }),
  );
}

export const useReplyThread = () => useCommentMutation((args: { id: number; body: string }) => api.replyThread(args.id, args.body));

export const useSetThreadResolved = () =>
  useCommentMutation((args: { id: number; resolved: boolean }) => api.setThreadResolved(args.id, args.resolved));

export const useDeleteComment = () => useCommentMutation((id: number) => api.deleteComment(id));

/** Loading on hover makes the click feel instant. */
export function prefetchWorktree(worktree: Worktree, base: string | null, scope: DiffScope, ignoreWhitespace: boolean) {
  queryClient.prefetchQuery({
    queryKey: keys.files(worktree.path, base, scope, ignoreWhitespace),
    queryFn: () => api.changedFiles(worktree.path, base, scope, ignoreWhitespace),
  });
  queryClient.prefetchQuery({
    queryKey: keys.patch(worktree.path, base, scope, ignoreWhitespace),
    queryFn: () => api.diffPatch(worktree.path, base, scope, ignoreWhitespace),
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
      client.invalidateQueries({ queryKey: ["files"] });
      client.invalidateQueries({ queryKey: ["patch"] });
      client.invalidateQueries({ queryKey: ["threads"] });
    });
    const offComments = onCommentsChanged(() => client.invalidateQueries({ queryKey: ["threads"] }));
    return () => {
      offFocus();
      offRepo();
      offComments();
    };
  }, [client]);
}
