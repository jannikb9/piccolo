import { AlertTriangle, ChevronRight, FolderGit2, GitBranch, Plus, X } from "lucide-react";
import { prefetchChangedFiles, useAddRepo, useRemoveRepo, useRepos, useWorktreeStats } from "../lib/queries";
import { cn, timeAgo } from "../lib/utils";
import { sortWorktrees, useStore } from "../store";
import type { Repo, Worktree } from "../types";
import { DiffCount, IconButton, Skeleton, Tooltip } from "./ui";

export function Sidebar({ selectedId, shortcuts }: { selectedId: string | null; shortcuts: Map<string, number> }) {
  const repos = useRepos();
  const addRepo = useAddRepo();

  return (
    <aside className="sidebar-surface flex h-full flex-col">
      {/* Titlebar area: the macOS traffic lights sit in the top-left of this strip. */}
      <div data-tauri-drag-region className="flex h-13 shrink-0 items-center justify-end px-3">
        <IconButton label="Add repository" onClick={() => addRepo.mutate()} disabled={addRepo.isPending}>
          <Plus className="size-4" />
        </IconButton>
      </div>

      {addRepo.error && (
        <div className="mx-2 mb-2 flex items-start gap-2 rounded-md border border-del/30 bg-del-bg px-2.5 py-2 text-[12px] text-fg-muted">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-del" />
          <span className="min-w-0 flex-1 break-words">{String(addRepo.error)}</span>
          <button type="button" aria-label="Dismiss" onClick={() => addRepo.reset()} className="text-fg-subtle hover:text-fg">
            <X className="size-3.5" />
          </button>
        </div>
      )}

      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {repos.isPending ? (
          <SidebarSkeleton />
        ) : repos.data?.length === 0 ? (
          <div className="px-2 pt-2 text-[12px] text-fg-subtle">
            <p>No repositories yet.</p>
            <button
              type="button"
              onClick={() => addRepo.mutate()}
              className="mt-2 flex h-7 items-center gap-1.5 rounded-md border border-border px-2 font-medium text-fg-muted hover:border-border-strong hover:text-fg"
            >
              <Plus className="size-3.5" />
              Add repository
            </button>
          </div>
        ) : (
          repos.data?.map((repo) => (
            <RepoSection key={repo.id} repo={repo} selectedId={selectedId} shortcuts={shortcuts} />
          ))
        )}
      </nav>
    </aside>
  );
}

function RepoSection({ repo, selectedId, shortcuts }: { repo: Repo; selectedId: string | null; shortcuts: Map<string, number> }) {
  const collapsed = useStore((s) => !!s.collapsedRepos[repo.id]);
  const toggleRepo = useStore((s) => s.toggleRepo);
  const removeRepo = useRemoveRepo();

  return (
    <section className="mb-3">
      <div className="group flex h-7 items-center rounded-md pr-1 text-[12px] font-medium text-fg-subtle">
        <Tooltip label={<span className="font-mono">{repo.path}</span>} side="right">
          <button
            type="button"
            onClick={() => toggleRepo(repo.id)}
            className="flex h-full min-w-0 flex-1 items-center gap-1.5 px-2 hover:text-fg-muted"
          >
            <FolderGit2 className="size-3.5 shrink-0" />
            <span className="truncate">{repo.name}</span>
            <ChevronRight
              className={cn("size-3 shrink-0 opacity-0 transition-[transform,opacity] group-hover:opacity-100", !collapsed && "rotate-90")}
            />
          </button>
        </Tooltip>
        <IconButton
          label="Remove from sidebar"
          className="size-5 opacity-0 group-hover:opacity-100"
          onClick={() => removeRepo.mutate(repo.id)}
        >
          <X className="size-3" />
        </IconButton>
        <span className="tabular w-4 text-right text-[11px] text-fg-faint group-hover:hidden">{repo.worktrees.length || ""}</span>
      </div>

      {repo.error ? (
        <p className="flex items-start gap-1.5 px-2 py-1 text-[12px] text-fg-subtle">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-mod" />
          <span className="min-w-0 break-words">{repo.error}</span>
        </p>
      ) : (
        !collapsed && (
          <ul className="mt-0.5 space-y-px">
            {sortWorktrees(repo.worktrees).map((wt) => (
              <li key={wt.id}>
                <WorktreeRow
                  worktree={wt}
                  base={repo.defaultBranch}
                  selected={wt.id === selectedId}
                  shortcut={shortcuts.get(wt.id)}
                />
              </li>
            ))}
          </ul>
        )
      )}
    </section>
  );
}

function WorktreeRow({
  worktree: wt,
  base,
  selected,
  shortcut,
}: {
  worktree: Worktree;
  base: string | null;
  selected: boolean;
  shortcut?: number;
}) {
  const selectWorktree = useStore((s) => s.selectWorktree);
  const scope = useStore((s) => s.scope);
  const stats = useWorktreeStats(wt, base);

  return (
    <Tooltip
      side="right"
      label={
        <span className="flex items-center gap-3">
          <span className="font-mono">{wt.path}</span>
          {shortcut && <kbd className="font-sans text-fg-subtle">⌘{shortcut}</kbd>}
        </span>
      }
    >
      <button
        type="button"
        onClick={() => selectWorktree(wt.id)}
        // Loading on hover makes the click feel instant.
        onPointerEnter={() => prefetchChangedFiles(wt, base, scope)}
        aria-current={selected ? "page" : undefined}
        className={cn(
          "group grid w-full grid-cols-[16px_1fr_auto] items-center gap-x-2 gap-y-0.5 rounded-md px-2 py-1.5 text-left transition-colors",
          selected ? "bg-bg-active" : "hover:bg-bg-hover",
        )}
      >
        <GitBranch className={cn("size-3.5", selected ? "text-fg-muted" : "text-fg-subtle")} />
        <span className={cn("truncate text-[13px] font-medium", selected ? "text-fg" : "text-fg-muted group-hover:text-fg")}>
          {wt.branch ?? `detached @ ${wt.head}`}
        </span>
        <span className="tabular text-[11px] text-fg-faint">{wt.updatedAt ? timeAgo(wt.updatedAt) : ""}</span>

        <span className="grid place-items-center">
          {wt.dirty && <span className="size-1.5 rounded-full bg-mod" aria-label="Uncommitted changes" />}
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-fg-subtle">
          <span className="truncate">{wt.isMain ? "root" : wt.name}</span>
          {stats.data && (stats.data.ahead > 0 || stats.data.behind > 0) && (
            <span className="tabular shrink-0 text-fg-faint">
              {stats.data.ahead > 0 && `↑${stats.data.ahead}`}
              {stats.data.ahead > 0 && stats.data.behind > 0 && " "}
              {stats.data.behind > 0 && `↓${stats.data.behind}`}
            </span>
          )}
        </span>
        {stats.isPending ? (
          <Skeleton className="h-2.5 w-9 justify-self-end" />
        ) : (
          <DiffCount additions={stats.data?.additions ?? 0} deletions={stats.data?.deletions ?? 0} className="justify-end" />
        )}
      </button>
    </Tooltip>
  );
}

function SidebarSkeleton() {
  return (
    <div className="space-y-3 px-2 pt-1">
      <Skeleton className="h-3 w-20" />
      {[0, 1, 2].map((i) => (
        <div key={i} className="space-y-1.5 py-1">
          <Skeleton className="h-3 w-36" />
          <Skeleton className="h-2.5 w-20" />
        </div>
      ))}
    </div>
  );
}
