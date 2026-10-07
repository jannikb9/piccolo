import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import * as Popover from "@radix-ui/react-popover";
import { Check, ChevronDown, Copy, Eye, LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useCopyPrompt, useRequestReview, useSendComments, useSessionActivity, useSessions } from "../lib/queries";
import { agentLabel, cn, modelLabel } from "../lib/utils";
import type { AgentSession, ReviewRequest, SessionActivity, Worktree } from "../types";
import { AgentIcon } from "./AgentIcon";
import { Tooltip, useJustDone } from "./ui";

/** A session as the app names it: its title, else its agent. */
const sessionName = (session: AgentSession) => session.title ?? `${agentLabel(session.agent)} session`;

/** A request still going: asked, or taken on but not finished. */
const isUnderway = (request: ReviewRequest) => request.finishedAt === null;

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
 * The agents on a worktree: sessions still around (running, at work or just done); those that
 * ended are left out. What each is doing comes from its latest request. The author is the session
 * building the branch, which comments go to. A copied prompt shows up as a session once an agent
 * takes it on.
 */
function useAgents(worktree: Worktree) {
  const sessions = useSessions(worktree);
  const activity = useSessionActivity(worktree);
  // A session's latest request; requests come newest first.
  const requestOf = (session: AgentSession) => activity.requests.find((r) => r.sessionId === session.id);
  const isCurrent = (session: AgentSession) => {
    const request = requestOf(session);
    return session.running !== false || (!!request && (isUnderway(request) || request.finishedAt! > Date.now() - RECENT_MS));
  };
  const current = sessions.filter(isCurrent);
  return { activity, requestOf, current, author: authorOf(current, requestOf) };
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

/**
 * The toolbar's agents, like a pull request's reviewers: one overlapping mark per agent on the
 * branch, which fan out on hover and open the panel listing them; a spinner on a mark shows it's at
 * work. Only shows what's going on; asking for reviews and sending comments are the buttons beside it.
 */
export function AgentsButton({ worktree }: { worktree: Worktree }) {
  const { current, requestOf } = useAgents(worktree);
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
  for (const session of current) mark(session.agent, stateOf(session, requestOf(session)));
  const marks = [...agents];

  if (marks.length === 0) return null;

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
          className="group/agents flex h-7 shrink-0 items-center rounded-md px-1"
        >
          {/* Overlapped at rest; hovering fans the marks out and the toolbar makes room for them. */}
          {marks.map(([agent, state], i) => (
            <span
              key={agent}
              style={{ zIndex: marks.length - i }}
              className={cn(
                "relative grid size-6 shrink-0 place-items-center rounded-full bg-bg-raised ring-2 ring-bg transition-[margin] duration-200 ease-out",
                i > 0 && "-ml-[9px] group-hover/agents:ml-1 group-data-[state=open]/agents:ml-1",
              )}
            >
              <span className="absolute inset-0 rounded-full border border-border" />
              <AgentIcon name={agent} className="size-3.5" />
              <StateBadge state={state} />
            </span>
          ))}
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
          // Hovering mustn't take focus from the diff; a click gives it to the panel.
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            if (pinned) contentRef.current?.focus();
          }}
          onCloseAutoFocus={(e) => e.preventDefault()}
          className="z-40 max-h-[min(560px,calc(100vh-80px))] w-[340px] max-w-[calc(100vw-32px)] overflow-y-auto rounded-lg border border-border bg-bg-raised p-2 shadow-xl shadow-black/30 outline-none"
        >
          <AgentsPanel worktree={worktree} />
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

/** The agents on a worktree and what each is doing. */
function AgentsPanel({ worktree }: { worktree: Worktree }) {
  const { activity, requestOf, current, author } = useAgents(worktree);
  return (
    <section>
      <h3 className="flex h-6 items-center pl-2 text-[11px] font-medium text-fg-faint">On this branch</h3>
      <ul className="flex flex-col">
        {current.map((session) => {
          const request = requestOf(session);
          return (
            <SessionRow
              key={session.id}
              session={session}
              request={request}
              state={stateOf(session, request)}
              author={session.id === author?.id}
              written={activity.written[session.id] ?? 0}
            />
          );
        })}
      </ul>
    </section>
  );
}

