import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import * as Popover from "@radix-ui/react-popover";
import { Check, ChevronDown, FileText, LoaderCircle, Plus, RotateCcw, Send, X } from "lucide-react";
import { createContext, useContext, useEffect, useRef, useState, type CSSProperties } from "react";
import { api, showError } from "../lib/api";
import { useCancelReviewRequest, useInstalledAgents, useRequestReview, useSendComments } from "../lib/queries";
import { agentLabel, ago, cn, timeAgo } from "../lib/utils";
import type { AgentSession, ReviewRequest, Worktree } from "../types";
import { AgentIcon } from "./AgentIcon";
import { isUnderway, MenuRow, NEW_SESSIONS, sessionName, unseenBy, useSessionRoles } from "./SendToAgent";
import { Button, IconButton, Tooltip, useJustDone } from "./ui";

/** A review that finished in the last hour stays in view, even when its session ended. */
const RECENT_MS = 60 * 60 * 1000;

/**
 * The worktree's sessions split as the list shows them: reviews asked of sessions that haven't
 * started, sessions still around (running, reviewing or just done), and those that ended.
 */
function useSessionGroups(worktree: Worktree) {
  const roles = useSessionRoles(worktree);
  const { sessions, activity } = roles;
  // A session's latest request; requests come newest first.
  const requestOf = (session: AgentSession) => activity.requests.find((r) => r.sessionId === session.id);
  const waiting = activity.requests.filter((r) => isUnderway(r) && !r.sessionId);
  const isCurrent = (session: AgentSession) => {
    const request = requestOf(session);
    return session.running !== false || (!!request && (isUnderway(request) || request.finishedAt! > Date.now() - RECENT_MS));
  };
  return { ...roles, requestOf, waiting, current: sessions.filter(isCurrent), ended: sessions.filter((s) => !isCurrent(s)) };
}

type AgentState = "running" | "busy" | "idle";

/**
 * For a menu inside the hover popover: a menu that closes under the pointer leaves it outside the
 * popover without a pointer-leave event, so the popover checks where the pointer goes next.
 */
const MenuClosed = createContext<() => void>(() => {});

/**
 * The toolbar's agents, like a pull request's reviewers: one overlapping mark per agent on the
 * branch, which fan out on hover while a popover lists every session and what it's doing.
 */
