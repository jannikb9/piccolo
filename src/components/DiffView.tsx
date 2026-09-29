import type { CodeViewItem, DiffLineAnnotation, FileDiffLoadedFiles, FileDiffMetadata, SelectedLineRange } from "@pierre/diffs";
import { CodeView, type CodeViewHandle, type CodeViewReactOptions } from "@pierre/diffs/react";
import { ChevronRight, Copy, MessageSquare } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type Ref } from "react";
import { useShallow } from "zustand/react/shallow";
import { api } from "../lib/api";
import { emptyDiff, hashString, isCollapsedByDefault, parsePatch } from "../lib/diff";
import { useAddThread } from "../lib/queries";
import { clearMatches, findMatches, paintMatches } from "../lib/search";
import { cn, splitPath } from "../lib/utils";
import { useStore } from "../store";
import type { ChangedFile, DiffPatch, LineRange, Thread, Worktree } from "../types";
import { Composer, DetachedNote, ThreadCard } from "./Comments";
import { FindBar } from "./FindBar";
import { DiffBlocks, DiffCount, IconButton, StatusBadge, Tooltip, ViewedToggle } from "./ui";

/** What an annotation row under a diff line holds. */
type Note =
  | { kind: "thread"; thread: Thread }
  /** Threads whose lines changed, shown above the file. */
  | { kind: "outdated"; threads: Thread[] }
  | { kind: "draft"; key: string; range: LineRange };

export type DiffViewHandle = CodeViewHandle<Note, undefined>;

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

    /* Quieter row tints than the theme defaults so syntax colours stay readable on changed
       lines; the changed words themselves get the stronger tint. The library mixes these
       overrides into the background again (20% on lines, 15% on numbers in dark; 12% / 9% in
       light), so 40% here is about an 8% tint on a dark line. */
    --diffs-addition-color-override: var(--add);
    --diffs-deletion-color-override: var(--del);
    --diffs-bg-addition-override: color-mix(in oklab, var(--add) 40%, var(--bg));
    --diffs-bg-addition-number-override: color-mix(in oklab, var(--add) 75%, var(--bg));
    --diffs-bg-addition-emphasis-override: color-mix(in oklab, var(--add) 28%, transparent);
    --diffs-bg-deletion-override: color-mix(in oklab, var(--del) 40%, var(--bg));
    --diffs-bg-deletion-number-override: color-mix(in oklab, var(--del) 75%, var(--bg));
    --diffs-bg-deletion-emphasis-override: color-mix(in oklab, var(--del) 28%, transparent);
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
  /* Selected lines (for commenting) and the gutter "+" use the app accent, tinted lightly so
     the code stays readable. */
  :host {
    --diffs-selection-base: var(--accent);
    --diffs-bg-selection-override: color-mix(in oklab, var(--accent) 30%, var(--bg));
    --diffs-bg-selection-number-override: color-mix(in oklab, var(--accent) 45%, var(--bg));
  }
  [data-utility-button] {
    background-color: var(--accent);
    color: var(--accent-fg);
    border-radius: 5px;
    box-shadow: 0 1px 2px rgb(0 0 0 / 0.25);
  }
  [data-utility-button]:hover {
    filter: brightness(1.12);
  }
  [data-line-annotation] {
    --diffs-annotation-bg: var(--bg);
  }
  /* ⌘F matches, painted with the CSS Custom Highlight API (see lib/search.ts). */
  ::highlight(review-find) {
    background-color: color-mix(in oklab, var(--mod) 38%, transparent);
  }
  ::highlight(review-find-current) {
    background-color: var(--mod);
    color: oklch(0.2 0.02 70);
  }
