import { useMemo } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { CodeThemeId } from "./lib/codeThemes";
import type { DraftImage } from "./lib/images";
import type { SectionId } from "./lib/sections";
import type { DiffLayout, DiffOptions, DiffScope, Launcher, LineRange, Repo, Worktree } from "./types";

type PathSet = Record<string, true>;

/** What the panel beside the diff lists. */
export type FileTab = "files" | "comments";

/** A comment being written, before it's saved. */
export type Draft = { worktreeId: string; path: string; oldPath: string | null; range: LineRange; body: string };

/** Drafts are keyed by where their composer shows: below the last selected line. */
export const draftKey = (worktreeId: string, path: string, range: LineRange) =>
  `${worktreeId}\n${path}\n${range.endSide}:${range.endLine}`;

/** Where a thread's reply keeps its pasted images (see `draftImages`). */
export const replyKey = (threadId: number) => `reply:${threadId}`;
/** The general comment being written in the Comments panel. */
export const panelCommentKey = (worktreeId: string) => `panel:${worktreeId}`;
/** Where an edit of a message keeps its newly pasted images. */
export const editKey = (messageId: number) => `edit:${messageId}`;

type State = {
  selectedWorktreeId: string | null;
  collapsedRepos: PathSet;
  /** File list sections the user opened or closed; others use `COLLAPSED_BY_DEFAULT`. */
  collapsedSections: Partial<Record<SectionId, boolean>>;
  /** The layout chosen in the toolbar; a narrow diff pane shows unified regardless (`useDiffLayout`). */
  layout: DiffLayout;
  /** Whether the diff pane is too narrow for split diffs. */
  narrowDiff: boolean;
  /** worktreeId → the changes chosen in the commit picker; worktrees without one use `defaultScope`. */
  scopes: Record<string, DiffScope>;
  hideWhitespace: boolean;
  hideImports: boolean;
  codeTheme: CodeThemeId;
  /** Where new agent sessions start (Settings). */
  agentLauncher: Launcher;
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
  /** Text of messages being edited, by message id. */
  editDrafts: Record<number, string>;
  /** General comments being written, by `panelCommentKey`; images by the same key. */
  generalDrafts: Record<string, string>;
  /** Worktrees whose conversation above the diff is folded away. */
  conversationCollapsed: PathSet;
  fileTab: FileTab;
  /** The thread last picked in the comment list, for the diff to scroll to; `at` tells picks apart. */
  reveal: { threadId: number; at: number } | null;
  /** Pasted screenshots of drafts, by draft key (see `replyKey` for replies). */
  draftImages: Record<string, DraftImage[]>;

  selectWorktree: (id: string) => void;
  toggleRepo: (id: string) => void;
  setSectionCollapsed: (id: SectionId, collapsed: boolean) => void;
  setLayout: (layout: DiffLayout) => void;
  setNarrowDiff: (narrow: boolean) => void;
  /** `null` goes back to the worktree's default. */
  setScope: (worktreeId: string, scope: DiffScope | null) => void;
  toggleHideWhitespace: () => void;
  toggleHideImports: () => void;
  setCodeTheme: (theme: CodeThemeId) => void;
  setAgentLauncher: (launcher: Launcher) => void;
  toggleViewed: (worktreeId: string, path: string) => void;
  setCollapsed: (worktreeId: string, path: string, collapsed: boolean) => void;
  setActivePath: (path: string | null) => void;
  pinActivePath: (path: string) => void;
  startDraft: (draft: Omit<Draft, "body">) => void;
  setDraftBody: (key: string, body: string) => void;
  discardDraft: (key: string) => void;
  setReplyDraft: (threadId: number, body: string | null) => void;
  /** Starts or updates an edit of a message; `null` ends it. */
  setEditDraft: (messageId: number, body: string | null) => void;
  /** Starts or updates a general comment; `null` discards it. */
  setGeneralDraft: (key: string, body: string | null) => void;
  toggleConversation: (worktreeId: string) => void;
  setFileTab: (tab: FileTab) => void;
  revealThread: (threadId: number) => void;
  addDraftImages: (key: string, images: DraftImage[]) => void;
  removeDraftImage: (key: string, id: string) => void;
};

function toggle(set: PathSet | undefined, key: string, on: boolean): PathSet {
  const next = { ...set };
  if (on) next[key] = true;
  else delete next[key];
  return next;
}

