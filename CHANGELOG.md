# Changelog

What's new in each release, for people using the app: Piccolo shows the sections newer than the
installed version when it offers an update, and the release's GitHub page shows its own. Every
release needs a `## <version> — <date>` section before `scripts/release.sh` publishes it. Keep
each entry on one line, as both show line breaks as they are.

## 1.3.1 — 2026-10-26

- **Smoother on 120 Hz displays**: Piccolo now draws at your display's refresh rate instead of 60 frames a second, so typing and scrolling feel as smooth as in other apps.
- **Code blocks in comments**: type ``` on a line of its own and press Enter to start a code block, also after a line break, and ``` again on its last line to end it.
- **The cursor fits the text**: on a line after a line break, the cursor in a comment is no longer taller than the text.

## 1.3.0 — 2026-10-26

- **Push branches from Piccolo**: a Push button beside the commit picker pushes the branch and counts the commits not on the remote yet. A branch that was never pushed gets a branch of the same name there. The worktree menu in the sidebar can push too.
- **Resolved comments collapse**: resolving or dismissing a comment you jumped to, such as an outdated one, now folds it away.

## 1.2.0 — 2026-10-26

- **See what an agent changed after you requested changes**: the commit picker has a "Since you requested changes" view with only the commits made since, and marks new commits with a New label.
- **Connect agents that create worktrees**: `piccolo connect` tells Piccolo which worktree an agent session works on, so the session is listed there. With Worktrunk, a `post-switch` hook can run it for you (see the README).

## 1.1.0 — 2026-10-17

- **New comments from agents stand out**: messages you haven't seen yet are marked New, and a "3 new comments" button over the diff takes you to the topmost one, resolved threads included; its × marks them all as read. A message counts as read after a second on screen, or when you reply in its thread. The Comments tab, the comment list and the file tree show where something is new.
- **Agents can agree with a thumbs up**: instead of a reply that only says they agree, agents give your comment a thumbs up, shown under it with their names. Reviewing agents also answer questions in open threads, and add to or push back on other comments.
- **Worktrees have names**: the sidebar shows a title made from the branch ("Dispatch cmdk search" for codex/dispatch-cmdk-search) above the branch. Rename… in the row's menu changes it, and agent prompts use the same name.
- **Commented lines stay in the diff**: lines with an open comment no longer fold away when the worktree changes, and picking a resolved comment in the Comments list unfolds its lines. Lines you expanded in one file stay expanded when another file changes.

## 1.0.5 — 2026-10-13

- **A tidier sidebar**: worktrees no longer show commits ahead/behind or lines changed. A worktree whose GitHub pull request was closed shows a closed pull request icon, one that was merged the merged icon, and the tooltip names the pull request (needs the GitHub CLI, `gh`).
- **No more "Too many open files"**: refreshing after creating a worktree runs far fewer git commands at once.
- **An error instead of an empty window**: when part of the app fails to render, it shows what went wrong with Try again, Reload and Copy details, and the other panes keep working.
- **Agent prompts start with a title**: a new agent session is named after the branch, like "Dispatch cmdk search", instead of a long first line.

## 1.0.4 — 2026-10-12

- **Comments on deleted files stay visible**: a comment on a file the branch deleted, or on one the diff doesn't show, is listed above the diff with the conversation, and also under "No changes" when nothing differs at all.
- **Request changes waits for something new**: once it has sent the comments to an agent it stays disabled until you add a comment or reply, or stop the request with the × in the agents panel, which makes its comments sendable again.

## 1.0.3 — 2026-10-12

- **The diff follows the agent**: changes an agent makes to files, and commits it makes, show up in Piccolo as they happen, including in the commit picker, instead of after reloading.

## 1.0.2 — 2026-10-12

- **Request changes always works**: it's only disabled while no comment is open, and a copied prompt nobody picked up no longer leaves it waiting. Without an agent building the branch it opens a menu of the connected agents, reviewers included, and Copy prompt; the agent you ask becomes the default.
- **Reviewers can address comments**: an agent that wrote the comments can be asked to make the changes itself, and comments that are still open can be sent again.

## 1.0.1 — 2026-10-12

- **Syntax highlighting stays when you show unmodified lines**: expanding context in a large file no longer turns the whole diff white while the file is highlighted.

## 1.0.0 — 2026-10-08

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
