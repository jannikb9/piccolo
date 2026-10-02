import * as Dialog from "@radix-ui/react-dialog";
import { AlertTriangle, GitBranch, LoaderCircle, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useAddWorktree, useRemoteBranches } from "../lib/queries";
import { cn, timeAgo } from "../lib/utils";
import { useStore } from "../store";
import type { RemoteBranch, Repo } from "../types";
import { Skeleton } from "./ui";

/** Rows rendered at most; typing narrows the rest down. */
const LIMIT = 100;

/** Picks one of `repo`'s remote branches and checks it out in a new worktree, to review it. */
export function BranchPicker({ repo, open, onOpenChange }: { repo: Repo; open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed top-[12vh] left-1/2 z-50 flex max-h-[70vh] w-[560px] max-w-[calc(100vw-32px)] -translate-x-1/2 flex-col overflow-hidden rounded-xl border border-border bg-bg-raised shadow-2xl shadow-black/40 outline-none"
        >
          <Dialog.Title className="sr-only">New worktree from a branch of {repo.name}</Dialog.Title>
          <Picker repo={repo} onDone={() => onOpenChange(false)} />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Picker({ repo, onDone }: { repo: Repo; onDone: () => void }) {
  const { branches, fetch } = useRemoteBranches(repo.id);
  const addWorktree = useAddWorktree(repo.id);
  const selectWorktree = useStore((s) => s.selectWorktree);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  const worktreeOf = useMemo(
    () => new Map(repo.worktrees.flatMap((w) => (w.branch ? [[w.branch, w.id] as const] : []))),
    [repo.worktrees],
  );
  const matches = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return (branches.data ?? []).filter((b) => {
      // Nothing to review on the base branch.
      if (b.remoteRef === repo.defaultBranch || b.name === repo.defaultBranch) return false;
      const text = `${b.remoteRef} ${b.author}`.toLowerCase();
      return words.every((w) => text.includes(w));
    });
  }, [branches.data, query, repo.defaultBranch]);
  const shown = matches.slice(0, LIMIT);

  useEffect(() => {
    listRef.current?.children[active]?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const choose = (branch: RemoteBranch | undefined) => {
    if (!branch || addWorktree.isPending) return;
    const existing = worktreeOf.get(branch.name);
    if (existing) {
      selectWorktree(existing);
      onDone();
    } else {
      addWorktree.mutate(branch, { onSuccess: onDone });
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const step = { ArrowDown: 1, ArrowUp: -1 }[e.key];
    if (step) {
      e.preventDefault();
      setActive((i) => Math.min(Math.max(i + step, 0), shown.length - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(shown[active]);
    }
  };

  return (
    <>
      <div className="flex h-12 shrink-0 items-center gap-2.5 border-b border-border-subtle px-4">
        <Search className="size-4 shrink-0 text-fg-subtle" />
        <input
          autoFocus
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          placeholder={`Review a branch of ${repo.name}…`}
          aria-label="Search branches"
          spellCheck={false}
          className="min-w-0 flex-1 bg-transparent text-[14px] text-fg outline-none placeholder:text-fg-faint"
        />
        {fetch.isFetching ? (
          <span className="flex shrink-0 items-center gap-1.5 text-[12px] text-fg-subtle">
            <LoaderCircle className="size-3.5 animate-spin" />
            Fetching
          </span>
        ) : (
          fetch.error && (
            <span title={String(fetch.error)} className="flex shrink-0 items-center gap-1.5 text-[12px] text-fg-subtle">
              <AlertTriangle className="size-3.5 text-mod" />
              Couldn't fetch
            </span>
          )
        )}
      </div>

      {addWorktree.error && (
        <div className="mx-2 mt-2 flex items-start gap-2 rounded-md border border-del/30 bg-del-bg px-2.5 py-2 text-[12px] text-fg-muted">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-del" />
          <span className="min-w-0 flex-1 font-mono break-words whitespace-pre-wrap">{String(addWorktree.error)}</span>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {branches.isPending ? (
          <div className="space-y-3 p-2.5">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="space-y-1.5">
                <Skeleton className="h-3 w-56" />
                <Skeleton className="h-2.5 w-80" />
              </div>
            ))}
          </div>
        ) : branches.error ? (
          <p className="px-2.5 py-2 text-[12px] text-fg-subtle">{String(branches.error)}</p>
        ) : shown.length === 0 ? (
          <p className="px-2.5 py-2 text-[12px] text-fg-subtle">
            {query ? `No branches match “${query}”.` : fetch.isFetching ? "Looking for branches…" : "No remote branches."}
          </p>
        ) : (
          <ul ref={listRef} role="listbox" aria-label="Branches">
            {shown.map((b, i) => {
              const creating = addWorktree.isPending && addWorktree.variables?.name === b.name;
              return (
                <li
                  key={b.remoteRef}
                  role="option"
                  aria-selected={i === active}
                  onPointerMove={() => setActive(i)}
                  onClick={() => choose(b)}
                  className={cn(
                    "grid cursor-default grid-cols-[16px_1fr_auto] items-center gap-x-2.5 gap-y-0.5 rounded-md px-2.5 py-2",
                    i === active && "bg-bg-hover",
                    addWorktree.isPending && !creating && "opacity-50",
                  )}
                >
                  {creating ? (
                    <LoaderCircle className="size-3.5 animate-spin text-fg-subtle" />
                  ) : (
                    <GitBranch className="size-3.5 text-fg-subtle" />
                  )}
                  <span title={b.name} className="truncate text-[13px] font-medium text-fg">
                    {b.name}
                  </span>
                  <span className="tabular text-[11px] text-fg-faint">{timeAgo(b.updatedAt)}</span>
                  <span />
                  <span title={`${b.author} · ${b.subject}`} className="truncate text-[12px] text-fg-subtle">
                    {b.author} · {b.subject}
                  </span>
                  {worktreeOf.has(b.name) ? (
                    <span className="justify-self-end rounded border border-border px-1.5 text-[10.5px] font-medium text-fg-subtle">
                      Checked out
                    </span>
                  ) : (
                    <span />
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <footer className="flex h-9 shrink-0 items-center gap-3 border-t border-border-subtle px-4 text-[11.5px] text-fg-subtle">
        <span className="tabular">
          {matches.length > LIMIT ? `${LIMIT} of ${matches.length} branches` : `${matches.length} branches`}
        </span>
        <span className="ml-auto flex items-center gap-1.5">
          {addWorktree.isPending ? (
            "Creating worktree…"
          ) : (
            <>
              <kbd className="rounded border border-border px-1 font-sans text-[10.5px]">↵</kbd>
              {shown[active] && worktreeOf.has(shown[active].name) ? "Open worktree" : "Check out in a new worktree"}
            </>
          )}
        </span>
      </footer>
    </>
  );
}
