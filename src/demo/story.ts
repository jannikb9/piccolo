// What happens in the README demo: Claude is adding knight moves to a chess engine. The reviewer
// ⌘-clicks into the board's code, then copies a review prompt into Codex, which joins and comments.
// The reviewer agrees with one comment, adds one of their own, and Claude makes the changes and
// replies. Kept small and plain so someone seeing it for the first time can follow the code and the
// comments.

export const REPO = "~/code/chess";
export const WORKTREE = `${REPO}/chess.knight-moves`;
export const BRANCH = "feat/knight-moves";
/** Another worktree, for a sidebar that looks lived in. */
export const OTHER_WORKTREE = `${REPO}/chess.flip-board`;

export const SESSION_TITLE = "Add knight moves";
export const REVIEW_TITLE = "Review knight moves";

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
      "    if (to) moves.push(to);",
      "  }",
      "  return moves;",
      "}",
    ),
    v2: lines(
      'import type { Board, Square } from "../board";',
      "",
      "/** Every jump a knight makes: two squares one way, one to the side. */",
      "const KNIGHT_JUMPS = [",
      "  [1, 2], [2, 1], [2, -1], [1, -2],",
      "  [-1, -2], [-2, -1], [-2, 1], [-1, 2],",
      "];",
      "",
      "/** The squares the knight on `from` can move to. */",
      "export function knightMoves(board: Board, from: Square): Square[] {",
      "  const [file, rank] = board.coordinates(from);",
      "  const color = board.pieceAt(from)?.color;",
      "  const moves: Square[] = [];",
      "  for (const [df, dr] of KNIGHT_JUMPS) {",
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
      'test("a knight next to its own pawn can\'t take it", () => {',
      '  const board = Board.withPieces({ d4: "white knight", e6: "white pawn" });',
      '  expect(knightMoves(board, "d4")).not.toContain("e6");',
      "});",
    ),
  },
];

/** Files the branch doesn't change, which ⌘-click can open. */
export const UNCHANGED_FILES: Record<string, string> = {
  "src/board.ts": lines(
    '/** A name like "e4", from "a1" to "h8". */',
    "export type Square = string;",
    "",
    'export type Piece = { color: "white" | "black"; kind: string };',
    "",
    "/** The pieces on a chessboard, and where they are. */",
    "export class Board {",
    "  private pieces = new Map<Square, Piece>();",
    "",
    '  /** A board with only these pieces, like `{ d4: "white knight" }`. */',
    "  static withPieces(pieces: Record<Square, string>): Board {",
    "    const board = new Board();",
    "    for (const [at, name] of Object.entries(pieces)) {",
    '      const [color, kind] = name.split(" ") as [Piece["color"], string];',
    "      board.pieces.set(at, { color, kind });",
    "    }",
    "    return board;",
    "  }",
    "",
    "  /** The file (a–h) and rank (1–8) of `at`, both as numbers from 1 to 8. */",
    "  coordinates(at: Square): [number, number] {",
    "    return [at.charCodeAt(0) - 96, Number(at[1])];",
    "  }",
    "",
    '  /** `file` and `rank` as a name like "e4", or `null` when that\'s off the board. */',
    "  square(file: number, rank: number): Square | null {",
    "    if (file < 1 || file > 8 || rank < 1 || rank > 8) return null;",
    "    return String.fromCharCode(96 + file) + rank;",
    "  }",
    "",
    "  /** The piece on `at`, if there is one. */",
    "  pieceAt(at: Square): Piece | undefined {",
    "    return this.pieces.get(at);",
    "  }",
    "}",
  ),
};

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

/** The name the reviewer ⌘-clicks, on this line of the diff, to see where it's defined. */
export const LOOKUP = { path: "src/moves/knight.ts", line: 14, name: "square" };

/**
 * A comment on lines of a file, where it sits in v1 and after Claude's changes (v2). `key` names
 * it for the recorder.
 */
export type StoryComment = { key: string; path: string; v1: [number, number]; v2: [number, number]; body: string };

/** Codex's review, in the order it writes it. */
export const CODEX_COMMENTS: StoryComment[] = [
  {
    key: "own",
    path: "src/moves/knight.ts",
    v1: [15, 15],
    v2: [16, 18],
    body: "**Bug:** this also lands on squares with our own pieces. A knight can only move to an empty square or take an opponent's piece.",
  },
  {
    key: "test",
    path: "test/knight.test.ts",
    v1: [5, 8],
    v2: [5, 8],
    body: "The test has the knight alone on the board, so it can't catch the bug above. Put one of its own pieces where it could jump.",
  },
];

/** What the reviewer types, and where it sits after Claude's changes. */
export const REVIEWER_COMMENT = {
  path: "src/moves/knight.ts",
  line: 4,
  v2: [4, 4] as [number, number],
  body: "Let's call this `KNIGHT_JUMPS`, so it reads well next to the other pieces' moves.",
};

/** Claude's answers, by the comment they answer (`reviewer` for the reviewer's). */
export const CLAUDE_REPLIES: Record<string, string> = {
  own: "Fixed: squares with our own pieces are skipped now, so the knight can still take the opponent's pieces but never its own.",
  test: "Added `a knight next to its own pawn can't take it`, which fails without the fix.",
  reviewer: "Renamed it to `KNIGHT_JUMPS`.",
};

export const COMMITS = {
  v1: "Generate knight moves",
  v2: "Keep knights off their own pieces",
};

/** What Codex prints in the terminal as it works on the pasted prompt, one step at a time. */
export const CODEX_STEPS: { title: string; detail: string; output: string }[] = [
  { title: "Ran", detail: `piccolo -C ${WORKTREE} guide --request 1`, output: "# Reviewing feat/knight-moves  … +18 lines" },
  { title: "Explored", detail: "", output: "Read knight.ts, knight.test.ts, board.ts" },
  { title: "Ran", detail: "piccolo comment --as codex src/moves/knight.ts:15 …", output: "Commented on src/moves/knight.ts:15 (#1)." },
  { title: "Ran", detail: "piccolo comment --as codex test/knight.test.ts:5-8 …", output: "Commented on test/knight.test.ts:5-8 (#2)." },
];