export const useStore = create<State>()(
  persist(
    (set, get) => ({
      selectedWorktreeId: null,
      collapsedRepos: {},
      collapsedSections: {},
      layout: "split",
      narrowDiff: false,
      scopes: {},
      hideWhitespace: false,
      hideImports: false,
      codeTheme: "github",
      agentLauncher: "app",
      viewed: {},
      collapsed: {},
      activePath: null,
      activePinnedUntil: 0,
      drafts: {},
      replyDrafts: {},
      editDrafts: {},
      generalDrafts: {},
      conversationCollapsed: {},
      fileTab: "files",
      reveal: null,
      draftImages: {},

      selectWorktree: (id) => set({ selectedWorktreeId: id, activePath: null }),
      toggleRepo: (id) => set((s) => ({ collapsedRepos: toggle(s.collapsedRepos, id, !s.collapsedRepos[id]) })),
      setSectionCollapsed: (id, collapsed) => set((s) => ({ collapsedSections: { ...s.collapsedSections, [id]: collapsed } })),
      setLayout: (layout) => set({ layout }),
      setNarrowDiff: (narrowDiff) => set({ narrowDiff }),
      setScope: (wt, scope) =>
        set((s) => {
          const { [wt]: _, ...rest } = s.scopes;
          return { scopes: scope ? { ...rest, [wt]: scope } : rest };
        }),
      toggleHideWhitespace: () => set((s) => ({ hideWhitespace: !s.hideWhitespace })),
      toggleHideImports: () => set((s) => ({ hideImports: !s.hideImports })),
      setCodeTheme: (codeTheme) => set({ codeTheme }),
      setAgentLauncher: (agentLauncher) => set({ agentLauncher }),
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
      // Called on every scroll event: only touch the store when the file actually changes, since
      // each update re-runs every subscriber and the persist middleware writes to localStorage.
      setActivePath: (activePath) => {
        const s = get();
        if (s.activePath !== activePath && Date.now() >= s.activePinnedUntil) set({ activePath });
      },
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
          const { [key]: __, ...draftImages } = s.draftImages;
          return { drafts, draftImages };
        }),
      setReplyDraft: (threadId, body) =>
        set((s) => {
          const { [threadId]: _, ...rest } = s.replyDrafts;
          if (body !== null) return { replyDrafts: { ...rest, [threadId]: body } };
          const { [replyKey(threadId)]: __, ...draftImages } = s.draftImages;
          return { replyDrafts: rest, draftImages };
        }),
      setEditDraft: (messageId, body) =>
        set((s) => {
          const { [messageId]: _, ...rest } = s.editDrafts;
          if (body !== null) return { editDrafts: { ...rest, [messageId]: body } };
          const { [editKey(messageId)]: __, ...draftImages } = s.draftImages;
          return { editDrafts: rest, draftImages };
        }),
      setGeneralDraft: (key, body) =>
        set((s) => {
          const { [key]: _, ...rest } = s.generalDrafts;
          if (body !== null) return { generalDrafts: { ...rest, [key]: body } };
          const { [key]: __, ...draftImages } = s.draftImages;
          return { generalDrafts: rest, draftImages };
        }),
      toggleConversation: (worktreeId) =>
        set((s) => ({
          conversationCollapsed: toggle(s.conversationCollapsed, worktreeId, !s.conversationCollapsed[worktreeId]),
        })),
      setFileTab: (fileTab) => set({ fileTab }),
      revealThread: (threadId) => set({ reveal: { threadId, at: Date.now() } }),
      addDraftImages: (key, images) =>
        set((s) => ({ draftImages: { ...s.draftImages, [key]: [...(s.draftImages[key] ?? []), ...images] } })),
      removeDraftImage: (key, id) =>
        set((s) => {
          const { [key]: _, ...rest } = s.draftImages;
          const images = (s.draftImages[key] ?? []).filter((image) => image.id !== id);
          return { draftImages: images.length ? { ...rest, [key]: images } : rest };
        }),
    }),
    {
      name: "review-ui",
      // Version 1 dropped the Sessions tab: its sessions moved to the toolbar.
      version: 1,
      migrate: (state) => {
        const s = state as { fileTab?: string };
        return { ...s, fileTab: s.fileTab === "sessions" ? "files" : s.fileTab } as State;
      },
      // Viewed state is kept in memory until it can be tied to file contents (milestone 4).
      partialize: (s) => ({
        selectedWorktreeId: s.selectedWorktreeId,
        collapsedRepos: s.collapsedRepos,
        collapsedSections: s.collapsedSections,
        layout: s.layout,
        hideWhitespace: s.hideWhitespace,
        hideImports: s.hideImports,
        codeTheme: s.codeTheme,
        agentLauncher: s.agentLauncher,
        fileTab: s.fileTab,
      }),
    },
  ),
);

/** What the diff leaves out, as the backend takes it. */
export function useDiffOptions(): DiffOptions {
  const ignoreWhitespace = useStore((s) => s.hideWhitespace);
  const hideImports = useStore((s) => s.hideImports);
  return useMemo(() => ({ ignoreWhitespace, hideImports }), [ignoreWhitespace, hideImports]);
}

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

/** The diff layout to show: the chosen one, or unified while the diff pane is too narrow for split. */
export const useDiffLayout = (): DiffLayout => useStore((s) => (s.narrowDiff ? "unified" : s.layout));
