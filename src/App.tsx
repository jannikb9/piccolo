import { useWorkerPool } from "@pierre/diffs/react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Group, Panel, Separator, useDefaultLayout, useGroupRef, type PanelSize } from "react-resizable-panels";
import { FilePanel } from "./components/FilePanel";
import type { DiffViewHandle } from "./components/DiffView";
import { ReviewPane, Welcome } from "./components/ReviewPane";
import { SettingsDialog } from "./components/SettingsDialog";
import { Sidebar } from "./components/Sidebar";
import { shikiThemes } from "./lib/codeThemes";
import { onToggleSidebar } from "./lib/api";
import { hashString } from "./lib/diff";
import { useChangedFiles, useDiffPatch, useDiffScope, useLiveGitData, useRepos, useThreads } from "./lib/queries";
import { groupIntoSections } from "./lib/sections";
import { orderedWorktrees, resolveSelection, useDiffOptions, useStore } from "./store";
import type { GeneralThread, Thread, Worktree } from "./types";

export default function App() {
  useLiveGitData();
  useCodeThemeSync();
  const repos = useRepos();
  const selectedId = useStore((s) => s.selectedWorktreeId);
  const collapsedRepos = useStore((s) => s.collapsedRepos);
  const diffOptions = useDiffOptions();
  const pinActivePath = useStore((s) => s.pinActivePath);
  const viewRef = useRef<DiffViewHandle>(null);

  const selection = repos.data ? resolveSelection(repos.data, selectedId) : undefined;
  // Keep a fallback selection (nothing chosen yet, or the chosen worktree is gone), so it
  // doesn't jump elsewhere when repositories are reordered.
  const selectWorktree = useStore((s) => s.selectWorktree);
  const resolvedId = selection?.worktree.id;
  useEffect(() => {
    if (resolvedId && resolvedId !== selectedId) selectWorktree(resolvedId);
  }, [resolvedId, selectedId, selectWorktree]);
  const worktree = selection?.worktree;
  const base = selection?.repo.defaultBranch ?? null;

  const ordered = useMemo(() => orderedWorktrees(repos.data ?? [], collapsedRepos), [repos.data, collapsedRepos]);
  const shortcuts = useMemo(() => new Map(ordered.slice(0, 9).map((w, i) => [w.id, i + 1])), [ordered]);
  useWorktreeHotkeys(ordered, worktree?.id);

  const scope = useDiffScope(worktree, base);
  const filesQuery = useChangedFiles(worktree, base, scope, diffOptions);
  const patchQuery = useDiffPatch(worktree, base, scope, diffOptions);
  // Threads are re-positioned whenever the diff changes.
  const revision = useMemo(() => (patchQuery.data ? hashString(patchQuery.data.patch) : 0), [patchQuery.data]);
  const threadsQuery = useThreads(worktree, base, scope, revision);
  // Threads on lines go into the diff; general ones (on the whole branch) above it.
  const { threads, generalThreads } = useMemo(() => {
    const all = threadsQuery.data ?? [];
    return {
      threads: all.filter((t): t is Thread => t.path !== null),
      generalThreads: all.filter((t): t is GeneralThread => t.path === null),
    };
  }, [threadsQuery.data]);
  const commentCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const t of threads) if (!t.resolved) counts.set(t.path, (counts.get(t.path) ?? 0) + 1);
    return counts;
  }, [threads]);
  // Files grouped into Implementation / Tests / Changesets; the diff follows the same order.
  const { sections, files } = useMemo(() => {
    const sections = groupIntoSections(filesQuery.data ?? []);
    return { sections, files: sections.flatMap((s) => s.files) };
  }, [filesQuery.data]);
  const viewed = useStore((s) => (worktree ? s.viewed[worktree.id] : undefined));
  const viewedCount = files.filter((f) => viewed?.[f.path]).length;

  const { defaultLayout, onLayoutChanged } = useDefaultLayout({ id: "main-layout", storage: localStorage });
  const sidebar = useSidebarCollapse();

  const jumpTo = (path: string) => {
    pinActivePath(path);
    viewRef.current?.scrollTo({ type: "item", id: path, align: "start", behavior: "instant" });
  };

  return (
    <TooltipPrimitive.Provider delayDuration={500} skipDelayDuration={200}>
      <Group
        groupRef={sidebar.groupRef}
        orientation="horizontal" defaultLayout={defaultLayout} onLayoutChanged={onLayoutChanged} className="h-full">
        <Panel
          id="sidebar"
          collapsible
          onResize={sidebar.onResize}
          defaultSize={248}
          minSize={200}
          maxSize={420}
          groupResizeBehavior="preserve-pixel-size"
        >
          <Sidebar selectedId={worktree?.id ?? null} shortcuts={shortcuts} onToggle={sidebar.toggle} />
        </Panel>
        <ResizeHandle />
        <Panel id="files" defaultSize={272} minSize={220} maxSize={520} groupResizeBehavior="preserve-pixel-size">
          <FilePanel
            worktree={worktree}
            worktreeId={worktree?.id ?? ""}
            sections={sections}
            fileCount={files.length}
            viewedCount={viewedCount}
            commentCounts={commentCounts}
            threads={threads}
            generalThreads={generalThreads}
            loading={!!worktree && filesQuery.isPending}
            onSelect={jumpTo}
            sidebarCollapsed={sidebar.collapsed}
            onToggleSidebar={sidebar.toggle}
          />
        </Panel>
        <ResizeHandle />
        <Panel id="diff" minSize={400}>
          {selection ? (
            <ReviewPane
              repo={selection.repo}
              worktree={selection.worktree}
              scope={scope}
              files={files}
              filesQuery={filesQuery}
              patchQuery={patchQuery}
              threads={threads}
              generalThreads={generalThreads}
              viewRef={viewRef}
            />
          ) : (
            <Welcome loading={repos.isPending} />
          )}
        </Panel>
      </Group>
      <SettingsDialog />
    </TooltipPrimitive.Provider>
  );
}

