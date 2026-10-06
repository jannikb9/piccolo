// Placeholder data used when the UI runs in a plain browser (`pnpm dev`) instead of the desktop app.
import { hashString } from "./lib/diff";
import type { ImageUpload } from "./lib/images";
import type {
  AgentSession,
  Attachment,
  ChangedFile,
  Commit,
  DiffPatch,
  DiffScope,
  ExcerptRow,
  FileVersions,
  GeneralThread,
  LineRange,
  RemoteBranch,
  Repo,
  ReviewRequest,
  SessionActivity,
  SymbolHit,
  SymbolSearch,
  Thread,
  WorktreeStats,
} from "./types";

const minutesAgo = (m: number) => Date.now() - m * 60_000;

const worktree = (repoId: string, name: string, branch: string, fields: { dirty?: boolean; minutes: number; isMain?: boolean }) => ({
  id: `${repoId}/${name}`,
  repoId,
  path: `${repoId}/${name}`,
  name,
  branch,
  head: "a41c9e2",
  isMain: fields.isMain ?? false,
  dirty: fields.dirty ?? false,
  updatedAt: minutesAgo(fields.minutes),
});

export const mockRepos: Repo[] = [
  {
    id: "~/projects/spoke-app",
    name: "spoke-app",
    path: "~/projects/spoke-app",
    defaultBranch: "main",
    error: null,
    worktrees: [
      worktree("~/projects/spoke-app", "spoke-app", "main", { minutes: 60 * 50, isMain: true }),
      worktree("~/projects/spoke-app", "auth-session", "feat/auth-session-refresh", { dirty: true, minutes: 2 }),
      worktree("~/projects/spoke-app", "billing", "agent/refactor-billing-webhooks", { minutes: 38 }),
      worktree("~/projects/spoke-app", "nav", "fix/nav-overflow", { minutes: 60 * 26 }),
      worktree("~/projects/spoke-app", "codemod", "agent/migrate-logger", { minutes: 60 * 3 }),
    ],
  },
  {
    id: "~/projects/infra",
    name: "infra",
    path: "~/projects/infra",
    defaultBranch: "main",
    error: null,
    worktrees: [worktree("~/projects/infra", "infra", "main", { dirty: true, minutes: 9, isMain: true })],
  },
];

/** `patch` replaces the synthetic one, for files with real contents (see src/demo). */
export type MockFile = ChangedFile & { committed: boolean; patch?: string };
type FileInit = Omit<ChangedFile, "binary" | "generated"> & { binary?: boolean; generated?: boolean };

const committed = (f: FileInit): MockFile => ({ binary: false, generated: false, ...f, committed: true });
const uncommitted = (f: FileInit): MockFile => ({ binary: false, generated: false, ...f, committed: false });

const files: Record<string, MockFile[]> = {
  "~/projects/spoke-app/auth-session": [
    committed({ path: "src/auth/session.ts", status: "modified", additions: 8, deletions: 3 }),
    committed({ path: "src/auth/tokens.ts", status: "added", additions: 44, deletions: 0 }),
    committed({ path: "src/auth/refresh.ts", status: "added", additions: 44, deletions: 0 }),
    committed({ path: "src/auth/legacy-cookie.ts", status: "deleted", additions: 0, deletions: 11 }),
    committed({ path: "src/api/client.ts", status: "modified", additions: 8, deletions: 3 }),
    committed({ path: "src/api/interceptors/retry.ts", oldPath: "src/api/retry.ts", status: "renamed", additions: 8, deletions: 3 }),
    uncommitted({ path: "src/ui/components/Nav.tsx", status: "modified", additions: 8, deletions: 3 }),
    uncommitted({ path: "src/ui/components/SessionBanner.tsx", status: "added", additions: 44, deletions: 0 }),
    committed({ path: "src/ui/hooks/useSession.ts", status: "modified", additions: 8, deletions: 3 }),
    uncommitted({ path: "tests/auth/refresh.test.ts", status: "added", additions: 44, deletions: 0 }),
    committed({ path: "package.json", status: "modified", additions: 8, deletions: 3 }),
    committed({ path: "pnpm-lock.yaml", status: "modified", additions: 8, deletions: 3 }),
    committed({ path: "public/logo.png", status: "modified", additions: 0, deletions: 0, binary: true }),
    uncommitted({ path: ".changeset/brave-owls-sing.md", status: "added", additions: 5, deletions: 0 }),
  ],
  "~/projects/spoke-app/billing": [
    committed({ path: "services/billing/webhooks/handler.ts", status: "modified", additions: 8, deletions: 3 }),
    committed({ path: "services/billing/webhooks/events.ts", status: "added", additions: 44, deletions: 0 }),
    committed({ path: "services/billing/stripe.ts", status: "modified", additions: 8, deletions: 3 }),
    committed({ path: "services/billing/generated/schema.ts", status: "modified", additions: 8, deletions: 3, generated: true }),
  ],
  "~/projects/spoke-app/nav": [
    committed({ path: "src/ui/components/Nav.tsx", status: "modified", additions: 8, deletions: 3 }),
    committed({ path: "src/ui/styles/nav.css", status: "modified", additions: 8, deletions: 3 }),
  ],
  // A large change for checking scroll performance.
  "~/projects/spoke-app/codemod": Array.from({ length: 240 }, (_, i) =>
    committed({ path: `src/modules/m${Math.floor(i / 12)}/file${i}.ts`, status: "modified", additions: 8, deletions: 3 }),
  ),
  "~/projects/infra/infra": [uncommitted({ path: "terraform/modules/db/main.tf", status: "modified", additions: 8, deletions: 3 })],
};

