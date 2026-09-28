import type { CodeViewItem, FileDiffLoadedFiles, FileDiffMetadata } from "@pierre/diffs";
import { CodeView, type CodeViewHandle, type CodeViewReactOptions } from "@pierre/diffs/react";
import { ChevronRight, Copy } from "lucide-react";
import { useCallback, useMemo, type CSSProperties, type Ref } from "react";
import { api } from "../lib/api";
import { emptyDiff, hashString, isCollapsedByDefault, parsePatch } from "../lib/diff";
import { cn, splitPath } from "../lib/utils";
import { useStore } from "../store";
import type { ChangedFile, DiffPatch, Worktree } from "../types";
import { DiffBlocks, DiffCount, IconButton, StatusBadge, Tooltip, ViewedToggle } from "./ui";

export type DiffViewHandle = CodeViewHandle<undefined, undefined>;

// Code and chrome share the app's fonts; syntax colours come from the Pierre themes.
const viewStyle = {
  "--diffs-font-family": '"JetBrains Mono Variable", ui-monospace, "SF Mono", Menlo, monospace',
  "--diffs-font-size": "12px",
  "--diffs-line-height": "20px",
  "--diffs-header-font-family": '"Inter Variable", ui-sans-serif, system-ui, sans-serif',
} as CSSProperties;

// Injected into each diff's shadow root. The theme sets its background on :host, so matching the
// app surface needs to happen in here; the body then gets the card border under our header.
const unsafeCSS = /* css */ `
  :host {
    --diffs-dark-bg: var(--bg);
    --diffs-light-bg: var(--bg);
  }
  [data-diffs-header] {
    background: var(--bg);
  }
  [data-diff] {
    border: 1px solid var(--border);
    border-top: 0;
    border-radius: 0 0 8px 8px;
    overflow: clip;
  }
  /* The app chrome disables selection; code should be selectable. */
  [data-code] {
    user-select: text;
    -webkit-user-select: text;
    cursor: text;
  }
`;

