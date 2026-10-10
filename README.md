<p align="center">
  <img src="src-tauri/icons/128x128@2x.png" width="96" alt="">
</p>

<h1 align="center">Piccolo</h1>

<p align="center">A multi-agent collaboration tool to review code locally.</p>

<p align="center">
  <a href="https://github.com/jannikb9/piccolo/releases/latest"><img src="https://img.shields.io/github/v/release/jannikb9/piccolo" alt="Latest release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/jannikb9/piccolo" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/platform-macOS-lightgrey" alt="macOS">
</p>

https://github.com/user-attachments/assets/ca82d5d0-571a-44f0-811e-458a738a9573

## Why Piccolo?

The progress on agentic coding has drastically changed the workflows for most, if not all engineers. We run multiple sessions in parallel, each working in its own worktree. The produced code is reviewed both by us and independent agents.

Using GitHub for code reviews is inefficient and costly. Each push to the pull request triggers the full CI pipeline. Requesting changes requires copy & paste of code into the agent session, or adding comments on GitHub, which clutters the history.

Piccolo aims to provide a smoother workflow, allowing you to collaborate with your agents and review code efficiently before it's pushed to a pull request. You keep an overview of your worktrees and request changes from different agents, all without switching between apps, browser tabs, or terminal tabs.

## Features
- Advanced local review features (e.g. hide import statements, see function definitions, etc.)
- See all agent sessions working on a worktree
- Request changes and reviews from connected agents **with one click**
- Understand how agents collaborate through code comments

## Getting started

1. Add a repository.
2. Select a branch or worktree with code changes.
3. Review the code as you would in a pull request review. Add general comments or target specific lines of code.
4. **Recommended (but optional):** Ask another independent agent for a review. Its comments appear next to yours.
5. Request the changes from your implementation agent. It addresses the comments. Push when you're happy, or go back to step 3 and iterate further.

## Supported agents

| Agent | Support |
| --- | --- |
| Claude Code (CLI) | ✅ Native |
| Claude desktop app | ✅ Native |
| Codex (CLI) | ✅ Native |
| Codex desktop app | ✅ Native |
| Gemini CLI | Via copy prompt |
| Cursor | Via copy prompt |
| GitHub Copilot | Via copy prompt |
| OpenCode | Via copy prompt |
| Goose | Via copy prompt |
| Cline | Via copy prompt |
| Amp | Via copy prompt |
| Junie | Via copy prompt |
| Qwen Code | Via copy prompt |
| Kimi CLI | Via copy prompt |

**Native:** Piccolo sends review and change requests straight to the running session.

**Via copy prompt:** Piccolo copies a prompt to paste into a session. The agent reads and answers comments with the `piccolo` command, so any agent that can run shell commands works, including ones not listed here.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/jannikb9/piccolo/main/install.sh | sh
```

**Updates:** The app will automatically notify you about updates when available.
