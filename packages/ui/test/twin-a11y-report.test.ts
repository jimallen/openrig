// workspaces-o9o.130: the pure half of twin:a11y (twin/capture/a11y-report.ts). The scan accounts for every route of
// src/routes.tsx (scanned, or listed as not scanned with a reason), and axe-core's results fold into a report by rule.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  NOT_SCANNED, SURFACES, crashMessage, renderMarkdown, routePatterns, summarizeByRule, unaccountedRoutes, type ScanRecord, type Violation,
} from "../twin/capture/a11y-report.js";

const routesSource = readFileSync(path.resolve(__dirname, "..", "src", "routes.tsx"), "utf8");

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
