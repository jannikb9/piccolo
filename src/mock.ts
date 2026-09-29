// Placeholder data used when the UI runs in a plain browser (`pnpm dev`) instead of the desktop app.
import type { ChangedFile, DiffPatch, DiffScope, ExcerptRow, FileVersions, LineRange, Repo, Thread, WorktreeStats } from "./types";

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

type MockFile = ChangedFile & { committed: boolean };
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

const delay = <T>(value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), 150));

const inScope = (worktreePath: string, scope: DiffScope) =>
  (files[worktreePath] ?? []).filter((f) => scope === "all" || f.committed === (scope === "committed"));

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
  "  const token = readSessionToken(cookie);",
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
const threads: Record<string, Thread[]> = {
  "~/projects/spoke-app/auth-session": [
    {
      id: 1,
      path: "src/auth/session.ts",
      range: lines(24, 26),
      position: lines(24, 26),
      resolved: false,
      excerpt: excerpt(lines(24, 26)),
      messages: [
        {
          id: 1,
          author: "reviewer",
          body: "Refreshing here makes every read a potential write. Can we refresh in the middleware instead,\nso getSession stays side-effect free?",
          createdAt: minutesAgo(42),
        },
        {
          id: 2,
          author: "agent",
          body: "Moved the refresh into authMiddleware; getSession now only reads. The window check is shared via isExpiringSoon().",
          createdAt: minutesAgo(6),
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
      excerpt: excerpt(lines(29, 29)),
      messages: [{ id: 3, author: "reviewer", body: "sessionId or id? The column is still called sid.", createdAt: minutesAgo(40) }],
      createdAt: minutesAgo(40),
      updatedAt: minutesAgo(40),
    },
    {
      id: 3,
      path: "src/api/client.ts",
      range: lines(21, 21),
      position: lines(21, 21),
      resolved: true,
      excerpt: excerpt(lines(21, 21)),
      messages: [{ id: 4, author: "reviewer", body: "Nit: the token variable name.", createdAt: minutesAgo(90) }],
      createdAt: minutesAgo(90),
      updatedAt: minutesAgo(30),
    },
  ],
};

const findThread = (id: number) => Object.values(threads).flat().find((t) => t.id === id);

export function mockThreads(worktreePath: string): Promise<Thread[]> {
  return delay(structuredClone(threads[worktreePath] ?? []));
}

export function mockAddThread(worktreePath: string, file: string, range: LineRange, body: string): Promise<number> {
  const now = Date.now();
  const id = nextId++;
  (threads[worktreePath] ??= []).push({
    id,
    path: file,
    range,
    position: range,
    resolved: false,
    excerpt: excerpt(range),
    messages: [{ id: nextId++, author: "reviewer", body: body.trim(), createdAt: now }],
    createdAt: now,
    updatedAt: now,
  });
  return delay(id);
}

export function mockReply(id: number, body: string): Promise<void> {
  const thread = findThread(id);
  thread?.messages.push({ id: nextId++, author: "reviewer", body: body.trim(), createdAt: Date.now() });
  return delay(undefined);
}

export function mockSetResolved(id: number, resolved: boolean): Promise<void> {
  const thread = findThread(id);
  if (thread) thread.resolved = resolved;
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