const aheadBehind: Record<string, [number, number]> = {
  "~/projects/spoke-app/auth-session": [3, 0],
  "~/projects/spoke-app/billing": [7, 2],
  "~/projects/spoke-app/nav": [1, 12],
};

/** Worktrees whose branch was merged into the base branch. */
const merged = new Set(["~/projects/spoke-app/nav"]);

const delay = <T>(value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), 150));

/** Each worktree's commits, newest first. */
const commitLog: Record<string, [subject: string, author: string, minutes: number][]> = {
  "~/projects/spoke-app/auth-session": [
    ["Refresh the session before it expires", "Claude", 4],
    ["Retry requests once after a token refresh", "Claude", 21],
    ["Move tokens out of the legacy cookie", "Jannik Bertram", 95],
  ],
  "~/projects/spoke-app/billing": [
    ["Regenerate the billing schema", "Claude", 38],
    ["Handle invoice.paid in the webhook handler", "Claude", 52],
    ["Split webhook events into their own module", "Claude", 70],
  ],
  "~/projects/spoke-app/nav": [["Keep the nav from overflowing on small screens", "Jannik Bertram", 60 * 26]],
  "~/projects/spoke-app/codemod": [
    ["Migrate the remaining modules to the new logger", "Claude", 60 * 3],
    ["Migrate the first modules to the new logger", "Claude", 60 * 4],
  ],
};

const commitsOf = (worktreePath: string): Commit[] =>
  (commitLog[worktreePath] ?? []).map(([subject, author, minutes]) => {
    const sha = hashString(worktreePath + subject).toString(16).padStart(8, "0").repeat(5);
    return { sha, shortSha: sha.slice(0, 7), subject, author, time: minutesAgo(minutes) };
  });

export function mockCommits(worktreePath: string): Promise<Commit[]> {
  return delay(commitsOf(worktreePath));
}

const inScope = (worktreePath: string, scope: DiffScope) => {
  const all = files[worktreePath] ?? [];
  if (typeof scope === "string") return all.filter((f) => scope === "all" || f.committed === (scope === "committed"));
  // Committed files are spread over the commits in turn.
  const commits = commitsOf(worktreePath);
  const index = commits.findIndex((c) => c.sha === scope.commit);
  return all.filter((f) => f.committed).filter((_, i) => i % commits.length === index);
};

export function mockChangedFiles(worktreePath: string, scope: DiffScope): Promise<ChangedFile[]> {
  return delay(inScope(worktreePath, scope).map(({ committed: _, ...f }) => f));
}

export function mockWorktreeStats(worktreePath: string): Promise<WorktreeStats> {
  const all = files[worktreePath] ?? [];
  const [ahead, behind] = aheadBehind[worktreePath] ?? [0, 0];
  return delay({
    ahead,
    behind,
    additions: all.reduce((n, f) => n + f.additions, 0),
    deletions: all.reduce((n, f) => n + f.deletions, 0),
    merged: merged.has(worktreePath),
  });
}

