// Stand-in diff body for milestone 1 so layout, type and colour can be judged.
// Replaced by @pierre/diffs with Shiki highlighting in milestone 3.
import { ChevronsUpDown } from "lucide-react";
import { sampleHunk, type MockLine } from "../mock";
import { cn } from "../lib/utils";
import type { DiffLayout } from "../types";

type Side = { no?: number; text: string; kind: "ctx" | "add" | "del" | "empty" };
type SplitRow = { kind: "hunk"; text: string } | { kind: "pair"; left: Side; right: Side };

function toSplitRows(lines: MockLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let dels: Side[] = [];
  let adds: Side[] = [];
  const flush = () => {
    for (let i = 0; i < Math.max(dels.length, adds.length); i++) {
      rows.push({
        kind: "pair",
        left: dels[i] ?? { kind: "empty", text: "" },
        right: adds[i] ?? { kind: "empty", text: "" },
      });
    }
    dels = [];
    adds = [];
  };
  for (const line of lines) {
    if (line.kind === "del") dels.push({ kind: "del", no: line.old, text: line.text });
    else if (line.kind === "add") adds.push({ kind: "add", no: line.new, text: line.text });
    else {
      flush();
      if (line.kind === "hunk") rows.push({ kind: "hunk", text: line.text });
      else
        rows.push({
          kind: "pair",
          left: { kind: "ctx", no: line.old, text: line.text },
          right: { kind: "ctx", no: line.new, text: line.text },
        });
    }
  }
  flush();
  return rows;
}

const codeBg = { ctx: "", add: "bg-add-bg", del: "bg-del-bg", empty: "bg-bg-inset" } as const;
const gutterBg = { ctx: "", add: "bg-add-gutter", del: "bg-del-gutter", empty: "bg-bg-inset" } as const;
const sign = { ctx: " ", add: "+", del: "−", empty: " " } as const;
const signColor = { ctx: "", add: "text-add", del: "text-del", empty: "" } as const;

function LineNo({ no, kind, className }: { no?: number; kind: keyof typeof gutterBg; className?: string }) {
  return (
    <td className={cn("tabular w-12 min-w-12 pr-2 text-right align-top text-fg-faint", gutterBg[kind], className)}>
      {no}
    </td>
  );
}

function Code({ text, kind }: { text: string; kind: keyof typeof codeBg }) {
  return (
    <td className={cn("selectable pr-4 align-top whitespace-pre-wrap [overflow-wrap:anywhere]", codeBg[kind])}>
      <span className={cn("inline-block w-5 pl-1.5 select-none", signColor[kind])}>{sign[kind]}</span>
      {text}
    </td>
  );
}

function HunkRow({ text, colSpan }: { text: string; colSpan: number }) {
  return (
    <tr className="bg-hunk-bg text-hunk-fg">
      <td className="w-12 min-w-12 py-0.5 text-center">
        <button
          type="button"
          aria-label="Expand context"
          className="inline-grid size-5 place-items-center rounded text-hunk-fg hover:bg-accent-soft hover:text-fg"
        >
          <ChevronsUpDown className="size-3.5" />
        </button>
      </td>
      <td colSpan={colSpan - 1} className="py-0.5 pl-2">
        {text}
      </td>
    </tr>
  );
}

export function MockDiff({ layout }: { layout: DiffLayout }) {
  const tableClass = "w-full border-collapse font-mono text-[12px] leading-5";

  if (layout === "unified") {
    return (
      <table className={tableClass}>
        <tbody>
          {sampleHunk.map((line, i) =>
            line.kind === "hunk" ? (
              <HunkRow key={i} text={line.text} colSpan={3} />
            ) : (
              <tr key={i}>
                <LineNo no={line.kind !== "add" ? line.old : undefined} kind={line.kind} />
                <LineNo no={line.kind !== "del" ? line.new : undefined} kind={line.kind} />
                <Code text={line.text} kind={line.kind} />
              </tr>
            ),
          )}
        </tbody>
      </table>
    );
  }

  return (
    <table className={cn(tableClass, "table-fixed")}>
      <colgroup>
        <col className="w-12" />
        <col />
        <col className="w-12" />
        <col />
      </colgroup>
      <tbody>
        {toSplitRows(sampleHunk).map((row, i) =>
          row.kind === "hunk" ? (
            <HunkRow key={i} text={row.text} colSpan={4} />
          ) : (
            <tr key={i}>
              <LineNo no={row.left.no} kind={row.left.kind} />
              <Code text={row.left.text} kind={row.left.kind} />
              <LineNo no={row.right.no} kind={row.right.kind} className="border-l border-border-subtle" />
              <Code text={row.right.text} kind={row.right.kind} />
            </tr>
          ),
        )}
      </tbody>
    </table>
  );
}
