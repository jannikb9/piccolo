import { Check, ChevronRight, Folder, FolderOpen, MessageSquare } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { COLLAPSED_BY_DEFAULT, type FileSection } from "../lib/sections";
import { cn, totals, type TreeNode } from "../lib/utils";
import { useStore } from "../store";
import { DiffCount, Skeleton, StatusLetter } from "./ui";

export function FilePanel({
  worktreeId,
  sections,
  fileCount,
  viewedCount,
  commentCounts,
  loading,
  onSelect,
}: {
  worktreeId: string;
  /** Non-empty sections (Implementation, Tests, Changesets) in review order. */
  sections: FileSection[];
  fileCount: number;
  viewedCount: number;
  /** Open comment threads per file path. */
  commentCounts: Map<string, number>;
  loading: boolean;
  onSelect: (path: string) => void;
}) {
  const progress = fileCount === 0 ? 0 : viewedCount / fileCount;

  return (
    <div className="flex h-full flex-col border-r border-border-subtle bg-bg">
      <header data-tauri-drag-region className="flex h-13 shrink-0 items-center gap-2 border-b border-border-subtle px-4">
        <span className="pointer-events-none text-[13px] font-medium">Files</span>
        <span className="tabular pointer-events-none rounded-full bg-bg-hover px-1.5 text-[11px] font-medium text-fg-subtle">
          {fileCount}
        </span>
        <span className="tabular pointer-events-none ml-auto text-[11px] text-fg-subtle">
          {viewedCount} / {fileCount} viewed
        </span>
      </header>
      <div className="h-px shrink-0 bg-border-subtle">
        <div className="h-full bg-accent transition-[width] duration-300 ease-out" style={{ width: `${progress * 100}%` }} />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {loading ? (
          <div className="space-y-3 px-2 pt-2">
            {[28, 20, 32, 24, 18].map((w, i) => (
              <Skeleton key={i} className="h-3" style={{ width: `${w * 4}px` }} />
            ))}
          </div>
        ) : fileCount === 0 ? (
          worktreeId && <p className="px-2 py-6 text-center text-[12px] text-fg-subtle">No changed files</p>
        ) : (
          sections.map((section, i) => (
            <SectionGroup
              key={section.id}
              section={section}
              className={cn(i > 0 && "mt-2")}
              worktreeId={worktreeId}
              commentCounts={commentCounts}
              onSelect={onSelect}
            />
          ))
        )}
      </div>
    </div>
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
        {section.label}
        <span className="tabular rounded-full bg-bg-hover px-1.5 font-medium tracking-normal">{section.files.length}</span>
        <DiffCount additions={additions} deletions={deletions} className="ml-auto font-normal tracking-normal normal-case" />
      </button>
      {!collapsed && <TreeList nodes={section.tree} depth={0} {...rowProps} />}
    </section>
  );
}

type RowProps = {
  depth: number;
  worktreeId: string;
  commentCounts: Map<string, number>;
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
  onSelect,
}: RowProps & { node: Extract<TreeNode, { type: "file" }> }) {
  const comments = commentCounts.get(node.path) ?? 0;
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
      style={indent(depth)}
      className={cn(
        "group flex h-7 w-full items-center gap-2 rounded-md pr-2 text-left text-[12.5px] transition-colors",
        active ? "bg-accent-soft text-fg" : "text-fg-muted hover:bg-bg-hover hover:text-fg",
      )}
    >
      {/* Aligns file names with folder names, which have a chevron in this slot. */}
      <span className="w-3 shrink-0" />
      <StatusLetter status={file.status} />
      <span className={cn("truncate", viewed && !active && "text-fg-subtle")}>{node.name}</span>
      {comments > 0 && (
        <span className="tabular ml-auto flex shrink-0 items-center gap-0.5 text-[11px] text-fg-subtle" aria-label={`${comments} open comments`}>
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
