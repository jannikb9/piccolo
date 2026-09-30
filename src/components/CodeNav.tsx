import type { CodeViewItem, FileDiffMetadata } from "@pierre/diffs";
import { CodeView, type CodeViewHandle, type CodeViewReactOptions } from "@pierre/diffs/react";
import { ArrowLeft, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { unsafeCSS, viewStyle } from "../lib/codeViewStyle";
import { hashString } from "../lib/diff";
import { useFileText, useSymbolSearch } from "../lib/queries";
import { arrangeHits, diffShowsLine, nameAtPoint, splitOnName, type PointedName } from "../lib/symbols";
import { cn, splitPath } from "../lib/utils";
import type { ChangedFile, DiffPatch, Side, SymbolHit, Worktree } from "../types";
import { IconButton, Skeleton, StatusLetter } from "./ui";

/** `::highlight()` name for the name under the pointer while ⌘ is held (styled in codeViewStyle.ts). */
const HOVER_LAYER = "review-symbol";

/** A file opened from a search result, shown over the diff. */
type FilePlace = { kind: "file"; path: string; rev: string | null; line: number; scrollTop?: number };
/** Somewhere the reviewer was, to go back to. */
type Place = { kind: "diff"; scrollTop: number } | FilePlace;
/** A ⌘-clicked name, searched in files at `rev` (`null`: the working tree). */
type Lookup = { name: string; path: string; rev: string | null; anchor: DOMRect };

/** A changed file by its path on one side of the diff, with its position in the diff. */
type SideFiles = Map<string, { file: ChangedFile; index: number }>;

/**
 * Code navigation over the diff: ⌘-click a name to list where it's defined and used, then jump
 * there. Places in the diff scroll into view; other files open over the diff. ⌘[ goes back.
 */
export function CodeNavigation({
  rootRef,
  scrollerRef,
  worktree,
  diff,
  files,
  fileDiffs,
  revealInDiff,
  scrollDiff,
  highlight,
}: {
  /** Contains the diff; the file view is rendered into it too. */
  rootRef: RefObject<HTMLDivElement | null>;
  /** The diff's scroll container. */
  scrollerRef: RefObject<HTMLDivElement | null>;
  worktree: Worktree;
  diff: DiffPatch;
  files: ChangedFile[];
  fileDiffs: Map<string, FileDiffMetadata>;
  /** Scrolls a line of a changed file into view, expanding the file if needed. */
  revealInDiff: (path: string, side: Side, line: number) => void;
  scrollDiff: (top: number) => void;
  /** Highlights a name's occurrences in the diff; "" clears. */
  highlight: (name: string) => void;
}) {
  const [lookup, setLookup] = useState<Lookup | null>(null);
  const [file, setFile] = useState<FilePlace | null>(null);
  const [history, setHistory] = useState<Place[]>([]);
  const fileScrollerRef = useRef<HTMLDivElement>(null);

  const sides = useMemo(() => {
    const additions: SideFiles = new Map();
    const deletions: SideFiles = new Map();
    files.forEach((file, index) => {
      if (file.status !== "deleted") additions.set(file.path, { file, index });
      if (file.status !== "added") deletions.set(file.oldPath ?? file.path, { file, index });
    });
    return { additions, deletions };
  }, [files]);
  const sideOf = (rev: string | null): Side => (rev === diff.oldRev && rev !== diff.newRev ? "deletions" : "additions");

  const here = (): Place =>
    file ? { ...file, scrollTop: fileScrollerRef.current?.scrollTop } : { kind: "diff", scrollTop: scrollerRef.current?.scrollTop ?? 0 };

  const restore = (place: Place) => {
    if (place.kind === "file") return setFile(place);
    setFile(null);
    scrollDiff(place.scrollTop);
  };

  /** Shows a line: in the diff when it's there, otherwise in the file view. */
  const open = (path: string, rev: string | null, line: number, name: string) => {
    const side = sideOf(rev);
    const changed = sides[side].get(path);
    const fileDiff = changed && fileDiffs.get(changed.file.path);
    if (changed && fileDiff && diffShowsLine(fileDiff, side, line)) {
      setFile(null);
      revealInDiff(changed.file.path, side, line);
      highlight(name);
    } else {
      setFile({ kind: "file", path, rev, line });
    }
  };

  const back = () => {
    const place = history[history.length - 1];
    if (!place) return;
    setHistory(history.slice(0, -1));
    restore(place);
  };

  /** Leaves the file view for where the reviewer last was in the diff. */
  const closeFile = () => {
    let i = history.length - 1;
    while (i >= 0 && history[i].kind !== "diff") i--;
    if (i === -1) return setFile(null);
    restore(history[i]);
    setHistory(history.slice(0, i));
  };

  // Event handlers bound once below call the latest versions of these.
  const latest = useRef({
    lookUp: (_: PointedName) => {},
    onPlainPress: () => {},
    onKeyDown: (_: globalThis.KeyboardEvent) => {},
  });
  latest.current.lookUp = (pointed) => {
    let target: Omit<Lookup, "anchor"> | null = null;
    if (file && fileScrollerRef.current?.contains(pointed.host)) {
      target = { name: pointed.name, path: file.path, rev: file.rev };
    } else {
      const path = pointed.host.querySelector<HTMLElement>("[data-file-path]")?.dataset.filePath;
      const changed = files.find((f) => f.path === path);
      if (changed) {
        target =
          pointed.side === "deletions"
            ? { name: pointed.name, path: changed.oldPath ?? changed.path, rev: diff.oldRev }
            : { name: pointed.name, path: changed.path, rev: diff.newRev };
      }
    }
    if (target) setLookup({ ...target, anchor: pointed.range.getBoundingClientRect() });
  };
  latest.current.onPlainPress = () => highlight("");
  latest.current.onKeyDown = (e) => {
    if (e.defaultPrevented) return;
    if (e.metaKey && !e.shiftKey && !e.altKey && e.key === "[" && history.length > 0) {
      e.preventDefault();
      setLookup(null);
      back();
    } else if (e.key === "Escape" && !(e.target instanceof HTMLElement && e.target.closest("input, textarea"))) {
      if (lookup) setLookup(null);
      else if (file) closeFile();
      else return;
      e.preventDefault();
    }
  };

  // Holding ⌘ underlines the name under the pointer; ⌘-click looks it up.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const highlights = typeof CSS !== "undefined" && "highlights" in CSS ? CSS.highlights : null;
    let pointer: { x: number; y: number } | null = null;
    let meta = false;
    let hovering = false;
    let frame = 0;

    const paint = () => {
      frame = 0;
      const pointed = meta && pointer ? nameAtPoint(pointer.x, pointer.y) : null;
      if (pointed) {
        highlights?.set(HOVER_LAYER, new Highlight(pointed.range));
        root.style.setProperty("--code-cursor", "pointer");
        hovering = true;
      } else if (hovering) {
        highlights?.delete(HOVER_LAYER);
        root.style.removeProperty("--code-cursor");
        hovering = false;
      }
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(paint);
    };
    const onPointerMove = (e: PointerEvent) => {
      pointer = { x: e.clientX, y: e.clientY };
      meta = e.metaKey;
      if (meta || hovering) schedule();
    };
    const onPointerLeave = () => {
      pointer = null;
      schedule();
    };
    const onModifier = (e: globalThis.KeyboardEvent) => {
      if (e.metaKey === meta) return;
      meta = e.metaKey;
      schedule();
    };
    const onBlur = () => {
      meta = false;
      schedule();
    };
    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      if (!e.metaKey) return latest.current.onPlainPress();
      // Keeps the current selection instead of starting a new one.
      if (nameAtPoint(e.clientX, e.clientY)) e.preventDefault();
    };
    const onClick = (e: MouseEvent) => {
      if (!e.metaKey || e.button !== 0) return;
      const pointed = nameAtPoint(e.clientX, e.clientY);
      if (!pointed) return;
      e.preventDefault();
      meta = false;
      paint();
      latest.current.lookUp(pointed);
    };
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      onModifier(e);
      latest.current.onKeyDown(e);
    };

    root.addEventListener("pointermove", onPointerMove);
    root.addEventListener("pointerleave", onPointerLeave);
    root.addEventListener("mousedown", onMouseDown);
    root.addEventListener("click", onClick);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onModifier);
    window.addEventListener("blur", onBlur);
    return () => {
      cancelAnimationFrame(frame);
      highlights?.delete(HOVER_LAYER);
      root.removeEventListener("pointermove", onPointerMove);
      root.removeEventListener("pointerleave", onPointerLeave);
      root.removeEventListener("mousedown", onMouseDown);
      root.removeEventListener("click", onClick);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onModifier);
      window.removeEventListener("blur", onBlur);
    };
  }, [rootRef]);

  return (
    <>
      {file && (
        <FileView
          key={`${file.rev}:${file.path}`}
          worktree={worktree}
          place={file}
          isBase={sideOf(file.rev) === "deletions"}
          changed={sides[sideOf(file.rev)].get(file.path)?.file}
          scrollerRef={fileScrollerRef}
          onBack={back}
          onClose={closeFile}
        />
      )}
      {!file && history.length > 0 && (
        <button
          type="button"
          onClick={back}
          className="absolute bottom-4 left-1/2 z-20 flex h-8 -translate-x-1/2 items-center gap-1.5 rounded-lg border border-border bg-bg-raised pr-2.5 pl-2 text-[12px] font-medium text-fg-muted shadow-lg shadow-black/25 hover:text-fg"
        >
          <ArrowLeft className="size-3.5" />
          Back
          <kbd className="font-sans text-[11px] text-fg-faint">⌘[</kbd>
        </button>
      )}
      {lookup &&
        createPortal(
          <SymbolPopover
            // A new lookup starts with fresh focus and scroll.
            key={`${lookup.rev}:${lookup.path}:${lookup.name}:${lookup.anchor.x}:${lookup.anchor.y}`}
            lookup={lookup}
            worktree={worktree}
            isBase={sideOf(lookup.rev) === "deletions"}
            files={sides[sideOf(lookup.rev)]}
            onPick={(hit) => {
              setLookup(null);
              setHistory([...history, here()]);
              open(hit.path, lookup.rev, hit.line, lookup.name);
            }}
            onClose={() => setLookup(null)}
          />,
          document.body,
        )}
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Search results

const POPOVER_WIDTH = 520;
/** Definitions listed before "Show more"; a common local name can have many. */
const SHOWN_DEFINITIONS = 6;

/** Below the name, or above it when there's more room there. */
function placement(anchor: DOMRect): CSSProperties {
  const margin = 8;
  const below = window.innerHeight - anchor.bottom - margin;
  const above = anchor.top - margin;
  const down = below >= 280 || below >= above;
  const left = Math.max(margin, Math.min(anchor.left - 16, window.innerWidth - POPOVER_WIDTH - margin));
  const maxHeight = Math.min(460, (down ? below : above) - 4);
  return down ? { left, top: anchor.bottom + 4, maxHeight } : { left, bottom: window.innerHeight - anchor.top + 4, maxHeight };
}

function SymbolPopover({
  lookup,
  worktree,
  isBase,
  files,
  onPick,
  onClose,
}: {
  lookup: Lookup;
  worktree: Worktree;
  isBase: boolean;
  /** Changed files on the searched side, to mark them and list them first. */
  files: SideFiles;
  onPick: (hit: SymbolHit) => void;
  onClose: () => void;
}) {
  const search = useSymbolSearch(worktree.path, lookup.rev, lookup.name, lookup.path);
  const order = useMemo(() => new Map([...files].map(([path, { index }]) => [path, index])), [files]);
  const { definitions, references, referenceCount } = useMemo(
    () => arrangeHits(search.data?.hits ?? [], lookup.path, order),
    [search.data, lookup.path, order],
  );
  const [allDefinitions, setAllDefinitions] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const style = useMemo(() => placement(lookup.anchor), [lookup.anchor]);

  // Closes when anything else is pressed or scrolled, since the name it points at moves.
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const outside = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) close.current();
    };
    const onResize = () => close.current();
    window.addEventListener("mousedown", outside, true);
    window.addEventListener("scroll", outside, true);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("mousedown", outside, true);
      window.removeEventListener("scroll", outside, true);
      window.removeEventListener("resize", onResize);
    };
  }, []);

  // Enter opens the first result right away; arrow keys move between results.
  useEffect(() => {
    if (search.data) ref.current?.querySelector<HTMLElement>("[data-hit]")?.focus({ preventScroll: true });
  }, [search.data]);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const hits = [...(ref.current?.querySelectorAll<HTMLElement>("[data-hit]") ?? [])];
    const i = hits.indexOf(document.activeElement as HTMLElement);
    const step = e.key === "ArrowDown" ? 1 : -1;
    hits[i === -1 ? 0 : (i + step + hits.length) % hits.length]?.focus();
  };

  const row = (hit: SymbolHit, content: ReactNode, className?: string) => (
    <button
      key={`${hit.path}:${hit.line}`}
      type="button"
      data-hit
      onClick={() => onPick(hit)}
      className={cn("block w-full pr-3 text-left outline-none hover:bg-bg-hover focus-visible:bg-bg-hover", className)}
    >
      {content}
    </button>
  );
  const shownDefinitions = allDefinitions ? definitions : definitions.slice(0, SHOWN_DEFINITIONS);

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={`Where ${lookup.name} is defined and used`}
      onKeyDown={onKeyDown}
      style={{ ...style, width: `min(${POPOVER_WIDTH}px, calc(100vw - 16px))` }}
      className="fixed z-50 flex flex-col overflow-hidden rounded-lg border border-border bg-bg-raised font-sans shadow-xl shadow-black/30"
    >
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-border-subtle px-3">
        <span className="truncate font-mono text-[12.5px] font-semibold text-fg">{lookup.name}</span>
        {isBase && <span className="shrink-0 rounded bg-bg-hover px-1.5 py-px text-[11px] text-fg-muted">Base version</span>}
      </header>
      <div className="min-h-0 overflow-y-auto pb-1.5">
        {search.isPending ? (
          <div className="space-y-2.5 px-3 py-3">
            {[60, 80, 45].map((w) => (
              <Skeleton key={w} className="h-2.5" style={{ width: `${w}%` }} />
            ))}
          </div>
        ) : search.isError ? (
          <p className="selectable px-3 py-3 text-[12px] break-words text-del">{String(search.error)}</p>
        ) : definitions.length + references.length === 0 ? (
          <p className="px-3 py-3 text-[12px] text-fg-subtle">No definitions or references found.</p>
        ) : (
          <>
            {definitions.length > 0 && (
              <section>
                <SectionLabel>{definitions.length === 1 ? "Definition" : `Definitions ${definitions.length}`}</SectionLabel>
                {shownDefinitions.map((hit) =>
                  row(
                    hit,
                    <>
                      <PathLabel path={hit.path} line={hit.line} changed={files.get(hit.path)?.file} />
                      <Snippet text={hit.text} name={lookup.name} className="pl-5" />
                    </>,
                    "py-1.5 pl-3",
                  ),
                )}
                {!allDefinitions && definitions.length > SHOWN_DEFINITIONS && (
                  <button
                    type="button"
                    onClick={() => setAllDefinitions(true)}
                    className="ml-3 h-6 text-[12px] text-accent hover:underline"
                  >
                    Show {definitions.length - SHOWN_DEFINITIONS} more
                  </button>
                )}
              </section>
            )}
            {references.length > 0 && (
              <section>
                <SectionLabel>References {referenceCount}</SectionLabel>
                {references.map((group) => (
                  <div key={group.path} className="pb-1">
                    <PathLabel path={group.path} changed={files.get(group.path)?.file} className="px-3 py-1" />
                    {group.hits.map((hit) =>
                      row(
                        hit,
                        <span className="flex items-baseline gap-2">
                          <span className="tabular w-9 shrink-0 text-right font-mono text-[11px] text-fg-faint">{hit.line}</span>
                          <Snippet text={hit.text} name={lookup.name} />
                        </span>,
                        "py-0.5 pl-3",
                      ),
                    )}
                  </div>
                ))}
              </section>
            )}
            {search.data?.truncated && (
              <p className="px-3 pt-1 text-[11px] text-fg-faint">Only the first {referenceCount} references are listed.</p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <h3 className="px-3 pt-2.5 pb-1 text-[11px] font-semibold tracking-wide text-fg-subtle uppercase">{children}</h3>
  );
}

/** A file path; files changed in this diff are marked with their status letter. */
function PathLabel({ path, line, changed, className }: { path: string; line?: number; changed?: ChangedFile; className?: string }) {
  const { dir, base } = splitPath(path);
  return (
    <span className={cn("flex min-w-0 items-center gap-1.5 text-[12px]", className)}>
      {changed ? <StatusLetter status={changed.status} /> : <span className="w-3 shrink-0" />}
      <span className="flex min-w-0 items-baseline font-mono">
        <span className="truncate text-fg-subtle">{dir}</span>
        <span className="shrink-0 text-fg">{base}</span>
        {line !== undefined && <span className="shrink-0 text-fg-faint">:{line}</span>}
      </span>
    </span>
  );
}

/** A line of code with the name highlighted. */
function Snippet({ text, name, className }: { text: string; name: string; className?: string }) {
  return (
    <code className={cn("block min-w-0 truncate font-mono text-[12px] whitespace-pre text-fg-muted", className)}>
      {splitOnName(text, name).map((part, i) =>
        part.match ? (
          <mark key={i} className="rounded-[2px] bg-mod/25 text-fg">
            {part.text}
          </mark>
        ) : (
          part.text
        ),
      )}
    </code>
  );
}

// ---------------------------------------------------------------------------------------------
// File view

type FileViewHandle = CodeViewHandle<undefined, undefined>;

/** A whole file at a search result's line, over the diff. */
function FileView({
  worktree,
  place,
  isBase,
  changed,
  scrollerRef,
  onBack,
  onClose,
}: {
  worktree: Worktree;
  place: FilePlace;
  /** Shows the file as it was on the base branch. */
  isBase: boolean;
  /** The file's entry in the diff, if it's changed. */
  changed?: ChangedFile;
  scrollerRef: RefObject<HTMLDivElement | null>;
  onBack: () => void;
  onClose: () => void;
}) {
  const text = useFileText(worktree.path, place.rev, place.path);
  const contents = text.data;
  const viewRef = useRef<FileViewHandle>(null);

  const items = useMemo(
    (): CodeViewItem<undefined>[] =>
      contents == null
        ? []
        : [
            {
              id: place.path,
              type: "file",
              file: {
                name: place.path,
                contents,
                cacheKey: `file:${worktree.path}:${place.rev ?? "worktree"}:${place.path}:${hashString(contents)}`,
              },
            },
          ],
    [contents, place.path, place.rev, worktree.path],
  );
  const selectedLines = useMemo(() => ({ id: place.path, range: { start: place.line, end: place.line } }), [place]);
  const options = useMemo(
    (): CodeViewReactOptions<undefined, undefined> => ({
      overflow: "scroll",
      disableFileHeader: true,
      layout: { paddingTop: 12, paddingBottom: 240, gap: 12 },
      unsafeCSS,
    }),
    [],
  );

  // Once rendered: the result's line, or where the reviewer left the file when coming back.
  useEffect(() => {
    if (items.length === 0) return;
    const frame = requestAnimationFrame(() =>
      viewRef.current?.scrollTo(
        place.scrollTop !== undefined
          ? { type: "position", position: place.scrollTop, behavior: "instant" }
          : { type: "line", id: place.path, lineNumber: place.line, align: "center", behavior: "instant" },
      ),
    );
    return () => cancelAnimationFrame(frame);
  }, [items, place]);

  const { dir, base } = splitPath(place.path);
  return (
    <div className="absolute inset-0 z-10 flex flex-col bg-bg">
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-border-subtle pr-2 pl-2 font-sans">
        <IconButton label="Back (⌘[)" onClick={onBack}>
          <ArrowLeft className="size-4" />
        </IconButton>
        {changed && <StatusLetter status={changed.status} />}
        <span className="flex min-w-0 items-baseline font-mono text-[12.5px]">
          <span className="truncate text-fg-subtle">{dir}</span>
          <span className="shrink-0 font-medium text-fg">{base}</span>
          <span className="shrink-0 text-fg-faint">:{place.line}</span>
        </span>
        {isBase && <span className="shrink-0 rounded bg-bg-hover px-1.5 py-px text-[11px] text-fg-muted">Base version</span>}
        <IconButton label="Close (Esc)" onClick={onClose} className="ml-auto shrink-0">
          <X className="size-4" />
        </IconButton>
      </header>
      <div className="min-h-0 flex-1">
        {text.isPending ? (
          <div className="space-y-2.5 px-6 py-4">
            {[70, 45, 60, 30].map((w) => (
              <Skeleton key={w} className="h-2.5" style={{ width: `${w}%` }} />
            ))}
          </div>
        ) : contents == null ? (
          <p className="px-6 py-4 text-[12px] text-fg-subtle">
            {text.isError ? String(text.error) : "This file isn't available as text."}
          </p>
        ) : (
          <CodeView<undefined>
            ref={viewRef}
            containerRef={scrollerRef}
            items={items}
            options={options}
            selectedLines={selectedLines}
            className="h-full overflow-auto px-4"
            style={viewStyle}
          />
        )}
      </div>
    </div>
  );
}
