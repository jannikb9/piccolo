import { clsx, type ClassValue } from "clsx";
import type { ChangedFile, DiffScope } from "../types";

export const cn = (...inputs: ClassValue[]) => clsx(inputs);

export function timeAgo(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 45) return "now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d`;
  return `${Math.round(d / 30)}mo`;
}

/** A string that identifies a scope, e.g. for React keys. */
export const scopeKey = (scope: DiffScope) => (typeof scope === "string" ? scope : `commit:${scope.commit}`);

export function splitPath(path: string): { dir: string; base: string } {
  const i = path.lastIndexOf("/");
  return i === -1 ? { dir: "", base: path } : { dir: path.slice(0, i + 1), base: path.slice(i + 1) };
}

export function totals(files: ChangedFile[]) {
  let additions = 0;
  let deletions = 0;
  for (const f of files) {
    additions += f.additions;
    deletions += f.deletions;
  }
  return { additions, deletions };
}

/** Natural order, so `file9` sorts before `file10`. */
const compareNames = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

export type TreeNode =
  | { type: "dir"; name: string; path: string; children: TreeNode[] }
  | { type: "file"; name: string; path: string; file: ChangedFile };

/**
 * Builds a directory tree from changed file paths. Chains of single-child directories are
 * merged into one node ("src/ui/components") so shallow changes in deep trees stay compact.
 */
export function buildTree(files: ChangedFile[]): TreeNode[] {
  type Dir = { dirs: Map<string, Dir>; files: ChangedFile[] };
  const root: Dir = { dirs: new Map(), files: [] };

  for (const file of files) {
    const parts = file.path.split("/");
    let dir = root;
    for (const part of parts.slice(0, -1)) {
      let next = dir.dirs.get(part);
      if (!next) {
        next = { dirs: new Map(), files: [] };
        dir.dirs.set(part, next);
      }
      dir = next;
    }
    dir.files.push(file);
  }

  const toNodes = (dir: Dir, prefix: string): TreeNode[] => {
    const dirs: TreeNode[] = [...dir.dirs.entries()]
      .sort(([a], [b]) => compareNames(a, b))
      .map(([name, child]) => {
        let label = name;
        let node = child;
        while (node.files.length === 0 && node.dirs.size === 1) {
          const [[childName, grandchild]] = node.dirs.entries();
          label += `/${childName}`;
          node = grandchild;
        }
        const path = prefix + label;
        return { type: "dir", name: label, path, children: toNodes(node, `${path}/`) };
      });
    const fileNodes: TreeNode[] = dir.files
      .sort((a, b) => compareNames(a.path, b.path))
      .map((file) => ({ type: "file", name: splitPath(file.path).base, path: file.path, file }));
    return [...dirs, ...fileNodes];
  };

  return toNodes(root, "");
}

/** Files in the order the tree displays them, so the diff stream matches the sidebar. */
export function treeOrder(nodes: TreeNode[]): ChangedFile[] {
  return nodes.flatMap((n) => (n.type === "file" ? [n.file] : treeOrder(n.children)));
}
