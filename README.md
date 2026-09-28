# Review

A local desktop app for reviewing changes in git worktrees and branches, PR-style.

Stack: Tauri 2 (Rust) · React 19 · TypeScript · Vite · Tailwind v4 · Radix · Zustand.

## Development

```bash
pnpm install
pnpm tauri dev      # desktop app
pnpm dev            # UI only, in a browser at http://localhost:1420
```

## Status

- [x] M1 — App shell: window chrome, design tokens (dark/light), resizable three-column layout (mock data)
- [ ] M2 — Repos & worktrees from git (`git worktree list`), switching, auto-discovery
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
  styles.css            design tokens (OKLCH) + Tailwind theme
  store.ts              UI state (Zustand)
  types.ts              shapes the Rust backend will return
  mock.ts               placeholder data (replaced in M2)
src-tauri/              Rust backend (git service lands in M2)
```
