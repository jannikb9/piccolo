import { Check, ChevronRight, Folder, FolderOpen } from "lucide-react";
import { useState } from "react";
import { cn, type TreeNode } from "../lib/utils";
import { useStore } from "../store";
import { DiffCount, Skeleton, StatusLetter } from "./ui";

export function FilePanel({
  worktreeId,
  tree,
  fileCount,
  viewedCount,
  loading,
  onSelect,
}: {
  worktreeId: string;
  tree: TreeNode[];
  fileCount: number;
  viewedCount: number;
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
          <TreeList nodes={tree} depth={0} worktreeId={worktreeId} onSelect={onSelect} />
        )}
      </div>
    </div>
  );
}

function TreeList({
  nodes,
  depth,
  worktreeId,
  onSelect,
}: {
  nodes: TreeNode[];
  depth: number;
  worktreeId: string;
  onSelect: (path: string) => void;
}) {
  return (
    <ul>
      {nodes.map((node) => (
        <li key={node.path}>
          {node.type === "dir" ? (
            <DirRow node={node} depth={depth} worktreeId={worktreeId} onSelect={onSelect} />
          ) : (
            <FileRow node={node} depth={depth} worktreeId={worktreeId} onSelect={onSelect} />
          )}
        </li>
      ))}
    </ul>
  );
}

const indent = (depth: number) => ({ paddingLeft: 8 + depth * 12 });

function DirRow({
  node,
  depth,
  worktreeId,
  onSelect,
}: {
  node: Extract<TreeNode, { type: "dir" }>;
  depth: number;
  worktreeId: string;
  onSelect: (path: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const Icon = open ? FolderOpen : Folder;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        style={indent(depth)}
        className="flex h-7 w-full items-center gap-1.5 rounded-md pr-2 text-left text-[12.5px] text-fg-subtle hover:bg-bg-hover hover:text-fg-muted"
      >
        <ChevronRight className={cn("size-3 shrink-0 transition-transform duration-150", open && "rotate-90")} />
        <Icon className="size-3.5 shrink-0" />
        <span className="truncate">{node.name}</span>
      </button>
      {open && <TreeList nodes={node.children} depth={depth + 1} worktreeId={worktreeId} onSelect={onSelect} />}
    </>
  );
}

function FileRow({
  node,
  depth,
  worktreeId,
  onSelect,
}: {
  node: Extract<TreeNode, { type: "file" }>;
  depth: number;
  worktreeId: string;
  onSelect: (path: string) => void;
}) {
  const viewed = useStore((s) => !!s.viewed[worktreeId]?.[node.path]);
  const active = useStore((s) => s.activePath === node.path);
  const { file } = node;

  return (
    <button
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
      {viewed ? (
        <Check className="ml-auto size-3.5 shrink-0 text-accent" strokeWidth={2.5} aria-label="Viewed" />
      ) : (
        <DiffCount additions={file.additions} deletions={file.deletions} className="ml-auto shrink-0" />
      )}
    </button>
  );
}
