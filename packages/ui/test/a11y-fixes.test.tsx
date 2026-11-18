// workspaces-o9o.130: pins for the violations the twin axe scan found and this unit fixed.
// 1. /search's audit filters: the verb select had no accessible name (select-name, critical) and the since/until fields were
//    named only by a title (label-title-only).
// 2. Detail panes nested their own <main> inside the shell's (landmark-no-duplicate-main, landmark-main-is-top-level,
//    landmark-unique on /files); the same markup was in four panes.
// 3. The shared detail drawer is a role="dialog" with no accessible name (aria-dialog-name, serious): found once the scan
//    opened non-Radix dialogs too (verify-qa2's finding).
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import axe from "axe-core";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { AuditHistoryView } from "../src/components/mission-control/views/AuditHistoryView.js";
import { SharedDetailDrawer } from "../src/components/SharedDetailDrawer.js";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("the audit filters have accessible names (o9o.130)", () => {
  it("axe finds no unnamed select and no title-only field, and each control has its name", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ rows: [], hasMore: false, nextBeforeId: null }) })));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(<QueryClientProvider client={client}><AuditHistoryView /></QueryClientProvider>);
    await waitFor(() => expect(screen.getByTestId("mc-audit-filter-action-verb")).toBeTruthy());
    expect(screen.getByRole("combobox", { name: "Action verb" })).toBeTruthy();
    expect(screen.getByLabelText("Since")).toBeTruthy();
    expect(screen.getByLabelText("Until")).toBeTruthy();
    const ids = (await axe.run(container)).violations.map((v) => v.id);
    expect(ids).not.toContain("select-name");
    expect(ids).not.toContain("label-title-only");
  });
});

/** Every .tsx under src/components. */
function components(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n);
    return statSync(p).isDirectory() ? components(p) : n.endsWith(".tsx") ? [p] : [];
  });
}

describe("one main landmark: only the shell renders <main> (o9o.130)", () => {
  const COMPONENTS = path.resolve(__dirname, "..", "src", "components");
  const MAIN = /<main(?=[\s>])/;

  it("no component but AppShell opens a <main> element", () => {
    const hits = components(COMPONENTS)
      .filter((f) => path.basename(f) !== "AppShell.tsx")
      .flatMap((f) => readFileSync(f, "utf8").split("\n").flatMap((line, i) =>
        MAIN.test(line) && !line.trim().startsWith("//") && !line.trim().startsWith("*") ? [`${path.relative(COMPONENTS, f)}:${i + 1}`] : []));
    expect(hits).toEqual([]);
  });

  it("control: the scan finds the shell's own <main>", () => {
    const shell = readFileSync(path.join(COMPONENTS, "AppShell.tsx"), "utf8").split("\n");
    expect(shell.some((line) => MAIN.test(line) && !line.trim().startsWith("//"))).toBe(true);
  });
});

describe("the shared detail drawer is a named dialog (o9o.130)", () => {
  it("opened on a sub-spec, it is a dialog named for its kind, and axe finds no unnamed dialog", async () => {
    const { container } = render(
      <SharedDetailDrawer
        selection={{ type: "sub-spec", data: { specKind: "rig", specName: "relay", version: "0.1.0", source: "builtin", manifestExcerpt: "name: relay" } }}
        onClose={() => undefined}
        events={[]}
      />,
    );
    expect(screen.getByRole("dialog", { name: "Sub-spec preview" })).toBeTruthy();
    const r = await axe.run(container, { runOnly: ["aria-dialog-name"] });
    expect(r.violations).toEqual([]);
    expect(r.passes.map((p) => p.id)).toEqual(["aria-dialog-name"]);
  });
});
