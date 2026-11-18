// workspaces-o9o.130: the pure half of twin:a11y (twin/capture/a11y-report.ts). The scan accounts for every route of
// src/routes.tsx (scanned, or listed as not scanned with a reason), and axe-core's results fold into a report by rule.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import {
  DIALOGS_NOT_SCANNED, NOT_SCANNED, SURFACES, crashMessage, dialogComponentOf, dialogComponents, renderMarkdown, routePatterns, summarizeByRule, unaccountedRoutes, type ScanRecord, type Violation,
} from "../twin/capture/a11y-report.js";

const routesSource = readFileSync(path.resolve(__dirname, "..", "src", "routes.tsx"), "utf8");
const SRC = path.resolve(__dirname, "..", "src");
/** Every .ts/.tsx file under src, path -> source. */
const srcFiles: Record<string, string> = Object.fromEntries(
  (readdirSync(SRC, { recursive: true }) as string[])
    .filter((f) => /\.tsx?$/.test(f))
    .map((f) => [path.join(SRC, f), readFileSync(path.join(SRC, f), "utf8")]),
);

describe("twin:a11y covers every route (o9o.130)", () => {
  it("every route in src/routes.tsx is scanned or listed as not scanned, with a reason", () => {
    const patterns = routePatterns(routesSource);
    expect(patterns.length).toBeGreaterThan(40);
    expect(unaccountedRoutes(patterns, SURFACES, NOT_SCANNED)).toEqual([]);
    for (const n of NOT_SCANNED) expect(n.reason.length, n.pattern).toBeGreaterThan(0);
  });

  it("control: a route dropped from the surfaces is reported as unaccounted", () => {
    const patterns = routePatterns(routesSource);
    const without = SURFACES.filter((s) => s.pattern !== "/settings");
    expect(unaccountedRoutes(patterns, without, NOT_SCANNED)).toEqual(["/settings"]);
  });

  it("every surface pattern is a real route, ids are unique, and a dialog surface names its trigger and what it opens", () => {
    const patterns = new Set(routePatterns(routesSource));
    for (const s of SURFACES) expect(patterns.has(s.pattern), s.pattern).toBe(true);
    for (const n of NOT_SCANNED) expect(patterns.has(n.pattern), n.pattern).toBe(true);
    expect(new Set(SURFACES.map((s) => s.id)).size).toBe(SURFACES.length);
    const dialogs = SURFACES.filter((s) => s.open);
    expect(dialogs.length).toBeGreaterThanOrEqual(3);
    for (const d of dialogs) expect(d.open!.click && d.open!.expect, d.id).toBeTruthy();
  });
});

describe("twin:a11y covers every dialog (o9o.130, verify-qa2 finding 1)", () => {
  it("every dialog component in src is scanned through a dialog surface or named as not scanned, with a reason", () => {
    const found = dialogComponents(srcFiles);
    // Positive control on the census itself: the hand-written ones and the Radix ones are both seen.
    expect(Object.keys(srcFiles).length).toBeGreaterThan(200);
    expect(found).toEqual(expect.arrayContaining(["Lightbox", "ProofImageViewer", "SharedDetailDrawer", "LaunchRecoveryModal", "TerminalLauncher"]));
    const scanned = new Set(SURFACES.map(dialogComponentOf).filter(Boolean));
    const named = new Set(DIALOGS_NOT_SCANNED.map((d) => d.dialog.split(" ")[0]));
    expect(found.filter((c) => !scanned.has(c) && !named.has(c))).toEqual([]);
    for (const d of DIALOGS_NOT_SCANNED) expect(d.reason.length, d.dialog).toBeGreaterThan(0);
  });

  it("the census sees a hand-written role=dialog, a Radix DialogContent and a VellumSheet, and skips the ui primitives", () => {
    expect(dialogComponents({
      "/x/components/A.tsx": '<div role="dialog" aria-label="a">',
      "/x/components/B.tsx": "<DialogContent>",
      "/x/components/C.tsx": "<VellumSheet open>",
      "/x/components/D.tsx": '<div role="region">',
      "/x/components/E.tsx": '// a role="dialog" must be named\n/* <DialogContent> */\n<div role="region">',
      "/x/components/ui/vellum-sheet.tsx": '<div role="dialog">',
    })).toEqual(["A", "B", "C"]);
  });

  it("the drawer is scanned for both kinds the twin can open, and the lightbox from the seeded Review media", () => {
    const ids = SURFACES.filter((s) => s.open).map((s) => s.id);
    expect(ids).toEqual(expect.arrayContaining([
      "dialog: queue item drawer (SharedDetailDrawer qitem)",
      "dialog: file drawer (SharedDetailDrawer file)",
      "dialog: image lightbox (Lightbox)",
    ]));
    expect(SURFACES.find((s) => s.id === "dialog: image lightbox (Lightbox)")!.route).toBe("/project/slice/EX.2.0.0.07");
  });

  it("the report lists the dialogs not scanned", () => {
    const md = renderMarkdown([], NOT_SCANNED, { axeVersion: "4.14.1", commit: "abc1234" }, DIALOGS_NOT_SCANNED);
    expect(md).toContain("## Dialogs not scanned");
    for (const d of DIALOGS_NOT_SCANNED) expect(md).toContain(`- ${d.dialog}: ${d.reason}`);
  });
});

