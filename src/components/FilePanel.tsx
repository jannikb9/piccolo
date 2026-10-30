import { Check, ChevronRight, CornerDownRight, Files, Folder, FolderOpen, MessageSquare, type LucideIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { COLLAPSED_BY_DEFAULT, type FileSection } from "../lib/sections";
import type { OrderedFile } from "../lib/structure";
import { hasUnread, unreadMessages } from "../lib/unread";
import { cn, splitPath, totals, type TreeNode } from "../lib/utils";
import { useStore, type FileTab } from "../store";
import type { ChangedFile, GeneralThread, Thread, Worktree } from "../types";
import { CommentList } from "./CommentList";
import { SidebarToggle } from "./Sidebar";
import { DiffCount, Skeleton, StatusLetter } from "./ui";

export function FilePanel({
  worktree,
  worktreeId,
  sections,
  callOrder,
  fileCount,
  viewedCount,
  commentCounts,
  threads,
  generalThreads,
  loading,
  onSelect,
  sidebarCollapsed,
  onToggleSidebar,
}: {
  /** For comments on the branch as a whole. */
  worktree: Worktree | undefined;
  worktreeId: string;
  /** Non-empty sections (Implementation, Tests, Changesets) in review order. */
  sections: FileSection[];
  /** The files in the order their changes call each other, when they call each other at all. */
  callOrder: { ordered: OrderedFile[]; unconnected: ChangedFile[] } | null;
  fileCount: number;
  /** Threads on lines, and on the branch as a whole, for the Comments tab. */
  threads: Thread[];
  generalThreads: GeneralThread[];
  viewedCount: number;
  /** Open comment threads per file path. */
  commentCounts: Map<string, number>;
  loading: boolean;
  onSelect: (path: string) => void;
  /** With the sidebar hidden, this panel's header holds the traffic lights and the button to show it again. */
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
}) {
  const progress = fileCount === 0 ? 0 : viewedCount / fileCount;
  const tab = useStore((s) => s.fileTab);
  const setTab = useStore((s) => s.setFileTab);
  const openComments = threads.filter((t) => !t.resolved).length + generalThreads.filter((t) => !t.resolved).length;
  const unread = unreadMessages([...generalThreads, ...threads]).length;
  const unreadPaths = new Set(threads.filter(hasUnread).map((t) => t.path));
  const files: ChangedFile[] = sections.flatMap((s) => s.files);
  const sortByCalls = useStore((s) => s.sortByCalls);
  const setSortByCalls = useStore((s) => s.setSortByCalls);
  const rowProps = { worktreeId, commentCounts, unreadPaths, onSelect };

  return (
    <div className="flex h-full flex-col border-r border-border-subtle bg-bg">
      <header
        data-tauri-drag-region
        className={cn(
          "flex h-13 shrink-0 items-center gap-2 border-b border-border-subtle px-3",
          // The macOS traffic lights end 77px in; leave a clear gap after them.
          sidebarCollapsed && "pl-[86px]",
        )}
      >
        {/* A size container, so the tabs drop their labels for icons when there's no room for them. */}
        <div role="tablist" aria-label="Show" className="@container flex min-w-0 flex-1 items-center gap-0.5">
          <TabButton tab="files" current={tab} onSelect={setTab} label="Files" icon={Files} count={fileCount} />
          <TabButton tab="comments" current={tab} onSelect={setTab} label="Comments" icon={MessageSquare} count={openComments} unread={unread} />
        </div>
        {sidebarCollapsed && <SidebarToggle collapsed onToggle={onToggleSidebar} />}
      </header>
      <div className="h-px shrink-0 bg-border-subtle">
        <div className="h-full bg-accent transition-[width] duration-300 ease-out" style={{ width: `${progress * 100}%` }} />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {tab === "comments" ? (
          worktree && <CommentList worktree={worktree} generalThreads={generalThreads} threads={threads} files={files} onSelectFile={onSelect} />
        ) : loading ? (
          <div className="space-y-3 px-2 pt-2">
            {[28, 20, 32, 24, 18].map((w, i) => (
              <Skeleton key={i} className="h-3" style={{ width: `${w * 4}px` }} />
            ))}
          </div>
        ) : fileCount === 0 ? (
          worktreeId && <p className="px-2 py-6 text-center text-[12px] text-fg-subtle">No changed files</p>
        ) : (
          <>
            {callOrder && (
              <div role="radiogroup" aria-label="Order files" className="mb-2 flex items-center gap-0.5 px-1">
                <OrderButton active={!sortByCalls} onClick={() => setSortByCalls(false)} label="Folders" hint="Files by folder" />
                <OrderButton
                  active={sortByCalls}
                  onClick={() => setSortByCalls(true)}
                  label="Calls"
                  hint="Files in the order their changes call each other, callers first"
                />
              </div>
            )}
            {sortByCalls && callOrder ? (
              <CallOrderList {...callOrder} {...rowProps} />
            ) : (
              sections.map((section, i) => (
                <SectionGroup key={section.id} section={section} className={cn(i > 0 && "mt-2")} {...rowProps} />
              ))
            )}
          </>
        )}
      </div>
    </div>
  );
}

function TabButton({
  tab,
  current,
  onSelect,
  label,
  icon: Icon,
  count,
  unread = 0,
}: {
  tab: FileTab;
  current: FileTab;
  onSelect: (tab: FileTab) => void;
  label: string;
  icon: LucideIcon;
  count: number;
  /** New messages from agents, marked with a dot. */
  unread?: number;
}) {
  const active = tab === current;
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      title={label}
      onClick={() => onSelect(tab)}
      className={cn(
        "flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-[13px] font-medium transition-colors",
        active ? "bg-bg-hover text-fg" : "text-fg-subtle hover:bg-bg-hover hover:text-fg-muted",
      )}
    >
      {/* Both labels need about 170px; with less, both tabs show their icon instead. */}
      <Icon aria-hidden className="size-3.5 @min-[176px]:hidden" />
      <span className="sr-only @min-[176px]:not-sr-only">{label}</span>
      <span
        className={cn(
          "tabular shrink-0 rounded-full px-1.5 text-[11px] font-medium text-fg-subtle",
          active ? "bg-bg-active" : "bg-bg-hover",
        )}
      >
        {count}
      </span>
      {unread > 0 && (
        <span
          aria-label={unread === 1 ? "1 new comment" : `${unread} new comments`}
          title={unread === 1 ? "1 new comment" : `${unread} new comments`}
          className="size-1.5 shrink-0 rounded-full bg-accent"
        />
      )}
    </button>
  );
}

