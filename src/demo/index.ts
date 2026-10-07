// The README demo (`?demo` in a plain browser). Replaces the placeholder data with the story in
// story.ts, frames the app like a macOS window, draws a pointer and a terminal running Codex, and
// exposes `window.demo`: what the agents do, for scripts/demo/record.mjs to call while it plays
// the reviewer.
import { structuredPatch } from "diff";
import { queryClient } from "../lib/queries";
import { mockState, type MockFile } from "../mock";
import { useStore } from "../store";
import type { CommentMessage, ExcerptRow, LineRange, Repo, ReviewRequest, Thread, Worktree } from "../types";
import "./demo.css";
import { codexSteps, openTerminal } from "./terminal";
import {
  BRANCH,
  CLAUDE_REPLIES,
  CODEX_COMMENTS,
  COMMITS,
  FILES,
  OTHER_FILE,
  OTHER_WORKTREE,
  REPO,
  REVIEW_TITLE,
  REVIEWER_COMMENT,
  SESSION_TITLE,
  UNCHANGED_FILES,
  WORKTREE,
} from "./story";

const minutesAgo = (m: number) => Date.now() - m * 60_000;

/** A git-style patch of one file, with the whole file as context so nothing needs expanding. */
function patchFile(path: string, before: string, after: string): MockFile {
  const added = before === "";
  const { hunks } = structuredPatch(path, path, before, after, "", "", { context: 10_000 });
  const lines = hunks.flatMap((h) => h.lines);
  const header = added
    ? `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n`
    : `diff --git a/${path} b/${path}\nindex 1a2b3c4..5d6e7f8 100644\n--- a/${path}\n+++ b/${path}\n`;
  const body = hunks
    .map((h) => `@@ -${h.oldLines ? h.oldStart : 0},${h.oldLines} +${h.newLines ? h.newStart : 0},${h.newLines} @@\n${h.lines.join("\n")}\n`)
    .join("");
  return {
    path,
    status: added ? "added" : "modified",
    additions: lines.filter((l) => l.startsWith("+")).length,
    deletions: lines.filter((l) => l.startsWith("-")).length,
    binary: false,
    generated: false,
    committed: true,
    patch: header + body,
  };
}

const worktree = (path: string, branch: string, minutes: number, isMain = false): Worktree => ({
  id: path,
  repoId: REPO,
  path,
  name: path.split("/").pop()!,
  branch,
  head: "4e1f0c2",
  isMain,
  dirty: false,
  updatedAt: minutesAgo(minutes),
});

const repo: Repo = {
  id: REPO,
  name: "chess",
  path: REPO,
  defaultBranch: "main",
  error: null,
  worktrees: [
    worktree(REPO, "main", 60 * 26, true),
    worktree(WORKTREE, BRANCH, 2),
    worktree(OTHER_WORKTREE, "feat/flip-board", 60 * 3),
  ],
};

// The mock's data is replaced in place: it keeps references to these objects.
for (const list of [mockState.repos, mockState.sessions, mockState.requests]) list.length = 0;
for (const record of [mockState.files, mockState.aheadBehind, mockState.commitLog, mockState.threads, mockState.sessionOfAgent, mockState.seen]) {
  for (const key of Object.keys(record)) delete (record as Record<string, unknown>)[key];
}
mockState.merged.clear();
mockState.repos.push(repo);
mockState.files[OTHER_WORKTREE] = [patchFile(OTHER_FILE.path, OTHER_FILE.main, OTHER_FILE.v1)];
mockState.commitLog[OTHER_WORKTREE] = [["Flip the board when playing black", "You", 60 * 3]];
mockState.aheadBehind[OTHER_WORKTREE] = [1, 0];
mockState.sessionsWorktree = WORKTREE;
mockState.sessionOfAgent.claude = "claude";
mockState.sessionOfAgent.codex = "codex";
// Claude has written knight moves and waits in its session. Codex joins once it's given the
// copied prompt.
mockState.sessions.push({
  id: "claude",
  agent: "claude",
  title: SESSION_TITLE,
  status: "idle",
  running: true,
  cwd: WORKTREE,
  inWorktree: true,
  startedAt: minutesAgo(25),
  lastSeen: minutesAgo(2),
  reachable: true,
  model: "claude-opus-5-5",
});