`;

/** A library selection as stored ranges: sides default to the new version, top line first. */
function toLineRange(selection: SelectedLineRange): LineRange {
  const startSide = selection.side ?? "additions";
  const endSide = selection.endSide ?? startSide;
  const range = { startSide, startLine: selection.start, endSide, endLine: selection.end };
  const upwards = startSide === endSide ? selection.start > selection.end : startSide === "additions";
  return upwards
    ? { startSide: endSide, startLine: selection.end, endSide: startSide, endLine: selection.start }
    : range;
}

/** Changes whenever an annotation would render differently, to bump the item's version. */
function annotationSignature(annotations: DiffLineAnnotation<Note>[]): string {
  const thread = (t: Thread) => `${t.id}.${t.updatedAt}.${t.resolved ? 1 : 0}.${t.messages.map((m) => m.id).join(",")}`;
  return annotations
    .map(({ side, lineNumber, metadata: note }) => {
      const detail =
        note.kind === "thread" ? thread(note.thread) : note.kind === "outdated" ? note.threads.map(thread).join("|") : note.key;
      return `${side}:${lineNumber}:${note.kind}:${detail}`;
    })
    .join(";");
}

export function DiffView({
  worktree,
  base,
  files,
  diff,
  threads,
  viewRef,
}: {
  worktree: Worktree;
  base: string | null;
  /** Changed files in display order. */
  files: ChangedFile[];
  diff: DiffPatch;
  threads: Thread[];
  viewRef: Ref<DiffViewHandle>;
}) {
  const layout = useStore((s) => s.layout);
  const viewed = useStore((s) => s.viewed[worktree.id]);
  const collapsedOverrides = useStore((s) => s.collapsed[worktree.id]);
  const setActivePath = useStore((s) => s.setActivePath);
  const startDraft = useStore((s) => s.startDraft);
  const discardDraft = useStore((s) => s.discardDraft);
  // Keys only: typing in a draft mustn't rebuild the items.
  const draftKeys = useStore(
    useShallow((s) => Object.keys(s.drafts).filter((key) => s.drafts[key].worktreeId === worktree.id)),
  );
  const localRef = useRef<DiffViewHandle>(null);
  const setRefs = useCallback(
    (handle: DiffViewHandle | null) => {
      localRef.current = handle;
      if (typeof viewRef === "function") viewRef(handle);
      else if (viewRef) viewRef.current = handle;
    },
    [viewRef],
  );

  // Parsed once per patch: the library hydrates these objects in place when context is expanded.
  const fileDiffs = useMemo(() => parsePatch(diff.patch), [diff.patch]);
  const patchVersion = useMemo(() => hashString(diff.patch), [diff.patch]);
  const byPath = useMemo(() => new Map(files.map((f) => [f.path, f])), [files]);

  const annotationsByPath = useMemo(() => {
    const map = new Map<string, DiffLineAnnotation<Note>[]>();
    const add = (path: string, annotation: DiffLineAnnotation<Note>) => {
      const list = map.get(path) ?? [];
      list.push(annotation);
      map.set(path, list);
    };
    const outdated = new Map<string, Thread[]>();
    for (const thread of threads) {
      const { position } = thread;
      if (position) {
        add(thread.path, { side: position.endSide, lineNumber: position.endLine, metadata: { kind: "thread", thread } });
      } else {
        outdated.set(thread.path, [...(outdated.get(thread.path) ?? []), thread]);
      }
    }
    // Line 0 renders above the file's first hunk.
    for (const [path, list] of outdated) add(path, { side: "additions", lineNumber: 0, metadata: { kind: "outdated", threads: list } });
    const drafts = useStore.getState().drafts;
    for (const key of draftKeys) {
      const draft = drafts[key];
      if (!draft) continue;
      const { range } = draft;
      add(draft.path, { side: range.endSide, lineNumber: range.endLine, metadata: { kind: "draft", key, range } });
    }
    return map;
  }, [threads, draftKeys]);

  const items = useMemo(
    () =>
      files.map((file): CodeViewItem<Note> => {
        const fileDiff = fileDiffs.get(file.path);
        const hasBody = !!fileDiff && fileDiff.hunks.length > 0;
        const collapsed = !hasBody || (collapsedOverrides?.[file.path] ?? isCollapsedByDefault(file));
        const isViewed = !!viewed?.[file.path];
        const annotations = annotationsByPath.get(file.path) ?? [];
        return {
          id: file.path,
          type: "diff",
          fileDiff: fileDiff ?? emptyDiff(file.path),
          annotations,
          collapsed,
          // Any change to what the item shows must change its version.
          version: hashString(`${patchVersion}:${collapsed}:${isViewed}:${annotationSignature(annotations)}`),
        };
      }),
    [files, fileDiffs, collapsedOverrides, viewed, patchVersion, annotationsByPath],
  );

  // Clicking or dragging the gutter "+" (or a selection's "+") opens a comment on those lines.
  const startComment = useRef<(selection: SelectedLineRange, path: string) => void>(null);
  startComment.current = (selection, path) => {
    const file = byPath.get(path);
    if (!file) return;
    startDraft({ worktreeId: worktree.id, path, oldPath: file.oldPath ?? null, range: toLineRange(selection) });
  };
  const closeDraft = useCallback(
    (key: string) => {
      discardDraft(key);
      localRef.current?.clearSelectedLines();
    },
    [discardDraft],
  );

  // ⌘F: search the lines of expanded files, like a browser's find in page.
  const [find, setFind] = useState({ open: false, query: "", current: -1, focusKey: 0 });
  const containerRef = useRef<HTMLDivElement>(null);
  const searchable = useMemo(
    () => items.flatMap((item) => (item.type === "diff" && !item.collapsed ? [{ path: item.id, fileDiff: item.fileDiff }] : [])),
    [items],
  );
  const matches = useMemo(() => (find.open ? findMatches(searchable, find.query) : []), [find.open, searchable, find.query]);
  const current = matches.length === 0 ? -1 : Math.min(Math.max(find.current, 0), matches.length - 1);

  const setQuery = (query: string) => {
    // Start from the file being read, as a browser starts from the current scroll position.
    const next = findMatches(searchable, query);
    const active = useStore.getState().activePath;
    const from = Math.max(0, searchable.findIndex((f) => f.path === active));
    const order = new Map(searchable.map((f, i) => [f.path, i]));
    const first = next.findIndex((m) => (order.get(m.path) ?? 0) >= from);
    setFind((f) => ({ ...f, query, current: next.length === 0 ? -1 : Math.max(first, 0) }));
  };
  const step = useCallback(
    (delta: 1 | -1) =>
      setFind((f) => (matches.length === 0 ? f : { ...f, current: (current + delta + matches.length) % matches.length })),
    [matches.length, current],
  );
  const closeFind = useCallback(() => setFind((f) => ({ ...f, open: false })), []);

  // Bring the current match into view, also after switching between split and unified.
  const match = current >= 0 ? matches[current] : undefined;
  useEffect(() => {
    if (!match) return;
    localRef.current?.scrollTo({ type: "line", id: match.path, lineNumber: match.line, side: match.side, align: "center" });
  }, [match, layout]);

  // Highlights are painted on rendered lines, so repaint whenever the diff renders more of them.
  const paint = useRef<() => void>(() => {});
  paint.current = () => paintMatches(containerRef.current, matches, current);
  const repaintFrame = useRef(0);
  const schedulePaint = useCallback(() => {
    cancelAnimationFrame(repaintFrame.current);
    repaintFrame.current = requestAnimationFrame(() => paint.current());
  }, []);
  useEffect(() => {
    paint.current();
  }, [matches, current]);
  useEffect(() => () => clearMatches(), []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!e.metaKey || e.altKey || e.ctrlKey) return;
      if (e.key === "f" && !e.shiftKey) {
        e.preventDefault();
        setFind((f) => ({ ...f, open: true, focusKey: f.focusKey + 1 }));
      } else if (e.key.toLowerCase() === "g" && find.open) {
        e.preventDefault();
        step(e.shiftKey ? -1 : 1);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [find.open, step]);

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
    (): CodeViewReactOptions<Note, undefined> => ({
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
      enableLineSelection: true,
      enableGutterUtility: true,
      onGutterUtilityClick: (selection: SelectedLineRange, context: { item: CodeViewItem<Note> }) =>
        startComment.current?.(selection, context.item.id),
      onPostRender: schedulePaint,
    }),
    [layout, loadDiffFiles, schedulePaint],
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
      schedulePaint();
    },
    [files, setActivePath, schedulePaint],
  );

  const renderHeader = useCallback(
    (item: CodeViewItem<Note>) => {
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

  const renderAnnotation = useCallback(
    (annotation: { metadata?: Note }, item: CodeViewItem<Note>) => {
      const note = annotation.metadata;
      if (!note) return null;
      switch (note.kind) {
        case "thread":
          return <ThreadCard thread={note.thread} />;
        case "outdated":
          return note.threads.map((thread) => (
            <ThreadCard key={thread.id} thread={thread} note={<DetachedNote thread={thread} reason="Outdated" />} />
          ));
        case "draft":
          return (
            <DraftComposer
              worktree={worktree}
              base={base}
              file={byPath.get(item.id)}
              draftKey={note.key}
              range={note.range}
              onClose={closeDraft}
            />
          );
      }
    },
    [worktree, base, byPath, closeDraft],
  );

  // Threads on files that no longer differ can't sit in the diff; list them above it.
  const orphans = useMemo(() => threads.filter((t) => !byPath.has(t.path)), [threads, byPath]);
  const renderViewHeader = useCallback(
    () =>
      orphans.length > 0 && (
        <section className="pt-3 font-sans">
          <h2 className="flex items-center gap-1.5 px-1 text-[12px] font-medium text-fg-subtle">
            <MessageSquare className="size-3.5" />
            Comments on files without changes in this view
          </h2>
          {orphans.map((thread) => (
            <ThreadCard key={thread.id} thread={thread} note={<DetachedNote thread={thread} reason="Not in diff" />} />
          ))}
        </section>
      ),
    [orphans],
  );

  return (
    <div className="relative h-full">
      {find.open && (
        <FindBar
          query={find.query}
          onQueryChange={setQuery}
          count={matches.length}
          current={current}
          capped={matches.length >= 5000}
          focusKey={find.focusKey}
          onStep={step}
          onClose={closeFind}
        />
      )}
      <CodeView<Note>
        ref={setRefs}
        containerRef={containerRef}
        items={items}
        options={options}
        onScroll={onScroll}
        renderCustomHeader={renderHeader}
        renderAnnotation={renderAnnotation}
        renderCodeViewHeader={renderViewHeader}
        className="h-full overflow-auto px-4"
        style={viewStyle}
      />
    </div>
  );
}

function DraftComposer({
  worktree,
  base,
  file,
  draftKey: key,
  range,
  onClose,
}: {
  worktree: Worktree;
  base: string | null;
  file: ChangedFile | undefined;
  draftKey: string;
  range: LineRange;
  onClose: (key: string) => void;
}) {
  const scope = useStore((s) => s.scope);
  const addThread = useAddThread(worktree, base, scope);
  if (!file) return null;
  return (
    <Composer
      draftKey={key}
      range={range}
      pending={addThread.isPending}
      error={addThread.error}
      onCancel={() => onClose(key)}
      onSubmit={(body) =>
        addThread.mutate({ file: file.path, oldFile: file.oldPath ?? null, range, body }, { onSuccess: () => onClose(key) })
      }
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
      data-file-path={file.path}
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
