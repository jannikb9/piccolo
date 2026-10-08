# Changelog

What's new in each release, for people using the app: Piccolo shows the sections newer than the
installed version when it offers an update, and the release's GitHub page shows its own. Every
release needs a `## <version> — <date>` section before `scripts/release.sh` publishes it. Keep
each entry on one line, as both show line breaks as they are.

## 0.2.3 — 2026-10-08

- **Stop waiting for an agent**: when an agent never says it's done, the × beside it in the agents panel stops its spinner and counts its work as done.
- **Review the same agent again in one click**: Review asks the agent that reviewed last, and the menus of Review and Request changes list every other connected agent.
- **Clearer diff options**: a Unified | Split switch, and checkboxes for hiding whitespace and import changes.
- Review and Request changes are only split into a button and a menu when the two do different things, and get their own robots when there's no agent to send to right away.

## 0.2.2 — 2026-10-07

- **Diff options in one menu**: switching between split and unified diffs and hiding whitespace or import changes now live in one toolbar menu, which stays highlighted while anything is hidden.
- **Request changes**: the button that sends your comments to the agent building the branch is now called Request changes, like on GitHub.
- **Safer review of other people's branches**: checking out a branch new to your clone no longer runs worktrunk's hooks from it, and symlinks show the path they point to instead of that file's contents.
- worktrunk now installs only through Homebrew.
- The Files and Comments tabs stay legible in a narrow file panel, and no gap opens in the toolbar next to the agents.
- Codex's icon no longer sits on a white tile.

## 0.2.1 — 2026-10-07

- **worktrunk in one click**: Piccolo offers to install worktrunk, which it uses to create worktrees, on first launch and in Settings. It's optional.
- **Security hardening**: the app's window only runs Piccolo's own code and never loads content from the internet, so a malicious diff or comment can't run scripts in it.

## 0.2.0 — 2026-10-07

- **Updates in the app**: Piccolo tells you when a new version is out, shows what changed and installs it with one click. Piccolo › Check for Updates… looks right away.
- **Work with agents from the toolbar**: ask any running Claude or Codex session to review the branch, or to address the comments it hasn't seen. Without one, Piccolo copies a prompt to paste into a new session.
- **See who's on the branch**: the agents working on a worktree show in the toolbar, with their model and whether they're busy.
- **Comments in Markdown** that renders as you type, a thumbs up for agents' comments, and "Dismiss" for comments you don't want raised again.
- **Comments on the whole branch**, and a Comments tab listing every thread.
- **Commit picker**: step through the uncommitted changes and each commit, or see them all.
- Narrow diff panes switch to a unified diff.

## 0.1.0 — 2026-10-04

- First release: review your worktrees' changes like a pull request and leave comments your agents read and answer with the `piccolo` command.
