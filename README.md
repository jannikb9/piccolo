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

## Status

- [x] M1 — App shell: window chrome, design tokens (dark/light), resizable three-column layout
- [x] M2 — Repos & worktrees from git, changed-file lists, switching (⌘1–9, ⌥↑/↓), auto-discovery
- [ ] M3 — Real diffs: changed-file tree, `@pierre/diffs` + Shiki, split/unified, renames/binary
- [ ] M4 — Review flow: viewed state with content fingerprints, keyboard nav, expand context, live refresh
- [ ] M5 — Polish: empty/loading/error states, large-diff performance, transitions

## Layout

```
src/
  App.tsx               three-panel layout
  components/
    Sidebar.tsx         repos → worktrees
    FilePanel.tsx       changed-file tree + viewed progress
    ReviewPane.tsx      toolbar + diff stream with sticky file headers
    MockDiff.tsx        placeholder diff body (replaced in M3)
    ui.tsx              primitives: Tooltip, Segmented, badges, Viewed toggle
  lib/
    api.ts              typed wrappers around Tauri commands and events
    queries.ts          TanStack Query hooks, live refresh on focus / repo changes
  styles.css            design tokens (OKLCH) + Tailwind theme
  store.ts              UI state (Zustand, persisted), worktree ordering
  types.ts              shapes returned by the Rust backend
  mock.ts               placeholder data used when running in a plain browser
src-tauri/src/
  git.rs                git CLI wrapper: worktrees, status, changed files (+ tests)
  repos.rs              saved repo list and the Tauri commands
  watch.rs              watches .git for added/removed worktrees and branch switches
```
