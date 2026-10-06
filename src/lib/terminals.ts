import type { AvailableAgent, Launcher, TerminalId, TerminalSetup } from "../types";

export const TERMINAL_NAMES: Record<TerminalId, string> = {
  tmux: "tmux",
  iterm: "iTerm2",
  kitty: "kitty",
  wezterm: "WezTerm",
  terminal: "Terminal",
};

/** Where an agent's CLI opens in `terminal`: a tab where Piccolo can make one, else a window. */
export function terminalPlace(terminal: TerminalId | null, setup?: TerminalSetup) {
  switch (terminal) {
    case null:
      return "a new terminal window";
    case "tmux":
      return "a new tmux window";
    case "kitty":
      return setup?.kittyTabs ? "a new kitty tab" : "a new kitty window";
    case "terminal":
      return "a new Terminal window";
    default:
      return `a new ${TERMINAL_NAMES[terminal]} tab`;
  }
}

/**
 * Where a new session of `agent` starts with `launcher`, as `start_session` (sessions.rs) decides:
 * the chosen place, or the other one when the agent lacks its app or CLI.
 */
export function opensIn(agent: AvailableAgent, launcher: Launcher, setup?: TerminalSetup) {
  const detected = setup?.detected ?? null;
  // `undefined`: the agent's app.
  let terminal: TerminalId | null | undefined;
  if (launcher === "app") terminal = agent.app ? undefined : detected;
  else if (agent.cli) terminal = launcher === "auto" ? detected : launcher;
  const app = agent.agent === "claude" ? "the Claude app" : "the ChatGPT app";
  return `Opens in ${terminal === undefined ? app : terminalPlace(terminal, setup)}`;
}
