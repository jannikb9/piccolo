import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import * as Popover from "@radix-ui/react-popover";
import { Check, ChevronDown, Copy, LoaderCircle, Plus, Settings2, X } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { newSession, useLaunchOptions, COPY_OPTION, type LaunchOption } from "../lib/agents";
import { openSettings } from "../lib/api";
import {
  useCancelReviewRequest,
  useCopyPrompt,
  useRequestReview,
  useSendComments,
  useSessionActivity,
  useSessions,
  useTerminalSetup,
} from "../lib/queries";
import { TERMINAL_NAMES, terminalPlace } from "../lib/terminals";
import { agentLabel, ago, cn } from "../lib/utils";
import { useStore } from "../store";
import type { AgentSession, ReviewRequest, SessionActivity, Worktree } from "../types";
import { AgentIcon } from "./AgentIcon";
import { Button, IconButton, Tooltip, useJustDone } from "./ui";

/** A session as the app names it: its title, else its agent. */
const sessionName = (session: AgentSession) => session.title ?? `${agentLabel(session.agent)} session`;

/** A request still going: asked, or taken on but not finished. */
const isUnderway = (request: ReviewRequest) => request.finishedAt === null;

/** A request whose prompt was copied, for whichever agent it's pasted into (`ANY_AGENT` in requests.rs). */
const isCopied = (request: ReviewRequest) => request.agent === "agent";

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
 * around (running, at work or just done); those that ended are left out. What each is doing comes
 * from its latest request. The author is the session building the branch, which comments go to.
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
  const current = sessions.filter(isCurrent);
  return { activity, requestOf, waiting, current, author: authorOf(current, requestOf) };
}

/**
 * The session building the branch, as far as Piccolo can tell: the one last asked to address
 * comments, else one never asked to review, those in the worktree first, then the latest. Only
 * sessions Piccolo can send messages to count.
 */
function authorOf(sessions: AgentSession[], requestOf: (session: AgentSession) => ReviewRequest | undefined) {
  const rank = (session: AgentSession) => [
    requestOf(session)?.requestedAt ?? 0,
    session.inWorktree ? 1 : 0,
    session.lastSeen ?? session.startedAt ?? 0,
  ];
  const candidates = sessions.filter((s) => s.reachable && requestOf(s)?.kind !== "review");
  candidates.sort((a, b) => {
    const [ra, rb] = [rank(a), rank(b)];
    const i = ra.findIndex((v, i) => v !== rb[i]);
    return i === -1 ? 0 : rb[i] - ra[i];
  });
  return candidates[0] ?? null;
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

/** Where `option` starts a session, briefly, e.g. "in kitty"; nothing for an app. */
function useWhere(option: LaunchOption) {
  const terminal = useStore((s) => s.cliTerminal);
  const setup = useTerminalSetup();
  if (option.via !== "cli") return null;
  const name = terminal === "auto" ? setup?.detected : terminal;
  return name ? `in ${TERMINAL_NAMES[name]}` : "in a terminal";
}

/** What starting a session with `option` does, for a tooltip. */
function useOpensIn(option: LaunchOption) {
  const terminal = useStore((s) => s.cliTerminal);
  const setup = useTerminalSetup();
  if (option.via === "app") return `in the ${option.agent === "claude" ? "Claude" : "ChatGPT"} app`;
  return `in ${terminalPlace(terminal === "auto" ? (setup?.detected ?? null) : terminal, setup)}`;
}

/**
 * The toolbar's reviewers, like a pull request's: one overlapping mark per agent on the branch,
 * which fan out on hover, and a "+" ("Review" while there are none). Both open the panel listing
 * the agents, where any can be asked to review, or a new one started on it.
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
        : `${isCopied(underway[0]) ? "An agent" : agentLabel(underway[0].agent)} ${doing(underway[0])}`;

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
          aria-label={empty ? "Request a review" : "Agents on this branch"}
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
            {empty && <span className="hidden text-[12px] font-medium whitespace-nowrap @2xl:inline">Review</span>}
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
          className="z-40 max-h-[min(560px,calc(100vh-80px))] w-[380px] max-w-[calc(100vw-32px)] overflow-y-auto rounded-lg border border-border bg-bg-raised p-2 shadow-xl shadow-black/30 outline-none"
        >
          <ReviewPanel worktree={worktree} />
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

/** The agents on a worktree, each of which can be asked to review it, and new ones to ask. */
function ReviewPanel({ worktree }: { worktree: Worktree }) {
  const { activity, requestOf, waiting, current, author } = useAgents(worktree);
  const options = useLaunchOptions();
  const terminal = useStore((s) => s.cliTerminal);
  const review = useRequestReview(worktree);
  const copy = useCopyPrompt(worktree);

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
            // The author reviewing its own work is not worth a button.
            const canReview = session.reachable && state !== "busy" && session.id !== author?.id;
            return (
              <SessionRow
                key={session.id}
                session={session}
                request={request}
                state={state}
                author={session.id === author?.id}
                written={activity.written[session.id] ?? 0}
              >
                {canReview && (
                  <Tooltip label="Ask it to review the branch">
                    <Button
                      disabled={review.isPending}
                      onClick={() => review.mutate({ session: session.id })}
                      className="h-6 border border-border px-2 text-[11.5px]"
                    >
                      Review
                    </Button>
                  </Tooltip>
                )}
              </SessionRow>
            );
          })}
        </Section>
      )}
      <Section
        title="Request review"
        action={
          <IconButton label="Choose these options in Settings" onClick={openSettings} className="size-5">
            <Settings2 className="size-3" />
          </IconButton>
        }
      >
        {options.map((option) => (
          <OptionRow
            key={option.id}
            option={option}
            disabled={review.isPending || copy.isPending}
            onSelect={(done) => {
              const to = newSession(option, terminal);
              if (to) review.mutate(to);
              else copy.mutate("review", { onSuccess: done });
            }}
          />
        ))}
        {options.length === 0 && (
          <p className="px-2 py-2 text-[12px] leading-5 text-fg-subtle">All options are hidden in Settings.</p>
        )}
      </Section>
    </div>
  );
}

