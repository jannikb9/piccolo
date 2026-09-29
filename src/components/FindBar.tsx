import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
import { useEffect, useRef, type KeyboardEvent } from "react";
import { cn } from "../lib/utils";
import { IconButton } from "./ui";

/** The browser-style find bar over the diff: Enter / ⇧Enter step through matches, Esc closes. */
export function FindBar({
  query,
  onQueryChange,
  count,
  current,
  capped,
  focusKey,
  onStep,
  onClose,
}: {
  query: string;
  onQueryChange: (query: string) => void;
  count: number;
  /** Index of the current match, or -1. */
  current: number;
  /** The match list stopped at its limit, so `count` is a lower bound. */
  capped: boolean;
  /** Changes whenever ⌘F is pressed again, to refocus and select the query. */
  focusKey: number;
  onStep: (delta: 1 | -1) => void;
  onClose: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, [focusKey]);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      onStep(e.shiftKey ? -1 : 1);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div className="absolute top-2 right-6 z-20 flex h-9 items-center gap-1 rounded-lg border border-border bg-bg-raised pr-1 pl-2.5 shadow-lg shadow-black/25">
      <Search className="size-3.5 shrink-0 text-fg-subtle" />
      <input
        ref={input}
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Find in changes"
        spellCheck={false}
        aria-label="Find in changes"
        className="selectable w-52 bg-transparent px-1 text-[13px] text-fg outline-none placeholder:text-fg-faint"
      />
      <span
        className={cn(
          "tabular min-w-16 shrink-0 text-right text-[12px]",
          query && count === 0 ? "text-del" : "text-fg-subtle",
        )}
      >
        {!query
          ? ""
          : count === 0
            ? "No results"
            : current < 0
              ? `${count}${capped ? "+" : ""} ${count === 1 ? "match" : "matches"}`
              : `${current + 1} of ${count}${capped ? "+" : ""}`}
      </span>
      <span className="mx-1 h-4 w-px bg-border" />
      <IconButton label="Previous match (⇧↩)" disabled={count === 0} onClick={() => onStep(-1)} className="disabled:opacity-40">
        <ChevronUp className="size-4" />
      </IconButton>
      <IconButton label="Next match (↩)" disabled={count === 0} onClick={() => onStep(1)} className="disabled:opacity-40">
        <ChevronDown className="size-4" />
      </IconButton>
      <IconButton label="Close (Esc)" onClick={onClose}>
        <X className="size-3.5" />
      </IconButton>
    </div>
  );
}
