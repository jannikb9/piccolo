// Syntax themes offered in the app. Each pairs a dark and a light Shiki theme; the app follows the
// system appearance.

export const codeThemes = [
  {
    id: "github",
    label: "GitHub",
    description: "The colours of GitHub pull requests",
    dark: "github-dark-default",
    light: "github-light-default",
  },
  {
    id: "github-dimmed",
    label: "GitHub Dimmed",
    description: "GitHub with softer contrast in dark mode",
    dark: "github-dark-dimmed",
    light: "github-light-default",
  },
  { id: "vitesse", label: "Vitesse", description: "Muted and warm", dark: "vitesse-dark", light: "vitesse-light" },
  { id: "min", label: "Minimal", description: "Mostly monochrome", dark: "min-dark", light: "min-light" },
  { id: "pierre", label: "Pierre", description: "Vivid, with many colours", dark: "pierre-dark", light: "pierre-light" },
] as const;

export type CodeThemeId = (typeof codeThemes)[number]["id"];

export function shikiThemes(id: CodeThemeId) {
  const theme = codeThemes.find((t) => t.id === id) ?? codeThemes[0];
  return { dark: theme.dark, light: theme.light };
}