// --- Synthetic file contents and patches -------------------------------------------------------

const before = (n: number) =>
  [
    'import { db } from "../db";',
    'import { parseLegacyCookie } from "./legacy-cookie";',
    'import type { Session } from "./types";',
    "",
    "const SESSION_COOKIE = \"sid\";",
    "const REFRESH_WINDOW_MS = 5 * 60 * 1000;",
    "",
    "/**",
    " * Reads the session for an incoming request.",
    " * Returns null when the request is anonymous.",
    " */",
    ...Array.from({ length: n - 11 }, (_, i) => `// setup step ${i + 1}`),
    "export async function getSession(req: Request) {",
  ].slice(-n);

const after = (n: number) =>
  Array.from({ length: n }, (_, i) =>
    i % 5 === 0 ? "" : `export const helper${i} = (value: number) => value * ${i}; // keeps the file realistic`,
  );

const oldBody = [
  '  const cookie = req.headers.get("cookie");',
  "  if (!cookie) return null;",
  "",
  "  const token = parseLegacyCookie(cookie);",
  "  if (!token || token.expiresAt < Date.now()) return null;",
  "",
  "  return db.session.findUnique({",
  "    where: { id: token.sid },",
  "    include: { user: true },",
  "  });",
  "}",
];

const newBody = [
  '  const cookie = req.headers.get("cookie");',
  "  if (!cookie) return null;",
  "",
  "  const token = readSessionToken(cookie); // Parses the signed cookie, verifies its signature against the rotating keys and rejects anything issued before the last global logout.",
  "  if (!token) return null;",
  "",
  "  if (isExpiringSoon(token, REFRESH_WINDOW_MS)) {",
  "    return refreshSession(token);",
  "  }",
  "",
  "  return db.session.findUnique({",
  "    where: { id: token.sessionId },",
  "    include: { user: true },",
  "  });",
  "}",
];

const PRE = 17;
const POST = 30;
const oldContents = [...before(PRE), ...oldBody, ...after(POST)].join("\n") + "\n";
const newContents = [...before(PRE), ...newBody, ...after(POST)].join("\n") + "\n";

// The changed region of the body, plus three lines of trailing context.
const hunkLines = [
  ...oldBody.slice(0, 3).map((l) => ` ${l}`),
  ...oldBody.slice(3, 5).map((l) => `-${l}`),
  ...newBody.slice(3, 9).map((l) => `+${l}`),
  ` ${oldBody[5]}`,
  ` ${oldBody[6]}`,
  `-${oldBody[7]}`,
  `+${newBody[11]}`,
  ...oldBody.slice(8).map((l) => ` ${l}`),
  ...after(POST).slice(0, 3).map((l) => ` ${l}`),
];
const count = (sign: string) => hunkLines.filter((l) => l[0] === " " || l[0] === sign).length;
const changedHunk = [`@@ -${PRE + 1},${count("-")} +${PRE + 1},${count("+")} @@ export async function getSession(req: Request) {`, ...hunkLines];

const allLines = (contents: string, sign: string) =>
  contents
    .slice(0, -1)
    .split("\n")
    .map((l) => sign + l);

function filePatch(f: MockFile): string {
  if (f.patch) return f.patch;
  const oldPath = f.oldPath ?? f.path;
  const header = `diff --git a/${oldPath} b/${f.path}\n`;
  if (f.binary) return `${header}index 1111111..2222222 100644\nBinary files a/${oldPath} and b/${f.path} differ\n`;
  switch (f.status) {
    case "added": {
      const lines = allLines(newContents, "+");
      return `${header}new file mode 100644\n--- /dev/null\n+++ b/${f.path}\n@@ -0,0 +1,${lines.length} @@\n${lines.join("\n")}\n`;
    }
    case "deleted": {
      const lines = allLines(oldContents, "-");
      return `${header}deleted file mode 100644\n--- a/${oldPath}\n+++ /dev/null\n@@ -1,${lines.length} +0,0 @@\n${lines.join("\n")}\n`;
    }
    case "renamed":
      return `${header}similarity index 88%\nrename from ${oldPath}\nrename to ${f.path}\n--- a/${oldPath}\n+++ b/${f.path}\n${changedHunk.join("\n")}\n`;
    default:
      return `${header}index 1111111..2222222 100644\n--- a/${oldPath}\n+++ b/${f.path}\n${changedHunk.join("\n")}\n`;
  }
}

