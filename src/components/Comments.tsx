import { Bot, CheckCircle2, ChevronRight, RotateCcw, Trash2, User } from "lucide-react";
import { useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent, type ReactNode } from "react";
import { showError } from "../lib/api";
import { clipboardImages, prepareImage, type DraftImage } from "../lib/images";
import { useDeleteComment, useReplyThread, useSetThreadResolved } from "../lib/queries";
import { cn, timeAgo } from "../lib/utils";
import { replyKey, useStore } from "../store";
import type { CommentMessage, ExcerptRow, LineRange, Thread } from "../types";
import { DraftImages, MessageImages, useDraftImages } from "./Images";
import { Button, Tooltip } from "./ui";

/** "line 12", "lines 12–14"; ranges across both sides of a unified diff name the sides. */
export function describeRange(range: LineRange): string {
  const { startSide, startLine, endSide, endLine } = range;
  const sign = (side: LineRange["startSide"]) => (side === "deletions" ? "−" : "+");
  if (startSide !== endSide) return `lines ${sign(startSide)}${startLine} to ${sign(endSide)}${endLine}`;
  const prefix = startSide === "deletions" ? "−" : "";
  return startLine === endLine ? `line ${prefix}${startLine}` : `lines ${prefix}${startLine}–${prefix}${endLine}`;
}

/** Card chrome shared by threads and the composer, inset from the diff's edges. */
function Card({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className="px-3 py-2 font-sans">
      <div className={cn("max-w-[760px] overflow-hidden rounded-lg border border-border bg-bg-raised text-[13px]", className)}>
        {children}
      </div>
    </div>
  );
}

