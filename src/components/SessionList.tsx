import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { Check, ChevronDown, LoaderCircle, RotateCcw, Send, X } from "lucide-react";
import { useState } from "react";
import { useCancelReviewRequest, useRequestReview, useSendComments } from "../lib/queries";
import { agentLabel, ago, cn, timeAgo } from "../lib/utils";
import type { AgentKind, AgentSession, ReviewRequest, Worktree } from "../types";
import { AgentIcon } from "./AgentIcon";
import { isUnderway, MenuRow, NEW_SESSIONS, sessionName, unseenBy, useJustDone, useSessionRoles } from "./SendToAgent";
import { Button, IconButton, Tooltip } from "./ui";

/** Sessions shown in the tab's count: those that may still be running, and reviews waiting to start. */
export function useActiveSessionCount(worktree: Worktree): number {
  const { sessions, activity } = useSessionRoles(worktree);
  return sessions.filter((s) => s.running !== false).length + activity.requests.filter((r) => isUnderway(r) && !r.sessionId).length;
}

/**
 * The agents on a worktree, like the reviewers of a pull request: the session building the branch,
 * those asked to review it and how far they got, and sessions that ended. Reviews are requested
 * here, and comments sent to any session that can take them.
 */
export function SessionList({ worktree }: { worktree: Worktree }) {
  const { sessions, activity, author } = useSessionRoles(worktree);
  const [showEnded, setShowEnded] = useState(false);
  // A session's latest request; requests come newest first.
  const requestOf = (session: AgentSession) => activity.requests.find((r) => r.sessionId === session.id);
  const waiting = activity.requests.filter((r) => isUnderway(r) && !r.sessionId);
  const ended = sessions.filter((s) => s.running === false);
  const current = sessions.filter((s) => s.running !== false);
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

/** "Request review": a new Claude or Codex session, or a running session asked by name. */
function RequestReview({ worktree, sessions }: { worktree: Worktree; sessions: AgentSession[] }) {
  const request = useRequestReview(worktree);
  const [justAsked, markAsked] = useJustDone();
  const ask = (to: { session: string } | { agent: AgentKind }) => request.mutate(to, { onSuccess: markAsked });
  const reachable = sessions.filter((s) => s.reachable);
  return (
    <DropdownMenuPrimitive.Root>
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
          {reachable.length > 0 && (
            <>
              <DropdownMenuPrimitive.Separator className="-mx-1 my-1 h-px bg-border" />
              <DropdownMenuPrimitive.Label className="px-2 pt-1 pb-0.5 text-[11px] text-fg-faint">Ask a running session</DropdownMenuPrimitive.Label>
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
function describe(session: AgentSession, request: ReviewRequest | undefined, isAuthor: boolean): { text: string; busy: boolean } {
  const comments = (n: number) => (n === 1 ? "1 comment" : `${n} comments`);
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
  const { text, busy } = describe(session, request, isAuthor);
  const underway = !!request && isUnderway(request);

  return (
    <li className={cn("group flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-bg-hover", session.running === false && "opacity-60 hover:opacity-100")}>
      <StatusIcon agent={session.agent} state={busy ? "busy" : session.running ? "running" : "idle"} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span title={sessionName(session)} className="truncate text-[12.5px] font-medium text-fg">
          {sessionName(session)}
        </span>
        <span className="truncate text-[11.5px] text-fg-subtle">{text}</span>
      </span>
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
      {request && !underway && session.reachable && (
        <IconButton label="Ask for another review" disabled={ask.isPending} onClick={() => ask.mutate({ session: session.id })} className="size-7">
          <RotateCcw className="size-3.5" />
        </IconButton>
      )}
      {underway && (
        <IconButton label="Stop waiting for this review" onClick={() => cancel.mutate(request.id)} className="size-7 opacity-0 group-hover:opacity-100">
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
