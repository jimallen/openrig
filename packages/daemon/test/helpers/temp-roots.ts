// Tracked temp roots. A test file that mints a directory under the shared temp dir calls mkTemp()
// instead of mkdtempSync(); the file's afterAll removes exactly those paths (never a name match
// in the shared temp dir, so a parallel run's roots are untouched), afterAll runs after failed
// tests too, and then fails the file if any minted root still exists. Importing this module
// registers the hook in the importing test file (vitest isolates modules per file). A file that
// imports this and mints nothing passes: the fake-*-usage helpers import it on behalf of every
// consumer, and some consumers never build the fake.
import { afterAll, expect } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";

const roots: string[] = [];

export function mkTemp(prefix: string): string {
  const root = mkdtempSync(prefix);
  roots.push(root);
  return root;
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  const leftovers = roots.filter(root => existsSync(root));
  roots.length = 0;
  expect(leftovers, "temp roots left behind by this test file").toEqual([]);
});