/** A textarea that grows with its content; ⌘↩ submits and Esc cancels. Pasted screenshots attach to `imageKey`. */
function CommentField({
  imageKey,
  value,
  onChange,
  onSubmit,
  onCancel,
  placeholder,
  autoFocus,
}: {
  imageKey: string;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  placeholder: string;
  autoFocus?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const addImages = useStore((s) => s.addDraftImages);
  const hasImages = useDraftImages(imageKey).length > 0;
  useEffect(() => {
    if (autoFocus) ref.current?.focus({ preventScroll: true });
  }, [autoFocus]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (value.trim() || hasImages) onSubmit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = clipboardImages(e.clipboardData);
    if (files.length === 0) return;
    e.preventDefault();
    Promise.all(files.map(prepareImage)).then(
      (images: DraftImage[]) => addImages(imageKey, images),
      (error) => showError("Couldn't paste the image", String(error)),
    );
  };

  // The textarea grows with a hidden copy of its text in the same grid cell, so the height follows
  // in the normal layout pass; measuring it from script forces a layout of the whole diff per key.
  // WebKit draws the caret as tall as the line, so lines are kept fairly tight.
  const shared = "col-start-1 row-start-1 max-h-80 px-3 py-2.5 leading-[18px] break-words whitespace-pre-wrap";
  return (
    <>
      <div className="grid">
        <div aria-hidden className={cn(shared, "invisible overflow-hidden")}>
          {value}{" "}
        </div>
        <textarea
          ref={ref}
          value={value}
          rows={3}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          className={cn(
            shared,
            "selectable block min-h-[74px] w-full resize-none bg-transparent text-fg caret-accent outline-none placeholder:text-fg-faint",
          )}
        />
      </div>
      <DraftImages imageKey={imageKey} />
    </>
  );
}

function FieldActions({
  hint,
  submitLabel,
  canSubmit,
  pending,
  onSubmit,
  onCancel,
  error,
}: {
  hint: string;
  submitLabel: string;
  canSubmit: boolean;
  pending: boolean;
  onSubmit: () => void;
  onCancel: () => void;
  error?: unknown;
}) {
  return (
    <div className="flex items-center gap-1.5 px-2 pb-2">
      {error ? (
        <span className="selectable min-w-0 flex-1 truncate px-1 text-[12px] text-del" title={String(error)}>
          {String(error)}
        </span>
      ) : (
        <span className="flex-1 px-1 text-[11px] text-fg-faint">{hint}</span>
      )}
      <Button onClick={onCancel}>Cancel</Button>
      <Button variant="primary" disabled={!canSubmit || pending} onClick={onSubmit}>
        {submitLabel}
      </Button>
    </div>
  );
}

/** The form for a new comment, shown below the selected lines. */
export function Composer({
  draftKey,
  range,
  pending,
  error,
  onSubmit,
  onCancel,
}: {
  draftKey: string;
  range: LineRange;
  pending: boolean;
  error?: unknown;
  onSubmit: (body: string, images: DraftImage[]) => void;
  onCancel: () => void;
}) {
  const body = useStore((s) => s.drafts[draftKey]?.body ?? "");
  const setDraftBody = useStore((s) => s.setDraftBody);
  const images = useDraftImages(draftKey);
  const canSubmit = !!body.trim() || images.length > 0;
  const submit = () => canSubmit && onSubmit(body, images);
  // Esc only closes an empty draft, so a stray keypress can't lose text.
  const cancel = () => !canSubmit && onCancel();

  return (
    <Card className="focus-within:border-border-strong">
      <div className="border-b border-border-subtle px-3 py-1.5 text-[12px] text-fg-subtle">
        Comment on {describeRange(range)}
      </div>
      <CommentField
        imageKey={draftKey}
        value={body}
        onChange={(value) => setDraftBody(draftKey, value)}
        onSubmit={submit}
        onCancel={cancel}
        placeholder="Leave a comment, or paste a screenshot"
        autoFocus
      />
      <FieldActions
        hint="⌘↩ to comment"
        submitLabel="Comment"
        canSubmit={canSubmit}
        pending={pending}
        error={error}
        onSubmit={submit}
        onCancel={onCancel}
      />
    </Card>
  );
}

export function ThreadCard({ thread, note }: { thread: Thread; note?: ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  const setResolved = useSetThreadResolved();
  const first = thread.messages[0];

  if (thread.resolved && !expanded) {
    return (
      <div className="px-3 py-1.5 font-sans">
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="flex h-8 w-full max-w-[760px] items-center gap-2 rounded-lg border border-border-subtle bg-bg px-3 text-left text-[12px] text-fg-subtle hover:border-border hover:text-fg-muted"
        >
          <CheckCircle2 className="size-3.5 shrink-0 text-add" />
          <span className="shrink-0 font-medium">Resolved</span>
          <span className="min-w-0 flex-1 truncate">{first?.body.split("\n")[0] || (first?.attachments.length ? "Image" : "")}</span>
          <span className="tabular shrink-0 text-fg-faint">
            {thread.messages.length > 1 && `${thread.messages.length} comments`}
          </span>
          <ChevronRight className="size-3.5 shrink-0" />
        </button>
      </div>
    );
  }

  return (
    <Card>
      {note}
      {thread.messages.map((message, i) => (
        <MessageRow key={message.id} message={message} isFirst={i === 0} />
      ))}
      <div className="flex items-start gap-2 border-t border-border-subtle p-2">
        <ReplyBox threadId={thread.id} />
        {thread.resolved ? (
          <Button
            onClick={() => {
              setResolved.mutate({ id: thread.id, resolved: false });
              setExpanded(false);
            }}
          >
            <RotateCcw className="size-3.5" />
            Unresolve
          </Button>
        ) : (
          <Button onClick={() => setResolved.mutate({ id: thread.id, resolved: true })} disabled={setResolved.isPending}>
            <CheckCircle2 className="size-3.5" />
            Resolve
          </Button>
        )}
      </div>
    </Card>
  );
}

function MessageRow({ message, isFirst }: { message: CommentMessage; isFirst: boolean }) {
  const isAgent = message.author === "agent";
  const Icon = isAgent ? Bot : User;
  return (
    <div className="group border-border-subtle px-3 py-2.5 [&+&]:border-t">
      <div className="flex h-5 items-center gap-2 text-[12px]">
        <span
          className={cn(
            "grid size-5 shrink-0 place-items-center rounded-full",
            isAgent ? "bg-accent-soft text-accent" : "bg-bg-active text-fg-muted",
          )}
        >
          <Icon className="size-3" />
        </span>
        <span className="font-medium text-fg">{isAgent ? "Agent" : "You"}</span>
        <Tooltip label={new Date(message.createdAt).toLocaleString()}>
          <span className="tabular text-fg-subtle">{timeAgo(message.createdAt)}</span>
        </Tooltip>
        <DeleteButton messageId={message.id} label={isFirst ? "Delete thread" : "Delete comment"} />
      </div>
      {message.body && (
        <p className="selectable mt-1 pl-7 leading-5 break-words whitespace-pre-wrap text-fg-muted">{message.body}</p>
      )}
      <MessageImages attachments={message.attachments} />
    </div>
  );
}

/** Deleting takes a second click, so a thread with replies isn't lost to a misclick. */
function DeleteButton({ messageId, label }: { messageId: number; label: string }) {
  const [armed, setArmed] = useState(false);
  const remove = useDeleteComment();
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(timer);
  }, [armed]);

  return (
    <button
      type="button"
      aria-label={label}
      onClick={() => (armed ? remove.mutate(messageId) : setArmed(true))}
      className={cn(
        "ml-auto flex h-5 items-center gap-1 rounded px-1 text-[11px] transition-[opacity,colors]",
        armed ? "bg-del-bg text-del opacity-100" : "text-fg-faint opacity-0 group-hover:opacity-100 hover:text-fg-muted",
      )}
    >
      <Trash2 className="size-3" />
      {armed && (label === "Delete thread" ? "Delete thread?" : "Delete?")}
    </button>
  );
}

