import type { FileDiffMetadata } from "@pierre/diffs";
import type { Side } from "../types";

/** One occurrence of the search text in a diff line. */
export type SearchMatch = {
  path: string;
  side: Side;
  /** Line number on `side`. */
  line: number;
  /** For unchanged lines, which show on both sides of a split diff: the old line number. */
  oldLine?: number;
  start: number;
  end: number;
};

/** Enough to keep a huge lockfile-sized match list from freezing the view. */
const MAX_MATCHES = 5000;

/** Case-insensitive matches in the diffs' lines, in display order (removed lines before added). */
export function findMatches(files: { path: string; fileDiff: FileDiffMetadata }[], query: string): SearchMatch[] {
  const needle = query.toLowerCase();
  const matches: SearchMatch[] = [];
  if (!needle) return matches;

  const scan = (text: string | undefined, match: Omit<SearchMatch, "start" | "end">) => {
    if (!text) return;
    const haystack = text.replace(/\r?\n$/, "").toLowerCase();
    for (let i = haystack.indexOf(needle); i !== -1 && matches.length < MAX_MATCHES; i = haystack.indexOf(needle, i + needle.length)) {
      matches.push({ ...match, start: i, end: i + needle.length });
    }
  };

  for (const { path, fileDiff } of files) {
    for (const hunk of fileDiff.hunks) {
      let oldLine = hunk.deletionStart;
      let newLine = hunk.additionStart;
      for (const block of hunk.hunkContent) {
        if (block.type === "context") {
          for (let i = 0; i < block.lines; i++) {
            const text = fileDiff.additionLines[block.additionLineIndex + i];
            scan(text, { path, side: "additions", line: newLine + i, oldLine: oldLine + i });
          }
          oldLine += block.lines;
          newLine += block.lines;
        } else {
          for (let i = 0; i < block.deletions; i++) {
            scan(fileDiff.deletionLines[block.deletionLineIndex + i], { path, side: "deletions", line: oldLine + i });
          }
          for (let i = 0; i < block.additions; i++) {
            scan(fileDiff.additionLines[block.additionLineIndex + i], { path, side: "additions", line: newLine + i });
          }
          oldLine += block.deletions;
          newLine += block.additions;
        }
        if (matches.length >= MAX_MATCHES) return matches;
      }
    }
  }
  return matches;
}

const ALL = "review-find";
const CURRENT = "review-find-current";

const key = (path: string, side: Side, line: number) => `${path}\n${side}\n${line}`;

/**
 * Highlights matches in the lines currently rendered in `container` with the CSS Custom Highlight
 * API, which paints over text without touching the diff's DOM. Call again after the diff renders
 * more lines (it's virtualized).
 */
export function paintMatches(container: HTMLElement | null, matches: SearchMatch[], current: number) {
  if (typeof CSS === "undefined" || !("highlights" in CSS)) return;
  if (!container || matches.length === 0) return clearMatches();
  const all = new Highlight();
  const active = new Highlight();

  const byLine = new Map<string, { start: number; end: number; index: number }[]>();
  const add = (k: string, entry: { start: number; end: number; index: number }) => {
    const list = byLine.get(k);
    if (list) list.push(entry);
    else byLine.set(k, [entry]);
  };
  matches.forEach((m, index) => {
    add(key(m.path, m.side, m.line), { start: m.start, end: m.end, index });
    if (m.oldLine !== undefined) add(key(m.path, "deletions", m.oldLine), { start: m.start, end: m.end, index });
  });

  for (const host of container.querySelectorAll<HTMLElement>("diffs-container")) {
    const path = host.querySelector<HTMLElement>("[data-file-path]")?.dataset.filePath;
    const root = host.shadowRoot;
    if (!path || !root) continue;
    for (const lineEl of root.querySelectorAll<HTMLElement>("[data-content] > [data-line]")) {
      const code = lineEl.closest("code");
      const side: Side =
        code?.hasAttribute("data-deletions") ||
        (code?.hasAttribute("data-unified") && lineEl.dataset.lineType === "change-deletion")
          ? "deletions"
          : "additions";
      // In the unified layout an unchanged line shows once, under its new line number.
      const entries = byLine.get(key(path, side, Number(lineEl.dataset.line)));
      if (!entries) continue;
      for (const { start, end, index } of entries) {
        const range = textRange(lineEl, start, end);
        if (range) (index === current ? active : all).add(range);
      }
    }
  }
  CSS.highlights.set(ALL, all);
  CSS.highlights.set(CURRENT, active);
}

export function clearMatches() {
  if (typeof CSS === "undefined" || !("highlights" in CSS)) return;
  CSS.highlights.delete(ALL);
  CSS.highlights.delete(CURRENT);
}

/** A range over characters `start`–`end` of an element's text, which is split across token spans. */
function textRange(el: HTMLElement, start: number, end: number): Range | null {
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
