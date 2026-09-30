import type { FileDiffMetadata } from "@pierre/diffs";
import type { DiffLayout, Side } from "../types";

/** One occurrence of the search text in a diff line. */
export type SearchMatch = {
  path: string;
  /** Position of the file in display order. */
  file: number;
  side: Side;
  /** Line number on `side`. */
  line: number;
  /** For unchanged lines, which show on both sides of a split diff: the old line number. */
  oldLine?: number;
  /** Row of the line in the file's unified and split layouts, counting collapsed lines too. */
  row: number;
  splitRow: number;
  start: number;
  end: number;
};

const WORD_CHAR = /[\p{L}\p{N}_$]/u;

/** Enough to keep a huge lockfile-sized match list from freezing the view. */
export const MAX_MATCHES = 5000;

/**
 * Matches in the diffs' lines, in unified display order (removed lines before added). Row numbers
 * follow the diff library's `data-line-index`, so matches can be compared with rendered lines.
 */
export function findMatches(
  files: { path: string; fileDiff: FileDiffMetadata }[],
  query: string,
  { caseSensitive = false, wholeWord = false } = {},
): SearchMatch[] {
  const needle = caseSensitive ? query : query.toLowerCase();
  const matches: SearchMatch[] = [];
  if (!needle) return matches;

  const scan = (text: string | undefined, match: Omit<SearchMatch, "start" | "end">) => {
    if (!text) return;
    const line = text.replace(/\r?\n$/, "");
    const haystack = caseSensitive ? line : line.toLowerCase();
    for (let i = haystack.indexOf(needle); i !== -1 && matches.length < MAX_MATCHES; i = haystack.indexOf(needle, i + needle.length)) {
      if (wholeWord && (WORD_CHAR.test(line[i - 1] ?? "") || WORD_CHAR.test(line[i + needle.length] ?? ""))) continue;
      matches.push({ ...match, start: i, end: i + needle.length });
    }
  };

  files.forEach(({ path, fileDiff }, file) => {
    let row = 0;
    let splitRow = 0;
    for (const hunk of fileDiff.hunks) {
      row += hunk.collapsedBefore;
      splitRow += hunk.collapsedBefore;
      let oldLine = hunk.deletionStart;
      let newLine = hunk.additionStart;
      for (const block of hunk.hunkContent) {
        if (matches.length >= MAX_MATCHES) return;
        if (block.type === "context") {
          for (let i = 0; i < block.lines; i++) {
            const text = fileDiff.additionLines[block.additionLineIndex + i];
            const at = { row: row + i, splitRow: splitRow + i };
            scan(text, { path, file, side: "additions", line: newLine + i, oldLine: oldLine + i, ...at });
          }
          oldLine += block.lines;
          newLine += block.lines;
          row += block.lines;
          splitRow += block.lines;
        } else {
          for (let i = 0; i < block.deletions; i++) {
            const at = { row: row + i, splitRow: splitRow + i };
            scan(fileDiff.deletionLines[block.deletionLineIndex + i], { path, file, side: "deletions", line: oldLine + i, ...at });
          }
          for (let i = 0; i < block.additions; i++) {
            const at = { row: row + block.deletions + i, splitRow: splitRow + i };
            scan(fileDiff.additionLines[block.additionLineIndex + i], { path, file, side: "additions", line: newLine + i, ...at });
          }
          oldLine += block.deletions;
          newLine += block.additions;
          row += block.deletions + block.additions;
          splitRow += Math.max(block.deletions, block.additions);
        }
      }
    }
  });
  return matches;
}

/** A position in the diff that sorts like the screen: file, then row, then left column first. */
type Position = [file: number, row: number, column: number];

const compare = (a: Position, b: Position) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

function positionOf(match: SearchMatch, layout: DiffLayout): Position {
  return layout === "split" ? [match.file, match.splitRow, match.side === "deletions" ? 0 : 1] : [match.file, match.row, 0];
}

/** Matches in the order they appear on screen, which differs between the split and unified layouts. */
export function inScreenOrder(matches: SearchMatch[], layout: DiffLayout): SearchMatch[] {
  if (layout === "unified") return matches;
  return [...matches].sort((a, b) => compare(positionOf(a, layout), positionOf(b, layout)) || a.start - b.start);
}

// ---------------------------------------------------------------------------------------------
// Rendered lines

type RenderedLine = { el: HTMLElement; path: string; side: Side; line: number; position: Position };

/** A rendered line of code (not a line number), inside a diff's shadow root. */
export const LINE_SELECTOR = "[data-content] > [data-line]";

/** Which version a rendered line belongs to; unchanged lines count as the new one. */
export function lineSide(el: HTMLElement): Side {
  const code = el.closest("code");
  return code?.hasAttribute("data-deletions") || (code?.hasAttribute("data-unified") && el.dataset.lineType === "change-deletion")
    ? "deletions"
    : "additions";
}

/** Diff lines currently in the DOM (the diff is virtualized), with where they sit in the diff. */
function renderedLines(container: HTMLElement, fileIndex: Map<string, number>, layout: DiffLayout): RenderedLine[] {
  const lines: RenderedLine[] = [];
  for (const host of container.querySelectorAll<HTMLElement>("diffs-container")) {
    const path = host.querySelector<HTMLElement>("[data-file-path]")?.dataset.filePath;
    const root = host.shadowRoot;
    const file = path === undefined ? undefined : fileIndex.get(path);
    if (path === undefined || file === undefined || !root) continue;
    for (const el of root.querySelectorAll<HTMLElement>(LINE_SELECTOR)) {
      const side = lineSide(el);
      const [row, splitRow] = (el.dataset.lineIndex ?? "0,0").split(",").map(Number);
      const position: Position =
        layout === "split" ? [file, splitRow, side === "deletions" ? 0 : 1] : [file, row, 0];
      lines.push({ el, path, side, line: Number(el.dataset.line), position });
    }
  }
  return lines;
}

