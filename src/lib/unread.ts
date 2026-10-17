import { useEffect, type RefObject } from "react";
import type { CommentMessage, GeneralThread, Thread } from "../types";
import { api } from "./api";
import { queryClient } from "./queries";

type AnyThread = Thread | GeneralThread;

/** Agents' messages in `threads` you haven't seen yet. */
export const unreadMessages = (threads: AnyThread[]): CommentMessage[] => threads.flatMap((t) => t.messages.filter((m) => m.unread));

export const hasUnread = (thread: AnyThread): boolean => thread.messages.some((m) => m.unread);

const queued = new Set<number>();
let flushTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Marks messages as read. Messages that come into view together are written in one go; the
 * cached threads change at once, so counts drop without waiting for the database.
 */
export function markRead(ids: number[]) {
  for (const id of ids) queued.add(id);
  flushTimer ??= setTimeout(() => {
    flushTimer = undefined;
    const batch = new Set(queued);
    queued.clear();
    queryClient.setQueriesData<AnyThread[]>({ queryKey: ["threads"] }, (threads) =>
      threads?.map((t) =>
        t.messages.some((m) => m.unread && batch.has(m.id))
          ? { ...t, messages: t.messages.map((m) => (batch.has(m.id) ? { ...m, unread: false } : m)) }
          : t,
      ),
    );
    api
      .markCommentsRead([...batch])
      .catch(() => {})
      .finally(() => queryClient.invalidateQueries({ queryKey: ["threads"] }));
  }, 150);
}

/** How long an agent's message has to be on screen, with the window focused, to count as read. */
const READ_AFTER_MS = 1000;
const THRESHOLDS = Array.from({ length: 21 }, (_, i) => i / 20);

/** Marks an unread message as read once it's been on screen for a moment while the window has focus. */
export function useMarkReadOnScreen(ref: RefObject<HTMLElement | null>, message: CommentMessage) {
  const { id, unread } = message;
  useEffect(() => {
    const element = ref.current;
    if (!unread || !element) return;
    let visible = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const restart = () => {
      clearTimeout(timer);
      if (!visible || !document.hasFocus()) return;
      timer = setTimeout(() => {
        observer.disconnect();
        markRead([id]);
      }, READ_AFTER_MS);
    };
    const observer = new IntersectionObserver(
      ([entry]) => {
        // Enough to read it: half of it, or a good part of a long one.
        visible = entry.intersectionRatio >= 0.5 || entry.intersectionRect.height >= 80;
        restart();
      },
      { threshold: THRESHOLDS },
    );
    observer.observe(element);
    const stop = () => clearTimeout(timer);
    window.addEventListener("focus", restart);
    window.addEventListener("blur", stop);
    return () => {
      stop();
      observer.disconnect();
      window.removeEventListener("focus", restart);
      window.removeEventListener("blur", stop);
    };
  }, [ref, id, unread]);
}