export function mockDiffPatch(worktreePath: string, scope: DiffScope): Promise<DiffPatch> {
  const patch = inScope(worktreePath, scope).map(filePatch).join("");
  return delay({ oldRev: "base", newRev: null, patch });
}

export function mockFileVersions(): Promise<FileVersions> {
  return delay({ old: oldContents, new: newContents });
}

// --- Code navigation ---------------------------------------------------------------------------

/** Files outside the diff that the changed code refers to. */
const unchangedFiles: Record<string, string> = {
  "src/auth/token-utils.ts": [
    'import type { SessionToken } from "./types";',
    "",
    "/** Reads the signed session token from a cookie header. */",
    "export function readSessionToken(cookie: string): SessionToken | null {",
    '  const value = cookie.split("; ").find((part) => part.startsWith("sid="));',
    "  if (!value) return null;",
    '  const [sessionId, expiresAt] = value.slice(4).split(".");',
    "  return { sessionId, expiresAt: Number(expiresAt) };",
    "}",
    "",
    "/** Whether the token expires within `windowMs`. */",
    "export function isExpiringSoon(token: SessionToken, windowMs: number): boolean {",
    "  return token.expiresAt - Date.now() < windowMs;",
    "}",
    "",
    "export async function refreshSession(token: SessionToken) {",
    "  return { ...token, expiresAt: Date.now() + 60 * 60 * 1000 };",
    "}",
    ...Array.from({ length: 60 }, (_, i) => (i % 4 === 0 ? "" : `export const tokenHelper${i} = (value: number) => value + ${i};`)),
    "",
  ].join("\n"),
  "src/auth/types.ts": [
    "export interface SessionToken {",
    "  sessionId: string;",
    "  expiresAt: number;",
    "}",
    "",
    "export type Session = { id: string; userId: string };",
    "",
  ].join("\n"),
  "src/db/index.ts": ['import { createClient } from "./client";', "", "export const db = createClient();", ""].join("\n"),
};

function mockFiles(worktreePath: string, rev: string | null): Record<string, string> {
  const out: Record<string, string> = { ...unchangedFiles };
  const old = rev === "base";
  for (const f of files[worktreePath] ?? []) {
    if (f.binary || f.status === (old ? "added" : "deleted")) continue;
    out[old ? (f.oldPath ?? f.path) : f.path] = old ? oldContents : newContents;
  }
  return out;
}

export function mockFindSymbol(worktreePath: string, rev: string | null, name: string, from: string): Promise<SymbolSearch> {
  const ext = from.split(".").pop();
  const word = new RegExp(`(?<![\\w$])${name.replace(/[$]/g, "\\$")}(?![\\w$])`);
  const definition = new RegExp(`\\b(?:function|const|let|class|interface|type)\\s+${name}\\b|^\\s*${name}\\??:`);
  const hits: SymbolHit[] = [];
  for (const [path, contents] of Object.entries(mockFiles(worktreePath, rev)).sort(([a], [b]) => a.localeCompare(b))) {
    if (path.split(".").pop()?.replace("tsx", "ts") !== ext?.replace("tsx", "ts")) continue;
    contents.split("\n").forEach((text, i) => {
      if (!word.test(text)) return;
      const isImport = text.trimStart().startsWith("import");
      hits.push({ path, line: i + 1, text: text.trim(), definition: !isImport && definition.test(text) });
    });
  }
  return delay({ hits, truncated: false });
}

export function mockFileText(worktreePath: string, rev: string | null, file: string): Promise<string | null> {
  return delay(mockFiles(worktreePath, rev)[file] ?? null);
}

// --- Review comments (kept in memory) ----------------------------------------------------------

const newLines = newContents.split("\n");

/** New-side lines around a range, standing in for the snapshot the backend stores. */
function excerpt(range: LineRange): ExcerptRow[] {
  const from = Math.max(1, Math.min(range.startLine, range.endLine) - 3);
  const to = Math.min(newLines.length, Math.max(range.startLine, range.endLine) + 3);
  return Array.from({ length: to - from + 1 }, (_, i) => {
    const n = from + i;
    return {
      kind: "context",
      old: n,
      new: n,
      text: newLines[n - 1] ?? "",
      commented: n >= range.startLine && n <= range.endLine,
    };
  });
}

