import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { Check, ChevronDown, ChevronLeft, ChevronRight, GitCommitHorizontal } from "lucide-react";
import type { ReactNode } from "react";
import { defaultScope, useCommits } from "../lib/queries";
import { cn, timeAgo } from "../lib/utils";
import { useStore } from "../store";
import type { DiffScope, ScopeMode, Worktree } from "../types";
import { IconButton } from "./ui";

const LABELS: Record<ScopeMode, string> = {
  all: "All changes",
  committed: "All commits",
  uncommitted: "Uncommitted changes",
};

/**
 * Like GitHub's "Changes from all commits" menu: shows all of the branch's changes, only its
 * commits, or a single step of it: the uncommitted changes or one commit. While a step is shown,
 * buttons go to the previous (older) and next (newer) one.
 */
export function CommitPicker({ worktree, base, scope }: { worktree: Worktree; base: string | null; scope: DiffScope }) {
  const setScope = useStore((s) => s.setScope);
  const commits = useCommits(worktree, base).data ?? [];
  // Without commits, all changes are the uncommitted ones: nothing to pick.
  if (commits.length === 0 && typeof scope === "string") return null;

  const value = typeof scope === "string" ? scope : scope.commit;
  // Newest first, so the previous step comes after the selected one.
  const steps = [...(worktree.dirty ? ["uncommitted"] : []), ...commits.map((c) => c.sha)];
  const index = steps.indexOf(value);
  const commit = typeof scope === "object" ? commits.find((c) => c.sha === scope.commit) : undefined;
  // The default isn't stored, so the worktree keeps following it as it gets dirty or clean.
  const select = (value: string) => {
    const next: DiffScope = value === "all" || value === "committed" || value === "uncommitted" ? (value as ScopeMode) : { commit: value };
    setScope(worktree.id, next === defaultScope(worktree, base) ? null : next);
  };

  return (
    <div className="flex min-w-0 items-center gap-0.5">
      {index !== -1 && (
        <IconButton
          label="Previous"
          className="size-7 disabled:pointer-events-none disabled:opacity-40"
          disabled={index === steps.length - 1}
          onClick={() => select(steps[index + 1])}
        >
          <ChevronLeft className="size-3.5" />
        </IconButton>
      )}
      <DropdownMenuPrimitive.Root>
        <DropdownMenuPrimitive.Trigger
          className={cn(
            "flex h-7 min-w-0 items-center gap-1.5 rounded-md px-2 text-[12px] font-medium outline-none transition-colors",
            index !== -1 ? "bg-accent-soft text-fg" : "text-fg-muted hover:bg-bg-hover hover:text-fg data-[state=open]:bg-bg-hover",
          )}
        >
          <GitCommitHorizontal className="size-3.5 shrink-0 text-fg-subtle" />
          {commit ? (
            // Narrow panes cut the subject shorter, so the branch name keeps its room.
            <span title={`${commit.shortSha} ${commit.subject}`} className="max-w-32 truncate @5xl:max-w-44 @6xl:max-w-72">
              {commit.subject}
            </span>
          ) : typeof scope === "object" ? (
            <span className="tabular font-mono text-[11.5px]">{scope.commit.slice(0, 7)}</span>
          ) : (
            <span className="shrink-0">{LABELS[scope]}</span>
          )}
          <ChevronDown className="size-3 shrink-0 text-fg-subtle" />
        </DropdownMenuPrimitive.Trigger>
        <DropdownMenuPrimitive.Portal>
          <DropdownMenuPrimitive.Content
            align="end"
            sideOffset={4}
            className="z-50 flex max-h-[min(70vh,520px)] w-[420px] max-w-[calc(100vw-32px)] flex-col overflow-y-auto rounded-md border border-border bg-bg-raised p-1 text-[12.5px] text-fg-muted shadow-lg shadow-black/20"
          >
            <DropdownMenuPrimitive.RadioGroup value={value} onValueChange={select}>
              {worktree.dirty && <Item value="all" title={LABELS.all} />}
              <Item value="committed" title={LABELS.committed} />
              <DropdownMenuPrimitive.Separator className="-mx-1 my-1 h-px shrink-0 bg-border" />
              {worktree.dirty && <Item value="uncommitted" title={LABELS.uncommitted} detail="Working tree" />}
              {commits.map((c) => (
                <Item
                  key={c.sha}
                  value={c.sha}
                  title={c.subject}
                  detail={
                    <>
                      <span className="font-mono">{c.shortSha}</span> · {c.author}
                    </>
                  }
                  time={timeAgo(c.time)}
                />
              ))}
            </DropdownMenuPrimitive.RadioGroup>
          </DropdownMenuPrimitive.Content>
        </DropdownMenuPrimitive.Portal>
      </DropdownMenuPrimitive.Root>
      {index !== -1 && (
        <IconButton
          label="Next"
          className="size-7 disabled:pointer-events-none disabled:opacity-40"
          disabled={index === 0}
          onClick={() => select(steps[index - 1])}
        >
          <ChevronRight className="size-3.5" />
        </IconButton>
      )}
    </div>
  );
}

function Item({ value, title, detail, time }: { value: string; title: string; detail?: ReactNode; time?: string }) {
  return (
    <DropdownMenuPrimitive.RadioItem
      value={value}
      className="grid shrink-0 cursor-default grid-cols-[14px_1fr_auto] items-center gap-x-2 gap-y-0.5 rounded px-2 py-1.5 outline-none data-[highlighted]:bg-bg-hover data-[highlighted]:text-fg"
    >
      <DropdownMenuPrimitive.ItemIndicator>
        <Check className="size-3.5 text-accent" />
      </DropdownMenuPrimitive.ItemIndicator>
      <span title={title} className="col-start-2 truncate font-medium text-fg">
        {title}
      </span>
      {time && <span className="tabular text-[11px] text-fg-faint">{time}</span>}
      {detail && <span className="col-start-2 truncate text-[11.5px] text-fg-subtle">{detail}</span>}
    </DropdownMenuPrimitive.RadioItem>
  );
}
