import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { Check, ChevronDown, ChevronLeft, ChevronRight, GitCommitHorizontal } from "lucide-react";
import type { ReactNode } from "react";
import { useCommits } from "../lib/queries";
import { cn, timeAgo } from "../lib/utils";
import { useStore } from "../store";
import type { DiffScope, Worktree } from "../types";
import { IconButton } from "./ui";

/**
 * Like GitHub's "Changes from all commits" menu: shows what a single commit on the branch changed,
 * with buttons to step to the previous (older) and next (newer) commit while one is shown.
 */
export function CommitPicker({ worktree, base, scope }: { worktree: Worktree; base: string | null; scope: DiffScope }) {
  const selectCommit = useStore((s) => s.selectCommit);
  const commits = useCommits(worktree, base).data ?? [];
  const sha = typeof scope === "string" ? null : scope.commit;
  if (commits.length === 0 && !sha) return null;

  // Newest first, so the previous commit comes after the selected one in the list.
  const index = commits.findIndex((c) => c.sha === sha);
  const selected = commits[index];
  const select = (sha: string | null) => selectCommit(worktree.id, sha);

  return (
    <div className="flex min-w-0 items-center gap-0.5">
      {sha && (
        <IconButton
          label="Previous commit"
          className="size-7 disabled:pointer-events-none disabled:opacity-40"
          disabled={index === -1 || index === commits.length - 1}
          onClick={() => select(commits[index + 1].sha)}
        >
          <ChevronLeft className="size-3.5" />
        </IconButton>
      )}
      <DropdownMenuPrimitive.Root>
        <DropdownMenuPrimitive.Trigger
          className={cn(
            "flex h-7 min-w-0 items-center gap-1.5 rounded-md px-2 text-[12px] font-medium outline-none transition-colors",
            sha ? "bg-accent-soft text-fg" : "text-fg-muted hover:bg-bg-hover hover:text-fg data-[state=open]:bg-bg-hover",
          )}
        >
          <GitCommitHorizontal className="size-3.5 shrink-0 text-fg-subtle" />
          {selected ? (
            // Narrow panes cut the subject shorter, so the branch name keeps its room.
            <span title={`${selected.shortSha} ${selected.subject}`} className="max-w-32 truncate @5xl:max-w-44 @6xl:max-w-72">
              {selected.subject}
            </span>
          ) : sha ? (
            <span className="tabular font-mono text-[11.5px]">{sha.slice(0, 7)}</span>
          ) : (
            <span className="shrink-0">All commits</span>
          )}
          <ChevronDown className="size-3 shrink-0 text-fg-subtle" />
        </DropdownMenuPrimitive.Trigger>
        <DropdownMenuPrimitive.Portal>
          <DropdownMenuPrimitive.Content
            align="end"
            sideOffset={4}
            className="z-50 flex max-h-[min(70vh,520px)] w-[420px] max-w-[calc(100vw-32px)] flex-col overflow-y-auto rounded-md border border-border bg-bg-raised p-1 text-[12.5px] text-fg-muted shadow-lg shadow-black/20"
          >
            <DropdownMenuPrimitive.RadioGroup value={sha ?? ""} onValueChange={(v) => select(v || null)}>
              <Item value="" title="All commits" />
              <DropdownMenuPrimitive.Separator className="-mx-1 my-1 h-px shrink-0 bg-border" />
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
      {sha && (
        <IconButton
          label="Next commit"
          className="size-7 disabled:pointer-events-none disabled:opacity-40"
          disabled={index <= 0}
          onClick={() => select(commits[index - 1].sha)}
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
      <span className="col-start-2 truncate font-medium text-fg">{title}</span>
      {time && <span className="tabular text-[11px] text-fg-faint">{time}</span>}
      {detail && <span className="col-start-2 truncate text-[11.5px] text-fg-subtle">{detail}</span>}
    </DropdownMenuPrimitive.RadioItem>
  );
}