const lines = (startLine: number, endLine: number): LineRange => ({
  startSide: "additions",
  startLine,
  endSide: "additions",
  endLine,
});

let nextId = 100;
const threads: Record<string, (Thread | GeneralThread)[]> = {
  "~/projects/spoke-app/auth-session": [
    {
      id: 6,
      path: null,
      range: null,
      position: null,
      resolved: false,
      dismissed: false,
      excerpt: [],
      messages: [
        {
          id: 6,
          author: "agent",
          body: "Moving the refresh into the middleware is the right call. Two things across files:\n\n1. Nothing tests an expired token end to end (only `isExpiringSoon` is unit-tested).\n2. The API client still retries on **401** by refreshing itself, so a request can now refresh twice:\n\n```ts\nif (res.status === 401) await refresh();\n```\n\n| Path | Refreshes |\n| --- | --- |\n| `authMiddleware` | once |\n| `apiClient` on 401 | again |",
          attachments: [],
          createdAt: minutesAgo(4),
          editedAt: null,
          authorName: "codex",
          thumbsUp: false,
        },
      ],
      createdAt: minutesAgo(4),
      updatedAt: minutesAgo(4),
    },
    {
      id: 1,
      path: "src/auth/session.ts",
      range: lines(24, 26),
      position: lines(24, 26),
      resolved: false,
      dismissed: false,
      excerpt: excerpt(lines(24, 26)),
      messages: [
        {
          id: 1,
          author: "reviewer",
          body: "Refreshing here makes every read a potential write. Can we refresh in the middleware instead,\nso getSession stays side-effect free?",
          attachments: [],
          createdAt: minutesAgo(42),
          editedAt: null,
          authorName: null,
          thumbsUp: false,
        },
        {
          id: 2,
          author: "agent",
          body: "Moved the refresh into authMiddleware; getSession now only reads. The window check is shared via isExpiringSoon().",
          attachments: [],
          createdAt: minutesAgo(6),
          editedAt: null,
          authorName: "claude",
          thumbsUp: false,
        },
      ],
      createdAt: minutesAgo(42),
      updatedAt: minutesAgo(6),
    },
    {
      id: 2,
      path: "src/auth/session.ts",
      range: lines(29, 29),
      position: null,
      resolved: false,
      dismissed: false,
      excerpt: excerpt(lines(29, 29)),
      messages: [{ id: 3, author: "reviewer", body: "sessionId or id? The column is still called sid.",  attachments: [], createdAt: minutesAgo(40), editedAt: null, authorName: null, thumbsUp: false }],
      createdAt: minutesAgo(40),
      updatedAt: minutesAgo(40),
    },
    {
      id: 5,
      path: "src/auth/session.ts",
      range: lines(21, 22),
      position: lines(21, 22),
      resolved: false,
      dismissed: false,
      excerpt: excerpt(lines(21, 22)),
      messages: [
        {
          id: 5,
          author: "agent",
          body: "readSessionToken returns null for an expired token too, so this drops the old \"expired\" error path: callers can't tell a missing session from an expired one. Return a reason, or keep the expiry check here.",
          attachments: [],
          createdAt: minutesAgo(3),
          editedAt: null,
          authorName: "codex",
          thumbsUp: false,
        },
      ],
      createdAt: minutesAgo(3),
      updatedAt: minutesAgo(3),
    },
    {
      id: 3,
      path: "src/api/client.ts",
      range: lines(21, 21),
      position: lines(21, 21),
      resolved: true,
      dismissed: false,
      excerpt: excerpt(lines(21, 21)),
      messages: [{ id: 4, author: "reviewer", body: "Nit: the token variable name.",  attachments: [], createdAt: minutesAgo(90), editedAt: null, authorName: null, thumbsUp: false }],
      createdAt: minutesAgo(90),
      updatedAt: minutesAgo(30),
    },
  ],
};

const findThread = (id: number) => Object.values(threads).flat().find((t) => t.id === id);