describe("crashMessage: the router's error screen is a failed scan, not the route (o9o.130)", () => {
  it("the opened error screen gives its message", () => {
    expect(crashMessage("Something went wrong!\nHide Error\nCannot read properties of undefined (reading 'value')"))
      .toBe("Cannot read properties of undefined (reading 'value')");
  });

  it("the unopened error screen is a crash with no message yet", () => {
    expect(crashMessage("Something went wrong!\nShow Error")).toBe("");
  });

  it("control: a page that only mentions the phrase further down is not a crash", () => {
    expect(crashMessage("OPENRIG\nSettings\nSomething went wrong! is what the old banner said")).toBeNull();
    expect(crashMessage("")).toBeNull();
  });
});

const v = (id: string, impact: Violation["impact"], n: number): Violation =>
  ({ id, impact, help: `help ${id}`, helpUrl: `https://example.invalid/${id}`, targets: Array.from({ length: n }, (_, i) => `#${id}-${i}`) });

describe("summarizeByRule (o9o.130)", () => {
  const records: ScanRecord[] = [
    { surface: "/", theme: "light", ok: true, violations: [v("region", "minor", 2), v("color-contrast", "serious", 3)] },
    { surface: "/", theme: "dark", ok: true, violations: [v("color-contrast", "serious", 1)] },
    { surface: "/packages", theme: "light", ok: true, violations: [v("button-name", "critical", 1), v("region", "moderate", 4)] },
    { surface: "/broken", theme: "light", ok: false, error: "twin:build failed (1)" },
  ];

  it("folds by rule: most severe first, then most elements; counts every element; keeps each hit", () => {
    const rules = summarizeByRule(records);
    expect(rules.map((r) => r.id)).toEqual(["button-name", "color-contrast", "region"]);
    expect(rules.find((r) => r.id === "color-contrast")!.nodes).toBe(4);
    expect(rules.find((r) => r.id === "color-contrast")!.hits.map((h) => `${h.surface}:${h.theme}:${h.nodes}`)).toEqual(["/:light:3", "/:dark:1"]);
  });

  // The worse impact (moderate) is reported second, so keeping the first one would fail this row.
  it("a rule's impact is the worst it was reported at", () => {
    expect(summarizeByRule(records).find((r) => r.id === "region")!.impact).toBe("moderate");
  });

  it("a failed scan contributes no violation, and an empty input gives an empty summary", () => {
    expect(summarizeByRule(records).flatMap((r) => r.hits).some((h) => h.surface === "/broken")).toBe(false);
    expect(summarizeByRule([])).toEqual([]);
  });

  it("ties on impact break by element count, then by rule id", () => {
    const tie: ScanRecord[] = [{ surface: "/", theme: "light", ok: true, violations: [v("b-rule", "serious", 1), v("a-rule", "serious", 1), v("c-rule", "serious", 2)] }];
    expect(summarizeByRule(tie).map((r) => r.id)).toEqual(["c-rule", "a-rule", "b-rule"]);
  });

  it("the report gives the totals, a section per rule, the failed scans and the routes not scanned", () => {
    const md = renderMarkdown(records, NOT_SCANNED, { axeVersion: "4.14.1", commit: "abc1234" });
    expect(md).toContain("axe-core 4.14.1, default rules");
    expect(md).toContain("Commit abc1234. 3 scans (surface x theme) ran, 0 clean; 1 failed; 3 rules violated, 11 elements.");
    expect(md).toContain("## button-name (critical): help button-name");
    expect(md).toContain("- /broken [light]: twin:build failed (1)");
    for (const n of NOT_SCANNED) expect(md).toContain(`- ${n.pattern}: ${n.reason}`);
  });
});
