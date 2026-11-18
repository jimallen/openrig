// workspaces-o9o.164: a ratchet on hard-coded Tailwind palette colour classes in packages/ui/src. Such a class ignores the
// theme (it is the same colour in light and dark); the theme tokens in tailwind.config.ts follow it. The classes that exist
// today are recorded per file and class in palette-class-baseline.json (classified on the o9o.164 bead), and the baseline
// can only shrink: palette-class-baseline.test.ts fails on a file and class above its entry (a new palette class) and on an
// entry above today's count (stale: shrink it). Counts are per file and class, so moving lines does not disturb them.
//
// Rewrite the baseline after removing palette classes (it refuses a rise):
//   npx tsx test/palette-classes.ts --update      (from packages/ui)
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HUES = "slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose";
const PREFIXES = "text|bg|border|border-[trblxy]|ring|ring-offset|outline|divide|fill|stroke|from|via|to|placeholder|decoration|accent|caret|shadow";

/** One palette colour class: an optional variant chain (hover:, dark:, md:, ...), a colour utility, then white/black or a hue
 *  and shade, and an optional /opacity. The same pattern as the o9o.164 census. */
export const PALETTE_CLASS = new RegExp(
  `(?<![\\w-])(?:[a-z0-9-]+:)*(?:${PREFIXES})-(?:white|black|(?:${HUES})-(?:50|[1-9]00|950))(?:/\\d+)?(?![\\w-])`,
  "g",
);

export type PaletteCounts = Record<string, number>;

/** `<path relative to packages/ui>|<class>` -> occurrences, over every .ts and .tsx file under `srcDir`. */
export function countPaletteClasses(uiDir: string, srcDir = join(uiDir, "src")): PaletteCounts {
  const counts: PaletteCounts = {};
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.tsx?$/.test(entry.name)) continue;
      const file = relative(uiDir, full).split("\\").join("/");
      for (const match of readFileSync(full, "utf8").matchAll(PALETTE_CLASS)) {
        const key = `${file}|${match[0]}`;
        counts[key] = (counts[key] ?? 0) + 1;
      }
    }
  };
  walk(srcDir);
  return counts;
}

export interface BaselineDrift {
  /** Above the baseline: a palette class that is new, or used more often in a file. */
  raised: Array<{ key: string; count: number; allowed: number }>;
  /** Below the baseline: palette classes were removed, so the entry must shrink. */
  stale: Array<{ key: string; count: number; allowed: number }>;
}

export function compareToBaseline(counts: PaletteCounts, baseline: PaletteCounts): BaselineDrift {
  const raised: BaselineDrift["raised"] = [];
  const stale: BaselineDrift["stale"] = [];
  for (const [key, count] of Object.entries(counts)) {
    const allowed = baseline[key] ?? 0;
    if (count > allowed) raised.push({ key, count, allowed });
  }
  for (const [key, allowed] of Object.entries(baseline)) {
    const count = counts[key] ?? 0;
    if (count < allowed) stale.push({ key, count, allowed });
  }
  return { raised, stale };
}

/** The baseline file of the ui package at `uiDir`. */
export const baselinePath = (uiDir: string): string => join(uiDir, "test", "palette-class-baseline.json");

export function readBaseline(path: string): PaletteCounts {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${path}: not an object of counts`);
  const out: PaletteCounts = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!Number.isInteger(value) || (value as number) < 1) throw new Error(`${path}: ${key} has a count that is not a positive integer`);
    out[key] = value as number;
  }
  return out;
}

/** CLI: `--update` rewrites the baseline down to today's counts, and refuses when any count is above its entry. */
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1] && process.argv.includes("--update")) {
  // Run from packages/ui: refuse anywhere else rather than write a stray baseline.
  const uiDir = process.cwd();
  let pkg: unknown = null;
  try { pkg = JSON.parse(readFileSync(join(uiDir, "package.json"), "utf8")); } catch { /* not a package folder */ }
  if (!pkg || typeof pkg !== "object" || (pkg as { name?: unknown }).name !== "@openrig/ui") {
    console.error("palette classes: run --update from packages/ui");
    process.exit(1);
  }
  const counts = countPaletteClasses(uiDir);
  const drift = compareToBaseline(counts, readBaseline(baselinePath(uiDir)));
  if (drift.raised.length > 0) {
    console.error("palette classes: refusing --update; the baseline can only shrink. Use a theme token instead of:");
    for (const r of drift.raised) console.error(`  ${r.key}: ${r.count} (baseline allows ${r.allowed})`);
    process.exit(1);
  }
  const sorted = Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(baselinePath(uiDir), `${JSON.stringify(sorted, null, 2)}\n`);
  console.log(`palette classes: baseline rewritten (${Object.keys(sorted).length} entries, ${drift.stale.length} lowered or removed)`);
}