function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section>
      <h3 className="flex h-6 items-center justify-between pr-1 pl-2 text-[11px] font-medium text-fg-faint">
        {title}
        {action}
      </h3>
      <ul className="flex flex-col">{children}</ul>
    </section>
  );
}

/** A way to start a new agent, picked with a click; a copied prompt shows a check for a moment. */
function OptionRow({
  option,
  disabled,
  onSelect,
}: {
  option: LaunchOption;
  disabled: boolean;
  /** `done` confirms a copy. */
  onSelect: (done: () => void) => void;
}) {
  const [copied, markCopied] = useJustDone();
  const where = useWhere(option);
  const opensIn = useOpensIn(option);
  return (
    <li>
      <button
        type="button"
        disabled={disabled}
        title={option.via === "copy" ? "Copies a prompt to paste into any agent" : `Starts a new session ${opensIn}`}
        onClick={() => onSelect(markCopied)}
        className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[12.5px] text-fg hover:bg-bg-hover disabled:opacity-50"
      >
        <OptionIcon option={option} copied={copied} />
        <span className="font-medium">{copied ? "Copied" : option.label}</span>
        {where && <span className="truncate text-[11.5px] text-fg-subtle">{where}</span>}
      </button>
    </li>
  );
}

function OptionIcon({ option, copied = false }: { option: LaunchOption; copied?: boolean }) {
  return (
    <span className="grid size-6 shrink-0 place-items-center rounded-md border border-border-subtle bg-bg-raised text-fg-muted">
      {option.agent ? (
        <AgentIcon name={option.agent} className="size-3.5" />
      ) : copied ? (
        <Check className="size-3.5" strokeWidth={2.5} />
      ) : (
        <Copy className="size-3.5" />
      )}
    </span>
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

/** A session on the branch: what it's doing, or what it wrote. */
function SessionRow({
  session,
  request,
  state,
  author,
  written,
  children,
}: {
  session: AgentSession;
  request: ReviewRequest | undefined;
  state: AgentState;
  author: boolean;
  written: number;
  children?: ReactNode;
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
      : author
        ? `Author · ${plural(written, "comment")}`
        : plural(written, "comment");

  return (
    <Row icon={session.agent} state={state} title={sessionName(session)} detail={detail}>
      {children}
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
  const copied = isCopied(request);
  return (
    <Row
      icon={request.agent}
      state="busy"
      title={copied ? "Copied prompt" : `New ${agentLabel(request.agent)} session`}
      detail={`${asked} ${ago(request.requestedAt)} · ${copied ? "waiting for an agent" : "waiting to start"}`}
    >
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

const menuItem =
  "flex h-8 cursor-default items-center gap-2 rounded px-2 outline-none data-[disabled]:opacity-50 data-[highlighted]:bg-bg-hover data-[highlighted]:text-fg";
const menuLabel = "px-2 pt-1.5 pb-0.5 text-[11px] font-medium text-fg-faint";

/**
 * "Implement N": sends the comments the author hasn't seen to it, to address. Shown while there
 * are any, from the reviewer or from reviewing agents. Without an author it starts a new session
 * the first way the menus offer. Its menu sends them to another session on the branch instead, or
 * to a new one.
 */
export function ImplementButton({ worktree }: { worktree: Worktree }) {
  const { activity, current, author } = useAgents(worktree);
  const shown = useLaunchOptions();
  const options = shown.length > 0 ? shown : [COPY_OPTION];
  const terminal = useStore((s) => s.cliTerminal);
  const implement = useSendComments(worktree);
  const copy = useCopyPrompt(worktree);
  const [copied, markCopied] = useJustDone();
  const busy = implement.isPending || copy.isPending;

  const start = (option: LaunchOption) => {
    const to = newSession(option, terminal);
    if (to) implement.mutate(to);
    else copy.mutate("implement", { onSuccess: markCopied });
  };
  const unseen = (session: AgentSession) => activity.unseen[session.id] ?? [];

  const primary = author ? null : options[0];
  const threads = author ? unseen(author) : activity.open;
  // A new session that's starting on the comments becomes the author once it takes them on.
  const starting = activity.requests.some((r) => r.kind === "implement" && isUnderway(r) && !r.sessionId);
  const others = current.filter((s) => s.reachable && s.id !== author?.id);
  const fallbacks = options.filter((o) => o !== primary);
  const primaryOpensIn = useOpensIn(primary ?? COPY_OPTION);

  if ((threads.length === 0 || (!author && starting)) && !copied) return null;

  const tooltip = author
    ? `Send ${plural(threads.length, "comment")} to ${sessionName(author)}`
    : primary!.via === "copy"
      ? `Copy a prompt for ${plural(threads.length, "comment")}, to paste into any agent`
      : `Start a ${agentLabel(primary!.agent!)} session on ${plural(threads.length, "comment")} ${primaryOpensIn}`;

  return (
    <div className="flex h-7 shrink-0 items-stretch rounded-md border border-border bg-bg-raised text-[12px] font-medium text-fg">
      <Tooltip
        label={
          <span className="flex flex-col gap-0.5">
            <span>{tooltip}</span>
            {threads.length > 0 && <span className="text-fg-subtle">{startedBy(threads, activity)}</span>}
          </span>
        }
      >
        <button
          type="button"
          disabled={busy}
          onClick={() => (author ? implement.mutate({ session: author.id }) : start(primary!))}
          className={cn(
            "flex items-center gap-1.5 pr-2 pl-2 hover:bg-bg-hover disabled:opacity-50",
            fallbacks.length + others.length > 0 ? "rounded-l-md" : "rounded-md",
          )}
        >
          {copied ? (
            <Check className="size-3.5" strokeWidth={2.5} />
          ) : author || primary!.agent ? (
            <AgentIcon name={author?.agent ?? primary!.agent} className="size-3.5" />
          ) : (
            <Copy className="size-3.5 text-fg-muted" />
          )}
          {/* A narrow toolbar keeps the mark and the count. */}
          <span className="hidden @3xl:inline">{copied ? "Copied" : "Implement"}</span>
          {!copied && (
            <span className="tabular grid h-4 min-w-4 place-items-center rounded-full bg-accent px-1 text-[10.5px] font-semibold text-accent-fg">
              {threads.length}
            </span>
          )}
        </button>
      </Tooltip>
      {fallbacks.length + others.length > 0 && (
        <DropdownMenuPrimitive.Root modal={false}>
          <DropdownMenuPrimitive.Trigger
            aria-label="Send the comments elsewhere"
            disabled={busy}
            className="grid w-6 place-items-center rounded-r-md border-l border-border text-fg-subtle outline-none hover:bg-bg-hover hover:text-fg data-[state=open]:bg-bg-hover"
          >
            <ChevronDown className="size-3" />
          </DropdownMenuPrimitive.Trigger>
          <DropdownMenuPrimitive.Portal>
            <DropdownMenuPrimitive.Content
              align="end"
              sideOffset={4}
              className="z-50 w-64 rounded-md border border-border bg-bg-raised p-1 text-[12.5px] text-fg-muted shadow-lg shadow-black/20"
            >
              {others.length > 0 && (
                <>
                  <DropdownMenuPrimitive.Label className={menuLabel}>Send to a session</DropdownMenuPrimitive.Label>
                  {others.map((session) => {
                    const count = unseen(session).length;
                    return (
                      <DropdownMenuPrimitive.Item
                        key={session.id}
                        disabled={count === 0}
                        onSelect={() => implement.mutate({ session: session.id })}
                        className={menuItem}
                      >
                        <AgentIcon name={session.agent} className="size-3.5" />
                        <span className="min-w-0 flex-1 truncate text-fg">{sessionName(session)}</span>
                        <span className="tabular text-[11px] text-fg-subtle">{count === 0 ? "Seen all" : count}</span>
                      </DropdownMenuPrimitive.Item>
                    );
                  })}
                </>
              )}
              {fallbacks.length > 0 && (
                <>
                  {others.length > 0 && <DropdownMenuPrimitive.Separator className="-mx-1 my-1 h-px bg-border" />}
                  <DropdownMenuPrimitive.Label className={menuLabel}>New session</DropdownMenuPrimitive.Label>
                  {fallbacks.map((option) => (
                    <MenuOption key={option.id} option={option} onSelect={() => start(option)} />
                  ))}
                </>
              )}
            </DropdownMenuPrimitive.Content>
          </DropdownMenuPrimitive.Portal>
        </DropdownMenuPrimitive.Root>
      )}
    </div>
  );
}

function MenuOption({ option, onSelect }: { option: LaunchOption; onSelect: () => void }) {
  const where = useWhere(option);
  return (
    <DropdownMenuPrimitive.Item onSelect={onSelect} className={menuItem}>
      {option.agent ? <AgentIcon name={option.agent} className="size-3.5" /> : <Copy className="size-3.5" />}
      <span className="text-fg">{option.label}</span>
      {where && <span className="truncate text-[11px] text-fg-subtle">{where}</span>}
    </DropdownMenuPrimitive.Item>
  );
}