export function DiffView({
  worktree,
  files,
  diff,
  viewRef,
}: {
  worktree: Worktree;
  /** Changed files in display order. */
  files: ChangedFile[];
  diff: DiffPatch;
  viewRef: Ref<DiffViewHandle>;
}) {
  const layout = useStore((s) => s.layout);
  const viewed = useStore((s) => s.viewed[worktree.id]);
  const collapsedOverrides = useStore((s) => s.collapsed[worktree.id]);
  const setActivePath = useStore((s) => s.setActivePath);

  // Parsed once per patch: the library hydrates these objects in place when context is expanded.
  const fileDiffs = useMemo(() => parsePatch(diff.patch), [diff.patch]);
  const patchVersion = useMemo(() => hashString(diff.patch), [diff.patch]);
  const byPath = useMemo(() => new Map(files.map((f) => [f.path, f])), [files]);

  const items = useMemo(
    () =>
      files.map((file): CodeViewItem<undefined> => {
        const fileDiff = fileDiffs.get(file.path);
        const hasBody = !!fileDiff && fileDiff.hunks.length > 0;
        const collapsed = !hasBody || (collapsedOverrides?.[file.path] ?? isCollapsedByDefault(file));
        const isViewed = !!viewed?.[file.path];
        return {
          id: file.path,
          type: "diff",
          fileDiff: fileDiff ?? emptyDiff(file.path),
          collapsed,
          // Any change to what the item shows must change its version.
          version: patchVersion * 4 + (collapsed ? 1 : 0) + (isViewed ? 2 : 0),
        };
      }),
    [files, fileDiffs, collapsedOverrides, viewed, patchVersion],
  );

  const loadDiffFiles = useCallback(
    async (fileDiff: FileDiffMetadata): Promise<FileDiffLoadedFiles> => {
      const oldPath = fileDiff.prevName ?? fileDiff.name;
      const versions = await api.fileVersions(worktree.path, diff, oldPath, fileDiff.name);
      if (versions.new == null) throw new Error(`${fileDiff.name} is not available`);
      const key = `${worktree.path}:${diff.oldRev}:${diff.newRev ?? "worktree"}:${patchVersion}`;
      const newFile = { name: fileDiff.name, contents: versions.new, cacheKey: `${key}:new:${fileDiff.name}` };
      if (fileDiff.type === "rename-pure") return { oldFile: null, newFile };
      if (versions.old == null) throw new Error(`${oldPath} is not available`);
      return { oldFile: { name: oldPath, contents: versions.old, cacheKey: `${key}:old:${oldPath}` }, newFile };
    },
    [worktree.path, diff, patchVersion],
  );

  const options = useMemo(
    (): CodeViewReactOptions<undefined, undefined> => ({
      diffStyle: layout,
      diffIndicators: "classic",
      hunkSeparators: "line-info",
      lineDiffType: "word-alt",
      overflow: "scroll",
      expansionLineCount: 20,
      stickyHeaders: true,
      layout: { paddingTop: 12, paddingBottom: 240, gap: 12 },
      unsafeCSS,
      loadDiffFiles,
    }),
    [layout, loadDiffFiles],
  );

  // Highlights the file in the tree whose header is at the top of the viewport.
  const onScroll = useCallback(
    (scrollTop: number, viewer: { getTopForItem(id: string): number | undefined }) => {
      let active = files[0]?.path ?? null;
      for (const file of files) {
        const top = viewer.getTopForItem(file.path);
        if (top === undefined) continue;
        if (top > scrollTop + 16) break;
        active = file.path;
      }
      setActivePath(active);
    },
    [files, setActivePath],
  );

  const renderHeader = useCallback(
    (item: CodeViewItem<undefined>) => {
      const file = byPath.get(item.id);
      if (!file || item.type !== "diff") return null;
      const hasBody = item.fileDiff.hunks.length > 0;
      return (
        <FileHeader
          worktreeId={worktree.id}
          file={file}
          collapsed={!!item.collapsed}
          expandable={hasBody}
          note={hasBody ? null : emptyDiffNote(file, item.fileDiff)}
        />
      );
    },
    [byPath, worktree.id],
  );

  return (
    <CodeView
      ref={viewRef}
      items={items}
      options={options}
      onScroll={onScroll}
      renderCustomHeader={renderHeader}
      className="h-full overflow-auto px-4"
      style={viewStyle}
    />
  );
}

/** Explains why a file has no diff body. */
function emptyDiffNote(file: ChangedFile, fileDiff: FileDiffMetadata): string | null {
  if (file.binary) return "Binary file not shown";
  if (fileDiff.prevMode && fileDiff.mode && fileDiff.prevMode !== fileDiff.mode) {
    if (fileDiff.mode === "100755") return "Made executable";
    if (fileDiff.prevMode === "100755") return "No longer executable";
    return `Mode changed ${fileDiff.prevMode} → ${fileDiff.mode}`;
  }
  if (fileDiff.type === "rename-pure") return "Renamed without changes";
  if (file.additions + file.deletions > 0) return "Diff too large to show";
  return "Empty file";
}

function FileHeader({
  worktreeId,
  file,
  collapsed,
  expandable,
  note,
}: {
  worktreeId: string;
  file: ChangedFile;
  collapsed: boolean;
  expandable: boolean;
  note: string | null;
}) {
  const viewed = useStore((s) => !!s.viewed[worktreeId]?.[file.path]);
  const toggleViewed = useStore((s) => s.toggleViewed);
  const setCollapsed = useStore((s) => s.setCollapsed);
  const { dir, base } = splitPath(file.path);

  return (
    <div
      onClick={() => expandable && setCollapsed(worktreeId, file.path, !collapsed)}
      className={cn(
        "group flex h-10 items-center gap-2 border border-border bg-bg-raised pr-2 pl-2.5 font-sans",
        collapsed ? "rounded-lg" : "rounded-t-lg",
      )}
    >
      <ChevronRight
        className={cn(
          "size-3.5 shrink-0 text-fg-subtle transition-transform duration-150",
          !collapsed && "rotate-90",
          !expandable && "invisible",
        )}
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
      {note && <span className="truncate text-[12px] text-fg-subtle">{note}</span>}

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
    </div>
  );
}