/**
 * The worktree sidebar can be hidden with its titlebar button, View > Toggle Sidebar (⌃⌘S), or by
 * dragging its edge past the minimum width. Whether it's hidden is saved with the panel layout.
 */
function useSidebarCollapse() {
  const groupRef = useGroupRef();
  const [collapsed, setCollapsed] = useState(false);
  /** The sidebar's width (% of the window) before it was hidden. */
  const lastSize = useRef<number | null>(null);
  const onResize = useCallback((size: PanelSize) => {
    setCollapsed(size.inPixels === 0);
    if (size.inPixels > 0) lastSize.current = size.asPercentage;
  }, []);
  // Hiding gives the width to the diff, not the file list next to it, and showing takes it back.
  const toggle = useCallback(() => {
    const group = groupRef.current;
    if (!group) return;
    const { sidebar, files, diff } = group.getLayout();
    const size = sidebar > 0 ? 0 : (lastSize.current ?? (248 / window.innerWidth) * 100);
    // The file list's header makes room for the traffic lights in the same frame it moves under them.
    flushSync(() => setCollapsed(size === 0));
    group.setLayout({ sidebar: size, files, diff: diff + sidebar - size });
  }, [groupRef]);
  useEffect(() => onToggleSidebar(toggle), [toggle]);
  return { groupRef, collapsed, onResize, toggle };
}

/** Applies the chosen syntax theme to the highlighter workers, which re-render mounted diffs. */
function useCodeThemeSync() {
  const pool = useWorkerPool();
  const codeTheme = useStore((s) => s.codeTheme);
  useEffect(() => {
    pool?.setRenderOptions({ theme: shikiThemes(codeTheme) });
  }, [pool, codeTheme]);
}

/** ⌘1–⌘9 jump to a worktree in sidebar order; ⌥↑ / ⌥↓ step through them. */
function useWorktreeHotkeys(ordered: Worktree[], selectedId: string | undefined) {
  const selectWorktree = useStore((s) => s.selectWorktree);
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLElement && e.target.closest("input, textarea, [contenteditable]")) return;
      if (e.metaKey && !e.altKey && !e.shiftKey && /^[1-9]$/.test(e.key)) {
        const target = ordered[Number(e.key) - 1];
        if (target) {
          e.preventDefault();
          selectWorktree(target.id);
        }
      } else if (e.altKey && !e.metaKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
        if (ordered.length === 0) return;
        e.preventDefault();
        const index = ordered.findIndex((w) => w.id === selectedId);
        const step = e.key === "ArrowDown" ? 1 : -1;
        const next = index === -1 ? 0 : (index + step + ordered.length) % ordered.length;
        selectWorktree(ordered[next].id);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [ordered, selectedId, selectWorktree]);
}

function ResizeHandle() {
  return (
    // The wider `after` strip is the grab area; only the cursor signals it.
    <Separator className="relative w-px bg-border-subtle outline-none after:absolute after:inset-y-0 after:-right-1 after:-left-1" />
  );
}