function OrderButton({ active, onClick, label, hint }: { active: boolean; onClick: () => void; label: string; hint: string }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      title={hint}
      onClick={onClick}
      className={cn(
        "h-6 rounded-md px-2 text-[12px] transition-colors",
        active ? "bg-bg-hover font-medium text-fg" : "text-fg-subtle hover:bg-bg-hover hover:text-fg-muted",
      )}
    >
      {label}
    </button>
  );
}

/** Files below the ones whose changes use them, then the files no other change touches. */
function CallOrderList({ ordered, unconnected, ...props }: Omit<RowProps, "depth"> & { ordered: OrderedFile[]; unconnected: ChangedFile[] }) {
  const node = (file: ChangedFile): Extract<TreeNode, { type: "file" }> => ({ type: "file", name: splitPath(file.path).base, path: file.path, file });
  return (
    <>
      <ul>
        {ordered.map(({ file, depth }) => (
          <li key={file.path}>
            <FileRow node={node(file)} depth={depth} called={depth > 0} {...props} />
          </li>
        ))}
      </ul>
      {unconnected.length > 0 && (
        <>
          <p className="mt-3 mb-1 px-2 text-[11px] font-semibold tracking-wide text-fg-subtle uppercase">Not connected</p>
          <ul>
            {unconnected.map((file) => (
              <li key={file.path}>
                <FileRow node={node(file)} depth={0} {...props} />
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

/** A collapsible section of the file list (Implementation, Tests, Changesets). */
function SectionGroup({
  section,
  className,
  ...rowProps
}: Omit<RowProps, "depth"> & { section: FileSection; className?: string }) {
  const collapsed = useStore((s) => s.collapsedSections[section.id] ?? COLLAPSED_BY_DEFAULT[section.id]);
  const setCollapsed = useStore((s) => s.setSectionCollapsed);
  // While closed, the header stands in for the file being read, so the reader still knows where they are.
  const holdsActive = useStore((s) => collapsed && !!s.activePath && section.files.some((f) => f.path === s.activePath));
  const { additions, deletions } = totals(section.files);

  return (
    <section className={className}>
      <button
        type="button"
        aria-expanded={!collapsed}
        onClick={() => setCollapsed(section.id, !collapsed)}
        className={cn(
          "flex h-7 w-full items-center gap-1.5 rounded-md px-2 text-left text-[11px] font-semibold tracking-wide uppercase transition-colors hover:bg-bg-hover hover:text-fg-muted",
          holdsActive ? "bg-accent-soft text-fg" : "text-fg-subtle",
        )}
      >
        <ChevronRight className={cn("size-3 shrink-0 transition-transform duration-150", !collapsed && "rotate-90")} />
        {/* In a narrow panel the label gives way, so the counts stay visible. */}
        <span className="min-w-0 truncate">{section.label}</span>
        <span className="tabular shrink-0 rounded-full bg-bg-hover px-1.5 font-medium tracking-normal">{section.files.length}</span>
        <DiffCount additions={additions} deletions={deletions} className="ml-auto shrink-0 font-normal tracking-normal normal-case" />
      </button>
      {!collapsed && <TreeList nodes={section.tree} depth={0} {...rowProps} />}
    </section>
  );
}

type RowProps = {
  depth: number;
  worktreeId: string;
  commentCounts: Map<string, number>;
  /** Files with comments that have something new from an agent. */
  unreadPaths: Set<string>;
  onSelect: (path: string) => void;
};

function TreeList({ nodes, ...props }: RowProps & { nodes: TreeNode[] }) {
  return (
    <ul>
      {nodes.map((node) => (
        <li key={node.path}>
          {node.type === "dir" ? <DirRow node={node} {...props} /> : <FileRow node={node} {...props} />}
        </li>
      ))}
    </ul>
  );
}

const indent = (depth: number) => ({ paddingLeft: 8 + depth * 12 });

function DirRow({ node, ...props }: RowProps & { node: Extract<TreeNode, { type: "dir" }> }) {
  const { depth } = props;
  const [open, setOpen] = useState(true);
  const Icon = open ? FolderOpen : Folder;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        style={indent(depth)}
        // Folder paths sit between the subtle and muted text colours: readable, but quieter than file names.
        className="flex h-7 w-full items-center gap-1.5 rounded-md pr-2 text-left text-[12.5px] text-[color-mix(in_oklab,var(--fg-subtle),var(--fg-muted))] hover:bg-bg-hover hover:text-fg-muted"
      >
        <ChevronRight className={cn("size-3 shrink-0 transition-transform duration-150", open && "rotate-90")} />
        <Icon className="size-3.5 shrink-0" />
        <span className="truncate">{node.name}</span>
      </button>
      {open && <TreeList nodes={node.children} {...props} depth={depth + 1} />}
    </>
  );
}

function FileRow({
  node,
  depth,
  worktreeId,
  commentCounts,
  unreadPaths,
  onSelect,
  called = false,
}: RowProps & {
  node: Extract<TreeNode, { type: "file" }>;
  /** In call order, below a file whose changes use it. */
  called?: boolean;
}) {
  const comments = commentCounts.get(node.path) ?? 0;
  const unread = unreadPaths.has(node.path);
  const viewed = useStore((s) => !!s.viewed[worktreeId]?.[node.path]);
  const active = useStore((s) => s.activePath === node.path);
  const ref = useRef<HTMLButtonElement>(null);
  const { file } = node;

  // Keep the file being read visible in the tree as the diff scrolls.
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: "nearest" });
  }, [active]);

  return (
    <button
      ref={ref}
      type="button"
      onClick={() => onSelect(node.path)}
      title={node.path === node.name ? undefined : node.path}
      style={indent(depth)}
      className={cn(
        "group flex h-7 w-full items-center gap-2 rounded-md pr-2 text-left text-[12.5px] transition-colors",
        active ? "bg-accent-soft text-fg" : "text-fg-muted hover:bg-bg-hover hover:text-fg",
      )}
    >
      {/* Aligns file names with folder names, which have a chevron in this slot. */}
      {called ? <CornerDownRight className="size-3 shrink-0 text-fg-faint" /> : <span className="w-3 shrink-0" />}
      <StatusLetter status={file.status} />
      <span className={cn("truncate", viewed && !active && "text-fg-subtle")}>{node.name}</span>
      {comments > 0 && (
        <span
          className={cn("tabular ml-auto flex shrink-0 items-center gap-0.5 text-[11px]", unread ? "font-medium text-accent" : "text-fg-subtle")}
          aria-label={`${comments} open comments${unread ? ", with something new" : ""}`}
        >
          <MessageSquare className="size-3" />
          {comments}
        </span>
      )}
      {viewed ? (
        <Check className={cn("size-3.5 shrink-0 text-accent", comments === 0 && "ml-auto")} strokeWidth={2.5} aria-label="Viewed" />
      ) : (
        <DiffCount additions={file.additions} deletions={file.deletions} className={cn("shrink-0", comments === 0 && "ml-auto")} />
      )}
    </button>
  );
}
