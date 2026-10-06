// What happens in the README demo: Claude is adding knight moves to a chess engine, Codex reviews
// them, the reviewer adds a comment of their own, and Claude makes the changes and replies. Kept
// small and plain so someone seeing it for the first time can follow the code and the comments.

export const REPO = "~/code/chess";
export const WORKTREE = `${REPO}/chess.knight-moves`;
export const BRANCH = "feat/knight-moves";
/** Another worktree, for a sidebar that looks lived in. */
export const OTHER_WORKTREE = `${REPO}/chess.flip-board`;

export const SESSION_TITLE = "Add knight moves";
export const REVIEW_TITLE = "Code review";

const lines = (...l: string[]) => l.join("\n") + "\n";

/** Each file on `main`, as Claude first wrote it (`v1`), and after it addressed the review (`v2`). */
export const FILES: { path: string; main: string; v1: string; v2: string }[] = [
  {
    path: "src/moves/knight.ts",
    main: "",
    v1: lines(
      'import type { Board, Square } from "../board";',
      "",
      "/** Every jump a knight makes: two squares one way, one to the side. */",
      "const JUMPS = [",
      "  [1, 2], [2, 1], [2, -1], [1, -2],",
      "  [-1, -2], [-2, -1], [-2, 1], [-1, 2],",
      "];",
      "",
      "/** The squares the knight on `from` can move to. */",
      "export function knightMoves(board: Board, from: Square): Square[] {",
      "  const [file, rank] = board.coordinates(from);",
      "  const moves: Square[] = [];",
      "  for (const [df, dr] of JUMPS) {",
      "    const to = board.square(file + df, rank + dr);",
      "    moves.push(to);",
      "  }",
      "  return moves;",
      "}",
    ),
    v2: lines(
      'import type { Board, Square } from "../board";',
      "",
      "/** Every jump a knight makes: two squares one way, one to the side. */",
      "const JUMPS = [",
      "  [1, 2], [2, 1], [2, -1], [1, -2],",
      "  [-1, -2], [-2, -1], [-2, 1], [-1, 2],",
      "];",
      "",
      "/** The squares the knight on `from` can move to. */",
      "export function knightMoves(board: Board, from: Square): Square[] {",
      "  const [file, rank] = board.coordinates(from);",
      "  const color = board.pieceAt(from)?.color;",
      "  const moves: Square[] = [];",
      "  for (const [df, dr] of JUMPS) {",
      "    const to = board.square(file + df, rank + dr);",
      "    // Off the board, or one of our own pieces is there.",
      "    if (!to || board.pieceAt(to)?.color === color) continue;",
      "    moves.push(to);",
      "  }",
      "  return moves;",
      "}",
    ),
  },
  {
    path: "test/knight.test.ts",
    main: "",
    v1: lines(
      'import { expect, test } from "vitest";',
      'import { Board } from "../src/board";',
      'import { knightMoves } from "../src/moves/knight";',
      "",
      'test("a knight in the middle has eight moves", () => {',
      '  const board = Board.withPieces({ d4: "white knight" });',
      '  expect(knightMoves(board, "d4")).toHaveLength(8);',
      "});",
    ),
    v2: lines(
      'import { expect, test } from "vitest";',
      'import { Board } from "../src/board";',
      'import { knightMoves } from "../src/moves/knight";',
      "",
      'test("a knight in the middle has eight moves", () => {',
      '  const board = Board.withPieces({ d4: "white knight" });',
      '  expect(knightMoves(board, "d4")).toHaveLength(8);',
      "});",
      "",
      'test("a knight in the corner has two moves", () => {',
      '  const board = Board.withPieces({ a1: "white knight" });',
      '  expect(knightMoves(board, "a1")).toEqual(["b3", "c2"]);',
      "});",
    ),
  },
];

/** What the other worktree changes. */
export const OTHER_FILE = {
  path: "src/ui/flip.ts",
  main: "",
  v1: lines(
    'import type { Square } from "../board";',
    "",
    "/** The square seen from the other side of the board, for playing black. */",
    "export function flip(square: Square): Square {",
    "  return `${\"hgfedcba\"[\"abcdefgh\".indexOf(square[0])]}${9 - Number(square[1])}`;",
    "}",
  ),
};

/**
 * A comment on lines of a file, where it sits in v1 and after Claude's changes (v2). `key` names
 * it for the recorder.
 */
export type StoryComment = { key: string; path: string; v1: [number, number]; v2: [number, number]; body: string };

/** Codex's review, in the order it writes it. */
export const CODEX_COMMENTS: StoryComment[] = [
  {
    key: "board",
    path: "src/moves/knight.ts",
    v1: [14, 14],
    v2: [15, 17],
    body: "**Bug:** jumps that leave the board aren't skipped. From a corner, six of the eight land off the board.",
  },
  {
    key: "own",
    path: "src/moves/knight.ts",
    v1: [15, 15],
    v2: [18, 18],
    body: "This also lands on squares with our own pieces. A knight can only move to an empty square or take an opponent's piece.",
  },
];

/** What the reviewer types, on the test, and where it sits after Claude's changes. */
export const REVIEWER_COMMENT = {
  path: "test/knight.test.ts",
  line: 8,
  v2: [10, 13] as [number, number],
  body: "Add a test for a knight in the corner.",
};

/** Claude's answers, by the comment they answer (`reviewer` for the reviewer's). */
export const CLAUDE_REPLIES: Record<string, string> = {
  board: "Good catch. Jumps that leave the board are skipped now, so a knight in the corner only gets its two real moves.",
  own: "Fixed: squares with our own pieces are skipped, so the knight can still take the opponent's pieces but never its own.",
  reviewer: "Added `a knight in the corner has two moves`: from a1 the knight can only reach b3 and c2.",
};

export const COMMITS = {
  v1: "Generate knight moves",
  v2: "Skip squares off the board or with our own pieces",
};
