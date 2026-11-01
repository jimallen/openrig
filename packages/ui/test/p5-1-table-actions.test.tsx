// V1 polish slice Phase 5.1 P5.1-7: TopologyTableView actions column +
// row click navigation regression guard.
//
// The table has no cmux launch affordance (cmux was removed) and keeps
// row-click navigation to the agent detail page.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const navigateSpy = vi.fn();
vi.mock("@tanstack/react-router", async (importActual) => {
  const actual = await importActual<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    useNavigate: () => navigateSpy,
  };
});

import { TopologyTableView } from "../src/components/topology/TopologyTableView.js";

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

beforeEach(() => {
  navigateSpy.mockClear();
  mockFetch.mockReset();
  mockFetch.mockImplementation(async (url: string) => {
    if (url.includes("/api/rigs/summary")) {
      return new Response(JSON.stringify([{ id: "rig-1", name: "test-rig" }]));
    }
    if (url.includes("/api/rigs/rig-1/nodes")) {
      return new Response(
        JSON.stringify([
          {
            rigId: "rig-1",
            rigName: "test-rig",
            logicalId: "orch.lead",
            podId: "orch",
            podNamespace: "orch",
            canonicalSessionName: "orch-lead@test-rig",
            nodeKind: "agent",
            runtime: "claude-code",
            sessionStatus: "running",
            startupStatus: "ready",
            contextUsage: {
              usedPercentage: 42,
              remainingPercentage: 58,
              contextWindowSize: 320000,
              availability: "known",
              sampledAt: "2026-05-09T10:00:00Z",
              fresh: true,
              totalInputTokens: 120000,
              totalOutputTokens: 14000,
            },
            restoreOutcome: "n-a",
            tmuxAttachCommand: null,
            resumeCommand: null,
            latestError: null,
          },
        ]),
      );
    }
    return new Response("[]");
  });
});

afterEach(() => {
  cleanup();
});

function withQueryClient(ui: React.ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

describe("TopologyTableView P5.1-7 actions column + row click", () => {
  it("renders the actions column per agent row with no CMUX button (cmux was removed)", async () => {
    const { findByTestId, queryByTestId } = withQueryClient(<TopologyTableView />);
    const actions = await findByTestId("topology-table-actions-orch.lead");
    expect(actions.textContent ?? "").not.toMatch(/cmux/i);
    expect(queryByTestId("topology-table-cmux-orch.lead")).toBeNull();
  });

  it("renders context percentage and token total from node inventory", async () => {
    const { findByTestId } = withQueryClient(<TopologyTableView />);
    const context = await findByTestId("topology-table-context-orch.lead");
    const tokens = await findByTestId("topology-table-tokens-orch.lead");
    expect(context.textContent).toBe("42%");
    expect(tokens.textContent).toBe("134k");
    expect(tokens.getAttribute("title")).toContain("Tokens: 134,000");
  });

  it("row click navigates to /topology/seat/$rigId/$logicalId", async () => {
    const { findByTestId } = withQueryClient(<TopologyTableView />);
    const row = await findByTestId("topology-table-row-orch.lead");
    fireEvent.click(row);
    await waitFor(() => {
      expect(navigateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          to: "/topology/seat/$rigId/$logicalId",
          params: {
            rigId: "rig-1",
            logicalId: encodeURIComponent("orch.lead"),
          },
        }),
      );
    });
  });
});
