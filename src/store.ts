import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { CodeThemeId } from "./lib/codeThemes";
import type { DiffLayout, DiffScope, LineRange, Repo, Worktree } from "./types";

type PathSet = Record<string, true>;

/** A comment being written, before it's saved. */
export type Draft = { worktreeId: string; path: string; oldPath: string | null; range: LineRange; body: string };

/** Drafts are keyed by where their composer shows: below the last selected line. */
export const draftKey = (worktreeId: string, path: string, range: LineRange) =>
  `${worktreeId}\n${path}\n${range.endSide}:${range.endLine}`;

type State = {
  selectedWorktreeId: string | null;
  collapsedRepos: PathSet;
  layout: DiffLayout;
  scope: DiffScope;
  hideWhitespace: boolean;
  codeTheme: CodeThemeId;
  /** worktreeId → set of viewed file paths */
  viewed: Record<string, PathSet>;
  /**
   * worktreeId → path → collapsed. Only explicit choices are stored; files without an entry use
   * their default (generated files start collapsed).
   */
  collapsed: Record<string, Record<string, boolean>>;
  activePath: string | null;
  /** Scroll tracking leaves `activePath` alone until then, so an explicit jump keeps its target. */
  activePinnedUntil: number;
  /** Unsaved comments by `draftKey`; kept here so they survive scrolling out of view. */
  drafts: Record<string, Draft>;
  /** Draft replies by thread id. */
  replyDrafts: Record<number, string>;

  selectWorktree: (id: string) => void;
  toggleRepo: (id: string) => void;
  setLayout: (layout: DiffLayout) => void;
  setScope: (scope: DiffScope) => void;
  toggleHideWhitespace: () => void;
  setCodeTheme: (theme: CodeThemeId) => void;
  toggleViewed: (worktreeId: string, path: string) => void;
  setCollapsed: (worktreeId: string, path: string, collapsed: boolean) => void;
  setActivePath: (path: string | null) => void;
  pinActivePath: (path: string) => void;
  startDraft: (draft: Omit<Draft, "body">) => void;
  setDraftBody: (key: string, body: string) => void;
  discardDraft: (key: string) => void;
  setReplyDraft: (threadId: number, body: string | null) => void;
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
      hideWhitespace: false,
      codeTheme: "github",
      viewed: {},
      collapsed: {},
      activePath: null,
      activePinnedUntil: 0,
      drafts: {},
      replyDrafts: {},

      selectWorktree: (id) => set({ selectedWorktreeId: id, activePath: null }),
      toggleRepo: (id) => set((s) => ({ collapsedRepos: toggle(s.collapsedRepos, id, !s.collapsedRepos[id]) })),
      setLayout: (layout) => set({ layout }),
      setScope: (scope) => set({ scope }),
      toggleHideWhitespace: () => set((s) => ({ hideWhitespace: !s.hideWhitespace })),
      setCodeTheme: (codeTheme) => set({ codeTheme }),
      // Like GitHub: marking a file viewed collapses it, un-marking expands it again.
      toggleViewed: (wt, path) =>
        set((s) => {
          const on = !s.viewed[wt]?.[path];
          return {
            viewed: { ...s.viewed, [wt]: toggle(s.viewed[wt], path, on) },
            collapsed: { ...s.collapsed, [wt]: { ...s.collapsed[wt], [path]: on } },
          };
        }),
      setCollapsed: (wt, path, collapsed) =>
        set((s) => ({ collapsed: { ...s.collapsed, [wt]: { ...s.collapsed[wt], [path]: collapsed } } })),
      setActivePath: (activePath) => set((s) => (Date.now() < s.activePinnedUntil ? {} : { activePath })),
      pinActivePath: (activePath) => set({ activePath, activePinnedUntil: Date.now() + 400 }),
      // Starting a comment where one is already being written keeps its text.
      startDraft: (draft) =>
        set((s) => {
          const key = draftKey(draft.worktreeId, draft.path, draft.range);
          return { drafts: { ...s.drafts, [key]: { ...draft, body: s.drafts[key]?.body ?? "" } } };
        }),
      setDraftBody: (key, body) =>
        set((s) => (s.drafts[key] ? { drafts: { ...s.drafts, [key]: { ...s.drafts[key], body } } } : {})),
      discardDraft: (key) =>
        set((s) => {
          const { [key]: _, ...drafts } = s.drafts;
          return { drafts };
        }),
      setReplyDraft: (threadId, body) =>
        set((s) => {
          const { [threadId]: _, ...rest } = s.replyDrafts;
          return { replyDrafts: body === null ? rest : { ...rest, [threadId]: body } };
        }),
    }),
    {
      name: "review-ui",
      // Viewed state is kept in memory until it can be tied to file contents (milestone 4).
      partialize: (s) => ({
        selectedWorktreeId: s.selectedWorktreeId,
        collapsedRepos: s.collapsedRepos,
        layout: s.layout,
        scope: s.scope,
        hideWhitespace: s.hideWhitespace,
        codeTheme: s.codeTheme,
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
