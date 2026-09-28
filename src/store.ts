import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { DiffLayout, DiffScope, Repo, Worktree } from "./types";

type PathSet = Record<string, true>;

type State = {
  selectedWorktreeId: string | null;
  collapsedRepos: PathSet;
  layout: DiffLayout;
  scope: DiffScope;
  /** worktreeId → set of viewed file paths */
  viewed: Record<string, PathSet>;
  /** worktreeId → set of collapsed file paths */
  collapsed: Record<string, PathSet>;
  activePath: string | null;

  selectWorktree: (id: string) => void;
  toggleRepo: (id: string) => void;
  setLayout: (layout: DiffLayout) => void;
  setScope: (scope: DiffScope) => void;
  toggleViewed: (worktreeId: string, path: string) => void;
  toggleCollapsed: (worktreeId: string, path: string) => void;
  setActivePath: (path: string | null) => void;
};

function toggle(set: PathSet | undefined, key: string, on: boolean): PathSet {
  const next = { ...set };
  if (on) next[key] = true;
  else delete next[key];
  return next;
}

export const useStore = create<State>()(
  persist(
    (set) => ({
      selectedWorktreeId: null,
      collapsedRepos: {},
      layout: "split",
      scope: "all",
      viewed: {},
      collapsed: {},
      activePath: null,

      selectWorktree: (id) => set({ selectedWorktreeId: id, activePath: null }),
      toggleRepo: (id) => set((s) => ({ collapsedRepos: toggle(s.collapsedRepos, id, !s.collapsedRepos[id]) })),
      setLayout: (layout) => set({ layout }),
      setScope: (scope) => set({ scope }),
      // Like GitHub: marking a file viewed collapses it, un-marking expands it again.
      toggleViewed: (wt, path) =>
        set((s) => {
          const on = !s.viewed[wt]?.[path];
          return {
            viewed: { ...s.viewed, [wt]: toggle(s.viewed[wt], path, on) },
            collapsed: { ...s.collapsed, [wt]: toggle(s.collapsed[wt], path, on) },
          };
        }),
      toggleCollapsed: (wt, path) =>
        set((s) => ({
          collapsed: { ...s.collapsed, [wt]: toggle(s.collapsed[wt], path, !s.collapsed[wt]?.[path]) },
        })),
      setActivePath: (activePath) => set({ activePath }),
    }),
    {
      name: "review-ui",
      // Viewed state is kept in memory until it can be tied to file contents (milestone 4).
      partialize: (s) => ({
        selectedWorktreeId: s.selectedWorktreeId,
        collapsedRepos: s.collapsedRepos,
        layout: s.layout,
        scope: s.scope,
      }),
    },
  ),
);

/**
 * Worktrees in sidebar order: per repo, the most recently changed first and the main worktree
 * last (it is rarely what you're reviewing). Keyboard shortcuts follow the same order.
 */
export function sortWorktrees(worktrees: Worktree[]): Worktree[] {
  return [...worktrees].sort((a, b) => Number(a.isMain) - Number(b.isMain) || b.updatedAt - a.updatedAt);
}

export function orderedWorktrees(repos: Repo[], collapsedRepos: PathSet): Worktree[] {
  return repos.flatMap((r) => (collapsedRepos[r.id] ? [] : sortWorktrees(r.worktrees)));
}

/** The selected worktree, falling back to the first one when the selection no longer exists. */
export function resolveSelection(repos: Repo[], selectedId: string | null) {
  for (const repo of repos) {
    const worktree = repo.worktrees.find((w) => w.id === selectedId);
    if (worktree) return { repo, worktree };
  }
  const repo = repos.find((r) => r.worktrees.length > 0);
  return repo ? { repo, worktree: sortWorktrees(repo.worktrees)[0] } : undefined;
}
