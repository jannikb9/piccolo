import { useWorkerPool } from "@pierre/diffs/react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { useEffect, useMemo, useRef } from "react";
import { Group, Panel, Separator, useDefaultLayout } from "react-resizable-panels";
import { FilePanel } from "./components/FilePanel";
import type { DiffViewHandle } from "./components/DiffView";
import { ReviewPane, Welcome } from "./components/ReviewPane";
import { SettingsDialog } from "./components/SettingsDialog";
import { Sidebar } from "./components/Sidebar";
import { shikiThemes } from "./lib/codeThemes";
import { useChangedFiles, useDiffPatch, useLiveGitData, useRepos } from "./lib/queries";
import { buildTree, treeOrder } from "./lib/utils";
import { orderedWorktrees, resolveSelection, useStore } from "./store";
import type { Worktree } from "./types";

export default function App() {
  useLiveGitData();
  useCodeThemeSync();
  const repos = useRepos();
  const selectedId = useStore((s) => s.selectedWorktreeId);
  const collapsedRepos = useStore((s) => s.collapsedRepos);
  const scope = useStore((s) => s.scope);
  const hideWhitespace = useStore((s) => s.hideWhitespace);
  const pinActivePath = useStore((s) => s.pinActivePath);
  const viewRef = useRef<DiffViewHandle>(null);

  const selection = repos.data ? resolveSelection(repos.data, selectedId) : undefined;
  const worktree = selection?.worktree;
  const base = selection?.repo.defaultBranch ?? null;

  const ordered = useMemo(() => orderedWorktrees(repos.data ?? [], collapsedRepos), [repos.data, collapsedRepos]);
  const shortcuts = useMemo(() => new Map(ordered.slice(0, 9).map((w, i) => [w.id, i + 1])), [ordered]);
  useWorktreeHotkeys(ordered, worktree?.id);

  const filesQuery = useChangedFiles(worktree, base, scope, hideWhitespace);
  const patchQuery = useDiffPatch(worktree, base, scope, hideWhitespace);
  const { tree, files } = useMemo(() => {
    const tree = buildTree(filesQuery.data ?? []);
    return { tree, files: treeOrder(tree) };
  }, [filesQuery.data]);
  const viewed = useStore((s) => (worktree ? s.viewed[worktree.id] : undefined));
  const viewedCount = files.filter((f) => viewed?.[f.path]).length;

  const { defaultLayout, onLayoutChanged } = useDefaultLayout({ id: "main-layout", storage: localStorage });

  const jumpTo = (path: string) => {
    pinActivePath(path);
    viewRef.current?.scrollTo({ type: "item", id: path, align: "start", behavior: "instant" });
  };

  return (
    <TooltipPrimitive.Provider delayDuration={500} skipDelayDuration={200}>
      <Group orientation="horizontal" defaultLayout={defaultLayout} onLayoutChanged={onLayoutChanged} className="h-full">
        <Panel id="sidebar" defaultSize={248} minSize={200} maxSize={420} groupResizeBehavior="preserve-pixel-size">
          <Sidebar selectedId={worktree?.id ?? null} shortcuts={shortcuts} />
        </Panel>
        <ResizeHandle />
        <Panel id="files" defaultSize={272} minSize={220} maxSize={520} groupResizeBehavior="preserve-pixel-size">
          <FilePanel
            worktreeId={worktree?.id ?? ""}
            tree={tree}
            fileCount={files.length}
            viewedCount={viewedCount}
            loading={!!worktree && filesQuery.isPending}
            onSelect={jumpTo}
          />
        </Panel>
        <ResizeHandle />
        <Panel id="diff" minSize={400}>
          {selection ? (
            <ReviewPane
              repo={selection.repo}
              worktree={selection.worktree}
              files={files}
              filesQuery={filesQuery}
              patchQuery={patchQuery}
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
    <Separator className="relative w-px bg-border-subtle outline-none after:absolute after:inset-y-0 after:-right-1 after:-left-1 after:transition-colors hover:after:bg-accent/40 data-[separator=active]:after:bg-accent/60" />
  );
}
