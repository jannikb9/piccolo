import type { FileDiffMetadata } from "@pierre/diffs";
import type { LineRange, Side } from "../types";

/**
 * The row of a line in the unified diff, counting collapsed lines too, as the library's
 * `data-line-index` numbers rows in both layouts. Lines outside the hunks are unchanged.
 */
function rowOf(fileDiff: FileDiffMetadata, side: Side, line: number): number {
  let row = 0;
  let oldLine = 1;
  let newLine = 1;
  const current = () => (side === "additions" ? newLine : oldLine);
  for (const hunk of fileDiff.hunks) {
    if (line < current() + hunk.collapsedBefore) return row + line - current();
    row += hunk.collapsedBefore;
    oldLine = hunk.deletionStart;
    newLine = hunk.additionStart;
    for (const block of hunk.hunkContent) {
      if (block.type === "context") {
        if (line < current() + block.lines) return row + line - current();
        row += block.lines;
        oldLine += block.lines;
        newLine += block.lines;
      } else {
        if (side === "deletions" && line < oldLine + block.deletions) return row + line - oldLine;
        if (side === "additions" && line < newLine + block.additions) return row + block.deletions + line - newLine;
        row += block.deletions + block.additions;
        oldLine += block.deletions;
        newLine += block.additions;
      }
    }
  }
  return row + line - current();
}

/**
 * Marks the rendered lines of one diff (a `diffs-container`) that comments are on, with
 * `data-commented` on the code and its line number. The diff is virtualized, so this runs again
 * after each render.
 */
export function markCommentedLines(
  host: Element,
  rangesByPath: Map<string, LineRange[]>,
  fileDiffs: Map<string, FileDiffMetadata>,
) {
  const root = host.shadowRoot;
  if (!root) return;
  const stale = new Set(root.querySelectorAll("[data-commented]"));
  const path = host.querySelector<HTMLElement>("[data-file-path]")?.dataset.filePath;
  const ranges = path === undefined ? undefined : rangesByPath.get(path);
  const fileDiff = path === undefined ? undefined : fileDiffs.get(path);
  if (ranges?.length && fileDiff) {
    const spans = ranges.map((range) => {
      const a = rowOf(fileDiff, range.startSide, range.startLine);
      const b = rowOf(fileDiff, range.endSide, range.endLine);
      return { first: Math.min(a, b), last: Math.max(a, b) };
    });
    for (const code of root.querySelectorAll("code")) {
      const gutter = code.querySelector(":scope > [data-gutter]")?.children;
      const content = code.querySelector(":scope > [data-content]")?.children;
      if (!gutter || !content) continue;
      // Line numbers and lines are siblings at the same index in their columns.
      for (let i = 0; i < content.length; i++) {
        const index = (content[i] as HTMLElement).dataset.lineIndex;
        if (index === undefined) continue;
        const row = Number(index.split(",")[0]);
        if (!spans.some((span) => row >= span.first && row <= span.last)) continue;
        for (const el of [content[i], gutter[i]]) {
          if (!el) continue;
          stale.delete(el);
          if (!el.hasAttribute("data-commented")) el.setAttribute("data-commented", "");
        }
      }
    }
  }
  for (const el of stale) el.removeAttribute("data-commented");
}
