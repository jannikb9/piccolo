import { create } from "zustand";
import { repos } from "./mock";
import type { DiffLayout, DiffScope } from "./types";

type PathSet = Record<string, true>;

type State = {
  selectedWorktreeId: string;
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

export const useStore = create<State>((set) => ({
  selectedWorktreeId: repos[0].worktrees[0].id,
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
}));

export function useSelectedWorktree() {
  const id = useStore((s) => s.selectedWorktreeId);
  for (const repo of repos) {
    const wt = repo.worktrees.find((w) => w.id === id);
    if (wt) return { repo, worktree: wt };
  }
  return { repo: repos[0], worktree: repos[0].worktrees[0] };
}
