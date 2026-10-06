import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import * as Popover from "@radix-ui/react-popover";
import { Check, Copy, LoaderCircle, Plus, X } from "lucide-react";
import { createContext, useContext, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  useAvailableAgents,
  useCancelReviewRequest,
  useCopyAgentCommand,
  useRequestReview,
  useSendComments,
  useSessionActivity,
  useSessions,
  useTerminalSetup,
} from "../lib/queries";
import { opensIn } from "../lib/terminals";
import { agentLabel, ago, cn } from "../lib/utils";
import { useStore } from "../store";
import type { AgentKind, AgentSession, ReviewRequest, SessionActivity, Worktree } from "../types";
import { AgentIcon } from "./AgentIcon";
import { Button, IconButton, Tooltip, useJustDone } from "./ui";

/**
 * Keeps the hover popover open: a menu opened from it lies outside it, so leaving the popover for
 * the menu mustn't close it.
 */
const PinPanel = createContext<() => void>(() => {});

/** A session as the app names it: its title, else its agent. */
const sessionName = (session: AgentSession) => session.title ?? `${agentLabel(session.agent)} session`;

/** A request still going: asked, or taken on but not finished. */
const isUnderway = (request: ReviewRequest) => request.finishedAt === null;

/** What `session` would be sent to address: what it hasn't seen, or every open comment for a new session. */
const unseenBy = (activity: SessionActivity, session: AgentSession | null) =>
  session ? (activity.unseen[session.id] ?? []) : activity.open;

const plural = (count: number, one: string) => `${count} ${one}${count === 1 ? "" : "s"}`;

/** Who started `threads`, e.g. "3 by you · 2 by Codex". */
function startedBy(threads: number[], activity: SessionActivity) {
  const counts = new Map<string | null, number>();
  for (const id of threads) {
    const by = activity.startedBy[id] ?? null;
    counts.set(by, (counts.get(by) ?? 0) + 1);
  }
  return [...counts]
    .sort(([a], [b]) => (a === null ? -1 : b === null ? 1 : a.localeCompare(b)))
    .map(([by, count]) => `${count} by ${by === null ? "you" : agentLabel(by)}`)
    .join(" · ");
}

/** A request that finished in the last hour stays in view, even when its session ended. */
const RECENT_MS = 60 * 60 * 1000;

/**
 * The agents on a worktree: requests to new sessions that haven't started, and sessions still
 * around (running, at work or just done); those that ended are left out. Any of them can review the
 * branch or address its comments; what each is doing comes from its latest request.
 */
function useAgents(worktree: Worktree) {
  const sessions = useSessions(worktree);
  const activity = useSessionActivity(worktree);
  // A session's latest request; requests come newest first.
  const requestOf = (session: AgentSession) => activity.requests.find((r) => r.sessionId === session.id);
  const waiting = activity.requests.filter((r) => isUnderway(r) && !r.sessionId);
  const isCurrent = (session: AgentSession) => {
    const request = requestOf(session);
    return session.running !== false || (!!request && (isUnderway(request) || request.finishedAt! > Date.now() - RECENT_MS));
  };
  return { activity, requestOf, waiting, current: sessions.filter(isCurrent) };
}

type AgentState = "running" | "busy" | "idle";

/** A session's state: busy while a turn or a request runs, else running or not. */
function stateOf(session: AgentSession, request: ReviewRequest | undefined): AgentState {
  if (session.status === "busy" || (!!request && isUnderway(request))) return "busy";
  return session.running ? "running" : "idle";
}

/** What an agent is doing about a request, e.g. "is reviewing". */
const doing = (request: ReviewRequest) =>
  request.startedAt === null ? "is starting" : request.kind === "review" ? "is reviewing" : "is addressing comments";

/**
 * The toolbar's agents, like a pull request's reviewers: one overlapping mark per agent on the
 * branch, which fan out on hover, and a "+" ("Add agent" while there are none). Both open the
 * panel listing the agents, where any can be asked to review or to address the comments.
 */
