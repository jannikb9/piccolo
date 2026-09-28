import type { UseQueryResult } from "@tanstack/react-query";
import { AlertTriangle, ArrowLeft, Columns2, Copy, FolderGit2, GitBranch, GitCompareArrows, Pilcrow, Rows2 } from "lucide-react";
import type { ReactNode, Ref } from "react";
import { useAddRepo } from "../lib/queries";
import { cn, totals } from "../lib/utils";
import { useStore } from "../store";
import type { ChangedFile, DiffPatch, Repo, Worktree } from "../types";
import { DiffView, type DiffViewHandle } from "./DiffView";
import { DiffCount, IconButton, Segmented, Skeleton, Tooltip } from "./ui";

export function ReviewPane({
  repo,
  worktree,
  files,
  filesQuery,
  patchQuery,
  viewRef,
}: {
  repo: Repo;
  worktree: Worktree;
  /** `filesQuery.data` in display order. */
  files: ChangedFile[];
  filesQuery: UseQueryResult<ChangedFile[]>;
  patchQuery: UseQueryResult<DiffPatch>;
  viewRef: Ref<DiffViewHandle>;
}) {
  const scope = useStore((s) => s.scope);
  const query = filesQuery.isError ? filesQuery : patchQuery;

  return (
    <main className="@container flex h-full min-w-0 flex-col bg-bg">
      <Toolbar repo={repo} worktree={worktree} files={files} />
      <div className="min-h-0 flex-1">
        {filesQuery.isPending || patchQuery.isPending ? (
          <DiffSkeleton />
        ) : query.isError ? (
          <CenteredMessage
            icon={<AlertTriangle className="size-5 text-del" />}
            title="Couldn't load changes"
            action={
              <button
                type="button"
                onClick={() => query.refetch()}
                className="mt-4 h-7 rounded-md border border-border px-3 text-[12px] font-medium text-fg-muted hover:border-border-strong hover:text-fg"
              >
                Try again
              </button>
            }
          >
            <span className="selectable font-mono break-words">{String(query.error)}</span>
          </CenteredMessage>
        ) : files.length === 0 ? (
          <CenteredMessage icon={<GitCompareArrows className="size-5" />} title="No changes">
            {repo.defaultBranch && !(scope === "uncommitted") ? (
              <>
                <span className="font-mono">{worktree.branch ?? worktree.head}</span> has no differences from{" "}
                <span className="font-mono">{repo.defaultBranch}</span>
                {scope === "committed" && " in its commits"}.
              </>
            ) : (
              "There are no uncommitted changes in this worktree."
            )}
          </CenteredMessage>
        ) : (
          // Remounted per worktree and scope so each starts at the top.
          <DiffView
            key={`${worktree.id}:${scope}`}
            worktree={worktree}
            files={files}
            diff={patchQuery.data!}
            viewRef={viewRef}
          />
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
  const hideWhitespace = useStore((s) => s.hideWhitespace);
  const toggleHideWhitespace = useStore((s) => s.toggleHideWhitespace);
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
        <Tooltip label={repo.defaultBranch ? "Base branch" : "No main or master branch found; showing uncommitted changes"}>
          <span className="flex h-6 shrink-0 items-center gap-1 rounded-md px-2 text-[12.5px] font-medium text-fg-muted">
            {repo.defaultBranch ?? "HEAD"}
          </span>
        </Tooltip>
        <span className="pointer-events-none ml-2 hidden shrink-0 items-center gap-2 text-[12px] text-fg-subtle @4xl:flex">
          <span className="tabular">
            {files.length} {files.length === 1 ? "file" : "files"}
          </span>
          <DiffCount additions={additions} deletions={deletions} />
        </span>
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-2">
        <IconButton
          label={hideWhitespace ? "Show whitespace changes" : "Hide whitespace changes"}
          aria-pressed={hideWhitespace}
          onClick={toggleHideWhitespace}
          className={cn("size-7", hideWhitespace && "bg-accent-soft text-accent hover:bg-accent-soft hover:text-accent")}
        >
          <Pilcrow className="size-3.5" />
        </IconButton>
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

function CenteredMessage({
  icon,
  title,
  children,
  action,
}: {
  icon: ReactNode;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="grid h-full place-items-center p-8">
      <div className="flex max-w-sm flex-col items-center text-center">
        <div className="mb-4 grid size-10 place-items-center rounded-xl border border-border bg-bg-raised text-fg-subtle">
          {icon}
        </div>
        <p className="text-[13px] font-medium">{title}</p>
        {children && <p className="mt-1 text-[12px] text-fg-subtle">{children}</p>}
        {action}
      </div>
    </div>
  );
}

function DiffSkeleton() {
  return (
    <div className="flex flex-col gap-3 px-4 pt-3">
      {[0, 1, 2].map((i) => (
        <div key={i} className="rounded-lg border border-border">
          <div className="flex h-10 items-center gap-3 border-b border-border bg-bg-raised px-3">
            <Skeleton className="h-3 w-56" />
            <Skeleton className="ml-auto h-3 w-24" />
          </div>
          <div className="space-y-2.5 p-4">
            {[70, 45, 60, 30].map((w, j) => (
              <Skeleton key={j} className="h-2.5" style={{ width: `${w}%` }} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export function Welcome({ loading }: { loading: boolean }) {
  const addRepo = useAddRepo();
  return (
    <main className="flex h-full flex-col bg-bg">
      <header data-tauri-drag-region className="h-13 shrink-0 border-b border-border-subtle" />
      {!loading && (
        <CenteredMessage
          icon={<FolderGit2 className="size-5" />}
          title="Review changes across your worktrees"
          action={
            <button
              type="button"
              onClick={() => addRepo.mutate()}
              className="mt-5 h-8 rounded-md bg-accent px-3.5 text-[13px] font-medium text-accent-fg hover:brightness-110"
            >
              Add repository
            </button>
          }
        >
          Add a git repository and every worktree in it shows up in the sidebar, ready to review against its base
          branch.
        </CenteredMessage>
      )}
    </main>
  );
}
