import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { useMemo, useRef } from "react";
import { Group, Panel, Separator, useDefaultLayout } from "react-resizable-panels";
import { FilePanel } from "./components/FilePanel";
import { fileAnchorId, ReviewPane } from "./components/ReviewPane";
import { Sidebar } from "./components/Sidebar";
import { buildTree, treeOrder } from "./lib/utils";
import { changedFiles } from "./mock";
import { useSelectedWorktree, useStore } from "./store";

export default function App() {
  const { repo, worktree } = useSelectedWorktree();
  const viewed = useStore((s) => s.viewed[worktree.id]);
  const setActivePath = useStore((s) => s.setActivePath);
  const scrollRef = useRef<HTMLDivElement>(null);

  const { tree, files } = useMemo(() => {
    const tree = buildTree(changedFiles(worktree.id));
    return { tree, files: treeOrder(tree) };
  }, [worktree.id]);
  const viewedCount = files.filter((f) => viewed?.[f.path]).length;

  const { defaultLayout, onLayoutChanged } = useDefaultLayout({ id: "main-layout", storage: localStorage });

  const jumpTo = (path: string) => {
    const container = scrollRef.current;
    const target = document.getElementById(fileAnchorId(path));
    if (!container || !target) return;
    const offset = target.getBoundingClientRect().top - container.getBoundingClientRect().top;
    container.scrollTo({ top: container.scrollTop + offset - 12 });
    setActivePath(path);
  };

  return (
    <TooltipPrimitive.Provider delayDuration={500} skipDelayDuration={200}>
      <Group orientation="horizontal" defaultLayout={defaultLayout} onLayoutChanged={onLayoutChanged} className="h-full">
        <Panel id="sidebar" defaultSize={248} minSize={200} maxSize={420} groupResizeBehavior="preserve-pixel-size">
          <Sidebar />
        </Panel>
        <ResizeHandle />
        <Panel id="files" defaultSize={272} minSize={220} maxSize={520} groupResizeBehavior="preserve-pixel-size">
          <FilePanel
            worktreeId={worktree.id}
            tree={tree}
            fileCount={files.length}
            viewedCount={viewedCount}
            onSelect={jumpTo}
          />
        </Panel>
        <ResizeHandle />
        <Panel id="diff" minSize={400}>
          <ReviewPane repo={repo} worktree={worktree} files={files} scrollRef={scrollRef} />
        </Panel>
      </Group>
    </TooltipPrimitive.Provider>
  );
}

function ResizeHandle() {
  return (
    <Separator className="relative w-px bg-border-subtle outline-none after:absolute after:inset-y-0 after:-right-1 after:-left-1 after:transition-colors hover:after:bg-accent/40 data-[separator=active]:after:bg-accent/60" />
  );
}
