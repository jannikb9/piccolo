import { ArrowLeft, ChevronRight, Columns2, Copy, FileImage, GitBranch, GitCompareArrows, Rows2 } from "lucide-react";
import { useEffect, useRef, type RefObject } from "react";
import { cn, splitPath, totals } from "../lib/utils";
import { useStore } from "../store";
import type { ChangedFile, Repo, Worktree } from "../types";
import { MockDiff } from "./MockDiff";
import { DiffBlocks, DiffCount, IconButton, Segmented, StatusBadge, Tooltip, ViewedToggle } from "./ui";

export const fileAnchorId = (path: string) => `file:${path}`;

export function ReviewPane({
  repo,
  worktree,
  files,
  scrollRef,
}: {
  repo: Repo;
  worktree: Worktree;
  files: ChangedFile[];
  scrollRef: RefObject<HTMLDivElement | null>;
}) {
  useActiveFileTracking(scrollRef, files, worktree.id);

  return (
    <main className="@container flex h-full min-w-0 flex-col bg-bg">
      <Toolbar repo={repo} worktree={worktree} files={files} />
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        {files.length === 0 ? (
          <EmptyState worktree={worktree} base={repo.defaultBranch} />
        ) : (
          <div className="flex flex-col gap-3 px-4 pt-3 pb-[40vh]">
            {files.map((file) => (
              <FileCard key={file.path} worktreeId={worktree.id} file={file} />
            ))}
          </div>
        )}
      </div>
    </main>
  );
}

function Toolbar({ repo, worktree, files }: { repo: Repo; worktree: Worktree; files: ChangedFile[] }) {
  const layout = useStore((s) => s.layout);
  const setLayout = useStore((s) => s.setLayout);
  const scope = useStore((s) => s.scope);
  const setScope = useStore((s) => s.setScope);
  const { additions, deletions } = totals(files);
  const branch = worktree.branch ?? worktree.head;

  return (
    <header
      data-tauri-drag-region
      className="flex h-13 shrink-0 items-center gap-3 border-b border-border-subtle px-4"
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="group flex h-6 min-w-24 items-center gap-1.5 rounded-md bg-bg-hover pr-1 pl-2 text-[12.5px] font-medium">
          <GitBranch className="size-3.5 shrink-0 text-fg-subtle" />
          <span className="selectable truncate">{branch}</span>
          <IconButton
            label="Copy branch name"
            className="size-5 opacity-0 group-hover:opacity-100"
            onClick={() => navigator.clipboard.writeText(branch)}
          >
            <Copy className="size-3" />
          </IconButton>
        </span>
        <ArrowLeft className="size-3.5 shrink-0 text-fg-faint" aria-label="into" />
        <Tooltip label="Change base branch">
          <button
            type="button"
            className="flex h-6 shrink-0 items-center gap-1 rounded-md px-2 text-[12.5px] font-medium text-fg-muted hover:bg-bg-hover hover:text-fg"
          >
            {repo.defaultBranch}
          </button>
        </Tooltip>
        <span className="pointer-events-none ml-2 hidden shrink-0 items-center gap-2 text-[12px] text-fg-subtle @4xl:flex">
          <span className="tabular">
            {files.length} {files.length === 1 ? "file" : "files"}
          </span>
          <DiffCount additions={additions} deletions={deletions} />
        </span>
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-2">
        <Segmented
          label="Changes to show"
          value={scope}
          onChange={setScope}
          options={[
            { value: "all", label: "All", tooltip: "Committed and uncommitted changes" },
            { value: "committed", label: "Committed", tooltip: "Commits on this branch only" },
            { value: "uncommitted", label: "Uncommitted", tooltip: "Working tree changes only" },
          ]}
        />
        <Segmented
          label="Diff layout"
          value={layout}
          onChange={setLayout}
          options={[
            { value: "split", label: <Columns2 className="size-3.5" />, tooltip: "Split" },
            { value: "unified", label: <Rows2 className="size-3.5" />, tooltip: "Unified" },
          ]}
        />
      </div>
    </header>
  );
}

