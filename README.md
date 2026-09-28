# Review

A local desktop app for reviewing changes in git worktrees and branches, PR-style.

Stack: Tauri 2 (Rust) · React 19 · TypeScript · Vite · Tailwind v4 · Radix · Zustand.

## Development

```bash
pnpm install
pnpm tauri dev      # desktop app
pnpm dev            # UI only, in a browser at http://localhost:1420 (placeholder data)
cd src-tauri && cargo test
```

Install a local build (unsigned, for this machine):

```bash
pnpm tauri build --bundles app
cp -R src-tauri/target/release/bundle/macos/Review.app /Applications/
```

## Status

- [x] M1 — App shell: window chrome, design tokens (dark/light), resizable three-column layout
- [x] M2 — Repos & worktrees from git, changed-file lists, switching (⌘1–9, ⌥↑/↓), auto-discovery
- [x] M3 — Real diffs: `@pierre/diffs` CodeView (virtualized, worker-highlighted), split/unified, expandable context, hide whitespace
- [x] Syntax themes: GitHub by default, others selectable in Settings (⌘,)
- [ ] M4 — Review flow: viewed state with content fingerprints, keyboard nav, live refresh
- [ ] M5 — Polish: empty/loading/error states, large-diff performance, transitions

### Backlog

- Live refresh while an agent edits. Today the diff refreshes when the window regains focus;
  added/removed worktrees and branch switches update live (watcher on `.git`).
- Viewed state: persist it, and reset a file's tick when its contents change (content fingerprint).
  Currently in memory only.
- Keyboard: `j`/`k` next/previous file, `v` viewed, `x` collapse.
- Choose the base branch per worktree (currently the repo default: origin/HEAD → main → master).
- Image previews for binary files; a proper app icon.
- Later: line comments with an interface agents can read (MCP server + CLI), ⌘K palette.

## Layout

```
src/
  App.tsx               three-panel layout
  components/
    Sidebar.tsx         repos → worktrees
    FilePanel.tsx       changed-file tree + viewed progress
    ReviewPane.tsx      toolbar + loading/error/empty states around the diff
    DiffView.tsx        CodeView from @pierre/diffs with our file headers
    SettingsDialog.tsx  settings (⌘, / app menu): syntax theme
    ui.tsx              primitives: Tooltip, Segmented, badges, Viewed toggle
  lib/
    api.ts              typed wrappers around Tauri commands and events
    diff.ts             patch parsing, default-collapsed files (lockfiles, generated)
    codeThemes.ts       syntax themes (Shiki) offered in Settings
    queries.ts          TanStack Query hooks, live refresh on focus / repo changes
  styles.css            design tokens (OKLCH) + Tailwind theme
  store.ts              UI state (Zustand, persisted), worktree ordering
  types.ts              shapes returned by the Rust backend
  mock.ts               placeholder data used when running in a plain browser
src-tauri/src/
  git.rs                git CLI wrapper: worktrees, status, changed files, patches, file contents (+ tests)
  repos.rs              saved repo list and the Tauri commands
  watch.rs              watches .git for added/removed worktrees and branch switches
  menu.rs               native menu bar with Settings… (⌘,)
```
