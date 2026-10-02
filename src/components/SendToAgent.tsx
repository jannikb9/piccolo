import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { Check, ChevronDown, Send } from "lucide-react";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useSendComments, useSessions, type SendTarget } from "../lib/queries";
import { agentLabel, cn, timeAgo } from "../lib/utils";
import type { AgentKind, AgentSession, Thread, Worktree } from "../types";
import { AgentIcon } from "./AgentIcon";
import { Button, Tooltip } from "./ui";

/** The worktree the diff shows, for comment cards the diff library draws. */
export const WorktreeContext = createContext<Worktree | null>(null);

/** Agents a new session can be opened for, in their desktop apps. */
const NEW_SESSIONS: { agent: AgentKind; app: string }[] = [
  { agent: "claude", app: "Opens in the Claude app" },
  { agent: "codex", app: "Opens in the ChatGPT app" },
];

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
 * Sends the comments written since the last send to an agent, like submitting a review on GitHub:
 * to the Claude Code session working on the worktree ("Send to Claude"), one of several by name,
 * or a new Claude or Codex session.
 */
export function SendToAgent({ worktree, threads }: { worktree: Worktree; threads: Thread[] }) {
  const sessions = useSessions(worktree);
  const send = useSendComments(worktree);
  const [justSent, markSent] = useJustSent();
  const pending = threads.filter((t) => t.pending).length;

  if (justSent) {
    return (
      <Button disabled className="disabled:opacity-100">
        <Check className="size-3.5 text-add" />
        Sent
      </Button>
    );
  }
  if (pending === 0) {
    if (sessions.length === 0) return null;
    return (
      <Tooltip label={<SessionList sessions={sessions} />}>
        <span className="flex h-7 items-center gap-1.5 px-2 text-[12px] text-fg-subtle">
          <AgentIcon name={sessions[0].agent} className="size-3.5" />
          {sessions.length === 1 ? agentLabel(sessions[0].agent) : `${sessions.length} sessions`}
        </span>
      </Tooltip>
    );
  }
  return (
    <SendControl
      sessions={sessions}
      primary
      busy={send.isPending}
      count={pending}
      onSend={(to) => send.mutate({ to, threads: null }, { onSuccess: markSent })}
    />
  );
}

function SessionList({ sessions }: { sessions: AgentSession[] }) {
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
 * The send button. With one session working on the worktree it sends there ("Send to Claude"),
 * and an arrow beside it opens the other choices; otherwise the button itself opens them: the
 * sessions by name, then a new Claude or Codex session.
 */
function SendControl({
  sessions,
  primary,
  busy,
  count,
  onSend,
}: {
  sessions: AgentSession[];
  primary?: boolean;
  busy: boolean;
  count?: number;
  onSend: (to: SendTarget) => void;
}) {
  const only = sessions.length === 1 ? sessions[0] : null;
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
          {sessions.map((session) => (
            <MenuRow
              key={session.id}
              icon={session.agent}
              title={sessionName(session)}
              time={timeAgo(session.startedAt)}
              detail={sessionDetail(session)}
              onSelect={() => onSend({ session: session.id })}
            />
          ))}
          {sessions.length > 0 && <DropdownMenuPrimitive.Separator className="-mx-1 my-1 h-px bg-border" />}
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

  if (!only) {
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
    <span className="flex items-center">
      <Tooltip
        label={
          <span className="flex max-w-80 flex-col">
            <span className="truncate">To “{sessionName(only)}”</span>
            {sessionDetail(only) && <span className="text-fg-subtle">{sessionDetail(only)}</span>}
          </span>
        }
      >
        <span>
          <Button variant={variant} disabled={busy} onClick={() => onSend({ session: only.id })} className="rounded-r-none">
            <Send className="size-3.5" />
            {primary ? `Send to ${agentLabel(only.agent)}` : "Send"}
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

function MenuRow({
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

/** Sends one comment straight away: to the session, one picked by name, or a new one. */
export function SendThreadButton({ thread }: { thread: Thread }) {
  const worktree = useContext(WorktreeContext);
  if (!worktree || !thread.pending) return null;
  return <SendThread worktree={worktree} thread={thread} />;
}

function SendThread({ worktree, thread }: { worktree: Worktree; thread: Thread }) {
  const sessions = useSessions(worktree);
  const send = useSendComments(worktree);
  return (
    <SendControl sessions={sessions} busy={send.isPending} onSend={(to) => send.mutate({ to, threads: [thread.id] })} />
  );
}
