import { LoaderCircle, Upload } from "lucide-react";
import { usePullRequests, usePushing, usePushWorktree, useWorktreeMerged } from "../lib/queries";
import { cn } from "../lib/utils";
import type { Repo, Worktree } from "../types";
import { Tooltip } from "./ui";

/**
 * Pushes the branch, with a count of the commits the remote branch doesn't have. Plain like the
 * commit picker beside it, so the agents' buttons stay the toolbar's main actions. Always shown,
 * so it stays put; dimmed once everything is pushed. Not shown for a detached HEAD or a merged branch,
 * whose remote branch may well be deleted.
 */
export function PushButton({ repo, worktree }: { repo: Repo; worktree: Worktree }) {
  const push = usePushWorktree();
  const pushing = usePushing(worktree);
  const merged = useWorktreeMerged(worktree, repo.defaultBranch);
  const pull = usePullRequests(repo)[worktree.branch ?? ""];
  if (!worktree.branch || merged || pull?.state === "merged") return null;

  const count = worktree.unpushed;
  const disabled = pushing || count === 0;
  const tooltip = pushing
    ? "Pushing…"
    : count === null
      ? "Push the branch to the remote"
      : count === 0
        ? "Everything is pushed"
        : `Push ${count} ${count === 1 ? "commit" : "commits"}`;

  return (
    <Tooltip label={tooltip}>
      {/* Not `disabled`, which would keep the tooltip from showing. */}
      <button
        type="button"
        aria-disabled={disabled}
        onClick={disabled ? undefined : () => push.mutate(worktree)}
        className={cn(
          "group flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-[12px] font-medium text-fg-muted outline-none transition-colors",
          disabled ? "opacity-50" : "hover:bg-bg-hover hover:text-fg",
        )}
      >
        {pushing ? (
          <LoaderCircle className="size-3.5 animate-spin text-fg-subtle" />
        ) : (
          <Upload className="size-3.5 text-fg-subtle" />
        )}
        {/* A narrow toolbar keeps the icon and the count. */}
        <span className="hidden @2xl:inline">{pushing ? "Pushing…" : "Push"}</span>
        {!pushing && !!count && (
          <span className="tabular shrink-0 rounded-full bg-bg-hover px-1.5 text-[11px] font-medium text-fg-subtle group-hover:bg-bg-active">
            {count}
          </span>
        )}
      </button>
    </Tooltip>
  );
}
