import type { ChangedFile } from "../types";
import { buildTree, treeOrder, type TreeNode } from "./utils";

export type SectionId = "implementation" | "tests" | "changesets";

/** Sections that start collapsed in the file list, so the implementation gets attention first. */
export const COLLAPSED_BY_DEFAULT: Record<SectionId, boolean> = {
  implementation: false,
  tests: true,
  changesets: true,
};

/** The file list's sections, in the order they're shown and reviewed. */
const SECTIONS: { id: SectionId; label: string }[] = [
  { id: "implementation", label: "Implementation" },
  { id: "tests", label: "Tests" },
  { id: "changesets", label: "Changesets" },
];

/** Folders that only hold tests and their support files. */
const TEST_DIRS = new Set([
  "test",
  "tests",
  "__tests__",
  "spec",
  "specs",
  "e2e",
  "fixtures",
  "__fixtures__",
  "__mocks__",
  "__snapshots__",
  "testdata",
]);

/** Test file naming conventions across ecosystems. */
const TEST_FILE = [
  /\.(test|spec|cy|e2e)\.[^/.]+$/, // foo.test.ts, foo.unit.test.ts, foo.spec.js, foo.cy.ts
  /_(test|spec)\.[^/.]+$/, // foo_test.go, foo_test.py, foo_spec.rb
  /^test_[^/]+\.py$/, // test_foo.py
  /[a-z0-9]Tests?\.(java|kt|kts|scala|cs|swift|php|groovy)$/, // FooTest.java, FooTests.cs
];

export function sectionOf(path: string): SectionId {
  const parts = path.split("/");
  if (parts[0] === ".changeset") return "changesets";
  const name = parts[parts.length - 1];
  if (parts.slice(0, -1).some((dir) => TEST_DIRS.has(dir)) || TEST_FILE.some((re) => re.test(name))) return "tests";
  return "implementation";
}

export type FileSection = { id: SectionId; label: string; tree: TreeNode[]; files: ChangedFile[] };

/** Changed files grouped into non-empty sections, each with its own tree in display order. */
export function groupIntoSections(files: ChangedFile[]): FileSection[] {
  return SECTIONS.flatMap(({ id, label }) => {
    const tree = buildTree(files.filter((f) => sectionOf(f.path) === id));
    return tree.length === 0 ? [] : [{ id, label, tree, files: treeOrder(tree) }];
  });
}
