// @vitest-environment jsdom

// OF-159 (UI): (1) the slice Overview names a workflow binding whose saved frontier the daemon could not read (OF-146 marks it
// `unreadable`), instead of showing the bound workflow as ordinary; (2) on a damaged workflow row the age and arrow stay on the
// first line and the damage note takes the second (review-w2 F6: the age used to drop to a third line).
//
// jsdom computes no layout: the row check proves the ordering class is present, NOT where the age lands. The rendered line count
// was measured in a real browser (see the unit report).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, fireEvent, waitFor } from "@testing-library/react";
import {
  createMemoryHistory,
  RouterProvider,
  createRouter,
  createRootRoute,
  createRoute,
  Outlet,
} from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DrawerSelectionContext } from "../src/components/AppShell.js";
import { SliceScopePage } from "../src/components/project/ScopePages.js";
import { WorkflowInstanceRow } from "../src/components/workflow/WorkflowInstancesBand.js";
import type { SliceDetail, WorkflowBindingPayload } from "../src/hooks/useSlices.js";
import type { WorkflowInstanceWithDeadline } from "../src/hooks/useWorkflow.js";

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

beforeEach(() => {
  mockFetch.mockReset();
});

afterEach(() => {
  cleanup();
});

function renderSliceScope(opts: {
  sliceId: string;
  detail?: SliceDetail | null;
  status?: number;
}): { setSelection: ReturnType<typeof vi.fn> } & ReturnType<typeof render> {
  const setSelection = vi.fn();
  // Mock /api/slices/:name response.
  mockFetch.mockImplementation(async (url: string) => {
    if (url.includes(`/api/slices/${opts.sliceId}/doc/`)) {
      return new Response(JSON.stringify({ relPath: "README.md", content: "# Readme" }), { status: 200 });
    }
    if (url.includes(`/api/slices/${opts.sliceId}`)) {
      if (opts.status && opts.status !== 200) {
        return new Response("not found", { status: opts.status });
      }
      return new Response(JSON.stringify(opts.detail), { status: 200 });
    }
    if (url.includes("/api/queue/qitem-A")) {
      return new Response(JSON.stringify(makeQueueItem("qitem-A", "Body for qitem-A")));
    }
    if (url.includes("/api/queue/qitem-B")) {
      return new Response(JSON.stringify(makeQueueItem("qitem-B", "Body for qitem-B")));
    }
    if (url.includes("/api/files/roots")) {
      // OPR.0.4.1 AC-4-FF: the Artifacts tab now mounts ArtifactsNavigator. With no
      // allowlist roots it deterministically renders its unavailable setup hint
      // (only the navigator renders that testid — proves the swap from the card wall).
      return new Response(JSON.stringify({ roots: [] }));
    }
    return new Response("[]");
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const sliceRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/project/slice/$sliceId",
    component: () => (
      <DrawerSelectionContext.Provider value={{ selection: null, setSelection }}>
        <SliceScopePage />
      </DrawerSelectionContext.Provider>
    ),
  });
  // Stub other routes that tabs may try to Link to (TopologyTab uses
  // /topology/seat/... links etc).
  const fallbackRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "$",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([sliceRoute, fallbackRoute]),
    history: createMemoryHistory({ initialEntries: [`/project/slice/${opts.sliceId}`] }),
  });
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { setSelection, ...utils };
}

function makeQueueItem(qitemId: string, body: string) {
  return {
    qitemId,
    tsCreated: "2026-05-06T18:00:00Z",
    tsUpdated: "2026-05-06T18:00:00Z",
    sourceSession: "source@rig",
    destinationSession: "dest@rig",
    state: "in-progress",
    priority: "routine",
    tier: "mode2",
    tags: ["demo"],
    body,
  };
}

