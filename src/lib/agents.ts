import { useStore } from "../store";
import type { AgentKind, Assignee, AvailableAgent, TerminalId } from "../types";
import { useAvailableAgents } from "./queries";

/** A way to start a new agent session on a request: an agent's app or CLI, or copying its prompt. */
export type LaunchId = `${AgentKind}-${"app" | "cli"}` | "copy";

export type LaunchOption = {
  id: LaunchId;
  /** `null` for a copied prompt, which any agent can take. */
  agent: AgentKind | null;
  via: "app" | "cli" | "copy";
  label: string;
};

/** A new session of an agent, in its app or its CLI in a terminal. */
export type NewSession = Extract<Assignee, { agent: AgentKind }>;

const AGENT_NAMES: Record<AgentKind, string> = { claude: "Claude", codex: "Codex" };

export const COPY_OPTION: LaunchOption = { id: "copy", agent: null, via: "copy", label: "Copy prompt" };

/** Every way to start a session found on this Mac, in menu order, the copied prompt last. */
export function detectedOptions(available: AvailableAgent[]): LaunchOption[] {
  const options: LaunchOption[] = [];
  for (const { agent, app, cli } of available) {
    if (app) options.push({ id: `${agent}-app`, agent, via: "app", label: `${AGENT_NAMES[agent]} app` });
    if (cli) options.push({ id: `${agent}-cli`, agent, via: "cli", label: `${AGENT_NAMES[agent]} CLI` });
  }
  return [...options, COPY_OPTION];
}

/**
 * Whether an option shows before the user chose: an agent's app, its CLI only when it has no app
 * (the ChatGPT app ships Codex's CLI, but people who use Codex there rarely want a terminal), and
 * the copied prompt.
 */
export function shownByDefault(option: LaunchOption, available: AvailableAgent[]) {
  return option.via !== "cli" || !available.find((a) => a.agent === option.agent)?.app;
}

/** The options the user can toggle in Settings, and whether each shows. */
export function useLaunchSettings() {
  const available = useAvailableAgents();
  const shown = useStore((s) => s.shownOptions);
  return detectedOptions(available).map((option) => ({
    option,
    shown: shown[option.id] ?? shownByDefault(option, available),
  }));
}

/** The ways to start a new session that show in menus. */
export function useLaunchOptions(): LaunchOption[] {
  return useLaunchSettings()
    .filter((s) => s.shown)
    .map((s) => s.option);
}

/** Where `option` starts a new session, as the backend takes it; `null` for a copied prompt. */
export function newSession(option: LaunchOption, terminal: "auto" | TerminalId): NewSession | null {
  if (!option.agent) return null;
  return { agent: option.agent, launcher: option.via === "app" ? "app" : terminal };
}