function isInView(el: Element, container: HTMLElement): boolean {
  const view = container.getBoundingClientRect();
  const rect = el.getBoundingClientRect();
  return rect.height > 0 && rect.top >= view.top && rect.bottom <= view.bottom;
}

const lineKey = (path: string, side: Side, line: number) => `${path}\n${side}\n${line}`;

/** Whether a match's line is rendered and fully on screen. */
export function isMatchInView(container: HTMLElement | null, match: SearchMatch, fileIndex: Map<string, number>, layout: DiffLayout) {
  if (!container) return false;
  const target = lineKey(match.path, match.side, match.line);
  const line = renderedLines(container, fileIndex, layout).find((l) => lineKey(l.path, l.side, l.line) === target);
  return !!line && isInView(line.el, container);
}

/**
 * The match to go to from what's on screen: the first one at or below the top of the view going
 * forwards, the last one at or above its bottom going backwards. Falls back to `fallbackFile`
 * (the file at the top of the view) when no lines are rendered there, e.g. over collapsed files.
 */
export function matchFromView(
  container: HTMLElement | null,
  matches: SearchMatch[],
  direction: 1 | -1,
  fileIndex: Map<string, number>,
  layout: DiffLayout,
  fallbackFile: number,
): number {
  if (matches.length === 0) return -1;
  const visible = container ? renderedLines(container, fileIndex, layout).filter((l) => isInView(l.el, container)) : [];
  const positions = visible.map((l) => l.position).sort(compare);
  const top: Position = positions[0] ?? [fallbackFile, 0, 0];
  const bottom: Position = positions[positions.length - 1] ?? [fallbackFile, Number.MAX_SAFE_INTEGER, 1];

  if (direction === 1) {
    const index = matches.findIndex((m) => compare(positionOf(m, layout), top) >= 0);
    return index === -1 ? 0 : index;
  }
  for (let i = matches.length - 1; i >= 0; i--) {
    if (compare(positionOf(matches[i], layout), bottom) <= 0) return i;
  }
  return matches.length - 1;
}

// ---------------------------------------------------------------------------------------------
// Highlights

/** Names for `::highlight()` styles; a current match gets its own, stronger style. */
export type HighlightLayer = { all: string; current?: string };
export const FIND_LAYER: HighlightLayer = { all: "review-find", current: "review-find-current" };
export const OCCURRENCE_LAYER: HighlightLayer = { all: "review-occurrence" };

/**
 * Highlights matches in the lines currently rendered in `container` with the CSS Custom Highlight
 * API, which paints over text without touching the diff's DOM. Call again after the diff renders
 * more lines (it's virtualized).
 */
export function paintMatches(
  container: HTMLElement | null,
  matches: SearchMatch[],
  current: number,
  layer: HighlightLayer,
  fileIndex: Map<string, number>,
  layout: DiffLayout,
) {
  if (typeof CSS === "undefined" || !("highlights" in CSS)) return;
  if (!container || matches.length === 0) return clearMatches(layer);
  const all = new Highlight();
  const active = new Highlight();

  const byLine = new Map<string, { start: number; end: number; index: number }[]>();
  const add = (k: string, entry: { start: number; end: number; index: number }) => {
    const list = byLine.get(k);
    if (list) list.push(entry);
    else byLine.set(k, [entry]);
  };
  matches.forEach((m, index) => {
    add(lineKey(m.path, m.side, m.line), { start: m.start, end: m.end, index });
    // Unchanged lines also show in the old column of a split diff.
    if (m.oldLine !== undefined) add(lineKey(m.path, "deletions", m.oldLine), { start: m.start, end: m.end, index });
  });

  for (const line of renderedLines(container, fileIndex, layout)) {
    for (const { start, end, index } of byLine.get(lineKey(line.path, line.side, line.line)) ?? []) {
      const range = textRange(line.el, start, end);
      if (range) (index === current && layer.current ? active : all).add(range);
    }
  }
  CSS.highlights.set(layer.all, all);
  if (layer.current) CSS.highlights.set(layer.current, active);
}

export function clearMatches(layer: HighlightLayer) {
  if (typeof CSS === "undefined" || !("highlights" in CSS)) return;
  CSS.highlights.delete(layer.all);
  if (layer.current) CSS.highlights.delete(layer.current);
}

/** A range over characters `start`–`end` of an element's text, which is split across token spans. */
export function textRange(el: HTMLElement, start: number, end: number): Range | null {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let offset = 0;
  let started = false;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = node.textContent?.length ?? 0;
    if (!started && start < offset + length) {
      range.setStart(node, start - offset);
      started = true;
    }
    if (started && end <= offset + length) {
      range.setEnd(node, end - offset);
      return range;
    }
    offset += length;
  }
  return null;
}

/** Whether `node` is inside `container`, looking through shadow roots. */
export function isInside(container: HTMLElement | null, node: Node | null): boolean {
  for (let n: Node | null = node; n && container; ) {
    if (container.contains(n)) return true;
    const root = n.getRootNode();
    n = root instanceof ShadowRoot ? root.host : null;
  }
  return false;
}
