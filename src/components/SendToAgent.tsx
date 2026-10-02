import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { Check, ChevronDown, Send } from "lucide-react";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useSendComments, useSessions } from "../lib/queries";
import { agentLabel, cn, timeAgo } from "../lib/utils";
import type { AgentSession, Thread, Worktree } from "../types";
import { AgentIcon } from "./AgentIcon";
import { Button, Tooltip } from "./ui";

/** The worktree the diff shows, for comment cards the diff library draws. */
export const WorktreeContext = createContext<Worktree | null>(null);

/** A session as the app names it: its title, else when it started. */
const sessionName = (session: AgentSession) =>
  session.title ?? `${agentLabel(session.agent)} session started ${timeAgo(session.startedAt)} ago`;

/** A folder with the home folder shortened to `~`. */
const homeShort = (path: string) => path.replace(/^\/Users\/[^/]+/, "~");

/** Where a session runs, when that's not the worktree itself, and whether it's mid-turn. */
function sessionDetail(session: AgentSession): string | null {
  const parts = [
    !session.inWorktree && `in ${homeShort(session.cwd)}`,
    session.status === "busy" && "busy: gets them when its turn ends",
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

/** True for two seconds after the returned function is called, to confirm a send. */
function useJustSent(): [boolean, () => void] {
  const [sentAt, setSentAt] = useState(0);
  useEffect(() => {
    if (!sentAt) return;
    const timer = setTimeout(() => setSentAt(0), 2000);
    return () => clearTimeout(timer);
  }, [sentAt]);
  return [sentAt > 0, () => setSentAt(Date.now())];
}

/**
 * Sends the comments written since the last send to a Claude Code session working on the worktree,
 * like submitting a review on GitHub: "Send to Claude" with one session, "Send to…" and the
 * sessions by name with several.
 */
export function SendToAgent({ worktree, threads }: { worktree: Worktree; threads: Thread[] }) {
  const sessions = useSessions(worktree);
  const send = useSendComments(worktree);
  const [justSent, markSent] = useJustSent();
  const pending = threads.filter((t) => t.pending).length;
  const sendTo = (session: AgentSession) => send.mutate({ session: session.id, threads: null }, { onSuccess: markSent });

  if (sessions.length === 0) {
    if (pending === 0) return null;
    return (
      <Tooltip label="No Claude session is working in this worktree. Open one there to send it comments.">
        <span>
          <Button disabled>
            <Send className="size-3.5" />
            Send
            <Count value={pending} />
          </Button>
        </span>
      </Tooltip>
    );
  }
  if (justSent) {
    return (
      <Button disabled className="disabled:opacity-100">
        <Check className="size-3.5 text-add" />
        Sent
      </Button>
    );
  }
  if (pending === 0) {
    return (
      <Tooltip label={<ConnectedList sessions={sessions} />}>
        <span className="flex h-7 items-center gap-1.5 px-2 text-[12px] text-fg-subtle">
          <AgentIcon name={sessions[0].agent} className="size-3.5" />
          {sessions.length === 1 ? agentLabel(sessions[0].agent) : `${sessions.length} sessions`}
        </span>
      </Tooltip>
    );
  }
  return (
    <SessionChoice sessions={sessions} onChoose={sendTo}>
      {(only, onClick) => (
        <Button variant="primary" disabled={send.isPending} onClick={onClick}>
          <Send className="size-3.5" />
          {only ? `Send to ${agentLabel(only.agent)}` : "Send to…"}
          <Count value={pending} inverted />
          {!only && <ChevronDown className="size-3" />}
        </Button>
      )}
    </SessionChoice>
  );
}

function ConnectedList({ sessions }: { sessions: AgentSession[] }) {
  return (
    <div className="flex max-w-80 flex-col gap-1">
      <span>Comments you send can go to:</span>
      {sessions.map((s) => (
        <span key={s.id} className="flex items-center gap-1.5 text-fg">
          <AgentIcon name={s.agent} className="size-3.5" />
          <span className="truncate">{sessionName(s)}</span>
        </span>
      ))}
    </div>
  );
}

/**
 * The button `children` draws: with one session it sends there (`only` is that session, `onClick`
 * sends, and a tooltip names it); with several it opens a menu of their names.
 */
function SessionChoice({
  sessions,
  onChoose,
  children,
}: {
  sessions: AgentSession[];
  onChoose: (session: AgentSession) => void;
  children: (only: AgentSession | null, onClick?: () => void) => ReactNode;
}) {
  if (sessions.length === 1) {
    const only = sessions[0];
    return (
      <Tooltip
        label={
          <span className="flex max-w-80 flex-col">
            <span className="truncate">To “{sessionName(only)}”</span>
            {sessionDetail(only) && <span className="text-fg-subtle">{sessionDetail(only)}</span>}
          </span>
        }
      >
        <span>{children(only, () => onChoose(only))}</span>
      </Tooltip>
    );
  }
  return (
    <DropdownMenuPrimitive.Root>
      <DropdownMenuPrimitive.Trigger asChild>{children(null)}</DropdownMenuPrimitive.Trigger>
      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.Content
          align="end"
          sideOffset={4}
          className="z-50 w-80 rounded-md border border-border bg-bg-raised p-1 text-[12.5px] text-fg-muted shadow-lg shadow-black/20"
        >
          {sessions.map((session) => (
            <DropdownMenuPrimitive.Item
              key={session.id}
              onSelect={() => onChoose(session)}
              className="grid cursor-default grid-cols-[16px_1fr_auto] items-center gap-x-2 gap-y-0.5 rounded px-2 py-1.5 outline-none data-[highlighted]:bg-bg-hover data-[highlighted]:text-fg"
            >
              <AgentIcon name={session.agent} className="size-4" />
              <span title={sessionName(session)} className="truncate font-medium text-fg">
                {sessionName(session)}
              </span>
              <span className="tabular text-[11px] text-fg-faint">{timeAgo(session.startedAt)}</span>
              {sessionDetail(session) && (
                <span className="col-start-2 col-end-4 truncate text-[11.5px] text-fg-subtle">{sessionDetail(session)}</span>
              )}
            </DropdownMenuPrimitive.Item>
          ))}
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
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

/** Sends one comment straight away: to the session, or one picked by name when there are several. */
export function SendThreadButton({ thread }: { thread: Thread }) {
  const worktree = useContext(WorktreeContext);
  if (!worktree || !thread.pending) return null;
  return <SendThread worktree={worktree} thread={thread} />;
}

function SendThread({ worktree, thread }: { worktree: Worktree; thread: Thread }) {
  const sessions = useSessions(worktree);
  const send = useSendComments(worktree);
  if (sessions.length === 0) return null;
  return (
    <SessionChoice sessions={sessions} onChoose={(session) => send.mutate({ session: session.id, threads: [thread.id] })}>
      {(only, onClick) => (
        <Button disabled={send.isPending} onClick={onClick}>
          <Send className="size-3.5" />
          {only ? "Send" : "Send to…"}
        </Button>
      )}
    </SessionChoice>
  );
}
