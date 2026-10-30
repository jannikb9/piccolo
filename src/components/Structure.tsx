import { parseDiffFromFile } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import { ArrowDown, ArrowRight, ArrowUp, MoveRight } from "lucide-react";
import { useMemo, useState } from "react";
import { unsafeCSS } from "../lib/codeViewStyle";
import { symbolLabel, type SymbolLinks } from "../lib/structure";
import { cn, splitPath } from "../lib/utils";
import type { DiffSymbol, Move, Side } from "../types";
import { Tooltip } from "./ui";

/** Shows a place in the diff. */
export type GoTo = (path: string, side: Side, line: number) => void;

const fileName = (path: string) => splitPath(path).base;

/** Above a changed symbol: the changed symbols it calls and uses, and those that use it. */
export function SymbolBar({ links, goTo }: { links: SymbolLinks; goTo: GoTo }) {
  const { symbol, calls, uses, usedBy } = links;
  return (
    <div className="flex flex-wrap items-center gap-1.5 px-3 py-1.5 font-sans [contain:inline-size]">
      <span className="mr-1 font-mono text-[12px] font-medium text-fg">{symbolLabel(symbol)}</span>
      {usedBy.map((other) => (
        <SymbolChip key={`by:${other.id}`} from={symbol} to={other} verb="Called by" icon="up" goTo={goTo} />
      ))}
      {calls.map((other) => (
        <SymbolChip key={`calls:${other.id}`} from={symbol} to={other} verb="Calls" icon="down" goTo={goTo} />
      ))}
      {uses.map((other) => (
        <SymbolChip key={`uses:${other.id}`} from={symbol} to={other} verb="Uses" icon="down" goTo={goTo} />
      ))}
    </div>
  );
}

function SymbolChip({ from, to, verb, icon, goTo }: { from: DiffSymbol; to: DiffSymbol; verb: string; icon: "up" | "down"; goTo: GoTo }) {
  const Icon = icon === "up" ? ArrowUp : ArrowDown;
  const elsewhere = to.path !== from.path;
  return (
    <Tooltip label={<span className="font-mono">{`${to.path}:${to.start}`}</span>}>
      <button
        type="button"
        onClick={() => goTo(to.path, to.side, to.start)}
        className="flex h-[22px] max-w-full items-center gap-1 rounded-md border border-border px-1.5 text-[11.5px] whitespace-nowrap text-fg-subtle hover:border-accent hover:text-accent"
      >
        <Icon className="size-3 shrink-0" />
        <span>{verb}</span>
        <span className="truncate font-mono text-fg-muted">{symbolLabel(to)}</span>
        {elsewhere && <span className="truncate text-fg-faint">{fileName(to.path)}</span>}
      </button>
    </Tooltip>
  );
}

/** Where moved lines were: a note in place of the lines the diff leaves out. */
export function MovedAway({ move, goTo }: { move: Move; goTo: GoTo }) {
  const lines = move.from.end - move.from.start + 1;
  return (
    <div className="px-3 py-1.5 font-sans [contain:inline-size]">
      <button
        type="button"
        onClick={() => goTo(move.to.path, "additions", move.to.start)}
        className="flex h-7 max-w-full items-center gap-2 rounded-md border border-dashed border-merged/50 px-2.5 text-[12px] text-fg-subtle hover:border-merged hover:text-fg-muted"
      >
        <MoveRight className="size-3.5 shrink-0 text-merged" />
        <span className="shrink-0">
          {lines} {lines === 1 ? "line" : "lines"} moved to
        </span>
        <span className="truncate font-mono text-fg-muted">
          {move.to.path === move.from.path ? `line ${move.to.start}` : `${fileName(move.to.path)}:${move.to.start}`}
        </span>
        <ArrowRight className="size-3 shrink-0" />
      </button>
    </div>
  );
}

/** Above moved lines: where they came from, and what changed on the way. */
export function MovedHere({ move, goTo }: { move: Move; goTo: GoTo }) {
  const [open, setOpen] = useState(false);
  const lines = move.to.end - move.to.start + 1;
  const same = move.same.reduce((n, [first, last]) => n + last - first + 1, 0);
  const changed = lines - same;
  return (
    <div className="px-3 py-1.5 font-sans [contain:inline-size]">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-fg-subtle">
        <MoveRight className="size-3.5 shrink-0 text-merged" />
        <span>Moved from</span>
        <button
          type="button"
          // Hidden lines leave the note in their place.
          onClick={() => goTo(move.from.path, "deletions", move.hidden ? Math.max(1, move.from.start - 1) : move.from.start)}
          className="truncate font-mono text-fg-muted hover:text-accent hover:underline"
        >
          {move.from.path === move.to.path ? `line ${move.from.start}` : `${move.from.path}:${move.from.start}`}
        </button>
        <span className="text-fg-faint">·</span>
        {changed === 0 ? (
          <span>unchanged</span>
        ) : (
          <button type="button" onClick={() => setOpen(!open)} className="text-accent hover:underline">
            {open ? "Hide" : "Show"} {changed} {changed === 1 ? "line" : "lines"} changed on the way
          </button>
        )}
      </div>
      {open && <MoveChanges move={move} />}
    </div>
  );
}

/** The moved lines as they were against how they are now. */
function MoveChanges({ move }: { move: Move }) {
  const fileDiff = useMemo(
    () =>
      parseDiffFromFile(
        { name: move.to.path, contents: `${move.oldText}\n`, cacheKey: `moved-old:${move.from.path}:${move.from.start}:${move.oldText.length}` },
        { name: move.to.path, contents: `${move.newText}\n`, cacheKey: `moved-new:${move.to.path}:${move.to.start}:${move.newText.length}` },
      ),
    [move],
  );
  const options = useMemo(
    () => ({
      diffStyle: "unified" as const,
      diffIndicators: "classic" as const,
      hunkSeparators: "line-info" as const,
      lineDiffType: "word-alt" as const,
      overflow: "wrap" as const,
      disableFileHeader: true,
      unsafeCSS,
    }),
    [],
  );
  return (
    <div className={cn("mt-1.5 max-w-[760px] overflow-hidden rounded-md border border-border-subtle")}>
      <FileDiff fileDiff={fileDiff} options={options} />
    </div>
  );
}
