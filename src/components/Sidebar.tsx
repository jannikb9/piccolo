import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type Modifier,
} from "@dnd-kit/core";
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useState } from "react";
import {
  AlertTriangle,
  ArrowRightLeft,
  ChevronRight,
  Copy,
  EllipsisVertical,
  FolderGit2,
  GitBranch,
  GitBranchPlus,
  GitMerge,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import {
  prefetchWorktree,
  useAddRepo,
  useDeleteWorktree,
  useRemoveRepo,
  useReorderRepos,
  useRepos,
  useSessions,
  useWorktreeStats,
} from "../lib/queries";
import { agentLabel, cn, timeAgo } from "../lib/utils";
import { sortWorktrees, useDiffOptions, useStore } from "../store";
import type { Repo, Worktree } from "../types";
import { AgentIcon } from "./AgentIcon";
import { BranchPicker } from "./BranchPicker";
import { ContextMenu, DiffCount, DropdownMenu, IconButton, Skeleton, Tooltip, type MenuItem } from "./ui";

/** Shows or hides the worktree sidebar. */
export function SidebarToggle({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const Icon = collapsed ? PanelLeftOpen : PanelLeftClose;
  return (
    <IconButton label={collapsed ? "Show sidebar" : "Hide sidebar"} onClick={onToggle}>
      <Icon className="size-4" />
    </IconButton>
  );
}

export function Sidebar({
  selectedId,
  shortcuts,
  onToggle,
}: {
  selectedId: string | null;
  shortcuts: Map<string, number>;
  onToggle: () => void;
}) {
  const repos = useRepos();
  const addRepo = useAddRepo();

  return (
    <aside className="sidebar-surface flex h-full flex-col">
      {/* Titlebar area: the macOS traffic lights sit in the top-left of this strip. */}
      <div data-tauri-drag-region className="flex h-13 shrink-0 items-center justify-end gap-1 px-3">
        <IconButton label="Add repository" onClick={() => addRepo.mutate()} disabled={addRepo.isPending}>
          <Plus className="size-4" />
        </IconButton>
        <SidebarToggle collapsed={false} onToggle={onToggle} />
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
          repos.data && <RepoList repos={repos.data} selectedId={selectedId} shortcuts={shortcuts} />
        )}
      </nav>
    </aside>
  );
}

const verticalOnly: Modifier = ({ transform }) => ({ ...transform, x: 0 });

/** When the last drag ended; the click that ends a drag mustn't also collapse the repository. */
let lastDragEnd = 0;

/** Repositories in the user's order; drag a repository's header to move it. */
function RepoList({ repos, selectedId, shortcuts }: { repos: Repo[]; selectedId: string | null; shortcuts: Map<string, number> }) {
  const reorder = useReorderRepos();
  const sensors = useSensors(
    // A few pixels of movement before a drag starts, so clicks still toggle the repository.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const ids = repos.map((r) => r.id);

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    lastDragEnd = Date.now();
    if (!over || active.id === over.id) return;
    reorder.mutate(arrayMove(ids, ids.indexOf(String(active.id)), ids.indexOf(String(over.id))));
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[verticalOnly]}
      onDragEnd={onDragEnd}
      onDragCancel={() => (lastDragEnd = Date.now())}
    >
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        {repos.map((repo) => (
          <RepoSection key={repo.id} repo={repo} selectedId={selectedId} shortcuts={shortcuts} />
        ))}
      </SortableContext>
    </DndContext>
  );
}

