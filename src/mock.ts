// Placeholder data for milestone 1 (layout and chrome). Replaced by real git data in milestone 2.
import type { ChangedFile, Repo } from "./types";

const minutesAgo = (m: number) => Date.now() - m * 60_000;

export const repos: Repo[] = [
  {
    id: "spoke-app",
    name: "spoke-app",
    path: "~/projects/spoke-app",
    defaultBranch: "main",
    worktrees: [
      {
        id: "spoke-app/auth-session",
        repoId: "spoke-app",
        path: "~/projects/spoke-app-worktrees/auth-session",
        name: "auth-session",
        branch: "feat/auth-session-refresh",
        head: "a41c9e2",
        isMain: false,
        dirty: true,
        ahead: 3,
        behind: 0,
        additions: 312,
        deletions: 84,
        updatedAt: minutesAgo(2),
      },
      {
        id: "spoke-app/billing",
        repoId: "spoke-app",
        path: "~/projects/spoke-app-worktrees/billing",
        name: "billing",
        branch: "agent/refactor-billing-webhooks",
        head: "9be0f11",
        isMain: false,
        dirty: false,
        ahead: 7,
        behind: 2,
        additions: 1204,
        deletions: 967,
        updatedAt: minutesAgo(38),
      },
      {
        id: "spoke-app/nav",
        repoId: "spoke-app",
        path: "~/projects/spoke-app-worktrees/nav",
        name: "nav",
        branch: "fix/nav-overflow",
        head: "31d7a08",
        isMain: false,
        dirty: false,
        ahead: 1,
        behind: 12,
        additions: 18,
        deletions: 6,
        updatedAt: minutesAgo(60 * 26),
      },
      {
        id: "spoke-app/main",
        repoId: "spoke-app",
        path: "~/projects/spoke-app",
        name: "spoke-app",
        branch: "main",
        head: "e0a2b54",
        isMain: true,
        dirty: false,
        ahead: 0,
        behind: 0,
        additions: 0,
        deletions: 0,
        updatedAt: minutesAgo(60 * 50),
      },
    ],
  },
  {
    id: "infra",
    name: "infra",
    path: "~/projects/infra",
    defaultBranch: "main",
    worktrees: [
      {
        id: "infra/main",
        repoId: "infra",
        path: "~/projects/infra",
        name: "infra",
        branch: "main",
        head: "77c1d3e",
        isMain: true,
        dirty: true,
        ahead: 0,
        behind: 0,
        additions: 22,
        deletions: 4,
        updatedAt: minutesAgo(9),
      },
    ],
  },
];

const files: Record<string, ChangedFile[]> = {
  "spoke-app/auth-session": [
    { path: "src/auth/session.ts", status: "modified", additions: 42, deletions: 8 },
    { path: "src/auth/tokens.ts", status: "added", additions: 61, deletions: 0 },
    { path: "src/auth/refresh.ts", status: "added", additions: 88, deletions: 0 },
    { path: "src/auth/legacy-cookie.ts", status: "deleted", additions: 0, deletions: 47 },
    { path: "src/api/client.ts", status: "modified", additions: 23, deletions: 11 },
    { path: "src/api/interceptors/retry.ts", oldPath: "src/api/retry.ts", status: "renamed", additions: 4, deletions: 2 },
    { path: "src/ui/components/Nav.tsx", status: "modified", additions: 9, deletions: 3 },
    { path: "src/ui/components/SessionBanner.tsx", status: "added", additions: 37, deletions: 0 },
    { path: "src/ui/hooks/useSession.ts", status: "modified", additions: 14, deletions: 6 },
    { path: "tests/auth/refresh.test.ts", status: "added", additions: 29, deletions: 0 },
    { path: "package.json", status: "modified", additions: 2, deletions: 1 },
    { path: "public/logo.png", status: "modified", additions: 0, deletions: 0, binary: true },
  ],
  "spoke-app/billing": [
    { path: "services/billing/webhooks/handler.ts", status: "modified", additions: 210, deletions: 344 },
    { path: "services/billing/webhooks/events.ts", status: "added", additions: 402, deletions: 0 },
    { path: "services/billing/stripe.ts", status: "modified", additions: 88, deletions: 120 },
  ],
  "spoke-app/nav": [
    { path: "src/ui/components/Nav.tsx", status: "modified", additions: 12, deletions: 4 },
    { path: "src/ui/styles/nav.css", status: "modified", additions: 6, deletions: 2 },
  ],
  "spoke-app/main": [],
  "infra/main": [{ path: "terraform/modules/db/main.tf", status: "modified", additions: 22, deletions: 4 }],
};

export function changedFiles(worktreeId: string): ChangedFile[] {
  return files[worktreeId] ?? [];
}

export type MockLine =
  | { kind: "hunk"; text: string }
  | { kind: "ctx"; old: number; new: number; text: string }
  | { kind: "add"; new: number; text: string }
  | { kind: "del"; old: number; text: string };

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