// The reviewer's view as the demo starts: knight moves open, one diff column.
useStore.setState({ selectedWorktreeId: WORKTREE, layout: "unified", fileTab: "files", scopes: {} });

const lineRange = ([start, end]: [number, number]): LineRange => ({
  startSide: "additions",
  startLine: start,
  endSide: "additions",
  endLine: end,
});

/** The lines around a comment in v1, as the backend would snapshot them. */
function excerpt(path: string, range: LineRange): ExcerptRow[] {
  const text = FILES.find((f) => f.path === path)!.v1.split("\n");
  const from = Math.max(1, range.startLine - 3);
  const to = Math.min(text.length - 1, range.endLine + 3);
  return Array.from({ length: to - from + 1 }, (_, i) => {
    const n = from + i;
    return { kind: "add", old: null, new: n, text: text[n - 1], commented: n >= range.startLine && n <= range.endLine };
  });
}

const message = (authorName: string, body: string): CommentMessage => ({
  id: mockState.nextId(),
  author: "agent",
  authorName,
  body,
  attachments: [],
  createdAt: Date.now(),
  editedAt: null,
  thumbsUp: false,
});

const threads = () => (mockState.threads[WORKTREE] ??= []);
const codexThreads = new Map<string, number>();
const session = (id: string) => mockState.sessions.find((s) => s.id === id)!;
/** The newest request of `kind`, as the app made it when the reviewer asked. */
const latest = (kind: ReviewRequest["kind"]) => mockState.requests.find((r) => r.kind === kind)!;

function setVersion(version: "v1" | "v2") {
  mockState.files[WORKTREE] = FILES.map((f) => patchFile(f.path, f.main, f[version]));
  mockState.texts[WORKTREE] = {
    base: UNCHANGED_FILES,
    head: { ...UNCHANGED_FILES, ...Object.fromEntries(FILES.map((f) => [f.path, f[version]])) },
  };
  mockState.commitLog[WORKTREE] =
    version === "v1" ? [[COMMITS.v1, "Claude", 2]] : [[COMMITS.v2, "Claude", 0], [COMMITS.v1, "Claude", 2]];
  mockState.aheadBehind[WORKTREE] = [version === "v1" ? 1 : 2, 0];
  if (version === "v2") repo.worktrees.find((w) => w.id === WORKTREE)!.updatedAt = Date.now();
}
setVersion("v1");

/** Runs what an agent does, then refreshes the app as the backend's change events would. */
const act =
  <A extends unknown[]>(fn: (...args: A) => void) =>
  (...args: A) => {
    fn(...args);
    return queryClient.invalidateQueries();
  };