function RepoSection({ repo, selectedId, shortcuts }: { repo: Repo; selectedId: string | null; shortcuts: Map<string, number> }) {
  const collapsed = useStore((s) => !!s.collapsedRepos[repo.id]);
  const toggleRepo = useStore((s) => s.toggleRepo);
  const removeRepo = useRemoveRepo();
  const [pickingBranch, setPickingBranch] = useState(false);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: repo.id });

  return (
    <section
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn("relative mb-3 rounded-md", isDragging && "z-10 bg-bg-sidebar shadow-lg ring-1 shadow-black/30 ring-border")}
    >
      <div
        {...attributes}
        {...listeners}
        aria-label={`${repo.name}, drag to reorder`}
        className="group flex h-7 items-center rounded-md pr-1 text-[12px] font-medium text-fg-subtle outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <button
          type="button"
          onClick={() => Date.now() - lastDragEnd > 100 && toggleRepo(repo.id)}
          className="flex h-full min-w-0 flex-1 items-center gap-1.5 px-2 hover:text-fg-muted"
        >
          <FolderGit2 className="size-3.5 shrink-0" />
          {/* Only the name shows the path, and below it, so the tooltip never covers the buttons. */}
          <Tooltip label={<span className="font-mono">{repo.path}</span>}>
            <span className="truncate">{repo.name}</span>
          </Tooltip>
          <ChevronRight
            className={cn("size-3 shrink-0 opacity-0 transition-[transform,opacity] group-hover:opacity-100", !collapsed && "rotate-90")}
          />
        </button>
        {!repo.error && (
          <IconButton
            label="New worktree from branch"
            className="size-5 opacity-0 group-hover:opacity-100"
            onClick={() => setPickingBranch(true)}
          >
            <GitBranchPlus className="size-3" />
          </IconButton>
        )}
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
      <BranchPicker repo={repo} open={pickingBranch} onOpenChange={setPickingBranch} />
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
  const diffOptions = useDiffOptions();
  const stats = useWorktreeStats(wt, base);
  const sessions = useSessions(wt);
  const deleteWorktree = useDeleteWorktree();
  // Shared by right-click and the "⋮" button.
  const menu: MenuItem[] = [
    {
      label: "Switch to worktree",
      icon: <ArrowRightLeft className="size-3.5 text-fg-subtle" />,
      shortcut: "S",
      onSelect: () => selectWorktree(wt.id),
    },
    {
      label: "Copy worktree name",
      icon: <Copy className="size-3.5 text-fg-subtle" />,
      shortcut: "C",
      onSelect: () => navigator.clipboard.writeText(wt.name),
    },
    // The main worktree is the repository itself.
    ...(wt.isMain
      ? []
      : [
          {
            label: "Delete worktree",
            icon: <Trash2 className="size-3.5 text-fg-subtle" />,
            shortcut: "D",
            onSelect: () => deleteWorktree.mutate({ worktree: wt, merged: !!stats.data?.merged }),
          },
        ]),
  ];

  return (
    <div className="group/row relative">
      <Tooltip
        side="right"
        label={
          <span className="flex flex-col gap-1">
            <span className="flex items-center gap-3">
              <span className="font-mono">{wt.path}</span>
              {shortcut && <kbd className="font-sans text-fg-subtle">⌘{shortcut}</kbd>}
            </span>
            {sessions.map((s) => (
              <span key={s.id} className="flex max-w-80 items-center gap-1.5">
                <AgentIcon name={s.agent} className="size-3.5" />
                <span className="truncate text-fg">{s.title ?? `${agentLabel(s.agent)} session`}</span>
                {s.status === "busy" && <span className="shrink-0 text-fg-subtle">working</span>}
              </span>
            ))}
          </span>
        }
      >
        <ContextMenu items={menu}>
          <button
            type="button"
            onClick={() => selectWorktree(wt.id)}
            onPointerEnter={() => prefetchWorktree(wt, base, scope, diffOptions)}
            aria-current={selected ? "page" : undefined}
            className={cn(
              "group grid w-full grid-cols-[16px_1fr_auto] items-center gap-x-2 gap-y-0.5 rounded-md px-2 py-1.5 text-left transition-colors",
              selected ? "bg-bg-active" : "hover:bg-bg-hover",
            )}
          >
            {stats.data?.merged ? (
              <GitMerge className="size-3.5 text-merged" aria-label="Merged" />
            ) : (
              <GitBranch className={cn("size-3.5", selected ? "text-fg-muted" : "text-fg-subtle")} />
            )}
            <span className="flex min-w-0 items-center gap-1.5">
              <span className={cn("truncate text-[13px] font-medium", selected ? "text-fg" : "text-fg-muted group-hover:text-fg")}>
                {wt.branch ?? `detached @ ${wt.head}`}
              </span>
              {/* Agent sessions working on it, named in the tooltip. */}
              {[...new Set(sessions.map((s) => s.agent))].map((agent) => (
                <AgentIcon key={agent} name={agent} className="size-3 shrink-0" />
              ))}
            </span>
            {/* The "⋮" button takes its place on hover and while its menu is open. */}
            <span className="tabular text-[11px] text-fg-faint group-hover/row:invisible group-has-[[data-state=open]]/row:invisible">
              {wt.updatedAt ? timeAgo(wt.updatedAt) : ""}
            </span>

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
        </ContextMenu>
      </Tooltip>
      <DropdownMenu items={menu}>
        <IconButton
          label="More"
          className="absolute top-1.5 right-1.5 size-5 opacity-0 group-hover/row:opacity-100 data-[state=open]:bg-bg-hover data-[state=open]:opacity-100"
        >
          <EllipsisVertical className="size-3.5" />
        </IconButton>
      </DropdownMenu>
    </div>
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