function ReplyBox({ threadId }: { threadId: number }) {
  const draft = useStore((s) => s.replyDrafts[threadId]);
  const setReplyDraft = useStore((s) => s.setReplyDraft);
  const reply = useReplyThread();
  const key = replyKey(threadId);
  const images = useDraftImages(key);

  if (draft === undefined) {
    return (
      <button
        type="button"
        onClick={() => setReplyDraft(threadId, "")}
        className="h-7 flex-1 rounded-md border border-border-subtle bg-bg px-2.5 text-left text-[12px] text-fg-faint hover:border-border hover:text-fg-subtle"
      >
        Reply…
      </button>
    );
  }

  const canSubmit = !!draft.trim() || images.length > 0;
  const submit = () =>
    canSubmit && reply.mutate({ id: threadId, body: draft, images }, { onSuccess: () => setReplyDraft(threadId, null) });
  return (
    <div className="min-w-0 flex-1 rounded-md border border-border bg-bg focus-within:border-border-strong">
      <CommentField
        imageKey={key}
        value={draft}
        onChange={(value) => setReplyDraft(threadId, value)}
        onSubmit={submit}
        onCancel={() => !canSubmit && setReplyDraft(threadId, null)}
        placeholder="Reply, or paste a screenshot"
        autoFocus
      />
      <FieldActions
        hint="⌘↩ to reply"
        submitLabel="Reply"
        canSubmit={canSubmit}
        pending={reply.isPending}
        error={reply.error}
        onSubmit={submit}
        onCancel={() => setReplyDraft(threadId, null)}
      />
    </div>
  );
}

/** Heading for a thread that can't sit on its lines: they changed, or aren't in this diff. */
export function DetachedNote({ thread, reason }: { thread: Thread; reason: string }) {
  return (
    <div className="border-b border-border-subtle">
      <div className="flex items-center gap-2 px-3 py-1.5 text-[12px] text-fg-subtle">
        <span className="rounded border border-mod/30 bg-mod/10 px-1.5 py-px text-[10px] font-semibold tracking-wide text-mod uppercase">
          {reason}
        </span>
        <span className="truncate">
          <span className="font-mono">{thread.path}</span>, {describeRange(thread.range)}
        </span>
      </div>
      <Excerpt rows={thread.excerpt} />
    </div>
  );
}

/** The code a thread was written on, as it was then. */
function Excerpt({ rows }: { rows: ExcerptRow[] }) {
  if (rows.length === 0) return null;
  return (
    <div className="selectable overflow-x-auto border-t border-border-subtle bg-bg font-mono text-[12px] leading-5">
      {rows.map((row, i) => (
        <div
          key={i}
          className={cn(
            "flex min-w-max",
            row.kind === "add" && "bg-add-bg",
            row.kind === "del" && "bg-del-bg",
            row.commented && "shadow-[inset_2px_0_0_var(--accent)]",
          )}
        >
          <span className="w-10 shrink-0 pr-2 text-right text-fg-faint select-none">{row.kind === "del" ? row.old : row.new}</span>
          <span className={cn("w-4 shrink-0 select-none", row.kind === "add" ? "text-add" : "text-del")}>
            {row.kind === "add" ? "+" : row.kind === "del" ? "−" : ""}
          </span>
          <span className="pr-3 whitespace-pre text-fg-muted">{row.text}</span>
        </div>
      ))}
    </div>
  );
}