export function mockThreads(worktreePath: string): Promise<(Thread | GeneralThread)[]> {
  return delay(structuredClone(threads[worktreePath] ?? []));
}

const mockWorktree = "~/projects/spoke-app/auth-session";

/**
 * The first worktree's sessions: Claude building it, Codex reviewing it right now, and an earlier
 * Claude review that ended. `localStorage["mock-sessions"]` = "0" starts without any, "author" with
 * only Claude building it.
 */
const mockSessionList: AgentSession[] = [
  {
    id: "mock-1",
    agent: "claude",
    title: "Refresh sessions in the auth middleware",
    status: "idle",
    running: true,
    cwd: mockWorktree,
    inWorktree: true,
    startedAt: minutesAgo(52),
    lastSeen: minutesAgo(6),
    reachable: true,
    model: "claude-opus-5-5",
  },
  {
    id: "mock-codex",
    agent: "codex",
    title: "Review the auth session refresh",
    status: null,
    running: null,
    cwd: null,
    inWorktree: false,
    startedAt: null,
    lastSeen: minutesAgo(3),
    reachable: true,
    model: "gpt-6-astra",
  },
  {
    id: "mock-old",
    agent: "claude",
    title: "Second opinion on token storage",
    status: null,
    running: false,
    cwd: null,
    inWorktree: false,
    startedAt: null,
    lastSeen: minutesAgo(130),
    reachable: false,
    model: "claude-sonnet-5-5",
  },
];

const mockRequests: ReviewRequest[] = [
  { id: 2, kind: "review", agent: "codex", sessionId: "mock-codex", head: "a1b2c3d", threads: [], requestedAt: minutesAgo(6), startedAt: minutesAgo(5), finishedAt: null, comments: 2 },
  { id: 1, kind: "review", agent: "claude", sessionId: "mock-old", head: "9f8e7d6", threads: [], requestedAt: minutesAgo(150), startedAt: minutesAgo(149), finishedAt: minutesAgo(131), comments: 0 },
];

/** The session an agent's mock message came from. */
const sessionOfAgent: Record<string, string> = { claude: "mock-1", codex: "mock-codex" };
/** session → thread → when it last saw it. */
const seen: Record<string, Record<number, number>> = { "mock-1": { 1: minutesAgo(6) } };

/**
 * The placeholder data, for the demo (src/demo) to replace with its story and change as agents
 * act in it. `sessionsWorktree` is the worktree the sessions and requests belong to.
 */
export const mockState = {
  repos: mockRepos,
  files,
  aheadBehind,
  merged,
  commitLog,
  threads,
  sessions: mockSessionList,
  requests: mockRequests,
  sessionOfAgent,
  seen,
  sessionsWorktree: mockWorktree,
  /** The next id for a thread or message. */
  nextId: () => nextId++,
};

const unseenBy = (worktreePath: string, session: string | null) =>
  (threads[worktreePath] ?? [])
    .filter((t) => !t.resolved)
    .filter(
      (t) =>
        !session ||
        t.messages.some(
          (m) =>
            (m.author !== "agent" || sessionOfAgent[m.authorName ?? ""] !== session) &&
            (m.editedAt ?? m.createdAt) > (seen[session]?.[t.id] ?? 0),
        ),
    )
    .map((t) => t.id);

/** Comments and replies each session wrote, by the agent names its mock messages are signed with. */
function mockWritten(worktreePath: string): Record<string, number> {
  const written: Record<string, number> = {};
  for (const message of (threads[worktreePath] ?? []).flatMap((t) => t.messages)) {
    const session = message.author === "agent" ? sessionOfAgent[message.authorName ?? ""] : undefined;
    if (session) written[session] = (written[session] ?? 0) + 1;
  }
  return written;
}

export function mockSessions(paths: string[]): Promise<Record<string, AgentSession[]>> {
  const mockWorktree = mockState.sessionsWorktree;
  if (!paths.includes(mockWorktree) || localStorage.getItem("mock-sessions") === "0") return delay({});
  return delay({ [mockWorktree]: structuredClone(onlyAuthor() ? mockSessionList.slice(0, 1) : mockSessionList) });
}

const onlyAuthor = () => localStorage.getItem("mock-sessions") === "author";

