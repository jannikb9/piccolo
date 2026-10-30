import type { ChangedFile, DiffSymbol, Move } from "../types";

/** A changed symbol with the changed symbols on either side of it. */
export type SymbolLinks = {
  symbol: DiffSymbol;
  /** Changed symbols it uses: functions it calls, then types. */
  calls: DiffSymbol[];
  uses: DiffSymbol[];
  /** Changed symbols that use it. */
  usedBy: DiffSymbol[];
};

const isType = (s: DiffSymbol) => s.kind === "type" || s.kind === "class";

/** Every symbol's links, by id. */
export function symbolLinks(symbols: DiffSymbol[]): Map<string, SymbolLinks> {
  const byId = new Map(symbols.map((s) => [s.id, s]));
  const links = new Map<string, SymbolLinks>(symbols.map((s) => [s.id, { symbol: s, calls: [], uses: [], usedBy: [] }]));
  for (const symbol of symbols) {
    for (const id of symbol.uses) {
      const used = byId.get(id);
      if (!used) continue;
      const link = links.get(symbol.id)!;
      (isType(used) ? link.uses : link.calls).push(used);
      links.get(id)!.usedBy.push(symbol);
    }
  }
  return links;
}

/** `Store.open`, or just `open`. */
export const symbolLabel = (s: DiffSymbol) => (s.container && s.kind === "method" ? `${s.container}.${s.name}` : s.name);

/** Moved lines by the file they went to, and the file they came from. */
export function movedLineCounts(moves: Move[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const move of moves) counts.set(move.to.path, (counts.get(move.to.path) ?? 0) + move.to.end - move.to.start + 1);
  return counts;
}

/** A file in call order, at its depth below the files that use it. */
export type OrderedFile = { file: ChangedFile; depth: number };

/**
 * Files in the order their changes call each other: each file that no other changed file uses,
 * followed by the files it uses, depth first, each file once. Files whose symbols use nothing
 * changed and aren't used come last (`unconnected`).
 */
export function filesByCalls(files: ChangedFile[], symbols: DiffSymbol[]): { ordered: OrderedFile[]; unconnected: ChangedFile[] } {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const pathOf = new Map(symbols.map((s) => [s.id, s.path]));
  const edges = new Map<string, string[]>();
  const used = new Set<string>();
  for (const symbol of symbols) {
    for (const id of symbol.uses) {
      const to = pathOf.get(id);
      if (!to || to === symbol.path || !byPath.has(to) || !byPath.has(symbol.path)) continue;
      const list = edges.get(symbol.path) ?? [];
      if (!list.includes(to)) list.push(to);
      edges.set(symbol.path, list);
      used.add(to);
    }
  }
  const fileIndex = new Map(files.map((f, i) => [f.path, i]));
  for (const list of edges.values()) list.sort((a, b) => fileIndex.get(a)! - fileIndex.get(b)!);

  const ordered: OrderedFile[] = [];
  const placed = new Set<string>();
  const visit = (path: string, depth: number) => {
    if (placed.has(path)) return;
    placed.add(path);
    ordered.push({ file: byPath.get(path)!, depth });
    for (const next of edges.get(path) ?? []) visit(next, depth + 1);
  };
  // Entry points first; then whatever only a cycle reaches.
  for (const file of files) if (edges.has(file.path) && !used.has(file.path)) visit(file.path, 0);
  for (const file of files) if (edges.has(file.path) || used.has(file.path)) visit(file.path, 0);
  return { ordered, unconnected: files.filter((f) => !placed.has(f.path)) };
}
