import type { FileDiffMetadata } from "@pierre/diffs";
import type { Side, SymbolHit } from "../types";
import { LINE_SELECTOR, lineSide, textRange } from "./search";

/** Syntax in common languages rather than names worth looking up. */
const KEYWORDS = new Set(
  (
    "if else elif for while do return break continue switch case default try catch finally throw throws " +
    "function fn func fun def class struct enum trait interface impl type typealias protocol " +
    "const let var mut static pub public private protected internal readonly abstract override final " +
    "import export from as use mod module package namespace require extends implements where " +
    "new delete this self super async await yield in of is not and or instanceof typeof keyof void " +
    "true false null undefined nil None True False"
  ).split(" "),
);

const NAME_CHAR = /[\p{L}\p{N}_$]/u;

/** The name at `offset` in `text`: a whole identifier that isn't a keyword or number. */
export function nameAt(text: string, offset: number): { name: string; start: number; end: number } | null {
  if (!NAME_CHAR.test(text[offset] ?? "")) return null;
  let start = offset;
  while (start > 0 && NAME_CHAR.test(text[start - 1])) start--;
  let end = offset + 1;
  while (end < text.length && NAME_CHAR.test(text[end])) end++;
  const name = text.slice(start, end);
  if (/^\p{N}/u.test(name) || KEYWORDS.has(name)) return null;
  return { name, start, end };
}

/** A name under the pointer in a rendered diff or file. */
export type PointedName = {
  name: string;
  /** The `diffs-container` element of the file it's in. */
  host: Element;
  line: number;
  side: Side;
  /** Covers the name, for painting it and positioning next to it. */
  range: Range;
};

/** The name at a point of the screen, looking into the diffs' shadow roots. */
export function nameAtPoint(x: number, y: number): PointedName | null {
  let el = document.elementFromPoint(x, y);
  while (el?.shadowRoot) {
    const inner = el.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === el) break;
    el = inner;
  }
  const lineEl = el?.closest<HTMLElement>(LINE_SELECTOR);
  if (!lineEl) return null;
  const offset = offsetAt(lineEl, x, y);
  const found = offset === null ? null : nameAt(lineEl.textContent ?? "", offset);
  const range = found && textRange(lineEl, found.start, found.end);
  if (!found || !range) return null;
  const root = lineEl.getRootNode();
  return {
    name: found.name,
    host: root instanceof ShadowRoot ? root.host : lineEl,
    line: Number(lineEl.dataset.line),
    side: lineSide(lineEl),
    range,
  };
}

/** The character of a line's text under a point, measured on the rendered text. */
function offsetAt(lineEl: HTMLElement, x: number, y: number): number | null {
  const walker = document.createTreeWalker(lineEl, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  const contains = (r: DOMRect) => x >= r.left && x < r.right && y >= r.top && y < r.bottom;
  let offset = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = node.textContent?.length ?? 0;
    range.selectNodeContents(node);
    if (contains(range.getBoundingClientRect())) {
      for (let i = 0; i < length; i++) {
        range.setStart(node, i);
        range.setEnd(node, i + 1);
        if (contains(range.getBoundingClientRect())) return offset + i;
      }
    }
    offset += length;
  }
  return null;
}

/** Whether the diff shows a line (it's in a hunk rather than in the unchanged lines between them). */
export function diffShowsLine(fileDiff: FileDiffMetadata, side: Side, line: number): boolean {
  return fileDiff.hunks.some((h) =>
    side === "additions"
      ? line >= h.additionStart && line < h.additionStart + h.additionCount
      : line >= h.deletionStart && line < h.deletionStart + h.deletionCount,
  );
}

export type HitGroup = { path: string; hits: SymbolHit[] };

/**
 * Definitions and references, most relevant first: the file the name was clicked in, then
 * changed files in diff order (`order`), then the rest by path.
 */
export function arrangeHits(hits: SymbolHit[], from: string, order: Map<string, number>) {
  const rank = (path: string) => (path === from ? -1 : (order.get(path) ?? Number.MAX_SAFE_INTEGER));
  const byRelevance = (a: string, b: string) => rank(a) - rank(b) || a.localeCompare(b, undefined, { numeric: true });

  const definitions = hits.filter((h) => h.definition).sort((a, b) => byRelevance(a.path, b.path) || a.line - b.line);
  const groups = new Map<string, SymbolHit[]>();
  for (const hit of hits) {
    if (hit.definition) continue;
    const group = groups.get(hit.path);
    if (group) group.push(hit);
    else groups.set(hit.path, [hit]);
  }
  const references: HitGroup[] = [...groups.entries()]
    .sort(([a], [b]) => byRelevance(a, b))
    .map(([path, list]) => ({ path, hits: list.sort((a, b) => a.line - b.line) }));
  return { definitions, references, referenceCount: hits.length - definitions.length };
}

/** `text` split around whole-word mentions of `name`, for highlighting them. */
export function splitOnName(text: string, name: string): { text: string; match: boolean }[] {
  const escaped = name.replace(/[$]/g, "\\$");
  const parts = text.split(new RegExp(`(?<![\\p{L}\\p{N}_$])(${escaped})(?![\\p{L}\\p{N}_$])`, "u"));
  return parts.map((part, i) => ({ text: part, match: i % 2 === 1 })).filter((p) => p.text);
}
