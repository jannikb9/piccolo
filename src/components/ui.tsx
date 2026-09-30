import * as ContextMenuPrimitive from "@radix-ui/react-context-menu";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import * as ToggleGroup from "@radix-ui/react-toggle-group";
import { Check } from "lucide-react";
import type { ComponentProps, CSSProperties, KeyboardEvent, ReactNode } from "react";
import { cn } from "../lib/utils";
import type { FileStatus } from "../types";

export function Tooltip({ label, children, side = "bottom" }: { label: ReactNode; children: ReactNode; side?: "top" | "bottom" | "left" | "right" }) {
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          sideOffset={6}
          className="z-50 rounded-md border border-border bg-bg-raised px-2 py-1 text-[12px] text-fg-muted shadow-lg shadow-black/20"
        >
          {label}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

export type MenuItem = {
  label: string;
  icon?: ReactNode;
  /** A letter that chooses the item while the menu is open. */
  shortcut?: string;
  onSelect: () => void;
};

/** Wraps `children` (a single element) so that right-clicking it opens a menu of `items`. */
export function ContextMenu({ children, items }: { children: ReactNode; items: MenuItem[] }) {
  // A shortcut letter clicks its item, which runs it and closes the menu. Handled before the
  // menu's own typeahead, which would only move the highlight.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.key.length !== 1) return;
    const item = e.currentTarget.querySelector<HTMLElement>(`[data-shortcut="${e.key.toLowerCase()}"]`);
    if (!item) return;
    e.preventDefault();
    item.click();
  };

  return (
    <ContextMenuPrimitive.Root>
      <ContextMenuPrimitive.Trigger asChild>{children}</ContextMenuPrimitive.Trigger>
      <ContextMenuPrimitive.Portal>
        <ContextMenuPrimitive.Content
          onKeyDown={onKeyDown}
          className="z-50 min-w-44 rounded-md border border-border bg-bg-raised p-1 text-[12.5px] text-fg-muted shadow-lg shadow-black/20"
        >
          {items.map((item) => (
            <ContextMenuPrimitive.Item
              key={item.label}
              onSelect={item.onSelect}
              data-shortcut={item.shortcut?.toLowerCase()}
              className="flex h-7 cursor-default items-center gap-2 rounded px-2 outline-none data-[highlighted]:bg-bg-hover data-[highlighted]:text-fg"
            >
              {item.icon}
              {item.label}
              {item.shortcut && <kbd className="ml-auto pl-4 font-sans text-[11px] text-fg-subtle">{item.shortcut.toUpperCase()}</kbd>}
            </ContextMenuPrimitive.Item>
          ))}
        </ContextMenuPrimitive.Content>
      </ContextMenuPrimitive.Portal>
    </ContextMenuPrimitive.Root>
  );
}

export function IconButton({ label, className, ...props }: ComponentProps<"button"> & { label: string }) {
  return (
    <Tooltip label={label}>
      <button
        type="button"
        aria-label={label}
        className={cn(
          "grid place-items-center rounded-md text-fg-subtle transition-colors hover:bg-bg-hover hover:text-fg",
          // `cn` doesn't resolve conflicting classes, so only default the size when none is given.
          !/(^|\s)size-/.test(className ?? "") && "size-6",
          // Toggles (`aria-pressed`) show their on state in the accent colour.
          "aria-pressed:bg-accent-soft aria-pressed:text-accent",
          className,
        )}
        {...props}
      />
    </Tooltip>
  );
}

type SegmentedOption<T extends string> = { value: T; label: ReactNode; tooltip?: string };

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
}: {
  value: T;
  onChange: (value: T) => void;
  options: SegmentedOption<T>[];
  label: string;
}) {
  return (
    <ToggleGroup.Root
      type="single"
      aria-label={label}
      value={value}
      // Radix emits "" when the active item is clicked again; a segmented control always has a value.
      onValueChange={(v) => v && onChange(v as T)}
      className="flex h-7 items-center gap-px rounded-lg border border-border-subtle bg-bg-inset p-0.5"
    >
      {options.map((o) => {
        const item = (
          <ToggleGroup.Item
            key={o.value}
            value={o.value}
            aria-label={typeof o.label === "string" ? undefined : o.tooltip}
            // Styled via aria-checked: the Tooltip trigger overwrites the item's data-state attribute.
            className={cn(
              "flex h-full items-center gap-1.5 rounded-md px-2 text-[12px] font-medium text-fg-subtle transition-colors",
              "hover:text-fg-muted aria-checked:bg-bg-active aria-checked:text-fg aria-checked:shadow-sm aria-checked:shadow-black/10",
            )}
          >
            {o.label}
          </ToggleGroup.Item>
        );
        return o.tooltip ? (
          <Tooltip key={o.value} label={o.tooltip}>
            {item}
          </Tooltip>
        ) : (
          item
        );
      })}
    </ToggleGroup.Root>
  );
}