export function mockSessionActivity(worktreePath: string): Promise<SessionActivity> {
  const mockWorktree = mockState.sessionsWorktree;
  const none = worktreePath !== mockWorktree || localStorage.getItem("mock-sessions") === "0";
  const sessions = none ? [] : onlyAuthor() ? mockSessionList.slice(0, 1) : mockSessionList;
  return delay({
    unseen: Object.fromEntries(sessions.map((s) => [s.id, unseenBy(worktreePath, s.id)])),
    open: unseenBy(worktreePath, null),
    startedBy: Object.fromEntries(
      (threads[worktreePath] ?? [])
        .filter((t) => !t.resolved)
        .map((t) => [t.id, t.messages[0]?.author === "agent" ? (t.messages[0].authorName ?? "agent") : null]),
    ),
    written: none ? {} : mockWritten(worktreePath),
    requests: structuredClone(
      worktreePath !== mockWorktree
        ? []
        : // Without sessions, only requests to new sessions that haven't started.
          mockRequests.filter((r) => (none ? !r.sessionId : !onlyAuthor() || !r.sessionId || r.sessionId === "mock-1")),
    ),
  });
}

export function mockSendComments(worktreePath: string, session: string): Promise<ReviewRequest> {
  const sent = unseenBy(worktreePath, session);
  if (sent.length === 0) return Promise.reject("There are no comments to send");
  for (const id of sent) (seen[session] ??= {})[id] = Date.now();
  return mockAsk("implement", session, sent);
}

export function mockCopyPrompt(worktreePath: string, kind: ReviewRequest["kind"]): Promise<string> {
  const sent = kind === "implement" ? unseenBy(worktreePath, null) : [];
  if (kind === "implement" && sent.length === 0) return Promise.reject("There are no comments to send");
  return mockAsk(kind, null, sent).then(
    (r) => `Piccolo asks you to review the changes in the worktree ${worktreePath}. Run \`piccolo -C ${worktreePath} guide --request ${r.id}\` and follow the steps it prints.`,
  );
}

export function mockRequestReview(_worktreePath: string, session: string): Promise<ReviewRequest> {
  return mockAsk("review", session, []);
}

/** `to` is `null` for a copied prompt, which any agent can take. */
function mockAsk(kind: ReviewRequest["kind"], to: string | null, sent: number[]): Promise<ReviewRequest> {
  const session = mockSessionList.find((s) => s.id === to);
  const request: ReviewRequest = {
    id: Math.max(0, ...mockRequests.map((r) => r.id)) + 1,
    kind,
    agent: session?.agent ?? "agent",
    sessionId: session?.id ?? null,
    head: "f00ba12",
    threads: sent,
    requestedAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    comments: 0,
  };
  mockRequests.unshift(request);
  return delay(request);
}

/** Pasted images by attachment id, as base64. */
const mockImages = new Map<number, string>();

function mockAttachments(images: ImageUpload[]): Attachment[] {
  return images.map(({ width, height, data }) => {
    const id = nextId++;
    mockImages.set(id, data);
    return { id, width, height, path: `~/Library/Application Support/dev.jb.piccolo/attachments/${id}.png` };
  });
}

export const mockAttachmentData = (id: number): Promise<string> => delay(mockImages.get(id) ?? "");

export function mockAddThread(
  worktreePath: string,
  file: string,
  range: LineRange,
  body: string,
  images: ImageUpload[],
): Promise<number> {
  const now = Date.now();
  const id = nextId++;
  (threads[worktreePath] ??= []).push({
    id,
    path: file,
    range,
    position: range,
    resolved: false,
    dismissed: false,
    excerpt: excerpt(range),
    messages: [{ id: nextId++, author: "reviewer", body: body.trim(), attachments: mockAttachments(images), createdAt: now, editedAt: null, authorName: null, thumbsUp: false }],
    createdAt: now,
    updatedAt: now,
  });
  return delay(id);
}

export function mockAddGeneralThread(worktreePath: string, body: string, images: ImageUpload[]): Promise<number> {
  const now = Date.now();
  const id = nextId++;
  const list = (threads[worktreePath] ??= []);
  // After the other general threads, oldest first, as the backend orders them.
  list.splice(list.filter((t) => t.path === null).length, 0, {
    id,
    path: null,
    range: null,
    position: null,
    resolved: false,
    dismissed: false,
    excerpt: [],
    messages: [{ id: nextId++, author: "reviewer", body: body.trim(), attachments: mockAttachments(images), createdAt: now, editedAt: null, authorName: null, thumbsUp: false }],
    createdAt: now,
    updatedAt: now,
  });
  return delay(id);
}

