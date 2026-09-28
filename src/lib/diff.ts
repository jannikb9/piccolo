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

/** Parses a multi-file patch into per-file diffs keyed by (new) path. */
export function parsePatch(patch: string): Map<string, FileDiffMetadata> {
  const byPath = new Map<string, FileDiffMetadata>();
  // The cache key prefix lets the highlighter reuse work until the patch changes.
  for (const parsed of parsePatchFiles(patch, `patch-${hashString(patch).toString(36)}`)) {
    for (const file of parsed.files) byPath.set(file.name, file);
  }
  return byPath;
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
