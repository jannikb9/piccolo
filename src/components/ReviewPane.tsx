import type { UseQueryResult } from "@tanstack/react-query";
import {
  AlertTriangle,
  Check,
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
import { useLayoutEffect, useRef, type ReactNode, type Ref } from "react";
import { useAddRepo, useWorktreeStats } from "../lib/queries";
import { cn, scopeKey, totals } from "../lib/utils";
import { useStore } from "../store";
import type { ChangedFile, DiffPatch, DiffScope, GeneralThread, Repo, Thread, Worktree } from "../types";
import { CommitPicker } from "./CommitPicker";
import { DiffView, type DiffViewHandle } from "./DiffView";
import { AddressButton, AgentsButton, ReviewButton } from "./SessionList";
import { DiffCount, IconButton, Segmented, Skeleton, Tooltip, useJustDone } from "./ui";

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
  const mainRef = useRef<HTMLElement>(null);
  const setNarrowDiff = useStore((s) => s.setNarrowDiff);
  // Measured before the first paint, so a narrow pane never shows a split diff first.
  useLayoutEffect(() => {
    const main = mainRef.current;
    if (!main) return;
    const check = () => setNarrowDiff(main.clientWidth < SPLIT_MIN_WIDTH);
    check();
    const observer = new ResizeObserver(check);
    observer.observe(main);
    return () => observer.disconnect();
  }, [setNarrowDiff]);

  return (
    <main ref={mainRef} className="@container flex h-full min-w-0 flex-col bg-bg">
      <Toolbar repo={repo} worktree={worktree} scope={scope} files={files} />
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
                {scope === "committed" && worktree.dirty && " in its commits"}.
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

/** Narrower than this, the diff pane shows unified diffs: split halves would wrap nearly every line. */
const SPLIT_MIN_WIDTH = 768;

function Toolbar({
  repo,
  worktree,
  scope,
  files,
}: {
  repo: Repo;
  worktree: Worktree;
  scope: DiffScope;
  files: ChangedFile[];
}) {
  const layout = useStore((s) => s.layout);
  const narrow = useStore((s) => s.narrowDiff);
  const setLayout = useStore((s) => s.setLayout);
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
        <BranchChip branch={branch} base={repo.defaultBranch} merged={merged} />
        <span className="pointer-events-none ml-2 hidden shrink-0 items-center gap-2 text-[12px] text-fg-subtle @4xl:flex">
          <span className="tabular">
            {files.length} {files.length === 1 ? "file" : "files"}
          </span>
          <DiffCount additions={additions} deletions={deletions} />
        </span>
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-2">
        <CommitPicker worktree={worktree} base={repo.defaultBranch} scope={scope} />
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
        {/* A narrow pane is always unified, so there's nothing to choose. */}
        {!narrow && (
          <Segmented
            label="Diff layout"
            value={layout}
            onChange={setLayout}
            options={[
              { value: "split", label: <Columns2 className="size-3.5" />, tooltip: "Split" },
              { value: "unified", label: <Rows2 className="size-3.5" />, tooltip: "Unified" },
            ]}
          />
        )}
        <ReviewButton worktree={worktree} />
        <AddressButton worktree={worktree} />
        <AgentsButton worktree={worktree} />
      </div>
    </header>
  );
}

/**
 * The branch name, copied by a click. Hovering swaps its icon for a copy icon, the cue that a
 * click copies; after a click it shows a check and the tooltip says so. Long names are cut short
 * and the tooltip has the whole name.
 */
function BranchChip({ branch, base, merged }: { branch: string; base: string | null; merged: boolean }) {
  const [copied, markCopied] = useJustDone();
  const BranchIcon = merged ? GitMerge : GitBranch;
  return (
    <Tooltip
      label={
        <span className="flex max-w-120 flex-col gap-0.5">
          <span className="font-mono break-all text-fg">{branch}</span>
          {base ? (
            <span>
              {merged ? "Merged into" : "Into"} <span className="font-mono">{base}</span>
            </span>
          ) : (
            "No main or master branch found; showing uncommitted changes"
          )}
          <span className="text-fg-subtle">{copied ? "Copied" : "Click to copy"}</span>
        </span>
      }
    >
      <button
        type="button"
        aria-label={`Copy branch name ${branch}`}
        onClick={(e) => {
          // Keeps the tooltip open, so it can say the name was copied.
          e.preventDefault();
          navigator.clipboard.writeText(branch).then(markCopied);
        }}
        className={cn(
          "group flex h-6 max-w-80 min-w-24 items-center gap-1.5 rounded-md px-2 text-[12.5px] font-medium transition-colors",
          merged ? "bg-merged-soft text-merged hover:bg-merged/25" : "bg-bg-hover hover:bg-bg-active",
        )}
      >
        {copied ? (
          <Check className={cn("size-3.5 shrink-0", !merged && "text-fg-muted")} strokeWidth={2.5} />
        ) : (
          <>
            <BranchIcon className={cn("size-3.5 shrink-0 group-hover:hidden", !merged && "text-fg-subtle")} />
            <Copy className={cn("hidden size-3.5 shrink-0 group-hover:block", !merged && "text-fg-muted")} />
          </>
        )}
        <span className="truncate">{branch}</span>
      </button>
    </Tooltip>
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
