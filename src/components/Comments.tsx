import { CheckCircle2, ChevronRight, Pencil, RotateCcw, Trash2, User } from "lucide-react";
import { useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent, type ReactNode } from "react";
import { showError } from "../lib/api";
import { clipboardImages, prepareImage, type DraftImage } from "../lib/images";
import { useDeleteComment, useEditComment, useReplyThread, useSetThreadResolved } from "../lib/queries";
import { agentLabel, cn, timeAgo } from "../lib/utils";
import { editKey, replyKey, useStore } from "../store";
import type { CommentMessage, ExcerptRow, LineRange, Thread } from "../types";
import { DraftImages, MessageImages, useDraftImages } from "./Images";
import { AgentIcon } from "./AgentIcon";
import { SendThreadButton } from "./SendToAgent";
import { Button, Tooltip } from "./ui";

/** "line 12", "lines 12–14"; ranges across both sides of a unified diff name the sides. */
export function describeRange(range: LineRange): string {
  const { startSide, startLine, endSide, endLine } = range;
  const sign = (side: LineRange["startSide"]) => (side === "deletions" ? "−" : "+");
  if (startSide !== endSide) return `lines ${sign(startSide)}${startLine} to ${sign(endSide)}${endLine}`;
  const prefix = startSide === "deletions" ? "−" : "";
  return startLine === endLine ? `line ${prefix}${startLine}` : `lines ${prefix}${startLine}–${prefix}${endLine}`;
}

/**
 * Card chrome shared by threads and the composer, inset from the diff's edges. Cards sit in a diff
 * column, so their content (an excerpt's long lines, an image) mustn't widen it: inline-size
 * containment makes them take the column's width instead of their content's.
 */
function Card({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className="px-3 py-2 font-sans [contain:inline-size]">
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
    const field = ref.current;
    if (!autoFocus || !field) return;
    field.focus({ preventScroll: true });
    // After any text it starts with (an edit).
    field.setSelectionRange(field.value.length, field.value.length);
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
      <div className="px-3 py-1.5 font-sans [contain:inline-size]">
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

  // Like GitHub, a comment on several lines names them (the card sits under the last one).
  const { position } = thread;
  const multiLine = !!position && (position.startSide !== position.endSide || position.startLine !== position.endLine);
  return (
    <Card>
      {note ??
        (multiLine && (
          <div className="border-b border-border-subtle px-3 py-1.5 text-[12px] text-fg-subtle">
            Comment on {describeRange(position)}
          </div>
        ))}
      {thread.messages.map((message, i) => (
        <MessageRow key={message.id} message={message} isFirst={i === 0} />
      ))}
      <div className="flex items-start gap-2 border-t border-border-subtle p-2">
        <ReplyBox threadId={thread.id} />
        <SendThreadButton thread={thread} />
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

/** "You", or the agent's name as it signed ("Codex"), or "Agent". */
function authorLabel(message: CommentMessage): string {
  if (message.author === "reviewer") return "You";
  return message.authorName ? agentLabel(message.authorName) : "Agent";
}

function MessageRow({ message, isFirst }: { message: CommentMessage; isFirst: boolean }) {
  const isAgent = message.author === "agent";
  // Known agents show their own mark; others a bot, the reviewer a person.
  const brand = isAgent && (message.authorName === "claude" || message.authorName === "codex");
  const editing = useStore((s) => s.editDrafts[message.id] !== undefined);
  const setEditDraft = useStore((s) => s.setEditDraft);
  return (
    <div className="group border-border-subtle px-3 py-2.5 [&+&]:border-t">
      <div className="flex h-5 items-center gap-2 text-[12px]">
        <span
          className={cn(
            "grid size-5 shrink-0 place-items-center rounded-full",
            brand ? "" : isAgent ? "bg-accent-soft text-accent" : "bg-bg-active text-fg-muted",
          )}
        >
          {isAgent ? <AgentIcon name={message.authorName} className={brand ? "size-4" : "size-3"} /> : <User className="size-3" />}
        </span>
        <span className="font-medium text-fg">{authorLabel(message)}</span>
        <Tooltip label={new Date(message.createdAt).toLocaleString()}>
          <span className="tabular text-fg-subtle">{timeAgo(message.createdAt)}</span>
        </Tooltip>
        {message.editedAt && (
          <Tooltip label={`Edited ${new Date(message.editedAt).toLocaleString()}`}>
            <span className="text-fg-faint">edited</span>
          </Tooltip>
        )}
        <span className="ml-auto flex items-center gap-0.5">
          {/* Only your own comments; an agent's answer stays as it wrote it. */}
          {!isAgent && !editing && (
            <button
              type="button"
              aria-label="Edit comment"
              onClick={() => setEditDraft(message.id, message.body)}
              className="flex h-5 items-center rounded px-1 text-fg-faint opacity-0 transition-[opacity,colors] group-hover:opacity-100 hover:text-fg-muted"
            >
              <Pencil className="size-3" />
            </button>
          )}
          <DeleteButton messageId={message.id} label={isFirst ? "Delete thread" : "Delete comment"} />
        </span>
      </div>
      {editing ? (
        <MessageEditor message={message} />
      ) : (
        message.body && (
          <p className="selectable mt-1 pl-7 leading-5 break-words whitespace-pre-wrap text-fg-muted">{message.body}</p>
        )
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
        "flex h-5 items-center gap-1 rounded px-1 text-[11px] transition-[opacity,colors]",
        armed ? "bg-del-bg text-del opacity-100" : "text-fg-faint opacity-0 group-hover:opacity-100 hover:text-fg-muted",
      )}
    >
      <Trash2 className="size-3" />
      {armed && (label === "Delete thread" ? "Delete thread?" : "Delete?")}
    </button>
  );
}

/** Edits a message in place; pasted screenshots are added to the ones it has. */
function MessageEditor({ message }: { message: CommentMessage }) {
  const draft = useStore((s) => s.editDrafts[message.id] ?? "");
  const setEditDraft = useStore((s) => s.setEditDraft);
  const editComment = useEditComment();
  const key = editKey(message.id);
  const images = useDraftImages(key);
  const canSubmit = !!draft.trim() || images.length > 0 || message.attachments.length > 0;
  const changed = draft.trim() !== message.body.trim() || images.length > 0;
  const close = () => setEditDraft(message.id, null);
  const submit = () => {
    if (!canSubmit) return;
    if (!changed) return close();
    editComment.mutate({ id: message.id, body: draft, images }, { onSuccess: close });
  };
  return (
    <div className="mt-1.5 ml-7 rounded-md border border-border bg-bg focus-within:border-border-strong">
      <CommentField
        imageKey={key}
        value={draft}
        onChange={(value) => setEditDraft(message.id, value)}
        onSubmit={submit}
        onCancel={() => !changed && close()}
        placeholder="Edit the comment, or paste a screenshot"
        autoFocus
      />
      <FieldActions
        hint="⌘↩ to save"
        submitLabel="Save"
        canSubmit={canSubmit}
        pending={editComment.isPending}
        error={editComment.error}
        onSubmit={submit}
        onCancel={close}
      />
    </div>
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