const demo = {
  /** The reviewer switches to the terminal where Codex runs. */
  openTerminal,

  /** Codex prints the next `count` steps of its work in the terminal. */
  codexSteps,

  /** Codex takes on the review prompt pasted into it, and so shows up as on the branch. */
  codexJoins: act(() => {
    mockState.sessions.push({
      id: "codex",
      agent: "codex",
      title: REVIEW_TITLE,
      status: null,
      running: null,
      cwd: REPO,
      inWorktree: false,
      startedAt: minutesAgo(9),
      lastSeen: Date.now(),
      reachable: true,
      model: "gpt-6-astra",
    });
    const request = latest("review");
    Object.assign(request, { agent: "codex", sessionId: "codex", startedAt: Date.now() });
  }),

  /** Codex comments on lines; `key` is one of story.ts's CODEX_COMMENTS. */
  codexComments: act((key: string) => {
    const comment = CODEX_COMMENTS.find((c) => c.key === key)!;
    const range = lineRange(comment.v1);
    const thread: Thread = {
      id: mockState.nextId(),
      path: comment.path,
      range,
      position: range,
      resolved: false,
      dismissed: false,
      excerpt: excerpt(comment.path, range),
      messages: [message("codex", comment.body)],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    threads().push(thread);
    codexThreads.set(key, thread.id);
    latest("review").comments += 1;
    session("codex").lastSeen = Date.now();
  }),

  /** Codex is done reviewing. */
  codexFinishes: act(() => {
    latest("review").finishedAt = Date.now();
  }),

  /** Claude takes on the comments sent to it. */
  claudeWorks: act(() => {
    session("claude").status = "busy";
    latest("implement").startedAt = Date.now();
  }),

  /** Claude commits its fix; the comments move with the lines they're on. */
  claudeFixes: act(() => {
    setVersion("v2");
    for (const thread of threads()) {
      if (thread.path === null) continue;
      const key = [...codexThreads].find(([, id]) => id === thread.id)?.[0];
      const comment = CODEX_COMMENTS.find((c) => c.key === key);
      const lines = comment ? comment.v2 : thread.messages[0]?.author === "reviewer" ? REVIEWER_COMMENT.v2 : null;
      if (lines) thread.position = lineRange(lines);
    }
  }),

  /** Claude answers a comment: a key of CLAUDE_REPLIES. */
  claudeReplies: act((key: string) => {
    const id = key === "reviewer" ? threads().find((t) => t.messages[0]?.author === "reviewer")?.id : codexThreads.get(key);
    const thread = threads().find((t) => t.id === id);
    if (!thread) return;
    thread.messages.push(message("claude", CLAUDE_REPLIES[key]));
    thread.updatedAt = Date.now();
    latest("implement").comments += 1;
  }),

  /** Claude is done with the comments. */
  claudeDone: act(() => {
    session("claude").status = "idle";
    latest("implement").finishedAt = Date.now();
  }),
};

declare global {
  interface Window {
    demo: typeof demo;
  }
}
window.demo = demo;

// The window's traffic lights, which the desktop app gets from macOS.
document.documentElement.dataset.demo = "";

// Narrow panels, so the diff's toolbar keeps its labels on the recording's small page. Set before
// the app reads its saved layout; 64 is the window's margins in demo.css.
{
  const width = window.innerWidth - 64;
  const [sidebar, files] = [200, 220];
  const layout = { sidebar: (sidebar / width) * 100, files: (files / width) * 100, diff: ((width - sidebar - files) / width) * 100 };
  localStorage.setItem("react-resizable-panels:main-layout", JSON.stringify(layout));
}
const lights = document.createElement("div");
lights.className = "demo-traffic-lights";
lights.innerHTML = "<span></span><span></span><span></span>";
document.body.append(lights);

// A pointer that follows the mouse, since screen captures don't include one. Like macOS's, it
// hides while typing.
const pointer = document.createElement("div");
pointer.className = "demo-pointer";
pointer.innerHTML = `<svg viewBox="0 0 24 24" width="24" height="24"><path d="M5.5 3.2v15.9l4.2-4 2.7 6.3 2.6-1.1-2.7-6.2h5.9z" fill="#000" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg>`;
document.body.append(pointer);
const options = { capture: true };
window.addEventListener("mousemove", (e) => {
  pointer.style.translate = `${e.clientX}px ${e.clientY}px`;
  pointer.classList.remove("hidden");
}, options);
window.addEventListener("mousedown", (e) => {
  pointer.classList.add("pressed");
  const ring = document.createElement("div");
  ring.className = "demo-click";
  ring.style.left = `${e.clientX}px`;
  ring.style.top = `${e.clientY}px`;
  ring.addEventListener("animationend", () => ring.remove());
  document.body.append(ring);
}, options);
window.addEventListener("mouseup", () => pointer.classList.remove("pressed"), options);

// An outline around what the reviewer is about to use, for the recorder to point things out
// without moving the camera.
declare global {
  interface Window {
    demoHighlight: (box: { x: number; y: number; width: number; height: number }, ms: number) => void;
  }
}
window.demoHighlight = ({ x, y, width, height }, ms) => {
  const outline = document.createElement("div");
  outline.className = "demo-highlight";
  Object.assign(outline.style, { left: `${x - 5}px`, top: `${y - 5}px`, width: `${width + 10}px`, height: `${height + 10}px` });
  document.body.append(outline);
  setTimeout(() => {
    outline.classList.add("out");
    outline.addEventListener("animationend", () => outline.remove());
  }, ms);
};
window.addEventListener("keydown", (e) => {
  // ⌘ alone is held for ⌘-click, not typed.
  if (!["Meta", "Shift", "Alt", "Control"].includes(e.key)) pointer.classList.add("hidden");
}, options);
