import { ChevronRight, MessageSquare } from "lucide-react";
import { useMemo, useState } from "react";
import { markdownPreview } from "../lib/markdown";
import { cn, splitPath } from "../lib/utils";
import { panelCommentKey, useStore } from "../store";
import type { ChangedFile, GeneralThread, LineRange, Thread, Worktree } from "../types";
import { authorLabel, AuthorAvatar, GeneralComposer } from "./Comments";

type AnyThread = Thread | GeneralThread;

/** Threads under one heading: the general ones, or those on one file. */
type Group = { key: string; path: string | null; inDiff: boolean; threads: AnyThread[] };

/** "L24", "L24–26"; lines the branch removed are marked "−". */
function lineLabel(range: LineRange): string {
  const line = (side: LineRange["startSide"], n: number) => (side === "deletions" ? `−${n}` : `${n}`);
  if (range.startSide === range.endSide && range.startLine === range.endLine) return `L${line(range.endSide, range.endLine)}`;
  return `L${line(range.startSide, range.startLine)}–${line(range.endSide, range.endLine)}`;
}

/**
 * Every comment on the branch, as an index: general comments, then those on each file in the
 * order the diff shows them, then those on files it doesn't show. Picking one scrolls the diff to
 * it, where it's read and answered.
 */
export function CommentList({
  worktree,
  generalThreads,
  threads,
  files,
  onSelectFile,
}: {
  worktree: Worktree;
  generalThreads: GeneralThread[];
  threads: Thread[];
  /** Changed files in display order. */
  files: ChangedFile[];
  onSelectFile: (path: string) => void;
}) {
  const [showResolved, setShowResolved] = useState(false);
  const revealThread = useStore((s) => s.revealThread);
  const resolvedCount = generalThreads.filter((t) => t.resolved).length + threads.filter((t) => t.resolved).length;

  const groups = useMemo(() => {
    const shown = <T extends AnyThread>(list: T[]) => list.filter((t) => showResolved || !t.resolved);
    const byPath = new Map<string, Thread[]>();
    for (const thread of shown(threads)) byPath.set(thread.path, [...(byPath.get(thread.path) ?? []), thread]);
    const line = (t: Thread) => (t.position ?? t.range).endLine;
    const groups: Group[] = [];
    const general = shown(generalThreads);
    if (general.length > 0) groups.push({ key: "general", path: null, inDiff: true, threads: general });
    for (const file of files) {
      const list = byPath.get(file.path);
      if (!list) continue;
      groups.push({ key: file.path, path: file.path, inDiff: true, threads: list.sort((a, b) => line(a) - line(b)) });
      byPath.delete(file.path);
    }
    for (const [path, list] of byPath) groups.push({ key: path, path, inDiff: false, threads: list });
    return groups;
  }, [generalThreads, threads, files, showResolved]);

  return (
    <div className="flex flex-col gap-2">
      <GeneralComposer worktree={worktree} draftKey={panelCommentKey(worktree.id)} />
      {groups.length === 0 ? (
        <p className="px-2 py-6 text-center text-[12px] leading-5 text-fg-subtle">
          {resolvedCount > 0 ? "No open comments." : "No comments yet."}
          <br />
          Click + beside a line in the diff, or add a comment on the whole branch.
        </p>
      ) : (
        groups.map((group) => <GroupSection key={group.key} group={group} onSelectFile={onSelectFile} onSelect={revealThread} />)
      )}
      {resolvedCount > 0 && (
        <button
          type="button"
          onClick={() => setShowResolved(!showResolved)}
          className="mx-auto h-7 rounded-md px-2 text-[12px] text-fg-subtle hover:bg-bg-hover hover:text-fg-muted"
        >
          {showResolved ? "Hide closed" : `Show ${resolvedCount} closed`}
        </button>
      )}
    </div>
  );
}

function GroupSection({
  group,
  onSelect,
  onSelectFile,
}: {
  group: Group;
  onSelect: (threadId: number) => void;
  onSelectFile: (path: string) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const { path } = group;
  const { dir, base } = splitPath(path ?? "");
  return (
    <section>
      <div className="group flex h-7 items-center gap-1.5 rounded-md pr-2 pl-2 hover:bg-bg-hover">
        <button
          type="button"
          aria-expanded={!collapsed}
          aria-label={collapsed ? "Show comments" : "Hide comments"}
          onClick={() => setCollapsed(!collapsed)}
          className="text-fg-subtle hover:text-fg-muted"
        >
          <ChevronRight className={cn("size-3 transition-transform duration-150", !collapsed && "rotate-90")} />
        </button>
        {path === null ? (
          <button
            type="button"
            onClick={() => setCollapsed(!collapsed)}
            className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-[12.5px] font-medium text-fg-muted"
          >
            <MessageSquare className="size-3.5 shrink-0" />
            General
          </button>
        ) : (
          <button
            type="button"
            title={group.inDiff ? `Go to ${path}` : `${path} has no changes in this view`}
            onClick={() => (group.inDiff ? onSelectFile(path) : onSelect(group.threads[0].id))}
            className="flex min-w-0 flex-1 items-baseline text-left font-mono text-[12px]"
          >
            <span className="truncate text-fg-subtle">{dir}</span>
            <span className="shrink-0 font-medium text-fg-muted">{base}</span>
          </button>
        )}
        <span className="tabular shrink-0 rounded-full bg-bg-hover px-1.5 text-[11px] font-medium text-fg-subtle group-hover:bg-bg-active">
          {group.threads.length}
        </span>
      </div>
      {!collapsed && (
        <ul>
          {group.threads.map((thread) => (
            <li key={thread.id}>
              <ThreadRow thread={thread} inDiff={group.inDiff} onSelect={() => onSelect(thread.id)} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ThreadRow({ thread, inDiff, onSelect }: { thread: AnyThread; inDiff: boolean; onSelect: () => void }) {
  const first = thread.messages[0];
  const last = thread.messages[thread.messages.length - 1];
  const replies = thread.messages.length - 1;
  const preview = markdownPreview(first?.body ?? "") || (first?.attachments.length ? "Image" : "");
  const range = thread.path === null ? null : (thread.position ?? thread.range);
  const status = thread.dismissed
    ? { label: "Dismissed", className: "text-fg-faint" }
    : thread.resolved
      ? { label: "Resolved", className: "text-add" }
      : thread.path !== null && !inDiff
        ? { label: "Not in diff", className: "text-mod" }
        : thread.path !== null && !thread.position
          ? { label: "Outdated", className: "text-mod" }
          : null;

  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex w-full flex-col gap-1 rounded-md py-1.5 pr-2 pl-7 text-left hover:bg-bg-hover",
        thread.resolved && "opacity-60 hover:opacity-100",
      )}
    >
      <span className="flex w-full items-center gap-1.5 text-[11.5px]">
        {first && <AuthorAvatar message={first} />}
        <span className="truncate font-medium text-fg-muted">{first ? authorLabel(first) : ""}</span>
        {range && <span className="tabular shrink-0 font-mono text-[11px] text-fg-faint">{lineLabel(range)}</span>}
        {status && <span className={cn("ml-auto shrink-0 text-[11px] font-medium", status.className)}>{status.label}</span>}
      </span>
      <span className="line-clamp-2 text-[12px] leading-[17px] break-words text-fg-subtle">{preview}</span>
      {replies > 0 && last && (
        <span className="text-[11px] text-fg-faint">
          {replies === 1 ? "1 reply" : `${replies} replies`} · last by {authorLabel(last)}
        </span>
      )}
    </button>
  );
}
