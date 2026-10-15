import { parseDiffFromFile, parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs";
import type { ChangedFile } from "../types";
import { splitPath } from "./utils";

/** FNV-1a; a cheap content fingerprint for cache keys and item versions. */
export function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** The part of the patch each diff was parsed from. */
const sources = new WeakMap<FileDiffMetadata, string>();

/**
 * Parses a multi-file patch into per-file diffs keyed by (new) path. A file whose part of the
 * patch is the same as in `previous` keeps its diff from there: the library expands context into
 * that object, so what the reviewer expanded stays. (The `index` line names both versions'
 * blobs, so the same text means the same file contents.)
 */
export function parsePatch(patch: string, previous?: Map<string, FileDiffMetadata>): Map<string, FileDiffMetadata> {
  const bySource = new Map([...(previous?.values() ?? [])].map((diff) => [sources.get(diff), diff]));
  const byPath = new Map<string, FileDiffMetadata>();
  for (const source of patch.split(/^(?=diff --git )/m)) {
    if (!source.startsWith("diff --git ")) continue;
    const kept = bySource.get(source);
    if (kept) {
      byPath.set(kept.name, kept);
      continue;
    }
    // The cache key prefix lets the highlighter reuse work until the file's patch changes.
    for (const parsed of parsePatchFiles(source, `patch-${hashString(source).toString(36)}`)) {
      for (const file of parsed.files) {
        sources.set(file, source);
        byPath.set(file.name, file);
      }
    }
  }
  return byPath;
}

/** Whether a hunk of `diff` holds `line` of the `side` version. */
export function inHunks(diff: FileDiffMetadata, side: "additions" | "deletions", line: number): boolean {
  return diff.hunks.some((hunk) =>
    side === "additions"
      ? line >= hunk.additionStart && line < hunk.additionStart + hunk.additionCount
      : line >= hunk.deletionStart && line < hunk.deletionStart + hunk.deletionCount,
  );
}

/** An empty diff for files without a textual patch (binary or too large). */
export function emptyDiff(path: string): FileDiffMetadata {
  return parseDiffFromFile({ name: path, contents: "" }, { name: path, contents: "" });
}

const LOCKFILES = new Set([
  "bun.lock",
  "bun.lockb",
  "Cargo.lock",
  "composer.lock",
  "flake.lock",
  "Gemfile.lock",
  "go.sum",
  "package-lock.json",
  "Pipfile.lock",
  "pnpm-lock.yaml",
  "poetry.lock",
  "uv.lock",
  "yarn.lock",
]);

/** Lockfiles, minified bundles and `linguist-generated` files start collapsed, as on GitHub. */
export function isCollapsedByDefault(file: ChangedFile): boolean {
  const name = splitPath(file.path).base;
  return file.generated || LOCKFILES.has(name) || /\.min\.(js|css)$|\.map$/.test(name);
}
