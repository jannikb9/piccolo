import { useStore } from "../store";
import type { Commit, ReviewRequest, Worktree } from "../types";
import { useCommits, useSessionActivity } from "./queries";

export type NewCommits = {
  /** The last time you asked an agent to address comments, with the commit the branch was at. */
  request: ReviewRequest | undefined;
  /** Commits made since then. */
  sinceRequest: number;
  /** Of those, the ones you haven't looked at yet. */
  unseen: number;
  /** Marks every commit there is as seen. */
  markSeen: () => void;
};

/**
 * How many of `commits` (newest first) came after `sha`. When it isn't one of them (it was where
 * the branch forked, or got rebased away), those committed after `time`.
 */
function newerThan(commits: Commit[], sha: string, time: number): number {
  const at = commits.findIndex((c) => c.sha === sha);
  return at !== -1 ? at : commits.filter((c) => c.time > time).length;
}

/** The commits on the branch since you last requested changes, and which of them are new to you. */
export function useNewCommits(worktree: Worktree, base: string | null): NewCommits {
  const commits = useCommits(worktree, base).data ?? [];
  const request = useSessionActivity(worktree).requests.find((r) => r.kind === "implement" && r.head);
  const seen = useStore((s) => s.seenCommits[worktree.id]);
  const setSeenCommit = useStore((s) => s.setSeenCommit);
  const sinceRequest = request ? newerThan(commits, request.head!, request.requestedAt) : 0;
  const seenAt = seen ? commits.findIndex((c) => c.sha === seen) : -1;
  return {
    request,
    sinceRequest,
    unseen: seenAt === -1 ? sinceRequest : Math.min(seenAt, sinceRequest),
    markSeen: () => commits[0] && setSeenCommit(worktree.id, commits[0].sha),
  };
}