export function AgentsButton({ worktree }: { worktree: Worktree }) {
  const { current, waiting, requestOf } = useSessionGroups(worktree);
  const [open, setOpen] = useState(false);
  // Opened by a click, it stays until dismissed; opened by hovering, until the pointer leaves.
  const [pinned, setPinned] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const hover = (show: boolean) => {
    clearTimeout(timer.current);
    if (pinned) return;
    timer.current = setTimeout(() => setOpen(show), show ? 120 : 200);
  };
  const close = () => {
    clearTimeout(timer.current);
    setOpen(false);
    setPinned(false);
  };
  const triggerRef = useRef<HTMLButtonElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const menuClosed = () => {
    const onMove = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!triggerRef.current?.contains(target) && !contentRef.current?.contains(target)) hover(false);
    };
    document.addEventListener("pointermove", onMove, { once: true });
  };

  // One mark per agent, in list order, busy when any of its sessions is.
  const agents = new Map<string, AgentState>();
  const mark = (agent: string, state: AgentState) => {
    const was = agents.get(agent);
    if (was !== "busy" && (state !== "idle" || !was)) agents.set(agent, state);
  };
  for (const request of waiting) mark(request.agent, "busy");
  for (const session of current) {
    const request = requestOf(session);
    const busy = session.status === "busy" || (!!request && isUnderway(request));
    mark(session.agent, busy ? "busy" : session.running ? "running" : "idle");
  }
  const marks = [...agents];

  const reviewing = [...waiting, ...current.map(requestOf).filter((r): r is ReviewRequest => !!r && isUnderway(r))];
  const reviewers = [...new Set(reviewing.map((r) => r.agent))];
  const label =
    reviewing.length === 0
      ? null
      : reviewing.length > 1
        ? `${reviewing.length} reviews`
        : `${agentLabel(reviewers[0])} ${reviewing[0].startedAt === null ? "is starting" : "is reviewing"}`;

  // Room for the marks fanned out, so the toolbar doesn't shift as they spread; collapsed, they sit
  // at its right end.
  const size = 24;
  const spread = 4;
  const overlap = -9;
  const width = marks.length === 0 ? size : marks.length * size + (marks.length - 1) * spread;

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        if (next) setOpen(true);
        else close();
      }}
    >
      <Popover.Trigger asChild>
        <button
          ref={triggerRef}
          type="button"
          aria-label="Agents on this branch"
          onPointerEnter={() => hover(true)}
          onPointerLeave={() => hover(false)}
          onClick={(e) => {
            // Radix would toggle; a click on a popover opened by hovering keeps it open instead.
            e.preventDefault();
            clearTimeout(timer.current);
            if (open && pinned) close();
            else {
              setOpen(true);
              setPinned(true);
            }
          }}
          className="group/agents flex h-7 shrink-0 items-center gap-2 rounded-md px-1 text-[12px] text-fg-muted hover:text-fg data-[state=open]:text-fg"
        >
          <span className="flex justify-end" style={{ width }}>
            {marks.length === 0 ? (
              <span className="grid size-6 place-items-center rounded-full border border-dashed border-border-strong text-fg-subtle group-hover/agents:text-fg-muted">
                <Plus className="size-3.5" />
              </span>
            ) : (
              marks.map(([agent, state], i) => (
                <span
                  key={agent}
                  style={{ zIndex: marks.length - i, "--overlap": `${overlap}px`, "--spread": `${spread}px` } as CSSProperties}
                  className={cn(
                    "relative grid size-6 shrink-0 place-items-center rounded-full bg-bg-raised ring-2 ring-bg transition-[margin] duration-200 ease-out",
                    i > 0 && "ml-[var(--overlap)] group-hover/agents:ml-[var(--spread)] group-data-[state=open]/agents:ml-[var(--spread)]",
                  )}
                >
                  <span className="absolute inset-0 rounded-full border border-border" />
                  <AgentIcon name={agent} className="size-3.5" />
                  <StateBadge state={state} />
                </span>
              ))
            )}
          </span>
          {/* In a narrow toolbar the branch name needs the room; the spinner still shows the review. */}
          {label && <span className="hidden whitespace-nowrap @5xl:inline">{label}</span>}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          ref={contentRef}
          align="end"
          sideOffset={6}
          onPointerEnter={() => hover(true)}
          onPointerLeave={() => hover(false)}
          // Hovering mustn't take focus from the diff; a click lets the popover keep it.
          onOpenAutoFocus={(e) => !pinned && e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
          className="z-40 max-h-[min(560px,calc(100vh-80px))] w-[360px] max-w-[calc(100vw-32px)] overflow-y-auto rounded-lg border border-border bg-bg-raised p-2 shadow-xl shadow-black/30"
        >
          <MenuClosed.Provider value={menuClosed}>
            <SessionList worktree={worktree} />
          </MenuClosed.Provider>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** A dot on an agent's mark for its state: green running, a spinner while busy or reviewing. */
function StateBadge({ state }: { state: AgentState }) {
  if (state === "busy") return <LoaderCircle className="absolute -right-1 -bottom-1 size-3 animate-spin rounded-full bg-bg text-mod" />;
  if (state === "running") return <span className="absolute -right-0.5 -bottom-0.5 size-2 rounded-full bg-add ring-2 ring-bg" />;
  return null;
}

/**
 * The agents on a worktree, like the reviewers of a pull request: the session building the branch,
 * those asked to review it and how far they got, and sessions that ended. Reviews are requested
 * here, and comments sent to any session that can take them.
 */
export function SessionList({ worktree }: { worktree: Worktree }) {
  const { sessions, activity, author, requestOf, waiting, current, ended } = useSessionGroups(worktree);
  const [showEnded, setShowEnded] = useState(false);
  const row = (session: AgentSession) => (
    <SessionRow
      key={session.id}
      worktree={worktree}
      session={session}
      request={requestOf(session)}
      unseen={unseenBy(activity, session).length}
      isAuthor={session.id === author?.id}
    />
  );

  return (
    <div className="flex flex-col gap-2">
      <RequestReview worktree={worktree} sessions={sessions} />
      {waiting.length + current.length === 0 ? (
        <p className="px-2 py-6 text-center text-[12px] leading-5 text-fg-subtle">
          No agent is working on this branch.
          <br />
          Sessions appear here once they run in the worktree or use <code className="font-mono">piccolo</code> on it.
        </p>
      ) : (
        <ul className="flex flex-col">
          {waiting.map((request) => (
            <WaitingRow key={request.id} request={request} />
          ))}
          {current.map(row)}
        </ul>
      )}
      {ended.length > 0 && (
        <>
          <button
            type="button"
            onClick={() => setShowEnded(!showEnded)}
            className="mx-auto h-7 rounded-md px-2 text-[12px] text-fg-subtle hover:bg-bg-hover hover:text-fg-muted"
          >
            {showEnded ? "Hide ended" : `Show ${ended.length} ended`}
          </button>
          {showEnded && <ul className="flex flex-col">{ended.map(row)}</ul>}
        </>
      )}
    </div>
  );
}

/**
 * "Request review": a new Claude or Codex session in its app, an installed ACP agent in the
 * background, or a running session asked by name.
 */
function RequestReview({ worktree, sessions }: { worktree: Worktree; sessions: AgentSession[] }) {
  const request = useRequestReview(worktree);
  const agents = useInstalledAgents();
  const [justAsked, markAsked] = useJustDone();
  const ask = (to: { session: string } | { agent: string }) => request.mutate(to, { onSuccess: markAsked });
  const reachable = sessions.filter((s) => s.reachable);
  const menuClosed = useContext(MenuClosed);
  const label = (text: string) => (
    <DropdownMenuPrimitive.Label className="px-2 pt-1 pb-0.5 text-[11px] text-fg-faint">{text}</DropdownMenuPrimitive.Label>
  );
  return (
    // Not modal: it opens from a hover popover, which a modal menu would make lose the pointer.
    <DropdownMenuPrimitive.Root modal={false} onOpenChange={(open) => !open && menuClosed()}>
      <DropdownMenuPrimitive.Trigger asChild>
        <Button variant="primary" disabled={request.isPending || justAsked} className="w-full justify-center disabled:opacity-100">
          {justAsked ? <Check className="size-3.5" /> : null}
          {justAsked ? "Review requested" : "Request review"}
          {!justAsked && <ChevronDown className="size-3" />}
        </Button>
      </DropdownMenuPrimitive.Trigger>
      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.Content
          align="start"
          sideOffset={4}
          className="z-50 w-80 rounded-md border border-border bg-bg-raised p-1 text-[12.5px] text-fg-muted shadow-lg shadow-black/20"
        >
          {NEW_SESSIONS.map(({ agent, app }) => (
            <MenuRow
              key={agent}
              icon={agent}
              title={`New ${agentLabel(agent)} session`}
              detail={app}
              onSelect={() => ask({ agent })}
            />
          ))}
          <DropdownMenuPrimitive.Separator className="-mx-1 my-1 h-px bg-border" />
          {label("In the background")}
          {agents.length === 0 ? (
            <p className="px-2 pb-1.5 text-[11.5px] leading-4 text-fg-subtle">
              Install Gemini CLI, Qwen Code, OpenCode or another agent that speaks ACP to have it review here, in the background.
            </p>
          ) : (
            agents.map((agent) => (
              <MenuRow
                key={agent.id}
                icon={agent.author}
                title={agent.name}
                detail="With your own sign-in · can't change files"
                onSelect={() => ask({ agent: agent.id })}
              />
            ))
          )}
          {reachable.length > 0 && (
            <>
              <DropdownMenuPrimitive.Separator className="-mx-1 my-1 h-px bg-border" />
              {label("Ask a running session")}
              {reachable.map((session) => (
                <MenuRow
                  key={session.id}
                  icon={session.agent}
                  title={sessionName(session)}
                  time={session.startedAt ? timeAgo(session.startedAt) : undefined}
                  onSelect={() => ask({ session: session.id })}
                />
              ))}
            </>
          )}
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  );
}

/** What a session is doing, as its row's second line says it. */
function describe(
  session: AgentSession,
  request: ReviewRequest | undefined,
  isAuthor: boolean,
): { text: string; busy: boolean; failed?: boolean } {
  const comments = (n: number) => (n === 1 ? "1 comment" : `${n} comments`);
  if (request?.error) {
    return { text: request.error === "Stopped" ? `Stopped ${ago(request.finishedAt ?? request.requestedAt)}` : request.error, busy: false, failed: request.error !== "Stopped" };
  }
  if (request && request.startedAt === null && isUnderway(request)) {
    return { text: `Review requested ${ago(request.requestedAt)}`, busy: true };
  }
  if (request && isUnderway(request)) {
    return { text: `Reviewing · ${comments(request.comments)} so far`, busy: true };
  }
  if (request?.finishedAt) {
    return { text: `Reviewed ${ago(request.finishedAt)} · ${comments(request.comments)}`, busy: false };
  }
  if (session.running === false) {
    return { text: session.lastSeen ? `Ended · last active ${ago(session.lastSeen)}` : "Ended", busy: false };
  }
  if (session.running) {
    const where = session.inWorktree ? "" : " · above the worktree";
    return { text: `${session.status === "busy" ? "Working" : "Idle"}${isAuthor ? " · gets comments" : ""}${where}`, busy: session.status === "busy" };
  }
  return { text: session.lastSeen ? `Last active ${ago(session.lastSeen)}` : "Not seen yet", busy: false };
}

function SessionRow({
  worktree,
  session,
  request,
  unseen,
  isAuthor,
}: {
  worktree: Worktree;
  session: AgentSession;
  request: ReviewRequest | undefined;
  unseen: number;
  isAuthor: boolean;
}) {
  const send = useSendComments(worktree);
  const ask = useRequestReview(worktree);
  const cancel = useCancelReviewRequest();
  const [justSent, markSent] = useJustDone();
  const { text, busy, failed } = describe(session, request, isAuthor);
  const underway = !!request && isUnderway(request);
  // A review Piccolo ran is asked again with a new run of the same agent.
  const rerun = useInstalledAgents().find((a) => session.id.startsWith("acp-") && a.author === session.agent);

  return (
    <li className={cn("group flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-bg-hover", session.running === false && "opacity-60 hover:opacity-100")}>
      <StatusIcon agent={session.agent} state={busy ? "busy" : session.running ? "running" : "idle"} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span title={sessionName(session)} className="truncate text-[12.5px] font-medium text-fg">
          {sessionName(session)}
        </span>
        <span title={text} className={cn("text-[11.5px]", failed ? "line-clamp-3 text-del" : "truncate text-fg-subtle")}>
          {text}
        </span>
      </span>
      {request?.log && (
        <IconButton
          label="Show what the agent did"
          onClick={() => api.openReviewLog(request.id).catch((e) => showError("Couldn't open the log", String(e)))}
          className="size-7 opacity-0 group-hover:opacity-100"
        >
          <FileText className="size-3.5" />
        </IconButton>
      )}
      {session.reachable && (unseen > 0 || justSent) && (
        <Tooltip label={`Send it the ${unseen === 1 ? "comment" : `${unseen} comments`} it hasn't seen`}>
          <span>
            <Button
              aria-label={`Send ${unseen === 1 ? "1 comment" : `${unseen} comments`}`}
              disabled={send.isPending || justSent}
              onClick={() => send.mutate({ to: { session: session.id }, threads: null }, { onSuccess: markSent })}
              className="px-2"
            >
              {justSent ? <Check className="size-3.5 text-add" /> : <Send className="size-3.5" />}
              {!justSent && <span className="tabular">{unseen}</span>}
            </Button>
          </span>
        </Tooltip>
      )}
      {request && !underway && (session.reachable || rerun) && (
        <IconButton
          label="Ask for another review"
          disabled={ask.isPending}
          onClick={() => ask.mutate(rerun ? { agent: rerun.id } : { session: session.id })}
          className="size-7"
        >
          <RotateCcw className="size-3.5" />
        </IconButton>
      )}
      {underway && (
        <IconButton
          label={request.log ? "Stop the review" : "Stop waiting for this review"}
          onClick={() => cancel.mutate(request.id)}
          className="size-7 opacity-0 group-hover:opacity-100"
        >
          <X className="size-3.5" />
        </IconButton>
      )}
    </li>
  );
}

/** A review asked of a new session that hasn't started on it yet. */
function WaitingRow({ request }: { request: ReviewRequest }) {
  const cancel = useCancelReviewRequest();
  return (
    <li className="group flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-bg-hover">
      <StatusIcon agent={request.agent} state="busy" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[12.5px] font-medium text-fg">New {agentLabel(request.agent)} session</span>
        <span className="truncate text-[11.5px] text-fg-subtle">Review requested {ago(request.requestedAt)} · waiting to start</span>
      </span>
      <IconButton label="Withdraw the request" onClick={() => cancel.mutate(request.id)} className="size-7 opacity-0 group-hover:opacity-100">
        <X className="size-3.5" />
      </IconButton>
    </li>
  );
}

/** The agent's mark with a dot for its state: green running, amber busy or reviewing, none otherwise. */
function StatusIcon({ agent, state }: { agent: string; state: "running" | "busy" | "idle" }) {
  return (
    <span className="relative grid size-6 shrink-0 place-items-center rounded-md border border-border-subtle bg-bg-raised">
      <AgentIcon name={agent} className="size-3.5" />
      {state === "busy" ? (
        <LoaderCircle className="absolute -right-1 -bottom-1 size-3 animate-spin rounded-full bg-bg text-mod" />
      ) : (
        state === "running" && <span className="absolute -right-0.5 -bottom-0.5 size-2 rounded-full bg-add ring-2 ring-bg" />
      )}
    </span>
  );
}