function makeDetail(overrides: Partial<SliceDetail> = {}): SliceDetail {
  return {
    name: "idea-ledger",
    displayName: "Idea Ledger",
    railItem: null,
    status: "active",
    rawStatus: "active",
    qitemIds: ["qitem-A", "qitem-B"],
    commitRefs: ["abc1234"],
    lastActivityAt: "2026-05-06T18:00:00Z",
    workflowBinding: null,
    story: { events: [], phaseDefinitions: null },
    acceptance: {
      totalItems: 3,
      doneItems: 1,
      percentage: 33,
      items: [
        {
          text: "item one",
          done: true,
          source: { file: "PROGRESS.md", line: 1 },
        },
      ],
      closureCallout: null,
      currentStep: null,
    },
    decisions: { rows: [] },
    docs: { tree: [] },
    tests: { proofPackets: [], aggregate: { passCount: 0, failCount: 0 } },
    topology: { affectedRigs: [], totalSeats: 0, specGraph: null },
    ...overrides,
  };
}


const binding = (over: Partial<WorkflowBindingPayload> = {}): WorkflowBindingPayload => ({
  instanceId: "01WFINSTANCEAAAAAAAAAAAAAA", workflowName: "conveyor", workflowVersion: "1", status: "active", currentStepId: "build",
  currentFrontier: [], hopCount: 2, createdAt: "2026-10-27T10:00:00.000Z", completedAt: null, additionalInstanceIds: [], ...over,
});

describe("OF-159: the slice Overview marks a workflow binding whose saved frontier is unreadable", () => {
  async function overview(workflowBinding: WorkflowBindingPayload) {
    const view = renderSliceScope({ sliceId: "idea-ledger", detail: makeDetail({ workflowBinding }) });
    await view.findByTestId("project-tab-nav");
    fireEvent.click(view.container.querySelector("[data-testid='project-tab-overview']")!);
    await view.findByTestId("slice-overview-tab");
    return view;
  }

  it("control: a readable binding shows the workflow line and no damage note", async () => {
    const view = await overview(binding());
    expect(view.container.textContent).toContain("Workflow: conveyor v1");
    expect(view.queryByTestId("slice-overview-workflow-damaged")).toBeNull();
  });

  it("a binding marked unreadable shows the damage, names the column and says a live step is unknown", async () => {
    const view = await overview(binding({ unreadable: ["current_frontier_json"] }));
    const note = view.getByTestId("slice-overview-workflow-damaged");
    expect(note.textContent).toContain("DAMAGED");
    expect(note.textContent).toContain("current_frontier_json unreadable");
    expect(note.textContent).toContain("unknown");
    expect(note.getAttribute("title")).toContain("Saved current_frontier_json cannot be read");
  });

  it("a marker that names no column still shows damage", async () => {
    const view = await overview(binding({ unreadable: [""] }));
    expect(view.getByTestId("slice-overview-workflow-damaged").textContent).toContain("unknown columns unreadable");
  });
});

describe("OF-159: a damaged workflow row keeps its age on the first line", () => {
  const damagedInstance: WorkflowInstanceWithDeadline = {
    instanceId: "01WFDAMAGEDAAAAAAAAAAAAAA", workflowName: "conveyor", workflowVersion: "1", createdBySession: "lead@rig",
    createdAt: "2026-10-27T10:00:00.000Z", status: "active", currentFrontier: [], currentStepId: null, hopCount: 2, fallbackSynthesis: null,
    lastContinuationDecision: null, completedAt: null, version: 1, resumeCount: 0, hopsBaseline: 0,
    deadline: { state: "healthy", evidence: null }, unreadable: ["current_frontier_json"],
  };

  it("the damage note is ordered after the age and arrow, so the wrapped note cannot push them to a third line", async () => {
    const rootRoute = createRootRoute();
    const mk = (p: string) => createRoute({ getParentRoute: () => rootRoute, path: p, component: () => <ul><WorkflowInstanceRow instance={damagedInstance} /></ul> });
    const router = createRouter({ routeTree: rootRoute.addChildren([mk("/"), mk("/workflow/instance/$instanceId")]), history: createMemoryHistory({ initialEntries: ["/"] }) });
    const view = render(<QueryClientProvider client={new QueryClient()}><RouterProvider router={router as never} /></QueryClientProvider>);
    const note = await waitFor(() => view.getByTestId(`workflow-instance-damaged-${damagedInstance.instanceId}`));
    expect(note.className).toContain("basis-full");
    expect(note.className.split(/\s+/)).toContain("order-last");
  });
});