export function AgentsButton({ worktree }: { worktree: Worktree }) {
  const { current, waiting, requestOf } = useAgents(worktree);
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
  const contentRef = useRef<HTMLDivElement>(null);

  // One mark per agent, in list order, busy when any of its sessions is.
  const agents = new Map<string, AgentState>();
  const mark = (agent: string, state: AgentState) => {
    const was = agents.get(agent);
    if (was !== "busy" && (state !== "idle" || !was)) agents.set(agent, state);
  };
  for (const request of waiting) mark(request.agent, "busy");
  for (const session of current) mark(session.agent, stateOf(session, requestOf(session)));
  const marks = [...agents];
  const empty = marks.length === 0;

  const underway = [...waiting, ...current.map(requestOf).filter((r): r is ReviewRequest => !!r && isUnderway(r))];
  const label =
    underway.length === 0
      ? null
      : underway.length > 1
        ? `${underway.length} agents at work`
        : `${agentLabel(underway[0].agent)} ${doing(underway[0])}`;

  // Room for the marks fanned out, so the toolbar doesn't shift as they spread; collapsed, they sit
  // at its right end.
  const size = 24;
  const spread = 4;
  const overlap = -9;
  const width = marks.length * size + (marks.length - 1) * spread;

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
          type="button"
          aria-label={empty ? "Add agent" : "Agents on this branch"}
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
          {!empty && (
            <span className="flex justify-end" style={{ width }}>
              {marks.map(([agent, state], i) => (
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
              ))}
            </span>
          )}
          {/* In a narrow toolbar the branch name needs the room; the spinner still shows the work. */}
          {label && <span className="hidden whitespace-nowrap @5xl:inline">{label}</span>}
          <span
            className={cn(
              "flex h-6 min-w-6 shrink-0 items-center justify-center gap-1 rounded-full border border-dashed border-border-strong text-fg-subtle group-hover/agents:border-fg-subtle group-hover/agents:text-fg group-data-[state=open]/agents:border-fg-subtle group-data-[state=open]/agents:text-fg",
              empty && "@2xl:pr-2.5 @2xl:pl-2",
            )}
          >
            <Plus className="size-3.5" />
            {empty && <span className="hidden text-[12px] font-medium whitespace-nowrap @2xl:inline">Add agent</span>}
          </span>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          ref={contentRef}
          tabIndex={-1}
          align="end"
          sideOffset={6}
          onPointerEnter={() => hover(true)}
          onPointerLeave={() => hover(false)}
          // Hovering mustn't take focus from the diff. A click gives it to the panel, not its first
          // button, whose tooltip would open.
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            if (pinned) contentRef.current?.focus();
          }}
          onCloseAutoFocus={(e) => e.preventDefault()}
          className="z-40 max-h-[min(560px,calc(100vh-80px))] w-[440px] outline-none max-w-[calc(100vw-32px)] overflow-y-auto rounded-lg border border-border bg-bg-raised p-2 shadow-xl shadow-black/30"
        >
          <PinPanel.Provider value={() => setPinned(true)}>
            <AgentPanel worktree={worktree} />
          </PinPanel.Provider>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** A dot on an agent's mark for its state: green running, a spinner while busy. */
function StateBadge({ state }: { state: AgentState }) {
  if (state === "busy") return <LoaderCircle className="absolute -right-1 -bottom-1 size-3 animate-spin rounded-full bg-bg text-mod" />;
  if (state === "running") return <span className="absolute -right-0.5 -bottom-0.5 size-2 rounded-full bg-add ring-2 ring-bg" />;
  return null;
}

type Ask = { session: string } | { agent: AgentKind };

/**
 * The agents on a worktree and those that can be added, each of which can be asked to review the
 * branch or to address its comments, unless it's at work already.
 */
