import type {
  CodeViewItem,
  DiffLineAnnotation,
  FileDiffLoadedFiles,
  FileDiffMetadata,
  PostRenderPhase,
  SelectedLineRange,
} from "@pierre/diffs";
import { CodeView, type CodeViewHandle, type CodeViewReactOptions } from "@pierre/diffs/react";
import { ChevronRight, Copy, MessageSquare } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type Ref } from "react";
import { useShallow } from "zustand/react/shallow";
import { api } from "../lib/api";
import { unsafeCSS, viewStyle } from "../lib/codeViewStyle";
import { markCommentedLines } from "../lib/commentedLines";
import { emptyDiff, hashString, isCollapsedByDefault, parsePatch } from "../lib/diff";
import { useAddThread, useDiffScope } from "../lib/queries";
import {
  clearMatches,
  FIND_LAYER,
  findMatches,
  inScreenOrder,
  isInside,
  isMatchInView,
  matchFromView,
  MAX_MATCHES,
  OCCURRENCE_LAYER,
  paintMatches,
  type SearchMatch,
} from "../lib/search";
import { cn, splitPath } from "../lib/utils";
import { useStore } from "../store";
import type { ChangedFile, DiffPatch, GeneralThread, LineRange, Side, Thread, Worktree } from "../types";
import { CodeNavigation } from "./CodeNav";
import { Composer, Conversation, DetachedNote, ThreadCard } from "./Comments";
import { FindBar } from "./FindBar";
import { WorktreeContext } from "./SendToAgent";
import { DiffBlocks, DiffCount, IconButton, StatusBadge, Tooltip, ViewedToggle } from "./ui";

/** What an annotation row under a diff line holds. */
type Note =
  | { kind: "thread"; thread: Thread }
  /** Threads whose lines changed, shown above the file. */
  | { kind: "outdated"; threads: Thread[] }
  | { kind: "draft"; key: string; range: LineRange };

export type DiffViewHandle = CodeViewHandle<Note, undefined>;

