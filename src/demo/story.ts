// What happens in the README demo: Claude adds rate limiting to a login route, Codex reviews it,
// the reviewer curates the review and adds a comment, and Claude answers with a fix. Kept small
// and plain so someone seeing it for the first time can follow the code and the comments.

export const REPO = "~/code/storefront";
export const WORKTREE = `${REPO}/storefront.login-rate-limit`;
export const BRANCH = "feat/login-rate-limit";
/** Other worktrees, one of them open when the demo starts. */
export const CART_WORKTREE = `${REPO}/storefront.cart-rounding`;
export const SEARCH_WORKTREE = `${REPO}/storefront.search-filters`;

export const SESSION_TITLE = "Add rate limiting to login";
export const REVIEW_TITLE = "Review login rate limiting";

const lines = (...l: string[]) => l.join("\n") + "\n";

/** Each file on `main`, after Claude's first pass (`v1`), and after it addressed the review (`v2`). */
export const FILES: { path: string; main: string; v1: string; v2: string }[] = [
  {
    path: "src/auth/rate-limit.ts",
    main: "",
    v1: lines(
      "const MAX_ATTEMPTS = 5;",
      "const WINDOW_MS = 15 * 60 * 1000;",
      "",
      "type Entry = { count: number; since: number };",
      "const attempts = new Map<string, Entry>();",
      "",
      "/** Whether this email tried to log in too often in the last 15 minutes. */",
      "export function isRateLimited(email: string): boolean {",
      "  const entry = attempts.get(email);",
      "  if (!entry) return false;",
      "  if (Date.now() - entry.since > WINDOW_MS) {",
      "    attempts.delete(email);",
      "    return false;",
      "  }",
      "  return entry.count >= MAX_ATTEMPTS;",
      "}",
      "",
      "export function recordAttempt(email: string): void {",
      "  const entry = attempts.get(email) ?? { count: 0, since: Date.now() };",
      "  entry.count += 1;",
      "  attempts.set(email, entry);",
      "}",
    ),
    v2: lines(
      "const MAX_ATTEMPTS = 5;",
      "const WINDOW_MS = 15 * 60 * 1000;",
      "",
      "type Entry = { count: number; since: number };",
      "const attempts = new Map<string, Entry>();",
      "",
      "/** Whether this email failed to log in too often in the last 15 minutes. */",
      "export function isRateLimited(email: string): boolean {",
      "  const entry = attempts.get(email);",
      "  if (!entry) return false;",
      "  if (Date.now() - entry.since > WINDOW_MS) {",
      "    attempts.delete(email);",
      "    return false;",
      "  }",
      "  return entry.count >= MAX_ATTEMPTS;",
      "}",
      "",
      "export function recordFailure(email: string): void {",
      "  const entry = attempts.get(email) ?? { count: 0, since: Date.now() };",
      "  entry.count += 1;",
      "  attempts.set(email, entry);",
      "}",
      "",
      "export function clearAttempts(email: string): void {",
      "  attempts.delete(email);",
      "}",
      "",
      "/** Seconds until this email may try again. */",
      "export function retryAfter(email: string): number {",
      "  const entry = attempts.get(email);",
      "  return entry ? Math.ceil((entry.since + WINDOW_MS - Date.now()) / 1000) : 0;",
      "}",
    ),
  },
  {
    path: "src/routes/login.ts",
    main: lines(
      'import { Router } from "express";',
      'import { verifyPassword } from "../auth/password";',
      'import { createSession } from "../auth/session";',
      "",
      "export const login = Router();",
      "",
      'login.post("/login", async (req, res) => {',
      "  const { email, password } = req.body;",
      "",
      "  const user = await verifyPassword(email, password);",
      '  if (!user) return res.status(401).json({ error: "Wrong email or password" });',
      "",
      "  res.json({ token: createSession(user) });",
      "});",
    ),
    v1: lines(
      'import { Router } from "express";',
      'import { verifyPassword } from "../auth/password";',
      'import { isRateLimited, recordAttempt } from "../auth/rate-limit";',
      'import { createSession } from "../auth/session";',
      "",
      "export const login = Router();",
      "",
      'login.post("/login", async (req, res) => {',
      "  const { email, password } = req.body;",
      "  if (isRateLimited(email)) {",
      '    return res.status(429).json({ error: "Too many attempts, try again later" });',
      "  }",
      "",
      "  recordAttempt(email);",
      "  const user = await verifyPassword(email, password);",
      '  if (!user) return res.status(401).json({ error: "Wrong email or password" });',
      "",
      "  res.json({ token: createSession(user) });",
      "});",
    ),
    v2: lines(
      'import { Router } from "express";',
      'import { verifyPassword } from "../auth/password";',
      'import { clearAttempts, isRateLimited, recordFailure, retryAfter } from "../auth/rate-limit";',
      'import { createSession } from "../auth/session";',
      "",
      "export const login = Router();",
      "",
      'login.post("/login", async (req, res) => {',
      "  const { email, password } = req.body;",
      "  if (isRateLimited(email)) {",
      '    res.set("Retry-After", String(retryAfter(email)));',
      '    return res.status(429).json({ error: "Too many attempts, try again later" });',
      "  }",
      "",
      "  const user = await verifyPassword(email, password);",
      "  if (!user) {",
      "    recordFailure(email);",
      '    return res.status(401).json({ error: "Wrong email or password" });',
      "  }",
      "",
      "  clearAttempts(email);",
      "  res.json({ token: createSession(user) });",
      "});",
    ),
  },
  {
    path: "test/rate-limit.test.ts",
    main: "",
    v1: lines(
      'import { expect, test } from "vitest";',
      'import { isRateLimited, recordAttempt } from "../src/auth/rate-limit";',
      "",
      'test("blocks an email after five attempts", () => {',
      '  for (let i = 0; i < 5; i++) recordAttempt("ann@example.com");',
      '  expect(isRateLimited("ann@example.com")).toBe(true);',
      "});",
    ),
    v2: lines(
      'import { expect, test } from "vitest";',
      'import { clearAttempts, isRateLimited, recordFailure } from "../src/auth/rate-limit";',
      "",
      'test("blocks an email after five failed logins", () => {',
      '  for (let i = 0; i < 5; i++) recordFailure("ann@example.com");',
      '  expect(isRateLimited("ann@example.com")).toBe(true);',
      "});",
      "",
      'test("a successful login resets the count", () => {',
      '  for (let i = 0; i < 4; i++) recordFailure("bob@example.com");',
      '  clearAttempts("bob@example.com");',
      '  recordFailure("bob@example.com");',
      '  expect(isRateLimited("bob@example.com")).toBe(false);',
      "});",
    ),
  },
];

