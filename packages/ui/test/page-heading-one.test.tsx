// workspaces-o9o.157: every routed page has one level-one heading (axe page-has-heading-one), and the pages fixed here keep
// their heading levels contiguous (no h1 -> h3 skip, the next rule, heading-order). The browser measurement is the twin
// scan (`npm run twin:a11y`, o9o.130); these pin the source of each fix.
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { WorkflowHeader } from "../src/components/WorkflowScaffold.js";

afterEach(cleanup);

const src = (rel: string) => readFileSync(path.resolve(__dirname, "..", "src", rel), "utf8");
/** The heading levels a source file renders with literal <hN> tags. */
const levels = (text: string) => [...new Set([...text.matchAll(/<h([1-6])\b/g)].map((m) => Number(m[1])))].sort();

describe("page heading one (o9o.157)", () => {
  it("WorkflowHeader renders its title as the page's level-one heading", () => {
    render(<WorkflowHeader eyebrow="Rig Import" title="Import Rig" description="Validate a RigSpec." />);
    expect(screen.getByRole("heading", { level: 1, name: "Import Rig" })).toBeTruthy();
    expect(screen.queryAllByRole("heading", { level: 2 })).toEqual([]);
  });

  // Pages whose own markup carries the title: [file, the levels it must use (contiguous from 1), h1 count]. A page renders
  // one of several states, and each state has its own h1 (the loading and error states a screen-reader one, since the
  // twin measured those three pages in them): RigAgentsPage and FleetPage 3 (loading, error, page), PackageList 4
  // (loading, error, empty, page), PackageDetail 4 (loading, package error, history error, page).
  const pages: Array<[string, number[], number]> = [
    ["components/BundleInspector.tsx", [1, 2], 1],
    ["components/BundleInstallFlow.tsx", [1, 2], 1],
    ["components/PackageList.tsx", [1, 2], 4],
    ["components/PackageInstallFlow.tsx", [1], 1],
    ["components/PackageDetail.tsx", [1, 2], 4],
    ["components/mission-control/views/AuditHistoryView.tsx", [1], 1],
    ["components/review/FleetPage.tsx", [1, 2], 3],
    ["components/review/RigAgentsPage.tsx", [1, 2], 3],
  ];
  for (const [rel, want, h1s] of pages) {
    it(`${rel}: its title is an h1 and its levels are ${want.join(",")}`, () => {
      const s = src(rel);
      expect(levels(s)).toEqual(want);
      expect((s.match(/<h1\b/g) ?? []).length).toBe(h1s);
    });
  }

  it("BootstrapWizard: under WorkflowHeader's h1 its sections are h2, not h3", () => {
    const s = src("components/BootstrapWizard.tsx");
    expect(s).toContain("<WorkflowHeader");
    expect(levels(s)).toEqual([2]);
  });

  it("topology scope pages (host, pod, rig) render their title as a screen-reader h1", () => {
    const s = src("components/topology/ScopePages.tsx");
    expect(s).toContain('{title ? <h1 className="sr-only">{title}</h1> : null}');
    expect((s.match(/<ScopeShell\b/g) ?? []).length).toBe(3);
    expect((s.match(/^\s+title=\{/gm) ?? []).length).toBe(3);
  });

  it("the canvas and placeholder routes (/rigs/$rigId, /discovery) carry a screen-reader h1", () => {
    const s = src("routes.tsx");
    expect(s).toContain('<h1 className="sr-only">{rigName ?? rigId}</h1>');
    expect(s).toContain('<h1 className="sr-only">Discovery</h1>');
  });
});
