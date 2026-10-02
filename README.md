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
# Quit Review first; replace the bundle rather than copying over it (macOS kills a binary
# that was overwritten in place).
rm -rf /Applications/Review.app && cp -R src-tauri/target/release/bundle/macos/Review.app /Applications/
```

## Comments for agents

Hover a line in the diff and click the **+** (or drag it over several lines) to comment, like on
GitHub. Comments belong to the branch and are stored in
`~/Library/Application Support/dev.jb.review/comments.db`, which the `review` command reads too.
Paste a screenshot (⌘V) into a comment or reply to attach it; images are scaled to at most 2000px,
saved as PNGs in `attachments/` next to the database, and `review comments` lists their paths so an
agent can open them.

`review` is the app binary run with a subcommand. Link it onto your PATH once (bundling an installer
is still open):

```bash
ln -sf /Applications/Review.app/Contents/MacOS/review ~/.local/bin/review
```

Then in any worktree:

```bash
review comments            # open comments on this branch, with the code they're about (--all, --json)
review reply 12 "Fixed"    # answer as the agent; shows up in the app right away
review resolve 12          # or: review reopen 12
```

Tell your agent about it, e.g. in `CLAUDE.md` / `AGENTS.md`: *Run `review comments` to see review
feedback on this branch; after addressing a comment, reply with `review reply <id> "<what changed>"`.*

## Status

- [x] M1 — App shell: window chrome, design tokens (dark/light), resizable three-column layout
- [x] M2 — Repos & worktrees from git, changed-file lists, switching (⌘1–9, ⌥↑/↓), auto-discovery, drag to reorder repos
- [x] M3 — Real diffs: `@pierre/diffs` CodeView (virtualized, worker-highlighted), split/unified, expandable context, hide whitespace
- [x] Syntax themes: GitHub by default, others selectable in Settings (⌘,)
- [x] Line comments (single and multi-line), replies, resolve, pasted screenshots; `review` CLI for agents
- [x] ⌘F find in changes: highlights without scrolling; ⌘G / ⇧⌘G, Enter / ⇧Enter step from the current view
- [x] Selecting text highlights its other occurrences
- [x] File list in sections (Implementation, Tests, Changesets); the diff follows that order
- [x] Code navigation: ⌘-click a name to list its definitions and references (`git grep` in files of the
  same language, definitions recognised by line shape, like GitHub's search-based navigation). Places in
  the diff scroll into view, other files open over it; ⌘[ goes back
- [x] Check out a remote branch to review: the branch button on a repository lists its remote branches
  (then fetches), and creates a worktree for the chosen one with worktrunk's `wt switch` (its approved
  hooks run) or `git worktree add`
- [x] One commit at a time: the commits button in the toolbar lists the branch's commits (newest first)
  and shows what one of them changed; ‹ / › step to the previous and next commit
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
- Comments: edit a comment, "Start a review" drafts that agents only see once submitted,
  per-worktree comment counts in the sidebar, installing `review` from the app, an MCP server on
  top of the same store.
- Later: ⌘K palette.

## Layout

```
src/
  App.tsx               three-panel layout
  components/
    Sidebar.tsx         repos → worktrees
    BranchPicker.tsx    remote branches of a repo, checked out in a new worktree
    CommitPicker.tsx    the branch's commits, to review one at a time
    FilePanel.tsx       changed-file tree in sections + viewed progress
    ReviewPane.tsx      toolbar + loading/error/empty states around the diff
    DiffView.tsx        CodeView from @pierre/diffs with our file headers and comment annotations
    CodeNav.tsx         ⌘-click lookup: results popover, file view over the diff, back history
    Comments.tsx        comment threads, composer, replies
    SettingsDialog.tsx  settings (⌘, / app menu): syntax theme
    ui.tsx              primitives: Tooltip, Segmented, badges, Viewed toggle
  lib/
    api.ts              typed wrappers around Tauri commands and events
    diff.ts             patch parsing, default-collapsed files (lockfiles, generated)
    sections.ts         sorts files into Implementation / Tests / Changesets
    search.ts           ⌘F and selection matches, painted with the CSS Custom Highlight API
    symbols.ts          the name under the pointer, ordering search results
    codeViewStyle.ts    fonts and CSS shared by the diff and the file view
    codeThemes.ts       syntax themes (Shiki) offered in Settings
    queries.ts          TanStack Query hooks, live refresh on focus / repo changes
  styles.css            design tokens (OKLCH) + Tailwind theme
  store.ts              UI state (Zustand, persisted), worktree ordering
  types.ts              shapes returned by the Rust backend
  mock.ts               placeholder data used when running in a plain browser
src-tauri/src/
  git.rs                git CLI wrapper: worktrees, status, changed files, patches, file contents (+ tests)
  comments.rs           comment store (SQLite), anchoring to lines as files change, Tauri commands (+ tests)
  cli.rs                the `review` command (the app binary run with a subcommand)
  navigate.rs           definitions and references via `git grep` (+ tests)
  repos.rs              saved repo list and the Tauri commands
  watch.rs              watches .git for worktree changes, and the comments database for agent replies
  menu.rs               native menu bar with Settings… (⌘,)
```