const statusMeta: Record<FileStatus, { letter: string; label: string; className: string }> = {
  added: { letter: "A", label: "Added", className: "text-add" },
  modified: { letter: "M", label: "Modified", className: "text-mod" },
  deleted: { letter: "D", label: "Deleted", className: "text-del" },
  renamed: { letter: "R", label: "Renamed", className: "text-ren" },
};

export function StatusLetter({ status, className }: { status: FileStatus; className?: string }) {
  const meta = statusMeta[status];
  return (
    <span
      title={meta.label}
      className={cn("w-3 shrink-0 text-center font-mono text-[11px] font-semibold", meta.className, className)}
    >
      {meta.letter}
    </span>
  );
}

export function StatusBadge({ status }: { status: FileStatus }) {
  const meta = statusMeta[status];
  return (
    <span
      className={cn(
        "rounded border border-current/25 bg-current/8 px-1.5 py-px text-[10px] font-semibold tracking-wide uppercase",
        meta.className,
      )}
    >
      {meta.label}
    </span>
  );
}

export function DiffCount({ additions, deletions, className }: { additions: number; deletions: number; className?: string }) {
  return (
    <span className={cn("tabular flex items-center gap-1.5 font-mono text-[11px]", className)}>
      {additions > 0 && <span className="text-add">+{additions}</span>}
      {deletions > 0 && <span className="text-del">−{deletions}</span>}
    </span>
  );
}

/** GitHub's five-block change ratio indicator. */
export function DiffBlocks({ additions, deletions }: { additions: number; deletions: number }) {
  const total = additions + deletions;
  const blocks = 5;
  const filled = total === 0 ? 0 : Math.min(blocks, Math.max(1, Math.ceil(Math.log10(total + 1) * 2)));
  const adds = total === 0 ? 0 : Math.round((additions / total) * filled);
  return (
    <span className="flex gap-px" aria-hidden>
      {Array.from({ length: blocks }, (_, i) => (
        <span
          key={i}
          className={cn(
            "size-[7px] rounded-[1.5px]",
            i < adds ? "bg-add" : i < filled ? "bg-del" : "bg-border",
          )}
        />
      ))}
    </span>
  );
}

export function Skeleton({ className, style }: { className?: string; style?: CSSProperties }) {
  return <span className={cn("block animate-pulse rounded bg-bg-hover", className)} style={style} />;
}

export function ViewedToggle({ checked, onChange }: { checked: boolean; onChange: () => void }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      onClick={(e) => {
        e.stopPropagation();
        onChange();
      }}
      className={cn(
        "flex h-6 items-center gap-1.5 rounded-md border px-2 text-[12px] font-medium transition-colors",
        checked
          ? "border-accent/40 bg-accent-soft text-fg"
          : "border-border text-fg-subtle hover:border-border-strong hover:text-fg-muted",
      )}
    >
      <span
        className={cn(
          "grid size-3.5 place-items-center rounded-[4px] border transition-colors",
          checked ? "border-accent bg-accent text-accent-fg" : "border-border-strong",
        )}
      >
        {checked && <Check className="size-2.5" strokeWidth={3.5} />}
      </span>
      Viewed
    </button>
  );
}

export function Button({
  variant = "ghost",
  className,
  ...props
}: ComponentProps<"button"> & { variant?: "primary" | "ghost" }) {
  return (
    <button
      type="button"
      className={cn(
        "flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[12px] font-medium transition-colors disabled:pointer-events-none disabled:opacity-50",
        variant === "primary"
          ? "bg-primary text-primary-fg shadow-sm shadow-black/20 hover:bg-primary-hover"
          : "text-fg-muted hover:bg-bg-hover hover:text-fg",
        className,
      )}
      {...props}
    />
  );
}
