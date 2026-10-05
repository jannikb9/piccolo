import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { ChevronDown, Send } from "lucide-react";
import { createContext, useContext, type ReactNode } from "react";
import { useSendComments, useSessionActivity, useSessions, type SendTarget } from "../lib/queries";
import { agentLabel, timeAgo } from "../lib/utils";
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

/** A session as the app names it: its title, else its agent. Piccolo's own runs are `acp-<request>`. */
export const sessionName = (session: AgentSession) =>
  session.title ?? (session.id.startsWith("acp-") ? `${agentLabel(session.agent)}, in the background` : `${agentLabel(session.agent)} session`);

/** A folder with the home folder shortened to `~`. */
const homeShort = (path: string) => path.replace(/^\/Users\/[^/]+/, "~");

/** Where a session runs, when that's not the worktree itself, and when it gets what's sent. */
function sessionDetail(session: AgentSession): string | null {
  const parts = [
    !session.inWorktree && session.cwd && `in ${homeShort(session.cwd)}`,
    session.status === "busy" && "busy: gets them when its turn ends",
    session.agent === "codex" && "queued: the chat takes them as its next message",
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

/**
 * A comment's send button. With a session building the branch it sends there, and an arrow beside
 * it opens the other choices; otherwise the button itself opens them: the running sessions by
 * name, then a new Claude or Codex session.
 */
function SendControl({
  sessions,
  author,
  busy,
  onSend,
}: {
  sessions: AgentSession[];
  author: AgentSession | null;
  busy: boolean;
  onSend: (to: SendTarget) => void;
}) {
  const reachable = sessions.filter((s) => s.reachable);
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
      <Button variant="ghost" disabled={busy}>
        <Send className="size-3.5" />
        Send
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
          <Button variant="ghost" disabled={busy} onClick={() => onSend({ session: author.id })} className="rounded-r-none">
            <Send className="size-3.5" />
            Send
          </Button>
        </span>
      </Tooltip>
      {menu(
        <Button variant="ghost" disabled={busy} aria-label="Send to another session" className="rounded-l-none px-1.5">
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
