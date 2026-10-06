import * as Dialog from "@radix-ui/react-dialog";
import * as RadioGroup from "@radix-ui/react-radio-group";
import { Check, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useLaunchSettings, type LaunchOption } from "../lib/agents";
import { isTauri, onOpenSettings } from "../lib/api";
import { codeThemes, type CodeThemeId } from "../lib/codeThemes";
import { useTerminalSetup } from "../lib/queries";
import { TERMINAL_NAMES, terminalPlace } from "../lib/terminals";
import { useStore } from "../store";
import type { TerminalId } from "../types";

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
            {open && <AgentSettings />}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
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

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** What each way to start an agent does, in Settings. */
function describe(option: LaunchOption) {
  switch (option.via) {
    case "app":
      return option.agent === "claude" ? "A new session in the Claude app" : "A new chat in the ChatGPT app";
    case "cli":
      return "A new session in your terminal";
    case "copy":
      return "Copies a prompt to paste into any agent";
  }
}

/** Which ways to start agents the menus offer, and the terminal their CLIs open in. */
function AgentSettings() {
  const options = useLaunchSettings();
  const setShown = useStore((s) => s.setOptionShown);
  const terminal = useStore((s) => s.cliTerminal);
  const setTerminal = useStore((s) => s.setCliTerminal);
  // Read when Settings opens: the terminal "Automatic" picks follows the app the user was in.
  const setup = useTerminalSetup();
  const detected = setup?.detected ?? null;
  const hasCli = options.some(({ option }) => option.via === "cli");
  return (
    <section className="border-t border-border-subtle p-4">
      <h3 className="mb-2 text-[12px] font-medium text-fg-subtle">Start agents with</h3>
      <div role="group" aria-label="Start agents with" className="overflow-hidden rounded-lg border border-border">
        {options.map(({ option, shown }) => (
          <button
            key={option.id}
            type="button"
            role="checkbox"
            aria-checked={shown}
            onClick={() => setShown(option.id, !shown)}
            className="group flex w-full items-center gap-3 border-b border-border-subtle px-3 py-2.5 text-left outline-none last:border-b-0 hover:bg-bg-hover focus-visible:bg-bg-hover"
          >
            <span className="grid size-4 shrink-0 place-items-center rounded-[4px] border border-border-strong group-aria-checked:border-accent group-aria-checked:bg-accent">
              {shown && <Check className="size-3 text-accent-fg" strokeWidth={3} />}
            </span>
            <span className="min-w-0">
              <span className="block text-[13px] font-medium text-fg">{option.label}</span>
              <span className="block text-[12px] text-fg-subtle">{describe(option)}</span>
            </span>
          </button>
        ))}
      </div>
      <p className="mt-2 text-[12px] text-fg-faint">
        The options shown when requesting a review or sending comments. Only agents found on this Mac are listed.
      </p>

      {hasCli && (
        <>
          <h3 className="mt-4 mb-2 text-[12px] font-medium text-fg-subtle">CLIs open in</h3>
          <RadioGroup.Root
            value={terminal}
            onValueChange={(v) => setTerminal(v as "auto" | TerminalId)}
            aria-label="CLIs open in"
            className="overflow-hidden rounded-lg border border-border"
          >
            <Choice
              value="auto"
              label="Automatic"
              description={`tmux while you're attached to it, else the terminal you used last. Now: ${terminalPlace(detected, setup)}.`}
            />
            {setup?.installed.map((terminal) => (
              <Choice
                key={terminal}
                value={terminal}
                label={TERMINAL_NAMES[terminal]}
                description={
                  terminal === "kitty" && !setup.kittyTabs ? (
                    <>
                      New windows. For tabs, turn on remote control in kitty.conf:{" "}
                      <code className="font-mono text-[11px]">allow_remote_control socket-only</code> and{" "}
                      <code className="font-mono text-[11px]">listen_on unix:/tmp/kitty</code>.
                    </>
                  ) : (
                    capitalize(terminalPlace(terminal, setup))
                  )
                }
              />
            ))}
          </RadioGroup.Root>
        </>
      )}
    </section>
  );
}
