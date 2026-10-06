import type { TerminalId, TerminalSetup } from "../types";

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
