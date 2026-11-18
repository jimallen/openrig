// workspaces-o9o.152 — axe nested-interactive (serious) on the twin: a button wrapping a link, or a role="button" row
// wrapping buttons. Each tree row and the storytelling card now keep their toggle and their link or actions as siblings.
// These rows pin that in jsdom; the twin scan (npm run twin:a11y) is the rendered proof.
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TopologyTreeView } from "../src/components/topology/TopologyTreeView.js";
import { ProjectTreeView } from "../src/components/project/ProjectTreeView.js";
import { ApprovalCard } from "../src/components/feed/cards/storytelling-cards.js";

const INTERACTIVE = 'a[href], button, input, select, textarea, summary, [role="button"], [role="link"], [tabindex]:not([tabindex="-1"])';

/** Every interactive element inside `root` that has another interactive element as an ancestor (within `root`). */
function nestedInteractive(root: Element): string[] {
  const out: string[] = [];
  for (const el of root.querySelectorAll(INTERACTIVE)) {
    const outer = el.parentElement?.closest(INTERACTIVE);
    if (outer && root.contains(outer)) out.push(`${el.tagName.toLowerCase()}[${el.getAttribute("data-testid") ?? el.textContent?.trim()}] in ${outer.tagName.toLowerCase()}[${outer.getAttribute("data-testid") ?? outer.getAttribute("aria-label") ?? ""}]`);
  }
  return out;
}

const mockFetch = vi.fn();
globalThis.fetch = mockFetch as unknown as typeof fetch;

function wireFetch() {
  mockFetch.mockImplementation(async (url: string) => {
    if (url === "/api/hosts") return { ok: true, json: async () => ({ ownName: "localhost", selected: "local", hosts: [] }) };
    if (url === "/api/config") return { ok: true, json: async () => ({ settings: {}, feedHostSubscriptions: [] }) };
    if (url === "/api/rigs/summary") {
      return { ok: true, json: async () => [{ id: "rig_a", name: "alpha", nodeCount: 1, latestSnapshotAt: null, latestSnapshotId: null }] };
    }
    if (url === "/api/rigs/rig_a/nodes") {
      return { ok: true, json: async () => [{ rigId: "rig_a", rigName: "alpha", logicalId: "lead.coordinator", podId: null, canonicalSessionName: "lead-coordinator@alpha", nodeKind: "agent", runtime: "claude-code", sessionStatus: "running", startupStatus: "ready", restoreOutcome: "n-a", tmuxAttachCommand: null, resumeCommand: null, latestError: null }] };
    }
    return { ok: true, json: async () => [] };
  });
}

function renderWithRouter(node: () => ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: node });
  const mk = (path: string) => createRoute({ getParentRoute: () => rootRoute, path, component: () => null });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, mk("/topology"), mk("/topology/rig/$rigId"), mk("/topology/pod/$rigId/$podName"), mk("/topology/seat/$rigId/$logicalId"), mk("/project")]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(<QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>);
}

beforeEach(() => { mockFetch.mockReset(); wireFetch(); });
afterEach(() => { cleanup(); });

describe("the nested-interactive instrument", () => {
  it("finds a link inside a button (positive control), and nothing in siblings", () => {
    const { container } = render(<div><button type="button"><a href="/x">x</a></button><button type="button">a</button><a href="/y">y</a></div>);
    expect(nestedInteractive(container)).toHaveLength(1);
  });
});

describe("no interactive control nested in another (workspaces-o9o.152)", () => {
  it("the topology tree: the selected host, an expanded rig and an expanded pod keep toggle and link side by side", async () => {
    const { container } = renderWithRouter(() => <TopologyTreeView />);
    // Expanded through each row's first button, which every revision of the tree has, so the nesting is judged first.
    await waitFor(() => expect(screen.getByTestId("topology-rig-rig_a")).toBeTruthy());
    fireEvent.click(screen.getByTestId("topology-rig-rig_a").querySelector("button")!);
    await waitFor(() => expect(screen.getByTestId("topology-pod-rig_a-lead")).toBeTruthy());
    fireEvent.click(screen.getByTestId("topology-pod-rig_a-lead").querySelector("button")!);
    expect(nestedInteractive(container)).toEqual([]);
    expect(screen.getByRole("button", { name: "Collapse alpha" }).getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("button", { name: /^Collapse lead/ }).getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("link", { name: "alpha" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Selected host/ }).getAttribute("aria-expanded")).toBe("true");
    expect(nestedInteractive(container)).toEqual([]);
  });

  it("the project tree's workspace row keeps its toggle and its open link side by side", async () => {
    const { container } = renderWithRouter(() => <ProjectTreeView />);
    await waitFor(() => expect(screen.getByTestId("project-workspace-toggle")).toBeTruthy());
    const toggle = screen.getByTestId("project-workspace-toggle");
    expect(toggle.contains(screen.getByTestId("project-workspace-link"))).toBe(false);
    expect(nestedInteractive(container)).toEqual([]);
  });

  it("a card's toggle is a button beside its inline actions, not around them", () => {
    const { container, getByTestId } = render(
      <ApprovalCard source={{ qitemId: "q1", title: "Approve?", oneLiner: "one", onApprove: () => {}, onDeny: () => {}, drillInHref: "/queue/q1" }} />,
    );
    const toggle = getByTestId("feed-card-approval-q1-toggle");
    expect(toggle.tagName).toBe("BUTTON");
    expect(toggle.contains(getByTestId("feed-card-approval-q1-approve"))).toBe(false);
    expect(nestedInteractive(container)).toEqual([]);
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(nestedInteractive(container)).toEqual([]);
  });
});
