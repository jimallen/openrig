// cmux was removed (the hc cutover). These pins hold the two UI surfaces that no other test renders:
// the hybrid topology card and the author-agent tag. Each used to carry a cmux launch; neither may now.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  RouterProvider,
  createRouter,
  createRootRoute,
  createRoute,
  Outlet,
} from "@tanstack/react-router";
import { HybridAgentNode } from "../src/components/topology/HybridTopologyNodes.js";
import { AuthorAgentTag } from "../src/components/for-you/AuthorAgentTag.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the hybrid topology card has no cmux launch", () => {
  it("renders the terminal preview trigger and nothing that names cmux", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container, queryByTestId } = render(
      <QueryClientProvider client={qc}>
        <ReactFlowProvider>
          <HybridAgentNode
            data={{ logicalId: "dev.impl", rigId: "rig-1", role: "worker", runtime: "claude-code", canonicalSessionName: "dev-impl@rig-1" }}
          />
        </ReactFlowProvider>
      </QueryClientProvider>,
    );
    // positive control: the card rendered, and its terminal affordance is there
    expect(container.textContent).toContain("dev-impl@rig-1");
    expect(queryByTestId("hybrid-dev.impl-terminal-open")).not.toBeNull();
    expect(queryByTestId("hybrid-cmux-open-dev.impl")).toBeNull();
    expect(container.innerHTML).not.toMatch(/cmux/i);
  });
});

describe("the author-agent tag only navigates", () => {
  it("a plain click on the tag fires no request (it used to POST open-cmux)", async () => {
    const fetchSpy = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetchSpy);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const rootRoute = createRootRoute({ component: () => <Outlet /> });
    const indexRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: () => <AuthorAgentTag authorSession="dev-impl@rig-1" />,
    });
    const seatRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/topology/seat/$rigId/$logicalId",
      component: () => <div data-testid="seat-page" />,
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([indexRoute, seatRoute]),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    const { findByTestId } = render(
      <QueryClientProvider client={qc}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    const tag = await findByTestId("author-agent-tag");
    fireEvent.click(tag);
    // positive control: the click did navigate to the seat page
    await waitFor(() => expect(router.state.location.pathname).toBe("/topology/seat/rig-1/dev-impl"));
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
