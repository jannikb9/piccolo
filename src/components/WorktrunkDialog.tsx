import * as Dialog from "@radix-ui/react-dialog";
import { AlertTriangle, Check, LoaderCircle, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useWorktrunk } from "../lib/queries";
import { useStore } from "../store";
import { Button } from "./ui";

/** The first check waits for the app to settle, and for the update offer, which comes first. */
const OFFER_DELAY = 2_000;

/** What worktrunk does for Piccolo, as shown in the offer and in Settings. */
export const WORKTRUNK_BLURB =
  "We recommend worktrunk for the best experience with worktrees: Piccolo then creates them where your others live, runs your project's hooks (like installing dependencies), and removes them in the background. It's optional: without it, Piccolo uses plain git.";

/**
 * Offers to install worktrunk when it's missing, a couple of seconds after launch. "Not now" asks
 * again next launch; "Don't ask again" turns the offer off (Settings still installs it).
 */
export function WorktrunkDialog() {
  const { installed } = useWorktrunk();
  const offer = useStore((s) => s.offerWorktrunk);
  const setOffer = useStore((s) => s.setOfferWorktrunk);
  const [open, setOpen] = useState(false);
  /** Whether the offer has been made (or declined) in this launch. */
  const made = useRef(false);

  useEffect(() => {
    if (installed !== false || !offer || made.current) return;
    const timer = setTimeout(() => {
      made.current = true;
      setOpen(true);
    }, OFFER_DELAY);
    return () => clearTimeout(timer);
  }, [installed, offer]);

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      {/* Mounted per offer, so it starts fresh rather than in the last one's progress or error. */}
      {open && <WorktrunkContent onNever={() => setOffer(false)} />}
    </Dialog.Root>
  );
}

function WorktrunkContent({ onNever }: { onNever: () => void }) {
  const { installed, install } = useWorktrunk();
  const done = installed === true;
  const busy = install.isPending;

  return (
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
      <Dialog.Content
        aria-describedby={undefined}
        // Closing mid-install would hide that it's still going.
        onEscapeKeyDown={(e) => busy && e.preventDefault()}
        onInteractOutside={(e) => busy && e.preventDefault()}
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          (e.currentTarget as HTMLElement).querySelector<HTMLElement>("[data-primary]")?.focus();
        }}
        className="fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100vh-64px)] w-[460px] max-w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border border-border bg-bg-raised shadow-2xl shadow-black/40 outline-none"
      >
        <header className="flex h-12 shrink-0 items-center border-b border-border-subtle pr-2 pl-4">
          <Dialog.Title className="text-[13px] font-medium">{done ? "worktrunk installed" : "Install worktrunk?"}</Dialog.Title>
          {!busy && (
            <Dialog.Close
              aria-label="Close"
              className="ml-auto grid size-7 place-items-center rounded-md text-fg-subtle hover:bg-bg-hover hover:text-fg"
            >
              <X className="size-4" />
            </Dialog.Close>
          )}
        </header>

        <div className="space-y-2 px-4 py-3 text-[13px] text-fg-muted">
          <p>{WORKTRUNK_BLURB}</p>
          <p className="text-[12px] text-fg-subtle">
            Installs with Homebrew if you have it. Otherwise it downloads <code>wt</code> from worktrunk's GitHub release into{" "}
            <code>~/.local/bin</code>, and your shell setup stays as it is.
          </p>
        </div>

        <footer className="flex shrink-0 items-center gap-2 border-t border-border-subtle px-4 py-3">
          {done ? (
            <p className="flex items-center gap-1.5 text-[12px] text-fg-muted">
              <Check className="size-3.5 text-add" strokeWidth={2.5} /> worktrunk is installed.
            </p>
          ) : (
            <InstallStatus busy={busy} error={install.error} />
          )}
          {done ? (
            <Dialog.Close asChild>
              <Button variant="primary" data-primary className="ml-auto">
                Done
              </Button>
            </Dialog.Close>
          ) : (
            <>
              <Dialog.Close asChild>
                <Button disabled={busy} className="ml-auto" onClick={onNever}>
                  Don't ask again
                </Button>
              </Dialog.Close>
              <Dialog.Close asChild>
                <Button disabled={busy}>Not now</Button>
              </Dialog.Close>
              <Button variant="primary" data-primary disabled={busy} onClick={() => install.mutate()}>
                {install.isError ? "Try again" : "Install worktrunk"}
              </Button>
            </>
          )}
        </footer>
      </Dialog.Content>
    </Dialog.Portal>
  );
}

/** Progress while installing, or why it failed. */
export function InstallStatus({ busy, error }: { busy: boolean; error: unknown }) {
  if (busy) {
    return (
      <p className="flex items-center gap-1.5 text-[12px] text-fg-subtle">
        <LoaderCircle className="size-3.5 animate-spin" /> Installing…
      </p>
    );
  }
  if (!error) return null;
  return (
    <p className="flex min-w-0 items-center gap-1.5 text-[12px] text-fg-muted" title={String(error)}>
      <AlertTriangle className="size-3.5 shrink-0 text-del" />
      <span className="truncate">Couldn't install: {String(error)}</span>
    </p>
  );
}
