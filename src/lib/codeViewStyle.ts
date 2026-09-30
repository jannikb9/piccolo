import type { CSSProperties } from "react";

// Shared by the diff and the file view (components/DiffView.tsx, components/CodeNav.tsx).

// Code and chrome share the app's fonts; syntax colours come from the Pierre themes.
export const viewStyle = {
  "--diffs-font-family": '"JetBrains Mono Variable", ui-monospace, "SF Mono", Menlo, monospace',
  "--diffs-font-size": "12px",
  "--diffs-line-height": "20px",
  "--diffs-header-font-family": '"Inter Variable", ui-sans-serif, system-ui, sans-serif',
} as CSSProperties;

// Injected into each diff's (and file's) shadow root. The theme sets its background on :host, so matching the
// app surface needs to happen in here; the body then gets the card border under our header.
export const unsafeCSS = /* css */ `
  :host {
    --diffs-dark-bg: var(--bg);
    --diffs-light-bg: var(--bg);

    /* GitHub's diff colours (see --add-* / --del-* in styles.css): tinted lines, stronger line
       numbers, strongest on the changed words. */
    --diffs-addition-color-override: var(--add);
    --diffs-deletion-color-override: var(--del);
    --diffs-bg-addition-override: var(--add-bg);
    --diffs-bg-addition-number-override: var(--add-gutter);
    --diffs-bg-addition-emphasis-override: var(--add-word);
    --diffs-bg-deletion-override: var(--del-bg);
    --diffs-bg-deletion-number-override: var(--del-gutter);
    --diffs-bg-deletion-emphasis-override: var(--del-word);
    --diffs-fg-number-override: var(--fg-faint);
    --diffs-fg-number-addition-override: var(--fg-muted);
    --diffs-fg-number-deletion-override: var(--fg-muted);
    --diffs-bg-separator-override: var(--hunk-bg);
  }
  /* The library blends those colours into the background again (to 20% or less); use them as
     given, as GitHub does. Unchanged lines blend with the background itself, so stay plain. */
  [data-diff] :is([data-line], [data-no-newline], [data-column-number], [data-gutter-buffer]) {
    --mix-light: 0%;
    --mix-dark: 0%;
  }
  [data-separator] {
    color: var(--hunk-fg);
  }
  [data-diffs-header] {
    background: var(--bg);
  }
  [data-diff] {
    border: 1px solid var(--border);
    border-top: 0;
    border-radius: 0 0 8px 8px;
    overflow: clip;
  }
  /* A whole file (components/CodeNav.tsx) has no header above it. */
  [data-file] {
    border: 1px solid var(--border);
    border-radius: 8px;
    overflow: clip;
  }
  /* The app chrome disables selection; code should be selectable. Holding ⌘ over a name makes it
     a link (see components/CodeNav.tsx). */
  [data-code] {
    user-select: text;
    -webkit-user-select: text;
    cursor: var(--code-cursor, text);
  }
  /* Selected lines (for commenting) and the gutter "+" use the app accent, tinted lightly so
     the code stays readable. */
  :host {
    --diffs-selection-base: var(--accent);
    --diffs-bg-selection-override: color-mix(in oklab, var(--accent) 30%, var(--bg));
    --diffs-bg-selection-number-override: color-mix(in oklab, var(--accent) 45%, var(--bg));
  }
  [data-utility-button] {
    background-color: var(--accent);
    color: var(--accent-fg);
    border-radius: 5px;
    box-shadow: 0 1px 2px rgb(0 0 0 / 0.25);
  }
  [data-utility-button]:hover {
    filter: brightness(1.12);
  }
  [data-line-annotation] {
    --diffs-annotation-bg: var(--bg);
  }
  /* ⌘F matches, painted with the CSS Custom Highlight API (see lib/search.ts). */
  ::highlight(review-find) {
    background-color: color-mix(in oklab, var(--mod) 38%, transparent);
  }
  ::highlight(review-find-current) {
    background-color: var(--mod);
    color: oklch(0.2 0.02 70);
  }
  /* Other occurrences of the selected text. */
  ::highlight(review-occurrence) {
    background-color: color-mix(in oklab, var(--accent) 30%, transparent);
  }
  /* The name under the pointer while ⌘ is held. */
  ::highlight(review-symbol) {
    color: var(--accent);
    text-decoration: underline;
  }
`;
