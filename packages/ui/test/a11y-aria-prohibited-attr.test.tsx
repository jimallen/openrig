// workspaces-o9o.154: axe's aria-prohibited-attr (serious) on six twin surfaces (/context, /lab/card-previews, /rigs/rig_alpha, /topology,
// /topology/pod/rig_alpha/lead, /topology/rig/rig_alpha): an aria-label on a plain span or div, whose (generic) role does not allow a name,
// so assistive technology ignores it. Measured with the o9o.130 twin scan (axe-core 4.14.1, default rules): 42 targets from four
// components, the context ring, the rig node's activity dot, the hybrid topology node's activity dot and the progress card's bar. Each
// now has the role that its label names (img; progressbar), or its label became visible-to-assistive-tech text. axe runs here with its
// DEFAULT rules, none disabled. A source census pins the same rule for every span/div in src/.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ReactFlowProvider } from "@xyflow/react";
import axe from "axe-core";
import { readFileSync, readdirSync } from "node:fs";
import nodePath from "node:path";
import ts from "typescript";

vi.mock("../src/components/terminal/FocusedTerminal.js", () => ({
  FocusedTerminal: ({ sessionName }: { sessionName: string }) => <div data-testid={`live-${sessionName}`} />,
}));
vi.mock("../src/components/preview/SessionPreviewPane.js", () => ({
  SessionPreviewPane: ({ sessionName }: { sessionName: string }) => <div data-testid={`preview-${sessionName}`} />,
}));

import { ContextUsageRing } from "../src/components/ContextUsageRing.js";
import { RigNode } from "../src/components/RigNode.js";
import { HybridAgentNode } from "../src/components/topology/HybridTopologyNodes.js";
import { ProgressCard } from "../src/components/feed/cards/storytelling-cards.js";
import { __resetFallbackRegistryForTests } from "../src/components/terminal/LiveTerminalProvider.js";

afterEach(() => { cleanup(); __resetFallbackRegistryForTests(); });

/** The targets axe reports for aria-prohibited-attr, with its default rules. */
async function prohibited(container: Element): Promise<string[]> {
  const result = await axe.run(container);
  return result.violations.filter((v) => v.id === "aria-prohibited-attr").flatMap((v) => v.nodes.map((n) => n.html));
}

describe("the instrument", () => {
  // The scanned targets are empty spans/divs (a dot, a ring, a bar); the control has that shape.
  it("axe reports an empty span with an aria-label, and not the same span with role img", async () => {
    const bare = render(<main><span aria-label="busy" /></main>);
    expect(await prohibited(bare.container)).toHaveLength(1);
    cleanup();
    const named = render(<main><span role="img" aria-label="busy" /></main>);
    expect(await prohibited(named.container)).toEqual([]);
  });
});

describe("the four components behind the six surfaces carry no prohibited ARIA attribute, and keep their name", () => {
  it("the context ring (/rigs, /topology, /context): an img named by its tier", async () => {
    const { container, getByTestId } = render(<main><ContextUsageRing percent={70} availability="known" fresh testIdSuffix="alpha" /></main>);
    expect(await prohibited(container)).toEqual([]);
    const ring = getByTestId("context-ring-alpha");
    expect(ring.getAttribute("role")).toBe("img");
    expect(ring.getAttribute("aria-label")).toBeTruthy();
  });

  it("the rig node's activity dot (/rigs/rig_alpha, /topology/rig/rig_alpha): an img named by its activity", async () => {
    const { container, getByTestId } = render(
      <main>
        <ReactFlowProvider>
          <RigNode
            data={{ logicalId: "dev.impl", rigId: "rig-1", role: "worker", runtime: "claude-code", model: null, status: "running",
              startupStatus: "ready" as const, canonicalSessionName: "dev-impl@test-rig", binding: { tmuxSession: "dev-impl@test-rig" } } as never}
          />
        </ReactFlowProvider>
      </main>,
    );
    expect(await prohibited(container)).toEqual([]);
    const dot = getByTestId("activity-dot-dev.impl");
    expect(dot.getAttribute("role")).toBe("img");
    expect(dot.getAttribute("aria-label")).toMatch(/^activity: /);
  });

  it("the hybrid topology node's activity dot (/topology, /topology/pod/...): an img named by its activity", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container, getByTestId } = render(
      <main>
        <QueryClientProvider client={client}>
          <ReactFlowProvider>
            <HybridAgentNode data={{ logicalId: "driver", role: "driver", runtime: "claude-code", model: null, status: "running",
              contextAvailability: "known", contextUsedPercentage: 14, contextFresh: true, canonicalSessionName: "velocity-driver@openrig-velocity" } as never} />
          </ReactFlowProvider>
        </QueryClientProvider>
      </main>,
    );
    expect(await prohibited(container)).toEqual([]);
    const dot = getByTestId("hybrid-activity-dot-driver");
    expect(dot.getAttribute("role")).toBe("img");
    expect(dot.getAttribute("aria-label")).toBeTruthy();
  });

  it("the progress card's bar (/lab/card-previews): a progressbar with its value", async () => {
    const { container, getByTestId } = render(<main><ProgressCard source={{ missionId: "m1", title: "Mission one", oneLiner: "moving", percent: 42 }} /></main>);
    expect(await prohibited(container)).toEqual([]);
    const bar = getByTestId("feed-card-progress-m1-bar");
    expect(bar.getAttribute("role")).toBe("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("42");
    // verify-qa2 review: the name says WHAT is progressing and carries no number, since aria-valuenow already says how far (a name with
    // the percentage made a screen reader say it twice).
    expect(bar.getAttribute("aria-label")).toBe("Mission one progress");
    expect(bar.getAttribute("aria-label")).not.toMatch(/\d|%/);
    expect([bar.getAttribute("aria-valuemin"), bar.getAttribute("aria-valuemax")]).toEqual(["0", "100"]);
  });
});

describe("source census: no span or div in src/ names itself without a role", () => {
  it("every span/div with aria-label, aria-labelledby or aria-roledescription has a role", () => {
    const root = nodePath.resolve(import.meta.dirname, "../src");
    const files: string[] = [];
    const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = nodePath.join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith(".tsx")) files.push(p); } };
    walk(root);
    const NAMING = new Set(["aria-label", "aria-labelledby", "aria-roledescription"]);
    let named = 0;
    const offenders: string[] = [];
    for (const f of files) {
      const sf = ts.createSourceFile(f, readFileSync(f, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      const visit = (n: ts.Node) => {
        if ((ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) && ["span", "div"].includes(n.tagName.getText(sf))) {
          const attrs = n.attributes.properties.filter(ts.isJsxAttribute).map((a) => a.name.getText(sf));
          if (attrs.some((a) => NAMING.has(a))) {
            named++;
            if (!attrs.includes("role")) offenders.push(`${nodePath.relative(root, f)}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`);
          }
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
    expect(files.length).toBeGreaterThan(100);
    expect(named).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });
});