function FileCard({ worktreeId, file }: { worktreeId: string; file: ChangedFile }) {
  const viewed = useStore((s) => !!s.viewed[worktreeId]?.[file.path]);
  const collapsed = useStore((s) => !!s.collapsed[worktreeId]?.[file.path]);
  const layout = useStore((s) => s.layout);
  const toggleViewed = useStore((s) => s.toggleViewed);
  const toggleCollapsed = useStore((s) => s.toggleCollapsed);
  const { dir, base } = splitPath(file.path);

  return (
    <section id={fileAnchorId(file.path)} className="scroll-mt-3 rounded-lg border border-border bg-bg">
      <header
        onClick={() => toggleCollapsed(worktreeId, file.path)}
        className={cn(
          "group sticky top-0 z-10 flex h-10 items-center gap-2 border-border bg-bg-raised pr-2 pl-2.5",
          collapsed ? "rounded-lg" : "rounded-t-lg border-b",
        )}
      >
        <ChevronRight
          className={cn("size-3.5 shrink-0 text-fg-subtle transition-transform duration-150", !collapsed && "rotate-90")}
        />
        <span className={cn("flex min-w-0 items-baseline font-mono text-[12.5px]", viewed && "opacity-60")}>
          <span className="truncate text-fg-subtle">{dir}</span>
          <span className="shrink-0 font-medium text-fg">{base}</span>
        </span>
        <IconButton
          label="Copy path"
          className="size-5 shrink-0 opacity-0 group-hover:opacity-100"
          onClick={(e) => {
            e.stopPropagation();
            navigator.clipboard.writeText(file.path);
          }}
        >
          <Copy className="size-3" />
        </IconButton>

        <span className="ml-auto flex shrink-0 items-center gap-3">
          {file.oldPath ? (
            <Tooltip label={<span className="font-mono">from {file.oldPath}</span>}>
              <span>
                <StatusBadge status={file.status} />
              </span>
            </Tooltip>
          ) : (
            <StatusBadge status={file.status} />
          )}
          {!file.binary && (
            <span className="flex items-center gap-2">
              <DiffCount additions={file.additions} deletions={file.deletions} />
              <DiffBlocks additions={file.additions} deletions={file.deletions} />
            </span>
          )}
          <ViewedToggle checked={viewed} onChange={() => toggleViewed(worktreeId, file.path)} />
        </span>
      </header>

      {!collapsed && (
        <div className="overflow-hidden rounded-b-lg">
          {file.binary ? (
            <div className="flex items-center justify-center gap-2 py-8 text-[12px] text-fg-subtle">
              <FileImage className="size-4" />
              Binary file not shown
            </div>
          ) : (
            <MockDiff layout={layout} />
          )}
        </div>
      )}
    </section>
  );
}

function EmptyState({ worktree, base }: { worktree: Worktree; base: string }) {
  return (
    <div className="grid h-full place-items-center">
      <div className="flex max-w-xs flex-col items-center text-center">
        <div className="mb-4 grid size-10 place-items-center rounded-xl border border-border bg-bg-raised text-fg-subtle">
          <GitCompareArrows className="size-5" />
        </div>
        <p className="text-[13px] font-medium">No changes</p>
        <p className="mt-1 text-[12px] text-fg-subtle">
          <span className="font-mono">{worktree.branch ?? worktree.head}</span> has no differences from{" "}
          <span className="font-mono">{base}</span>.
        </p>
      </div>
    </div>
  );
}

/** Highlights the file in the tree whose header is currently at the top of the diff stream. */
function useActiveFileTracking(scrollRef: RefObject<HTMLDivElement | null>, files: ChangedFile[], worktreeId: string) {
  const setActivePath = useStore((s) => s.setActivePath);
  const frame = useRef(0);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = 0;

    const update = () => {
      const top = el.getBoundingClientRect().top + 48;
      let active: string | null = null;
      for (const section of el.querySelectorAll<HTMLElement>("section[id^='file:']")) {
        if (section.getBoundingClientRect().top <= top) active = section.id.slice(5);
        else break;
      }
      setActivePath(active ?? files[0]?.path ?? null);
    };
    const onScroll = () => {
      cancelAnimationFrame(frame.current);
      frame.current = requestAnimationFrame(update);
    };

    update();
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(frame.current);
    };
  }, [scrollRef, files, worktreeId, setActivePath]);
}