/** An agent or session in the panel: its mark, name and what it's doing. */
function Row({ icon, state = "idle", title, detail }: { icon: string; state?: AgentState; title: string; detail: ReactNode }) {
  return (
    <li className="flex items-center gap-2 px-2 py-1.5">
      <StatusIcon agent={icon} state={state} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span title={title} className="truncate text-[12.5px] font-medium text-fg">
          {title}
        </span>
        <span className="tabular truncate text-[11.5px] text-fg-subtle">{detail}</span>
      </span>
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
}: {
  session: AgentSession;
  request: ReviewRequest | undefined;
  state: AgentState;
  author: boolean;
  written: number;
}) {
  const underway = !!request && isUnderway(request);
  const doing = underway
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
  const detail = session.model ? `${modelLabel(session.model)} · ${doing}` : doing;

  return <Row icon={session.agent} state={state} title={sessionName(session)} detail={detail} />;
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
 * A toolbar button that does its likeliest thing on a click, with a chevron for the menu of the
 * others, when there are any. Without a likeliest thing (`onClick` is `null`), a click opens the menu.
 */
function SplitButton({
  tooltip,
  disabled,
  onClick,
  children,
  menuLabel: chevronLabel,
  menu,
}: {
  tooltip: ReactNode;
  disabled: boolean;
  onClick: (() => void) | null;
  children: ReactNode;
  /** The chevron's accessible name. */
  menuLabel: string;
  /** The menu's items; no chevron without them. */
  menu: ReactNode | null;
}) {
  const [open, setOpen] = useState(false);
  const mainRef = useRef<HTMLButtonElement>(null);
  return (
    <div className="flex h-7 shrink-0 items-stretch rounded-md border border-border bg-bg-raised text-[12px] font-medium text-fg">
      <Tooltip label={tooltip}>
        {/* Not `disabled`, which would keep the tooltip saying why from showing. */}
        <button
          ref={mainRef}
          type="button"
          aria-disabled={disabled}
          onClick={() => {
            if (disabled) return;
            if (onClick) onClick();
            else setOpen((o) => !o);
          }}
          className={cn(
            "flex items-center gap-1.5 px-2 hover:bg-bg-hover aria-disabled:opacity-50 aria-disabled:hover:bg-transparent",
            menu ? "rounded-l-md" : "rounded-md",
          )}
        >
          {children}
        </button>
      </Tooltip>
      {menu && (
        <DropdownMenuPrimitive.Root modal={false} open={open} onOpenChange={setOpen}>
          <DropdownMenuPrimitive.Trigger
            aria-label={chevronLabel}
            disabled={disabled}
            className="grid w-6 place-items-center rounded-r-md border-l border-border text-fg-subtle outline-none hover:bg-bg-hover hover:text-fg data-[state=open]:bg-bg-hover"
          >
            <ChevronDown className="size-3" />
          </DropdownMenuPrimitive.Trigger>
          <DropdownMenuPrimitive.Portal>
            <DropdownMenuPrimitive.Content
              align="end"
              sideOffset={4}
              // A click on the button toggles the menu; it mustn't also count as dismissing it.
              onInteractOutside={(e) => mainRef.current?.contains(e.target as Node) && e.preventDefault()}
              className="z-50 w-64 rounded-md border border-border bg-bg-raised p-1 text-[12.5px] text-fg-muted shadow-lg shadow-black/20"
            >
              {menu}
            </DropdownMenuPrimitive.Content>
          </DropdownMenuPrimitive.Portal>
        </DropdownMenuPrimitive.Root>
      )}
    </div>
  );
}

/** The mark on a split button: the session it goes to, else `fallback` (a clipboard), then a check once copied. */
function TargetIcon({ agent, copied, fallback }: { agent: string | undefined; copied: boolean; fallback?: ReactNode }) {
  if (copied) return <Check className="size-3.5" strokeWidth={2.5} />;
  if (agent) return <AgentIcon name={agent} className="size-3.5" />;
  return fallback ?? <Copy className="size-3.5 text-fg-muted" />;
}

/** A session's model in a menu, beside its name. */
function ModelName({ session }: { session: AgentSession }) {
  if (!session.model) return null;
  return <span className="shrink-0 text-[11px] text-fg-subtle">{modelLabel(session.model)}</span>;
}

/** The menu's item copying the prompt, after the sessions on the branch if there are any. */
function CopyItem({ after, onSelect }: { after: boolean; onSelect: () => void }) {
  return (
    <>
      {after && <DropdownMenuPrimitive.Separator className="-mx-1 my-1 h-px bg-border" />}
      <DropdownMenuPrimitive.Item onSelect={onSelect} className={menuItem}>
        <Copy className="size-3.5" />
        <span className="text-fg">Copy prompt</span>
        <span className="truncate text-[11px] text-fg-subtle">for any agent</span>
      </DropdownMenuPrimitive.Item>
    </>
  );
}

/**
 * "Review": asks for a review of the branch. Another round goes to the session that reviewed it
 * last, while it's around and free; otherwise a click opens the menu. The menu asks another session
 * on the branch instead (never the author), or copies a prompt to paste into any agent; that agent
 * shows up here once it starts on the review.
 */
export function ReviewButton({ worktree }: { worktree: Worktree }) {
  const { current, author, requestOf } = useAgents(worktree);
  const review = useRequestReview(worktree);
  const copy = useCopyPrompt(worktree);
  const [copied, markCopied] = useJustDone();
  const busy = review.isPending || copy.isPending;
  const copyPrompt = () => copy.mutate("review", { onSuccess: markCopied });

  // The author reviewing its own work isn't worth offering, nor a session that's at work.
  const reviewers = current.filter((s) => s.reachable && s.id !== author?.id && stateOf(s, requestOf(s)) !== "busy");
  const reviewedAt = (s: AgentSession) => {
    const request = requestOf(s);
    return request?.kind === "review" ? request.requestedAt : 0;
  };
  const again = reviewers.filter((s) => reviewedAt(s) > 0).sort((a, b) => reviewedAt(b) - reviewedAt(a))[0] ?? null;
  const others = reviewers.filter((s) => s.id !== again?.id);

  return (
    <SplitButton
      tooltip={again ? `Ask ${sessionName(again)} to review the branch again` : "Ask for a review of the branch"}
      disabled={busy}
      onClick={again ? () => review.mutate(again.id) : null}
      menuLabel="Ask for a review elsewhere"
      menu={
        <>
          {others.length > 0 && (
            <>
              <DropdownMenuPrimitive.Label className={menuLabel}>Ask a session</DropdownMenuPrimitive.Label>
              {others.map((session) => (
                <DropdownMenuPrimitive.Item key={session.id} onSelect={() => review.mutate(session.id)} className={menuItem}>
                  <AgentIcon name={session.agent} className="size-3.5" />
                  <span className="min-w-0 flex-1 truncate text-fg">{sessionName(session)}</span>
                  <ModelName session={session} />
                </DropdownMenuPrimitive.Item>
              ))}
            </>
          )}
          <CopyItem after={others.length > 0} onSelect={copyPrompt} />
        </>
      }
    >
      <TargetIcon agent={again?.agent} copied={copied} fallback={<Eye className="size-3.5 text-fg-muted" />} />
      {/* A narrow toolbar keeps the mark. */}
      <span className="hidden @2xl:inline">{copied ? "Copied" : "Review"}</span>
    </SplitButton>
  );
}

/**
 * "Request changes N": sends the comments the author hasn't seen to it, to address, from the reviewer or
 * from reviewing agents; disabled, saying why, while there are none. Without an author it copies a
 * prompt for every open comment, to paste into any agent. Its menu sends them to another session on
 * the branch instead, or copies the prompt.
 */
export function AddressButton({ worktree }: { worktree: Worktree }) {
  const { activity, current, author } = useAgents(worktree);
  const send = useSendComments(worktree);
  const copy = useCopyPrompt(worktree);
  const [copied, markCopied] = useJustDone();
  const busy = send.isPending || copy.isPending;
  const copyPrompt = () => copy.mutate("implement", { onSuccess: markCopied });
  const unseen = (session: AgentSession) => activity.unseen[session.id] ?? [];

  const threads = author ? unseen(author) : activity.open;
  // An agent given a copied prompt becomes the author once it takes the comments on.
  const starting = activity.requests.some((r) => r.kind === "implement" && isUnderway(r) && !r.sessionId);
  const others = current.filter((s) => s.reachable && s.id !== author?.id);

  const waiting = !author && starting;
  const empty = threads.length === 0 || waiting;

  const tooltip = waiting
    ? "Waiting for an agent to take the copied comments on"
    : activity.open.length === 0
      ? "No comments to address"
      : author && threads.length === 0
        ? `${sessionName(author)} has seen every comment`
        : author
          ? `Send ${plural(threads.length, "comment")} to ${sessionName(author)}`
          : `Copy a prompt for ${plural(threads.length, "comment")}, to paste into any agent`;

  return (
    <SplitButton
      tooltip={
        <span className="flex flex-col gap-0.5">
          <span>{tooltip}</span>
          {!empty && <span className="text-fg-subtle">{startedBy(threads, activity)}</span>}
        </span>
      }
      disabled={busy || empty}
      onClick={() => (author ? send.mutate(author.id) : copyPrompt())}
      menuLabel="Send the comments elsewhere"
      menu={
        (author || others.length > 0) && (
          <>
            {others.length > 0 && (
              <>
                <DropdownMenuPrimitive.Label className={menuLabel}>Send to a session</DropdownMenuPrimitive.Label>
                {others.map((session) => {
                  const count = unseen(session).length;
                  return (
                    <DropdownMenuPrimitive.Item
                      key={session.id}
                      disabled={count === 0}
                      onSelect={() => send.mutate(session.id)}
                      className={menuItem}
                    >
                      <AgentIcon name={session.agent} className="size-3.5" />
                      <span className="min-w-0 flex-1 truncate text-fg">{sessionName(session)}</span>
                      <ModelName session={session} />
                      <span className="tabular text-[11px] text-fg-subtle">{count === 0 ? "Seen all" : count}</span>
                    </DropdownMenuPrimitive.Item>
                  );
                })}
              </>
            )}
            <CopyItem after={others.length > 0} onSelect={copyPrompt} />
          </>
        )
      }
    >
      <TargetIcon agent={author?.agent} copied={copied} />
      {/* A narrow toolbar keeps the mark and the count. */}
      <span className="hidden @3xl:inline">{copied ? "Copied" : "Request changes"}</span>
      {!copied && !empty && (
        <span className="tabular grid h-4 min-w-4 place-items-center rounded-full bg-accent px-1 text-[10.5px] font-semibold text-accent-fg">
          {threads.length}
        </span>
      )}
    </SplitButton>
  );
}
