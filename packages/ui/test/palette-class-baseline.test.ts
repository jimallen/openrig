// workspaces-o9o.164 (Jim: "Add a shrink-only check"): no new hard-coded palette colour class in packages/ui/src, and the
// recorded ones can only go down. See palette-classes.ts for the pattern and the --update command.
import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { PALETTE_CLASS, baselinePath, compareToBaseline, countPaletteClasses, readBaseline } from "./palette-classes";

const UI_DIR = join(__dirname, "..");
const matches = (text: string) => [...text.matchAll(PALETTE_CLASS)].map((m) => m[0]);

describe("o9o.164: hard-coded palette colour classes can only shrink", () => {
  it("the pattern finds palette classes, with variants and opacity, and not theme tokens or longer names", () => {
    expect(matches('className="text-stone-500 dark:bg-amber-900/40 hover:border-white"')).toEqual([
      "text-stone-500", "dark:bg-amber-900/40", "hover:border-white",
    ]);
    expect(matches('className="text-on-surface bg-surface-low border-outline-variant text-stone-500x bg-warning"')).toEqual([]);
  });

  it("compares by file and class: a new class or a higher count is raised, a lower count or a missing one is stale", () => {
    const baseline = { "src/a.tsx|text-red-600": 2, "src/b.tsx|bg-white": 1 };
    expect(compareToBaseline({ "src/a.tsx|text-red-600": 2, "src/b.tsx|bg-white": 1 }, baseline)).toEqual({ raised: [], stale: [] });
    expect(compareToBaseline({ "src/a.tsx|text-red-600": 3, "src/b.tsx|bg-white": 1, "src/c.tsx|text-amber-700": 1 }, baseline).raised).toEqual([
      { key: "src/a.tsx|text-red-600", count: 3, allowed: 2 }, { key: "src/c.tsx|text-amber-700", count: 1, allowed: 0 },
    ]);
    expect(compareToBaseline({ "src/a.tsx|text-red-600": 1 }, baseline).stale).toEqual([
      { key: "src/a.tsx|text-red-600", count: 1, allowed: 2 }, { key: "src/b.tsx|bg-white", count: 0, allowed: 1 },
    ]);
  });

  it("packages/ui/src has no palette class above the baseline, and no stale baseline entry", () => {
    const drift = compareToBaseline(countPaletteClasses(UI_DIR), readBaseline(baselinePath(UI_DIR)));
    const raised = drift.raised.map((r) => `${r.key}: ${r.count} (baseline allows ${r.allowed})`);
    const stale = drift.stale.map((s) => `${s.key}: ${s.count} (baseline still allows ${s.allowed})`);
    expect(raised, "a hard-coded palette colour ignores the theme: use a theme token (tailwind.config.ts)").toEqual([]);
    expect(stale, "palette classes were removed: shrink the baseline with `npx tsx test/palette-classes.ts --update`").toEqual([]);
  });
});
