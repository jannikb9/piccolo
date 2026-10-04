import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { Check, ChevronDown, LoaderCircle, Send } from "lucide-react";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useSendComments, useSessionActivity, useSessions, type SendTarget } from "../lib/queries";
import { agentLabel, ago, cn, timeAgo } from "../lib/utils";
import { useStore } from "../store";
import type { AgentKind, AgentSession, GeneralThread, ReviewRequest, SessionActivity, Thread, Worktree } from "../types";
import { AgentIcon } from "./AgentIcon";
import { Button, Tooltip } from "./ui";

/** The worktree the diff shows, for comment cards the diff library draws. */
export const WorktreeContext = createContext<Worktree | null>(null);

/** Agents a new session can be opened for, in their desktop apps. */
export const NEW_SESSIONS: { agent: AgentKind; app: string }[] = [
  { agent: "claude", app: "Opens in the Claude app" },
  { agent: "codex", app: "Opens in the ChatGPT app" },
];

/** A session as the app names it: its title, else its agent. */
export const sessionName = (session: AgentSession) => session.title ?? `${agentLabel(session.agent)} session`;

/** A folder with the home folder shortened to `~`. */
const homeShort = (path: string) => path.replace(/^\/Users\/[^/]+/, "~");

/** Where a session runs, when that's not the worktree itself, and whether it's mid-turn. */
function sessionDetail(session: AgentSession): string | null {
  const parts = [
    !session.inWorktree && session.cwd && `in ${homeShort(session.cwd)}`,
    session.status === "busy" && "busy: gets them when its turn ends",
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

/** A review still going: asked for, or taken on but not finished. */
export const isUnderway = (request: ReviewRequest) => request.finishedAt === null;

/**
 * The worktree's sessions and what they haven't seen, with the one comments go to by default: the
 * first running session that isn't one asked to review (the one building the branch).
 */
export function useSessionRoles(worktree: Worktree) {
  const sessions = useSessions(worktree);
  const activity = useSessionActivity(worktree);
  const reviewers = new Set(activity.requests.map((r) => r.sessionId).filter(Boolean));
  const author = sessions.find((s) => s.reachable && !reviewers.has(s.id)) ?? null;
  return { sessions, activity, author, reviewers };
}

/** What `session` would be sent: what it hasn't seen, or every open comment for a new session. */
export const unseenBy = (activity: SessionActivity, session: AgentSession | null) =>
  session ? (activity.unseen[session.id] ?? []) : activity.open;

/** True for two seconds after the returned function is called, to confirm a send. */
export function useJustDone(): [boolean, () => void] {
  const [doneAt, setDoneAt] = useState(0);
  useEffect(() => {
    if (!doneAt) return;
    const timer = setTimeout(() => setDoneAt(0), 2000);
    return () => clearTimeout(timer);
  }, [doneAt]);
  return [doneAt > 0, () => setDoneAt(Date.now())];
}

/**
 * The toolbar's view of the agents: who's reviewing right now, and a button that sends the session
 * building the branch what it hasn't seen ("Send to Claude 3"). Comments are posted as they're
 * written; this only tells an agent there's something to read.
 */
export function SendToAgent({ worktree }: { worktree: Worktree }) {
  const { sessions, activity, author } = useSessionRoles(worktree);
  const send = useSendComments(worktree);
  const [justSent, markSent] = useJustDone();
  const count = unseenBy(activity, author).length;
  const reviewing = activity.requests.filter(isUnderway);

  return (
    <>
      {reviewing.length > 0 && <ReviewingChip requests={reviewing} sessions={sessions} />}
      {justSent ? (
        <Button disabled className="disabled:opacity-100">
          <Check className="size-3.5 text-add" />
          Sent
        </Button>
      ) : (
        count > 0 && (
          <SendControl
            sessions={sessions}
            author={author}
            primary
            count={count}
            busy={send.isPending}
            onSend={(to) => send.mutate({ to, threads: null }, { onSuccess: markSent })}
          />
        )
      )}
    </>
  );
}

/** "Codex is reviewing": opens the Sessions tab, where reviews are followed. */
function ReviewingChip({ requests, sessions }: { requests: ReviewRequest[]; sessions: AgentSession[] }) {
  const setFileTab = useStore((s) => s.setFileTab);
  const agents = [...new Set(requests.map((r) => r.agent))];
  const waiting = requests.every((r) => r.startedAt === null);
  const label =
    requests.length === 1 ? `${agentLabel(agents[0])} ${waiting ? "is starting" : "is reviewing"}` : `${requests.length} reviews`;
  return (
    <Tooltip
      label={
        <span className="flex max-w-80 flex-col gap-0.5">
          {requests.map((r) => {
            const session = sessions.find((s) => s.id === r.sessionId);
            return (
              <span key={r.id} className="truncate">
                {session ? sessionName(session) : `${agentLabel(r.agent)}, new session`} ·{" "}
                {r.startedAt === null ? `asked ${ago(r.requestedAt)}` : `${r.comments} so far`}
              </span>
            );
          })}
          <span className="text-fg-subtle">Show sessions</span>
        </span>
      }
    >
      <button
        type="button"
        onClick={() => setFileTab("sessions")}
        className="flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-[12px] text-fg-muted hover:bg-bg-hover hover:text-fg"
      >
        <LoaderCircle className="size-3.5 animate-spin text-mod" />
        {agents.length === 1 && <AgentIcon name={agents[0]} className="size-3.5" />}
        {label}
      </button>
    </Tooltip>
  );
}

/**
 * The send button. With a session building the branch it sends there ("Send to Claude"), and an
 * arrow beside it opens the other choices; otherwise the button itself opens them: the running
 * sessions by name, then a new Claude or Codex session.
 */
export function SendControl({
  sessions,
  author,
  primary,
  busy,
  count,
  onSend,
}: {
  sessions: AgentSession[];
  author: AgentSession | null;
  primary?: boolean;
  busy: boolean;
  count?: number;
  onSend: (to: SendTarget) => void;
}) {
  const reachable = sessions.filter((s) => s.reachable);
  const variant = primary ? "primary" : "ghost";
  const countBadge = count !== undefined && <Count value={count} inverted={primary} />;
  const menu = (trigger: ReactNode) => (
    <DropdownMenuPrimitive.Root>
      <DropdownMenuPrimitive.Trigger asChild>{trigger}</DropdownMenuPrimitive.Trigger>
      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.Content
          align="end"
          sideOffset={4}
          className="z-50 w-80 rounded-md border border-border bg-bg-raised p-1 text-[12.5px] text-fg-muted shadow-lg shadow-black/20"
        >
          {reachable.map((session) => (
            <MenuRow
              key={session.id}
              icon={session.agent}
              title={sessionName(session)}
              time={session.startedAt ? timeAgo(session.startedAt) : undefined}
              detail={sessionDetail(session)}
              onSelect={() => onSend({ session: session.id })}
            />
          ))}
          {reachable.length > 0 && <DropdownMenuPrimitive.Separator className="-mx-1 my-1 h-px bg-border" />}
          {NEW_SESSIONS.map(({ agent, app }) => (
            <MenuRow
              key={agent}
              icon={agent}
              title={`New ${agentLabel(agent)} session`}
              detail={app}
              onSelect={() => onSend({ newAgent: agent })}
            />
          ))}
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  );

  if (!author) {
    return menu(
      <Button variant={variant} disabled={busy}>
        <Send className="size-3.5" />
        {primary ? "Send to…" : "Send"}
        {countBadge}
        <ChevronDown className="size-3" />
      </Button>,
    );
  }
  return (
    <span className="flex shrink-0 items-center">
      <Tooltip
        label={
          <span className="flex max-w-80 flex-col">
            <span className="truncate">To “{sessionName(author)}”</span>
            {sessionDetail(author) && <span className="text-fg-subtle">{sessionDetail(author)}</span>}
          </span>
        }
      >
        <span>
          <Button variant={variant} disabled={busy} onClick={() => onSend({ session: author.id })} className="rounded-r-none">
            <Send className="size-3.5" />
            {primary ? `Send to ${agentLabel(author.agent)}` : "Send"}
            {countBadge}
          </Button>
        </span>
      </Tooltip>
      {menu(
        <Button
          variant={variant}
          disabled={busy}
          aria-label="Send to another session"
          className={cn("rounded-l-none px-1.5", primary && "border-l border-black/25")}
        >
          <ChevronDown className="size-3" />
        </Button>,
      )}
    </span>
  );
}

export function MenuRow({
  icon,
  title,
  time,
  detail,
  onSelect,
}: {
  icon: string;
  title: string;
  time?: string;
  detail?: string | null;
  onSelect: () => void;
}) {
  return (
    <DropdownMenuPrimitive.Item
      onSelect={onSelect}
      className="grid cursor-default grid-cols-[16px_1fr_auto] items-center gap-x-2 gap-y-0.5 rounded px-2 py-1.5 outline-none data-[highlighted]:bg-bg-hover data-[highlighted]:text-fg"
    >
      <AgentIcon name={icon} className="size-4" />
      <span title={title} className="truncate font-medium text-fg">
        {title}
      </span>
      <span className="tabular text-[11px] text-fg-faint">{time}</span>
      {detail && <span className="col-start-2 col-end-4 truncate text-[11.5px] text-fg-subtle">{detail}</span>}
    </DropdownMenuPrimitive.Item>
  );
}

function Count({ value, inverted }: { value: number; inverted?: boolean }) {
  return (
    <span
      className={cn(
        "tabular rounded-full px-1.5 text-[11px] leading-4",
        inverted ? "bg-black/20 text-primary-fg" : "bg-bg-active text-fg-muted",
      )}
    >
      {value}
    </span>
  );
}

/**
 * Sends one comment straight away: to the session building the branch, one picked by name, or a
 * new one. Shown while it has something that session hasn't seen; without such a session, while
 * the reviewer has the last word.
 */
export function SendThreadButton({ thread }: { thread: Thread | GeneralThread }) {
  const worktree = useContext(WorktreeContext);
  if (!worktree || thread.resolved) return null;
  return <SendThread worktree={worktree} thread={thread} />;
}

function SendThread({ worktree, thread }: { worktree: Worktree; thread: Thread | GeneralThread }) {
  const { sessions, activity, author } = useSessionRoles(worktree);
  const send = useSendComments(worktree);
  const last = thread.messages[thread.messages.length - 1];
  const due = author ? unseenBy(activity, author).includes(thread.id) : last?.author === "reviewer";
  if (!due) return null;
  return (
    <SendControl
      sessions={sessions}
      author={author}
      busy={send.isPending}
      onSend={(to) => send.mutate({ to, threads: [thread.id] })}
    />
  );
}