const matchKey = (m: SearchMatch) => `${m.path}\n${m.side}\n${m.line}\n${m.start}`;

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
  const thread = (t: Thread) =>
    `${t.id}.${t.updatedAt}.${t.resolved ? 1 : 0}.${t.pending ? 1 : 0}.${t.messages.map((m) => m.id).join(",")}`;
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
  generalThreads,
  viewRef,
}: {
  worktree: Worktree;
  base: string | null;
  /** Changed files in display order. */
  files: ChangedFile[];
  diff: DiffPatch;
  threads: Thread[];
  generalThreads: GeneralThread[];
  viewRef: Ref<DiffViewHandle>;
}) {
  const layout = useStore((s) => s.layout);
  const viewed = useStore((s) => s.viewed[worktree.id]);
  const collapsedOverrides = useStore((s) => s.collapsed[worktree.id]);
  const setActivePath = useStore((s) => s.setActivePath);
  const pinActivePath = useStore((s) => s.pinActivePath);
  const setCollapsed = useStore((s) => s.setCollapsed);
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

  // The lines of open threads and drafts are marked in the gutter.
  const commentedRanges = useMemo(() => {
    const map = new Map<string, LineRange[]>();
    const add = (path: string, range: LineRange) => map.set(path, [...(map.get(path) ?? []), range]);
    for (const thread of threads) {
      if (thread.position && !thread.resolved) add(thread.path, thread.position);
    }
    const drafts = useStore.getState().drafts;
    for (const key of draftKeys) {
      const draft = drafts[key];
      if (draft) add(draft.path, draft.range);
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

  // ⌘F: search the lines of expanded files. Typing only highlights; stepping starts from what's on
  // screen and only scrolls when the next match isn't visible.
  const [find, setFind] = useState({ open: false, query: "", currentKey: null as string | null, focusKey: 0 });
  const containerRef = useRef<HTMLDivElement>(null);
  const searchable = useMemo(
    () => items.flatMap((item) => (item.type === "diff" && !item.collapsed ? [{ path: item.id, fileDiff: item.fileDiff }] : [])),
    [items],
  );
  const fileIndex = useMemo(() => new Map(searchable.map((f, i) => [f.path, i])), [searchable]);
  const matches = useMemo(
    () => (find.open ? inScreenOrder(findMatches(searchable, find.query), layout) : []),
    [find.open, searchable, find.query, layout],
  );
  // The current match is kept by identity, so it survives the list being rebuilt or reordered.
  const current = find.currentKey === null ? -1 : matches.findIndex((m) => matchKey(m) === find.currentKey);

  const setQuery = (query: string) => setFind((f) => ({ ...f, query, currentKey: null }));
  const step = useCallback(
    (direction: 1 | -1) => {
      if (matches.length === 0) return;
      const container = containerRef.current;
      const index =
        current >= 0 && isMatchInView(container, matches[current], fileIndex, layout)
          ? (current + direction + matches.length) % matches.length
          : matchFromView(container, matches, direction, fileIndex, layout, fileIndex.get(useStore.getState().activePath ?? "") ?? 0);
      const target = matches[index];
      setFind((f) => ({ ...f, currentKey: matchKey(target) }));
      if (!isMatchInView(container, target, fileIndex, layout)) {
        localRef.current?.scrollTo({ type: "line", id: target.path, lineNumber: target.line, side: target.side, align: "center" });
      }
    },
    [matches, current, fileIndex, layout],
  );
  const closeFind = useCallback(() => setFind((f) => ({ ...f, open: false })), []);

  // Selecting text highlights where else it occurs, like a code editor does.
  const [selected, setSelected] = useState("");
  useEffect(() => {
    let timer = 0;
    const onSelectionChange = () => {
      clearTimeout(timer);
      timer = window.setTimeout(() => {
        const selection = document.getSelection();
        const text = selection?.toString() ?? "";
        const inCode = isInside(containerRef.current, selection?.anchorNode ?? null) && !document.activeElement?.closest("textarea, input");
        setSelected(inCode && text.trim().length >= 2 && text.length <= 200 && !text.includes("\n") ? text : "");
      }, 120);
    };
    document.addEventListener("selectionchange", onSelectionChange);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("selectionchange", onSelectionChange);
    };
  }, []);
  // After jumping to a name (see CodeNav.tsx), its occurrences stay highlighted until the next click.
  const [jumpedTo, setJumpedTo] = useState("");
  const occurrences = useMemo(
    () =>
      selected
        ? findMatches(searchable, selected, { caseSensitive: true })
        : jumpedTo
          ? findMatches(searchable, jumpedTo, { caseSensitive: true, wholeWord: true })
          : [],
    [searchable, selected, jumpedTo],
  );

  // Highlights are painted on rendered lines, so repaint whenever the diff renders more of them.
  const paint = useRef<() => void>(() => {});
  paint.current = () => {
    paintMatches(containerRef.current, matches, current, FIND_LAYER, fileIndex, layout);
    paintMatches(containerRef.current, occurrences, -1, OCCURRENCE_LAYER, fileIndex, layout);
  };
  // Scrolling calls this every frame; with nothing to highlight it must not touch the page.
  const hasMatches = useRef(false);
  hasMatches.current = matches.length > 0 || occurrences.length > 0;
  const repaintFrame = useRef(0);
  const schedulePaint = useCallback(() => {
    if (!hasMatches.current) return;
    cancelAnimationFrame(repaintFrame.current);
    repaintFrame.current = requestAnimationFrame(() => paint.current());
  }, []);
  useEffect(() => {
    paint.current();
  }, [matches, current, occurrences]);
  const markCommented = useRef<(host: Element) => void>(() => {});
  markCommented.current = (host) => markCommentedLines(host, commentedRanges, fileDiffs);
  useEffect(() => {
    for (const host of containerRef.current?.querySelectorAll("diffs-container") ?? []) markCommented.current(host);
  }, [commentedRanges]);
  const onPostRender = useCallback(
    (node: HTMLElement, _instance: unknown, phase: PostRenderPhase) => {
      if (phase !== "unmount") markCommented.current(node);
      schedulePaint();
    },
    [schedulePaint],
  );
  useEffect(
    () => () => {
      clearMatches(FIND_LAYER);
      clearMatches(OCCURRENCE_LAYER);
    },
    [],
  );

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

  const itemsRef = useRef(items);
  itemsRef.current = items;
  const revealInDiff = useCallback(
    (path: string, side: Side, line: number) => {
      const scroll = () =>
        localRef.current?.scrollTo({ type: "line", id: path, lineNumber: line, side, align: "center", behavior: "instant" });
      pinActivePath(path);
      if (itemsRef.current.find((item) => item.id === path)?.collapsed) {
        setCollapsed(worktree.id, path, false);
        // Once the expanded file has rendered.
        requestAnimationFrame(() => requestAnimationFrame(scroll));
      } else {
        scroll();
      }
    },
    [worktree.id, pinActivePath, setCollapsed],
  );
  const scrollDiff = useCallback(
    (top: number) => localRef.current?.scrollTo({ type: "position", position: top, behavior: "instant" }),
    [],
  );

  // A thread picked in the comment list: scroll to where it shows. Picks from before this view
  // opened (another worktree or scope) are left alone.
  const openedAt = useRef(Date.now());
  const reveal = useStore((s) => s.reveal);
  const showThread = useRef<(id: number) => void>(() => {});
  showThread.current = (id) => {
    if (generalThreads.some((t) => t.id === id)) {
      if (useStore.getState().conversationCollapsed[worktree.id]) useStore.getState().toggleConversation(worktree.id);
      return scrollDiff(0);
    }
    const thread = threads.find((t) => t.id === id);
    // Threads on files this diff doesn't show are listed above it.
    if (!thread || !byPath.has(thread.path)) return scrollDiff(0);
    if (thread.position) return revealInDiff(thread.path, thread.position.endSide, thread.position.endLine);
    // Outdated: shown above the file's first hunk.
    pinActivePath(thread.path);
    const scroll = () => localRef.current?.scrollTo({ type: "item", id: thread.path, align: "start", behavior: "instant" });
    if (itemsRef.current.find((item) => item.id === thread.path)?.collapsed) {
      setCollapsed(worktree.id, thread.path, false);
      requestAnimationFrame(() => requestAnimationFrame(scroll));
    } else {
      scroll();
    }
  };
  useEffect(() => {
    if (reveal && reveal.at > openedAt.current) showThread.current(reveal.threadId);
  }, [reveal]);

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
      overflow: "wrap",
      expansionLineCount: 20,
      stickyHeaders: true,
      layout: { paddingTop: 12, paddingBottom: 240, gap: 12 },
      unsafeCSS,
      loadDiffFiles,
      enableLineSelection: true,
      enableGutterUtility: true,
      onGutterUtilityClick: (selection: SelectedLineRange, context: { item: CodeViewItem<Note> }) =>
        startComment.current?.(selection, context.item.id),
      onPostRender,
    }),
    [layout, loadDiffFiles, onPostRender],
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

  // Above the diff: the conversation on the whole branch, then threads on files that no longer
  // differ, which can't sit in it.
  const orphans = useMemo(() => threads.filter((t) => !byPath.has(t.path)), [threads, byPath]);
  const renderViewHeader = useCallback(
    () => (
      <>
        <Conversation worktree={worktree} threads={generalThreads} />
        {orphans.length > 0 && (
          <section className="pt-3 font-sans">
            <h2 className="flex items-center gap-1.5 px-1 text-[12px] font-medium text-fg-subtle">
              <MessageSquare className="size-3.5" />
              Comments on files without changes in this view
            </h2>
            {orphans.map((thread) => (
              <ThreadCard key={thread.id} thread={thread} note={<DetachedNote thread={thread} reason="Not in diff" />} />
            ))}
          </section>
        )}
      </>
    ),
    [worktree, generalThreads, orphans],
  );

  const rootRef = useRef<HTMLDivElement>(null);
  return (
    <div ref={rootRef} className="relative h-full">
      {find.open && (
        <FindBar
          query={find.query}
          onQueryChange={setQuery}
          count={matches.length}
          current={current}
          capped={matches.length >= MAX_MATCHES}
          focusKey={find.focusKey}
          onStep={step}
          onClose={closeFind}
        />
      )}
      <WorktreeContext.Provider value={worktree}>
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
      </WorktreeContext.Provider>
      <CodeNavigation
        rootRef={rootRef}
        scrollerRef={containerRef}
        worktree={worktree}
        diff={diff}
        files={files}
        fileDiffs={fileDiffs}
        revealInDiff={revealInDiff}
        scrollDiff={scrollDiff}
        highlight={setJumpedTo}
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
  const scope = useDiffScope(worktree, base);
  const addThread = useAddThread(worktree, base, scope);
  if (!file) return null;
  return (
    <Composer
      draftKey={key}
      range={range}
      pending={addThread.isPending}
      error={addThread.error}
      onCancel={() => onClose(key)}
      onSubmit={(body, images) =>
        addThread.mutate(
          { file: file.path, oldFile: file.oldPath ?? null, range, body, images },
          { onSuccess: () => onClose(key) },
        )
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
