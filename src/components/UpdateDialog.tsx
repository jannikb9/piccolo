import * as Dialog from "@radix-ui/react-dialog";
import { AlertTriangle, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import appIcon from "../../src-tauri/icons/128x128@2x.png";
import { api, isTauri, onCheckForUpdates, showError, showInfo } from "../lib/api";
import { formatReleaseDate, releasesSince } from "../lib/changelog";
import type { AvailableUpdate } from "../types";
import { Markdown } from "./Markdown";
import { Button } from "./ui";

/** The first check waits for the app to settle; later ones catch releases while it stays open. */
const FIRST_CHECK_DELAY = 5_000;
const CHECK_INTERVAL = 6 * 60 * 60 * 1000;

/**
 * Offers a new version with what changed since the running one. Checks a few seconds after
 * launch, then every few hours, and when Piccolo > Check for Updates… is chosen. "Later" doesn't
 * offer the same version again until the next launch, unless asked from the menu.
 */
export function UpdateDialog() {
  const [update, setUpdate] = useState<AvailableUpdate | null>(null);
  const [open, setOpen] = useState(false);
  /** The version "Later" was chosen for. */
  const declined = useRef<string | null>(null);

  useEffect(() => {
    // Development builds aren't releases; Check for Updates… still works there.
    if (isTauri && import.meta.env.DEV) return;
    const check = () =>
      api
        .checkUpdate()
        .then((found) => {
          if (!found || found.version === declined.current) return;
          setUpdate(found);
          setOpen(true);
        })
        // Offline, or GitHub is down: try again next time.
        .catch(() => {});
    const first = setTimeout(check, FIRST_CHECK_DELAY);
    const interval = setInterval(check, CHECK_INTERVAL);
    return () => {
      clearTimeout(first);
      clearInterval(interval);
    };
  }, []);

  useEffect(
    () =>
      onCheckForUpdates(async () => {
        try {
          const found = await api.checkUpdate();
          if (found) {
            setUpdate(found);
            setOpen(true);
          } else {
            await showInfo("You're up to date", `Piccolo ${await api.appVersion()} is the newest version.`);
          }
        } catch (e) {
          await showError("Couldn't check for updates", String(e));
        }
      }),
    [],
  );

  if (!update) return null;
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) declined.current = update.version;
        setOpen(next);
      }}
    >
      {/* Mounted per offer, so it starts fresh rather than in the last one's progress or error. */}
      {open && <UpdateContent key={update.version} update={update} />}
    </Dialog.Root>
  );
}

type Install =
  | { step: "offered" }
  /** `fraction` is `null` while the size is unknown. */
  | { step: "downloading"; fraction: number | null }
  | { step: "restarting" }
  | { step: "failed"; error: string };

function UpdateContent({ update }: { update: AvailableUpdate }) {
  const [install, setInstall] = useState<Install>({ step: "offered" });
  const busy = install.step === "downloading" || install.step === "restarting";
  const releases = useMemo(() => releasesSince(update.changelog, update.currentVersion), [update]);

  const start = () => {
    setInstall({ step: "downloading", fraction: 0 });
    api
      .installUpdate(({ downloaded, total }) =>
        setInstall({ step: "downloading", fraction: total ? Math.min(1, downloaded / total) : null }),
      )
      // The app restarts once it's installed; in the browser build the promise resolves instead.
      .then(() => setInstall({ step: "restarting" }))
      .catch((e) => setInstall({ step: "failed", error: String(e) }));
  };

  return (
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
      <Dialog.Content
        aria-describedby={undefined}
        // Closing mid-install would hide that the app is about to restart.
        onEscapeKeyDown={(e) => busy && e.preventDefault()}
        onInteractOutside={(e) => busy && e.preventDefault()}
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          (e.currentTarget as HTMLElement).querySelector<HTMLElement>("[data-primary]")?.focus();
        }}
        className="fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100vh-64px)] w-[480px] max-w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border border-border bg-bg-raised shadow-2xl shadow-black/40 outline-none"
      >
        <header className="flex shrink-0 items-center gap-3 border-b border-border-subtle py-3 pr-2 pl-4">
          <img src={appIcon} alt="" className="size-10 shrink-0" />
          <div className="min-w-0">
            <Dialog.Title className="text-[14px] font-semibold text-fg">Piccolo {update.version} is available</Dialog.Title>
            <p className="text-[12px] text-fg-subtle">You have {update.currentVersion}.</p>
          </div>
          {!busy && (
            <Dialog.Close
              aria-label="Close"
              className="mb-auto ml-auto grid size-7 shrink-0 place-items-center rounded-md text-fg-subtle hover:bg-bg-hover hover:text-fg"
            >
              <X className="size-4" />
            </Dialog.Close>
          )}
        </header>

        {releases.length > 0 && (
          <div className="min-h-0 overflow-y-auto px-4 py-3">
            <h3 className="mb-2 text-[12px] font-medium text-fg-subtle">What's new</h3>
            {releases.map((release) => (
              <section key={release.version} className="mb-4 last:mb-1">
                <h4 className="mb-1.5 flex items-baseline gap-2 text-[13px]">
                  <span className="font-semibold text-fg">{release.version}</span>
                  {release.date && <span className="text-[12px] text-fg-faint">{formatReleaseDate(release.date)}</span>}
                </h4>
                <Markdown text={release.notes} className="text-[13px] text-fg-muted" />
              </section>
            ))}
          </div>
        )}

        <footer className="flex shrink-0 items-center gap-2 border-t border-border-subtle px-4 py-3">
          <Status install={install} />
          <Dialog.Close asChild>
            <Button disabled={busy} className="ml-auto">
              Later
            </Button>
          </Dialog.Close>
          <Button variant="primary" data-primary onClick={start} disabled={busy}>
            {install.step === "failed" ? "Try again" : "Update and restart"}
          </Button>
        </footer>
      </Dialog.Content>
    </Dialog.Portal>
  );
}

function Status({ install }: { install: Install }) {
  if (install.step === "failed") {
    return (
      <p className="flex min-w-0 items-center gap-1.5 text-[12px] text-fg-muted" title={install.error}>
        <AlertTriangle className="size-3.5 shrink-0 text-del" />
        <span className="truncate">Couldn't update: {install.error}</span>
      </p>
    );
  }
  if (install.step === "restarting" || (install.step === "downloading" && install.fraction === 1)) {
    return <p className="text-[12px] text-fg-subtle">{install.step === "restarting" ? "Restarting…" : "Installing…"}</p>;
  }
  if (install.step !== "downloading") return null;
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      {install.fraction !== null && (
        <div
          role="progressbar"
          aria-valuenow={Math.round(install.fraction * 100)}
          className="h-1.5 w-full max-w-40 overflow-hidden rounded-full bg-bg-active"
        >
          <div className="h-full bg-accent" style={{ width: `${install.fraction * 100}%` }} />
        </div>
      )}
      <p className="tabular shrink-0 text-[12px] text-fg-subtle">
        Downloading…{install.fraction !== null && ` ${Math.round(install.fraction * 100)}%`}
      </p>
    </div>
  );
}
