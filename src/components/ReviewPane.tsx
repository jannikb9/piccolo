import type { UseQueryResult } from "@tanstack/react-query";
import {
  AlertTriangle,
  Columns2,
  Copy,
  FolderGit2,
  GitBranch,
  GitCompareArrows,
  GitMerge,
  Import,
  Pilcrow,
  Rows2,
} from "lucide-react";
import type { ReactNode, Ref } from "react";
import { useAddRepo, useWorktreeStats } from "../lib/queries";
import { cn, scopeKey, totals } from "../lib/utils";
import { useStore } from "../store";
import type { ChangedFile, DiffPatch, DiffScope, GeneralThread, Repo, Thread, Worktree } from "../types";
import { CommitPicker } from "./CommitPicker";
import { DiffView, type DiffViewHandle } from "./DiffView";
import { SendToAgent } from "./SendToAgent";
import { DiffCount, IconButton, Segmented, Skeleton, Tooltip } from "./ui";

export function ReviewPane({
  repo,
  worktree,
  scope,
  files,
  filesQuery,
  patchQuery,
  threads,
  generalThreads,
  viewRef,
}: {
  repo: Repo;
  worktree: Worktree;
  scope: DiffScope;
  /** `filesQuery.data` in display order. */
  files: ChangedFile[];
  filesQuery: UseQueryResult<ChangedFile[]>;
  patchQuery: UseQueryResult<DiffPatch>;
  /** Threads on lines. */
  threads: Thread[];
  /** Threads on the branch as a whole. */
  generalThreads: GeneralThread[];
  viewRef: Ref<DiffViewHandle>;
}) {
  const query = filesQuery.isError ? filesQuery : patchQuery;

  return (
    <main className="@container flex h-full min-w-0 flex-col bg-bg">
      <Toolbar repo={repo} worktree={worktree} scope={scope} files={files} threads={[...generalThreads, ...threads]} />
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
            {typeof scope === "object" ? (
              "This commit doesn't change any files."
            ) : repo.defaultBranch && !(scope === "uncommitted") ? (
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
            key={`${worktree.id}:${scopeKey(scope)}`}
            worktree={worktree}
            base={repo.defaultBranch}
            files={files}
            diff={patchQuery.data!}
            threads={threads}
            generalThreads={generalThreads}
            viewRef={viewRef}
          />
        )}
      </div>
    </main>
  );
}

function Toolbar({
  repo,
  worktree,
  scope,
  files,
  threads,
}: {
  repo: Repo;
  worktree: Worktree;
  scope: DiffScope;
  files: ChangedFile[];
  threads: (Thread | GeneralThread)[];
}) {
  const layout = useStore((s) => s.layout);
  const setLayout = useStore((s) => s.setLayout);
  const setScope = useStore((s) => s.setScope);
  const selectCommit = useStore((s) => s.selectCommit);
  const hideWhitespace = useStore((s) => s.hideWhitespace);
  const toggleHideWhitespace = useStore((s) => s.toggleHideWhitespace);
  const hideImports = useStore((s) => s.hideImports);
  const toggleHideImports = useStore((s) => s.toggleHideImports);
  const { additions, deletions } = totals(files);
  const branch = worktree.branch ?? worktree.head;
  const merged = !!useWorktreeStats(worktree, repo.defaultBranch).data?.merged;

  return (
    <header
      data-tauri-drag-region
      className="flex h-13 shrink-0 items-center gap-3 border-b border-border-subtle px-4"
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <span
          className={cn(
            "group flex h-6 min-w-24 items-center gap-1.5 rounded-md pr-1 pl-2 text-[12.5px] font-medium",
            merged ? "bg-merged-soft text-merged" : "bg-bg-hover",
          )}
        >
          {merged ? (
            <Tooltip label={`Merged into ${repo.defaultBranch}`}>
              <GitMerge className="size-3.5 shrink-0" />
            </Tooltip>
          ) : (
            <GitBranch className="size-3.5 shrink-0 text-fg-subtle" />
          )}
          <Tooltip
            label={
              repo.defaultBranch ? (
                <>
                  Into <span className="font-mono">{repo.defaultBranch}</span>
                </>
              ) : (
                "No main or master branch found; showing uncommitted changes"
              )
            }
          >
            <span className="selectable truncate">{branch}</span>
          </Tooltip>
          <IconButton
            label="Copy branch name"
            className="size-5 opacity-0 group-hover:opacity-100"
            onClick={() => navigator.clipboard.writeText(branch)}
          >
            <Copy className="size-3" />
          </IconButton>
        </span>
        <span className="pointer-events-none ml-2 hidden shrink-0 items-center gap-2 text-[12px] text-fg-subtle @4xl:flex">
          <span className="tabular">
            {files.length} {files.length === 1 ? "file" : "files"}
          </span>
          <DiffCount additions={additions} deletions={deletions} />
        </span>
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-2">
        <CommitPicker worktree={worktree} base={repo.defaultBranch} scope={scope} />
        <Segmented
          label="Changes to show"
          // Nothing is chosen while a single commit is shown; choosing a mode leaves the commit.
          value={typeof scope === "string" ? scope : null}
          onChange={(mode) => {
            setScope(mode);
            selectCommit(worktree.id, null);
          }}
          options={[
            { value: "all", label: "All", tooltip: "Committed and uncommitted changes" },
            { value: "committed", label: "Committed", tooltip: "Commits on this branch only" },
            { value: "uncommitted", label: "Uncommitted", tooltip: "Working tree changes only" },
          ]}
        />
        <div className="flex items-center gap-0.5">
          <IconButton
            label={hideWhitespace ? "Show whitespace changes" : "Hide whitespace changes"}
            aria-pressed={hideWhitespace}
            onClick={toggleHideWhitespace}
            className="size-7"
          >
            <Pilcrow className="size-3.5" />
          </IconButton>
          <IconButton
            label={hideImports ? "Show import changes" : "Hide import changes"}
            aria-pressed={hideImports}
            onClick={toggleHideImports}
            className="size-7"
          >
            <Import className="size-3.5" />
          </IconButton>
        </div>
        <Segmented
          label="Diff layout"
          value={layout}
          onChange={setLayout}
          options={[
            { value: "split", label: <Columns2 className="size-3.5" />, tooltip: "Split" },
            { value: "unified", label: <Rows2 className="size-3.5" />, tooltip: "Unified" },
          ]}
        />
        <SendToAgent worktree={worktree} threads={threads} />
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
              className="mt-5 h-8 rounded-md bg-primary px-3.5 text-[13px] font-medium text-primary-fg hover:bg-primary-hover"
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