/** What the other worktrees change. */
export const CART_FILE = {
  path: "src/cart/total.ts",
  main: lines(
    'import type { Cart } from "./types";',
    "",
    "export function cartTotal(cart: Cart): number {",
    "  return cart.items.reduce((sum, item) => sum + item.price * item.quantity, 0);",
    "}",
  ),
  v1: lines(
    'import type { Cart } from "./types";',
    "",
    "/** The total in cents, so rounding never drifts. */",
    "export function cartTotal(cart: Cart): number {",
    "  const cents = cart.items.reduce((sum, item) => sum + Math.round(item.price * 100) * item.quantity, 0);",
    "  return cents / 100;",
    "}",
  ),
};
export const SEARCH_FILE = {
  path: "src/search/filters.ts",
  main: "",
  v1: lines("export type Filters = { category?: string; maxPrice?: number };", "", "export const NO_FILTERS: Filters = {};"),
};

/**
 * A comment on lines of a file, where it sits in v1 and after Claude's fix (v2). `key` names it
 * for the recorder.
 */
export type StoryComment = { key: string; path: string; v1: [number, number]; v2: [number, number]; body: string };

/** Codex's review, in the order it writes it. */
export const CODEX_COMMENTS: StoryComment[] = [
  {
    key: "nit",
    path: "src/auth/rate-limit.ts",
    v1: [4, 4],
    v2: [4, 4],
    body: "Nit: `windowStart` would read better than `since`.",
  },
  {
    key: "retry",
    path: "src/routes/login.ts",
    v1: [10, 12],
    v2: [10, 13],
    body: "Send a `Retry-After` header with the 429, so clients know when to retry.",
  },
  {
    key: "bug",
    path: "src/routes/login.ts",
    v1: [14, 14],
    v2: [16, 21],
    body: "**Bug:** successful logins count too, so five logins in 15 minutes lock you out. Count only failures.",
  },
];

export const CODEX_SUMMARY =
  "Looks good overall. One bug: successful logins count toward the limit.";

/** What the reviewer types, on the test, and where it sits after the fix. */
export const REVIEWER_COMMENT = {
  path: "test/rate-limit.test.ts",
  line: 7,
  v2: [9, 14] as [number, number],
  body: "Also test that a successful login resets the count.",
};

/** Claude's answers after the fix, by the comment they answer (`reviewer` for the reviewer's). */
export const CLAUDE_REPLIES: Record<string, string> = {
  bug: "Good catch. Only failures count now, and a successful login clears them.",
  retry: "Added `Retry-After` with the seconds left in the window.",
  reviewer: "Added “a successful login resets the count”.",
};

export const COMMITS = {
  v1: "Rate-limit login attempts per email",
  v2: "Count only failed logins and send Retry-After",
};