export function AgentPanel({ worktree }: { worktree: Worktree }) {
  const { activity, requestOf, waiting, current } = useAgents(worktree);
  const available = useAvailableAgents();
  const launcher = useStore((s) => s.agentLauncher);
  const setup = useTerminalSetup();
  const review = useRequestReview(worktree);
  const implement = useSendComments(worktree);
  const pending = review.isPending || implement.isPending;
  const actions = (to: Ask, unseen: number[], seenAll: string) => (
    <Actions
      unseen={unseen}
      from={startedBy(unseen, activity)}
      seenAll={activity.open.length === 0 ? "There are no open comments" : seenAll}
      disabled={pending}
      onReview={() => review.mutate(to)}
      onImplement={() => implement.mutate(to)}
    />
  );

  return (
    <div className="flex flex-col gap-2">
      {waiting.length + current.length > 0 && (
        <Section title="On this branch">
          {waiting.map((request) => (
            <WaitingRow key={request.id} request={request} />
          ))}
          {current.map((session) => {
            const request = requestOf(session);
            const state = stateOf(session, request);
            return (
              <SessionRow
                key={session.id}
                session={session}
                request={request}
                state={state}
                written={activity.written[session.id] ?? 0}
                actions={
                  session.reachable && state !== "busy"
                    ? actions({ session: session.id }, unseenBy(activity, session), "It has seen every open comment")
                    : null
                }
              />
            );
          })}
        </Section>
      )}
      <Section title="Add agent">
        {available.map((option) => (
          <Row key={option.agent} icon={option.agent} title={agentLabel(option.agent)} detail={opensIn(option, launcher, setup)}>
            {actions({ agent: option.agent }, unseenBy(activity, null), "")}
            <CopyCommand worktree={worktree} agent={option.agent} canImplement={activity.open.length > 0} />
          </Row>
        ))}
        {available.length === 0 && (
          <p className="px-2 py-3 text-[12px] leading-5 text-fg-subtle">
            Install Claude Code or Codex (their app or CLI) to start agents from Piccolo. Agents that run{" "}
            <code className="font-mono">piccolo</code> on this branch show up here too.
          </p>
        )}
      </Section>
    </div>
  );
}

/**
 * Copies the command that starts a new session of `agent` on a review or on the comments, for a
 * terminal Piccolo doesn't open by itself. Copying asks for the work, like the buttons do.
 */
function CopyCommand({ worktree, agent, canImplement }: { worktree: Worktree; agent: AgentKind; canImplement: boolean }) {
  const copy = useCopyAgentCommand(worktree);
  const pin = useContext(PinPanel);
  const [copied, markCopied] = useJustDone();
  const item =
    "flex h-7 cursor-default items-center rounded px-2 outline-none data-[disabled]:opacity-50 data-[highlighted]:bg-bg-hover data-[highlighted]:text-fg";
  const select = (kind: ReviewRequest["kind"]) => copy.mutate({ kind, agent }, { onSuccess: markCopied });
  return (
    <DropdownMenuPrimitive.Root modal={false} onOpenChange={(open) => open && pin()}>
      <DropdownMenuPrimitive.Trigger asChild>
        <IconButton
          label={copied ? "Copied: paste it in a terminal" : "Copy the command, to run it yourself"}
          disabled={copy.isPending}
          className="size-6"
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        </IconButton>
      </DropdownMenuPrimitive.Trigger>
      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.Content
          align="end"
          sideOffset={4}
          className="z-50 min-w-48 rounded-md border border-border bg-bg-raised p-1 text-[12.5px] text-fg-muted shadow-lg shadow-black/20"
        >
          <DropdownMenuPrimitive.Item className={item} onSelect={() => select("review")}>
            Copy review command
          </DropdownMenuPrimitive.Item>
          <DropdownMenuPrimitive.Item className={item} disabled={!canImplement} onSelect={() => select("implement")}>
            Copy implement command
          </DropdownMenuPrimitive.Item>
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="px-2 pt-1 pb-0.5 text-[11px] font-medium text-fg-faint">{title}</h3>
      <ul className="flex flex-col">{children}</ul>
    </section>
  );
}

