// Placeholder data used when the UI runs in a plain browser (`pnpm dev`) instead of the desktop app.
import type { ChangedFile, DiffScope, Repo, WorktreeStats } from "./types";

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

const committed = (f: Omit<ChangedFile, "binary"> & { binary?: boolean }) => ({ binary: false, ...f, committed: true });
const uncommitted = (f: Omit<ChangedFile, "binary"> & { binary?: boolean }) => ({ binary: false, ...f, committed: false });

const files: Record<string, (ChangedFile & { committed: boolean })[]> = {
  "~/projects/spoke-app/auth-session": [
    committed({ path: "src/auth/session.ts", status: "modified", additions: 42, deletions: 8 }),
    committed({ path: "src/auth/tokens.ts", status: "added", additions: 61, deletions: 0 }),
    committed({ path: "src/auth/refresh.ts", status: "added", additions: 88, deletions: 0 }),
    committed({ path: "src/auth/legacy-cookie.ts", status: "deleted", additions: 0, deletions: 47 }),
    committed({ path: "src/api/client.ts", status: "modified", additions: 23, deletions: 11 }),
    committed({ path: "src/api/interceptors/retry.ts", oldPath: "src/api/retry.ts", status: "renamed", additions: 4, deletions: 2 }),
    uncommitted({ path: "src/ui/components/Nav.tsx", status: "modified", additions: 9, deletions: 3 }),
    uncommitted({ path: "src/ui/components/SessionBanner.tsx", status: "added", additions: 37, deletions: 0 }),
    committed({ path: "src/ui/hooks/useSession.ts", status: "modified", additions: 14, deletions: 6 }),
    uncommitted({ path: "tests/auth/refresh.test.ts", status: "added", additions: 29, deletions: 0 }),
    committed({ path: "package.json", status: "modified", additions: 2, deletions: 1 }),
    committed({ path: "public/logo.png", status: "modified", additions: 0, deletions: 0, binary: true }),
  ],
  "~/projects/spoke-app/billing": [
    committed({ path: "services/billing/webhooks/handler.ts", status: "modified", additions: 210, deletions: 344 }),
    committed({ path: "services/billing/webhooks/events.ts", status: "added", additions: 402, deletions: 0 }),
    committed({ path: "services/billing/stripe.ts", status: "modified", additions: 88, deletions: 120 }),
  ],
  "~/projects/spoke-app/nav": [
    committed({ path: "src/ui/components/Nav.tsx", status: "modified", additions: 12, deletions: 4 }),
    committed({ path: "src/ui/styles/nav.css", status: "modified", additions: 6, deletions: 2 }),
  ],
  "~/projects/infra/infra": [uncommitted({ path: "terraform/modules/db/main.tf", status: "modified", additions: 22, deletions: 4 })],
};

const aheadBehind: Record<string, [number, number]> = {
  "~/projects/spoke-app/auth-session": [3, 0],
  "~/projects/spoke-app/billing": [7, 2],
  "~/projects/spoke-app/nav": [1, 12],
};

const delay = <T>(value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), 150));

export function mockChangedFiles(worktreePath: string, scope: DiffScope): Promise<ChangedFile[]> {
  const all = files[worktreePath] ?? [];
  const inScope = all.filter((f) => scope === "all" || f.committed === (scope === "committed"));
  return delay(inScope.map(({ committed: _, ...f }) => f));
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

export type MockLine =
  | { kind: "hunk"; text: string }
  | { kind: "ctx"; old: number; new: number; text: string }
  | { kind: "add"; new: number; text: string }
  | { kind: "del"; old: number; text: string };

// Stand-in diff body until real diffs are rendered in milestone 3.
export const sampleHunk: MockLine[] = [
  { kind: "hunk", text: "@@ -18,14 +18,22 @@ export async function getSession(req: Request) {" },
  { kind: "ctx", old: 18, new: 18, text: "  const cookie = req.headers.get(\"cookie\");" },
  { kind: "ctx", old: 19, new: 19, text: "  if (!cookie) return null;" },
  { kind: "ctx", old: 20, new: 20, text: "" },
  { kind: "del", old: 21, text: "  const token = parseLegacyCookie(cookie);" },
  { kind: "del", old: 22, text: "  if (!token || token.expiresAt < Date.now()) return null;" },
  { kind: "add", new: 21, text: "  const token = readSessionToken(cookie);" },
  { kind: "add", new: 22, text: "  if (!token) return null;" },
  { kind: "add", new: 23, text: "" },
  { kind: "add", new: 24, text: "  if (isExpiringSoon(token, REFRESH_WINDOW_MS)) {" },
  { kind: "add", new: 25, text: "    return refreshSession(token);" },
  { kind: "add", new: 26, text: "  }" },
  { kind: "ctx", old: 23, new: 27, text: "" },
  { kind: "ctx", old: 24, new: 28, text: "  return db.session.findUnique({" },
  { kind: "del", old: 25, text: "    where: { id: token.sid }," },
  { kind: "add", new: 29, text: "    where: { id: token.sessionId }," },
  { kind: "ctx", old: 26, new: 30, text: "    include: { user: true }," },
  { kind: "ctx", old: 27, new: 31, text: "  });" },
  { kind: "ctx", old: 28, new: 32, text: "}" },
];
