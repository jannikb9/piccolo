import { ChevronRight, FolderGit2, GitBranch, Plus } from "lucide-react";
import { repos } from "../mock";
import { cn, timeAgo } from "../lib/utils";
import { useStore } from "../store";
import type { Repo, Worktree } from "../types";
import { DiffCount, IconButton, Tooltip } from "./ui";

export function Sidebar() {
  return (
    <aside className="sidebar-surface flex h-full flex-col">
      {/* Titlebar area: the macOS traffic lights sit in the top-left of this strip. */}
      <div data-tauri-drag-region className="flex h-13 shrink-0 items-center justify-end px-3">
        <IconButton label="Add repository">
          <Plus className="size-4" />
        </IconButton>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {repos.map((repo) => (
          <RepoSection key={repo.id} repo={repo} />
        ))}
      </nav>
    </aside>
  );
}

function RepoSection({ repo }: { repo: Repo }) {
  const collapsed = useStore((s) => !!s.collapsedRepos[repo.id]);
  const toggleRepo = useStore((s) => s.toggleRepo);
  // Most recently touched first — usually the worktree an agent just finished in.
  const worktrees = [...repo.worktrees].sort((a, b) => b.updatedAt - a.updatedAt);

  return (
    <section className="mb-3">
      <button
        type="button"
        onClick={() => toggleRepo(repo.id)}
        className="group flex h-7 w-full items-center gap-1.5 rounded-md px-2 text-[12px] font-medium text-fg-subtle hover:text-fg-muted"
      >
        <FolderGit2 className="size-3.5" />
        <span className="truncate">{repo.name}</span>
        <ChevronRight
          className={cn("size-3 opacity-0 transition-[transform,opacity] group-hover:opacity-100", !collapsed && "rotate-90")}
        />
        <span className="tabular ml-auto text-[11px] text-fg-faint">{repo.worktrees.length}</span>
      </button>

      {!collapsed && (
        <ul className="mt-0.5 space-y-px">
          {worktrees.map((wt) => (
            <li key={wt.id}>
              <WorktreeRow worktree={wt} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function WorktreeRow({ worktree: wt }: { worktree: Worktree }) {
  const selected = useStore((s) => s.selectedWorktreeId === wt.id);
  const selectWorktree = useStore((s) => s.selectWorktree);

  return (
    <button
      type="button"
      onClick={() => selectWorktree(wt.id)}
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
      <span className="tabular text-[11px] text-fg-faint">{timeAgo(wt.updatedAt)}</span>

      <span className="grid place-items-center">
        {wt.dirty && (
          <Tooltip label="Uncommitted changes" side="right">
            <span className="size-1.5 rounded-full bg-mod" />
          </Tooltip>
        )}
      </span>
      <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-fg-subtle">
        <span className="truncate">{wt.isMain ? "root" : wt.name}</span>
        {(wt.ahead > 0 || wt.behind > 0) && (
          <span className="tabular shrink-0 text-fg-faint">
            {wt.ahead > 0 && `↑${wt.ahead}`}
            {wt.ahead > 0 && wt.behind > 0 && " "}
            {wt.behind > 0 && `↓${wt.behind}`}
          </span>
        )}
      </span>
      <DiffCount additions={wt.additions} deletions={wt.deletions} className="justify-end" />
    </button>
  );
}
