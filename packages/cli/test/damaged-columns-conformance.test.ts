// OF-157 / OF-168 (a3): the three copies of the "damaged-row marker" reader must agree.
//
// The daemon marks a row whose saved JSON column is unreadable with `unreadable: [columns]` (OF-117). Three surfaces read that marker
// with their own copy of the same rule ("damage fails toward SHOWING"): the UI (ui/src/lib/damaged-row.ts), the CLI
// (cli/src/lib/damaged-rows.ts) and the TUI (tui/src/damaged.ts). They are deliberately NOT consolidated (a shared seam needs an
// architect call, OF-157). Until then this one probe table runs against all three, so a copy that drifts is a red row naming the
// copy and the marker, not a surface that quietly shows a damaged row as an ordinary blank.
//
// Production consequence: a copy that reads a marker as "readable" shows a damaged row as ordinary, and the operator then sees "no
// tags" where the truth is "unknown" (the unreadable-treated-as-absent failure). A copy that reads a readable row as damaged hides
// the actions of a healthy row.
//
// The expectations below are written out by hand, not computed from any copy. Cross-package imports in a test follow
// progress-ui-conformance.test.ts. Nothing here executes in production; the three modules are imported for their pure functions.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { damagedColumnsOf, damagedRowsIn } from "../src/lib/damaged-rows.js";
import { damagedColumns as tuiDamagedColumns, damagedPhrase } from "../../tui/src/damaged.js";
import { damagedColumns as uiDamagedColumns, isDamagedRow } from "../../ui/src/lib/damaged-row.js";

interface Probe { name: string; row: { unreadable?: unknown } | null | undefined; columns: string[] }

const PROBES: Probe[] = [
  { name: "no row at all", row: undefined, columns: [] },
  { name: "a null row", row: null, columns: [] },
  { name: "a row with no marker", row: {}, columns: [] },
  { name: "marker undefined", row: { unreadable: undefined }, columns: [] },
  { name: "marker null", row: { unreadable: null }, columns: [] },
  { name: "marker empty string", row: { unreadable: "" }, columns: [] },
  { name: "marker false", row: { unreadable: false }, columns: [] },
  { name: "marker empty list", row: { unreadable: [] }, columns: [] },
  { name: "one named column", row: { unreadable: ["tags"] }, columns: ["tags"] },
  { name: "two named columns keep their order", row: { unreadable: ["tags", "chain_of_record"] }, columns: ["tags", "chain_of_record"] },
  { name: "an empty name beside a real one is dropped", row: { unreadable: ["", "tags"] }, columns: ["tags"] },
  { name: "a list of only empty names is damage with unknown columns", row: { unreadable: [""] }, columns: ["unknown columns"] },
  { name: "two empty names are still one unknown", row: { unreadable: ["", ""] }, columns: ["unknown columns"] },
  { name: "a non-string column name is named by its text", row: { unreadable: [7] }, columns: ["7"] },
  { name: "a marker that is a bare column name", row: { unreadable: "tags" }, columns: ["tags"] },
  { name: "marker true names no column", row: { unreadable: true }, columns: ["unknown columns"] },
  { name: "marker 0 is present, so damage", row: { unreadable: 0 }, columns: ["unknown columns"] },
  { name: "an object marker names no column", row: { unreadable: {} }, columns: ["unknown columns"] },
];

// Each copy, adapted to one shape: row in, damaged column names out. The CLI reads a bare marker; its list reader is probed too.
const COPIES: Array<{ copy: string; columns: (row: Probe["row"]) => string[] }> = [
  { copy: "ui lib/damaged-row.ts damagedColumns", columns: (row) => uiDamagedColumns(row) },
  { copy: "cli lib/damaged-rows.ts damagedColumnsOf", columns: (row) => damagedColumnsOf(row?.unreadable) },
  { copy: "tui damaged.ts damagedColumns", columns: (row) => tuiDamagedColumns(row) },
];

describe("OF-157: the three damaged-marker readers agree on one probe table", () => {
  for (const { copy, columns } of COPIES) {
    describe(copy, () => {
      it.each(PROBES)("$name", ({ row, columns: expected }) => {
        expect(columns(row)).toEqual(expected);
      });
    });
  }

  // The derived readers each surface adds on top of its copy: a damaged row shown/marked iff the copy found columns.
  describe("what each surface derives from its copy", () => {
    it.each(PROBES)("ui isDamagedRow, tui damagedPhrase and cli damagedRowsIn agree: $name", ({ row, columns: expected }) => {
      expect(isDamagedRow(row)).toBe(expected.length > 0);
      expect(damagedPhrase(row)).toBe(expected.length > 0 ? `DAMAGED: ${expected.join(", ")} unreadable` : "");
      expect(damagedRowsIn([{ qitemId: "q-probe", ...(row ?? {}) }])).toEqual(expected.length > 0 ? [{ id: "q-probe", columns: expected }] : []);
    });
  });

  // Census guard: the probe table covers every copy only while there are exactly these three. The phrase "unknown columns" is the
  // fallback every copy carries; a fourth source file with it is a fourth copy this table does not run against.
  it("no fourth copy: exactly the three known files carry the 'unknown columns' fallback in cli, tui and ui src", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const packages = join(here, "..", "..");
    const found: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) { if (entry !== "node_modules" && entry !== "dist") walk(path); continue; }
        if (/\.(ts|tsx)$/.test(entry) && readFileSync(path, "utf8").includes("unknown columns")) found.push(relative(packages, path).split("\\").join("/"));
      }
    };
    for (const pkg of ["cli", "tui", "ui"]) walk(join(packages, pkg, "src"));
    expect(found.sort()).toEqual(["cli/src/lib/damaged-rows.ts", "tui/src/damaged.ts", "ui/src/lib/damaged-row.ts"]);
  });
});