/** An agent or session in the panel: its mark, name and what it's doing, then what can be done with it. */
function Row({
  icon,
  state = "idle",
  title,
  detail,
  children,
}: {
  icon: string;
  state?: AgentState;
  title: string;
  detail: ReactNode;
  children?: ReactNode;
}) {
  return (
    <li className="group flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-bg-hover">
      <StatusIcon agent={icon} state={state} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span title={title} className="truncate text-[12.5px] font-medium text-fg">
          {title}
        </span>
        <span className="tabular truncate text-[11.5px] text-fg-subtle">{detail}</span>
      </span>
      {children}
    </li>
  );
}

/** "Review" and "Implement": what an agent can be asked to do. Implementing needs comments it hasn't seen. */
function Actions({
  unseen,
  from,
  seenAll,
  disabled,
  onReview,
  onImplement,
}: {
  unseen: number[];
  from: string;
  /** Why there's nothing to implement. */
  seenAll: string;
  disabled: boolean;
  onReview: () => void;
  onImplement: () => void;
}) {
  const small = "h-6 border border-border px-2 text-[11.5px]";
  return (
    <span className="flex shrink-0 items-center gap-1">
      <Tooltip label="Ask it to review the branch">
        <Button disabled={disabled} onClick={onReview} className={small}>
          Review
        </Button>
      </Tooltip>
      <Tooltip label={unseen.length === 0 ? seenAll : `Send it ${plural(unseen.length, "comment")} to address: ${from}`}>
        {/* A disabled button gets no pointer events, so the tooltip hangs on this. */}
        <span>
          <Button disabled={disabled || unseen.length === 0} onClick={onImplement} className={small}>
            Implement
            {unseen.length > 0 && <span className="tabular text-fg-subtle">{unseen.length}</span>}
          </Button>
        </span>
      </Tooltip>
    </span>
  );
}

/** A session on the branch: what it's doing, or what it wrote. */
function SessionRow({
  session,
  request,
  state,
  written,
  actions,
}: {
  session: AgentSession;
  request: ReviewRequest | undefined;
  state: AgentState;
  written: number;
  actions: ReactNode;
}) {
  const cancel = useCancelReviewRequest();
  const underway = !!request && isUnderway(request);
  const detail = underway
    ? request.startedAt === null
      ? request.kind === "review"
        ? "Asked to review"
        : `Asked to address ${plural(request.threads.length, "comment")}`
      : request.kind === "review"
        ? "Reviewing"
        : `Addressing ${plural(request.threads.length, "comment")}`
    : session.status === "busy"
      ? "Working"
      : plural(written, "comment");

  return (
    <Row icon={session.agent} state={state} title={sessionName(session)} detail={detail}>
      {actions}
      {underway && (
        <IconButton
          label="Stop waiting for it"
          onClick={() => cancel.mutate(request.id)}
          className="size-7 opacity-0 group-hover:opacity-100"
        >
          <X className="size-3.5" />
        </IconButton>
      )}
    </Row>
  );
}

/** A request to a new session that hasn't started on it yet. */
function WaitingRow({ request }: { request: ReviewRequest }) {
  const cancel = useCancelReviewRequest();
  const asked = request.kind === "review" ? "Review requested" : `Asked to address ${plural(request.threads.length, "comment")}`;
  return (
    <Row icon={request.agent} state="busy" title={`New ${agentLabel(request.agent)} session`} detail={`${asked} ${ago(request.requestedAt)} · waiting to start`}>
      <IconButton label="Withdraw the request" onClick={() => cancel.mutate(request.id)} className="size-7 opacity-0 group-hover:opacity-100">
        <X className="size-3.5" />
      </IconButton>
    </Row>
  );
}

/** The agent's mark with a dot for its state: green running, a spinner while busy. */
function StatusIcon({ agent, state }: { agent: string; state: AgentState }) {
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
