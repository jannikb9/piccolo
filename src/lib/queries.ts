import { focusManager, QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useStore } from "../store";
import type { DiffScope, Repo, Worktree } from "../types";
import { api, onRepoChanged, onWindowFocusChanged, pickRepoFolder } from "./api";

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
  files: (path: string, base: string | null, scope: DiffScope) => ["files", path, base, scope] as const,
};

export function useRepos() {
  return useQuery({ queryKey: keys.repos, queryFn: api.listRepos });
}

export function useWorktreeStats(worktree: Worktree, base: string | null) {
  return useQuery({
    queryKey: keys.stats(worktree.path, base),
    queryFn: () => api.worktreeStats(worktree.path, base),
  });
}

export function useChangedFiles(worktree: Worktree | undefined, base: string | null, scope: DiffScope) {
  return useQuery({
    queryKey: keys.files(worktree?.path ?? "", base, scope),
    queryFn: () => api.changedFiles(worktree!.path, base, scope),
    enabled: !!worktree,
    // Switching scope keeps showing the previous list until the new one arrives, but never
    // another worktree's files.
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === worktree?.path ? previous : undefined,
  });
}

export function prefetchChangedFiles(worktree: Worktree, base: string | null, scope: DiffScope) {
  return queryClient.prefetchQuery({
    queryKey: keys.files(worktree.path, base, scope),
    queryFn: () => api.changedFiles(worktree.path, base, scope),
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

/** Keeps git data fresh: refetch when the window regains focus or a repository's worktrees change. */
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
    });
    return () => {
      offFocus();
      offRepo();
    };
  }, [client]);
}