export function mockReply(id: number, body: string, images: ImageUpload[]): Promise<void> {
  const thread = findThread(id);
  thread?.messages.push({
    id: nextId++,
    author: "reviewer",
    body: body.trim(),
    attachments: mockAttachments(images),
    createdAt: Date.now(),
    editedAt: null,
    authorName: null,
    thumbsUp: false,
  });
  return delay(undefined);
}

export function mockEditComment(messageId: number, body: string, images: ImageUpload[]): Promise<void> {
  const thread = Object.values(threads)
    .flat()
    .find((t) => t.messages.some((m) => m.id === messageId));
  const message = thread?.messages.find((m) => m.id === messageId);
  if (thread && message) {
    message.body = body.trim();
    message.attachments.push(...mockAttachments(images));
    message.editedAt = thread.updatedAt = Date.now();
  }
  return delay(undefined);
}

export function mockSetThumbsUp(messageId: number, thumbsUp: boolean): Promise<void> {
  const message = Object.values(threads)
    .flat()
    .flatMap((t) => t.messages)
    .find((m) => m.id === messageId);
  if (message) message.thumbsUp = thumbsUp;
  return delay(undefined);
}

export function mockSetResolved(id: number, resolved: boolean): Promise<void> {
  const thread = findThread(id);
  if (thread) {
    thread.resolved = resolved;
    thread.dismissed = false;
  }
  return delay(undefined);
}

export function mockSetDismissed(id: number, dismissed: boolean): Promise<void> {
  const thread = findThread(id);
  if (thread) {
    thread.resolved = dismissed;
    thread.dismissed = dismissed;
  }
  return delay(undefined);
}

export function mockDeleteComment(messageId: number): Promise<void> {
  for (const list of Object.values(threads)) {
    const index = list.findIndex((t) => t.messages.some((m) => m.id === messageId));
    if (index === -1) continue;
    const thread = list[index];
    if (thread.messages[0].id === messageId) list.splice(index, 1);
    else thread.messages = thread.messages.filter((m) => m.id !== messageId);
  }
  return delay(undefined);
}

export function mockReorderRepos(ids: string[]): Promise<void> {
  mockRepos.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
  return Promise.resolve();
}

const mockBranches = [
  ["manage-drivers-row-click-targets", "Priya Raman", "Make the whole row clickable in Manage drivers", 25],
  ["feat/auth-session-refresh", "Jannik Bertram", "Refresh sessions before they expire", 60 * 2],
  ["fix/route-eta-rounding", "Sam Okafor", "Round ETAs to the nearest minute", 60 * 7],
  ["agent/refactor-billing-webhooks", "Claude", "Split webhook handlers by event type", 60 * 20],
  ["fix/nav-overflow", "Jannik Bertram", "Stop the nav from overflowing on small screens", 60 * 30],
  ["chore/bump-vite", "renovate[bot]", "Update dependency vite to v7.2.1", 60 * 50],
  ["feat/stop-photos", "Lena Fischer", "Attach photos to stops", 60 * 24 * 4],
  ["spike/offline-mode", "Sam Okafor", "Cache the route for offline use", 60 * 24 * 40],
] as const;

export function mockRemoteBranches(): Promise<RemoteBranch[]> {
  return delay(
    mockBranches.map(([name, author, subject, minutes]) => ({
      name,
      remoteRef: `origin/${name}`,
      author,
      subject,
      updatedAt: minutesAgo(minutes),
    })),
  );
}

export function mockAddWorktree(repoId: string, branch: string): Promise<string> {
  const repo = mockRepos.find((r) => r.id === repoId)!;
  const existing = repo.worktrees.find((w) => w.branch === branch);
  if (existing) return delay(existing.path);
  const wt = worktree(repoId, `${repo.name}.${branch.replace(/\//g, "-")}`, branch, { minutes: 0 });
  repo.worktrees.push(wt);
  return new Promise((resolve) => setTimeout(() => resolve(wt.path), 800));
}
