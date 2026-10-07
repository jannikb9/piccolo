import * as Dialog from "@radix-ui/react-dialog";
import * as RadioGroup from "@radix-ui/react-radio-group";
import { Check, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { isTauri, onOpenSettings } from "../lib/api";
import { codeThemes, type CodeThemeId } from "../lib/codeThemes";
import { useWorktrunk } from "../lib/queries";
import { useStore } from "../store";
import { InstallStatus, WORKTRUNK_BLURB } from "./WorktrunkDialog";
import { Button } from "./ui";

/** App settings, opened from the app menu or with ⌘,. */
export function SettingsDialog() {
  const [open, setOpen] = useState(false);
  const codeTheme = useStore((s) => s.codeTheme);
  const setCodeTheme = useStore((s) => s.setCodeTheme);

  useEffect(() => onOpenSettings(() => setOpen(true)), []);

  // In the desktop app the menu's ⌘, accelerator handles this; the browser build needs a key handler.
  useEffect(() => {
    if (isTauri) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey && e.key === ",") {
        e.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Content
          aria-describedby={undefined}
          // Start on the selected theme so arrow keys change it right away.
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            (e.currentTarget as HTMLElement).querySelector<HTMLElement>("[role=radio][data-state=checked]")?.focus();
          }}
          className="fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100vh-64px)] w-[440px] max-w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border border-border bg-bg-raised shadow-2xl shadow-black/40 outline-none"
        >
          <header className="flex h-12 shrink-0 items-center border-b border-border-subtle pr-2 pl-4">
            <Dialog.Title className="text-[13px] font-medium">Settings</Dialog.Title>
            <Dialog.Close
              aria-label="Close"
              className="ml-auto grid size-7 place-items-center rounded-md text-fg-subtle hover:bg-bg-hover hover:text-fg"
            >
              <X className="size-4" />
            </Dialog.Close>
          </header>

          <div className="overflow-y-auto">
            <section className="p-4">
              <h3 className="mb-2 text-[12px] font-medium text-fg-subtle">Syntax theme</h3>
              <RadioGroup.Root
                value={codeTheme}
                onValueChange={(v) => setCodeTheme(v as CodeThemeId)}
                aria-label="Syntax theme"
                className="overflow-hidden rounded-lg border border-border"
              >
                {codeThemes.map((theme) => (
                  <Choice key={theme.id} value={theme.id} label={theme.label} description={theme.description} />
                ))}
              </RadioGroup.Root>
              <p className="mt-2 text-[12px] text-fg-faint">Light and dark variants follow your system appearance.</p>
            </section>
            <WorktrunkSetting />
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function WorktrunkSetting() {
  const { installed, install } = useWorktrunk();
  return (
    <section className="border-t border-border-subtle p-4">
      <h3 className="mb-2 text-[12px] font-medium text-fg-subtle">Worktrunk</h3>
      <p className="text-[12px] text-fg-subtle">{WORKTRUNK_BLURB}</p>
      <div className="mt-3 flex min-h-7 items-center gap-3">
        {installed === true ? (
          <p className="flex items-center gap-1.5 text-[13px] text-fg-muted">
            <Check className="size-3.5 text-add" strokeWidth={2.5} /> Installed
          </p>
        ) : (
          <>
            <Button variant="primary" disabled={installed === null || install.isPending} onClick={() => install.mutate()}>
              Install worktrunk
            </Button>
            <InstallStatus busy={install.isPending} error={install.error} />
          </>
        )}
      </div>
    </section>
  );
}

function Choice({ value, label, description }: { value: string; label: string; description: ReactNode }) {
  return (
    <RadioGroup.Item
      value={value}
      className="group flex w-full items-center gap-3 border-b border-border-subtle px-3 py-2.5 text-left outline-none last:border-b-0 hover:bg-bg-hover focus-visible:bg-bg-hover data-[state=checked]:bg-accent-soft"
    >
      <span className="grid size-4 shrink-0 place-items-center rounded-full border border-border-strong group-data-[state=checked]:border-accent">
        <RadioGroup.Indicator className="size-2 rounded-full bg-accent" />
      </span>
      <span className="min-w-0">
        <span className="block text-[13px] font-medium text-fg">{label}</span>
        <span className="block text-[12px] text-fg-subtle">{description}</span>
      </span>
    </RadioGroup.Item>
  );
}
