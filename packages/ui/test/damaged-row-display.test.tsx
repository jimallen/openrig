// @vitest-environment jsdom

// OF-136: the daemon serves a saved row with a damaged JSON column flagged `unreadable: [columns]` (OF-117), reads its
// damaged fields as null/empty, and refuses every action on it (HTTP 422 saved_row_unreadable). The UI used to render such a
// row like any other: a workflow instance whose deadline the daemon serves as "healthy" ranked as healthy and its band showed
// nothing, a damaged instance page said "Instance Not Found", and a queue-derived feed card still offered APPROVE and CHAT.
//
// jsdom computes no layout and paints nothing: these pins prove what the DOM says and offers, not how it looks.

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("../src/components/terminal/ProgressiveTerminal.js", () => ({
  ProgressiveTerminal: () => <div data-testid="mock-progressive-terminal" />,
}));

import { FeedCard } from "../src/components/for-you/FeedCard.js";
import { attentionItemToFeedCard } from "../src/lib/attention-feed.js";
import type { AttentionQueueItem } from "../src/hooks/useAttentionItems.js";
import { ExceptionBanner, WorkflowInstancePage } from "../src/components/workflow/WorkflowInstancePage.js";
import { WorkflowInstanceRow, instanceAttentionRank, selectSpecInstances } from "../src/components/workflow/WorkflowInstancesBand.js";
import { WorkflowsPage } from "../src/components/workflow/WorkflowsPage.js";
import type { WorkflowInstanceWithDeadline } from "../src/hooks/useWorkflow.js";
import { SavedRowUnreadableError, damagedColumns, throwIfSavedRowUnreadable } from "../src/lib/damaged-row.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const instance = (over: Partial<WorkflowInstanceWithDeadline> = {}): WorkflowInstanceWithDeadline => ({
  instanceId: "01WFINSTANCEAAAAAAAAAAAAAA",
  workflowName: "conveyor",
  workflowVersion: "1",
  createdBySession: "lead@rig",
  createdAt: "2026-10-27T10:00:00.000Z",
  status: "active",
  currentFrontier: [],
  currentStepId: null,
  hopCount: 2,
  fallbackSynthesis: null,
  lastContinuationDecision: null,
  completedAt: null,
  version: 1,
  resumeCount: 0,
  hopsBaseline: 0,
  deadline: { state: "healthy", evidence: null },
  ...over,
});

/** Exactly what the daemon serves for a damaged instance: a healthy-looking verdict kept only to preserve the shape. */
const DAMAGED = instance({ instanceId: "01WFDAMAGEDAAAAAAAAAAAAAA", status: "failed", unreadable: ["current_frontier_json"] });

function inRouter(node: ReactElement, path = "/") {
  const rootRoute = createRootRoute();
  const mk = (p: string) => createRoute({ getParentRoute: () => rootRoute, path: p, component: () => node });
  const routeTree = rootRoute.addChildren([
    mk("/"),
    mk("/workflows"),
    mk("/workflow/instance/$instanceId"),
    mk("/specs/library/$entryId"),
    mk("/specs"),
  ]);
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [path] }) });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("OF-136 workflow instance rows", () => {
  it("a damaged instance ranks first although the daemon serves its deadline as healthy and its status as active", () => {
    const damagedActive = instance({ unreadable: ["lastContinuationDecision"], status: "active" });
    expect(damagedActive.deadline.state).toBe("healthy");
    expect(instanceAttentionRank(damagedActive)).toBe(0);
    // control: the same instance without the marker is ordinary
    expect(instanceAttentionRank(instance({ status: "active" }))).toBe(3);
    const sorted = selectSpecInstances([instance({ instanceId: "A", status: "failed" }), instance({ instanceId: "B" }), instance({ instanceId: "D", unreadable: ["x_json"] })]);
    expect(sorted.map((i) => i.instanceId).slice(0, 2).sort()).toEqual(["A", "D"]);
    expect(sorted[2]!.instanceId).toBe("B");
  });

  it("the row says DAMAGED, names the columns and says position is unknown, instead of FAILED/ACTIVE and a step", async () => {
    const view = inRouter(<ul><WorkflowInstanceRow instance={{ ...DAMAGED, currentStepId: "build" }} /></ul>);
    const row = await waitFor(() => view.getByTestId(`workflow-instance-row-${DAMAGED.instanceId}`));
    const text = row.textContent ?? "";
    expect(text).toContain("DAMAGED");
    expect(text).toContain("current_frontier_json unreadable");
    expect(text).toContain("do not act on it");
    expect(text).toContain("position unknown");
    expect(text).not.toContain("FAILED");
    expect(text).not.toContain("at build");
  });

  it("a readable instance renders as before (control: no damaged marker, its step shown)", async () => {
    const view = inRouter(<ul><WorkflowInstanceRow instance={instance({ currentStepId: "build" })} /></ul>);
    const row = await waitFor(() => view.getByTestId("workflow-instance-row-01WFINSTANCEAAAAAAAAAAAAAA"));
    expect(row.textContent).toContain("ACTIVE");
    expect(row.textContent).toContain("at build");
    expect(row.textContent).not.toContain("DAMAGED");
  });
});

describe("OF-136 the instance page", () => {
  it("ExceptionBanner on a damaged failed instance names the damage and offers no Resume", () => {
    const view = render(<ExceptionBanner instance={DAMAGED} onResume={() => {}} resuming={false} resumeError={null} />);
    expect(view.getByTestId("workflow-instance-damaged").textContent).toContain("current_frontier_json");
    expect(view.queryByTestId("workflow-resume")).toBeNull();
  });

  it("control: the same failed instance without the marker still offers Resume", () => {
    const view = render(<ExceptionBanner instance={{ ...DAMAGED, unreadable: undefined }} onResume={() => {}} resuming={false} resumeError={null} />);
    expect(view.getByTestId("workflow-resume")).toBeTruthy();
    expect(view.queryByTestId("workflow-instance-damaged")).toBeNull();
  });

  it("the daemon's 422 refusal reads 'Instance Is Damaged', not 'Instance Not Found'", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (String(url).endsWith("/trace")) {
        return json(422, { error: "Saved workflow_instances row WF-BAD is damaged", code: "saved_row_unreadable", table: "workflow_instances", rowId: "WF-BAD", columns: ["current_frontier_json"] });
      }
      return json(404, { error: "not_found" });
    }));
    const view = inRouter(<WorkflowInstancePage instanceId="WF-BAD" />, "/");
    const page = await waitFor(() => view.getByTestId("workflow-instance-damaged-page"));
    expect(page.textContent).toContain("Instance Is Damaged");
    expect(page.textContent).toContain("WF-BAD");
    expect(page.textContent).toContain("current_frontier_json");
    expect(page.textContent).not.toContain("Not Found");
    expect(view.queryByTestId("workflow-resume")).toBeNull();
  });

  it("control: an ordinary failure is still 'Instance Not Found'", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(404, { error: "not_found" })));
    const view = inRouter(<WorkflowInstancePage instanceId="WF-GONE" />, "/");
    const page = await waitFor(() => view.getByTestId("workflow-instance-error"));
    expect(page.textContent).toContain("Instance Not Found");
  });
});

describe("OF-136 the workflows page", () => {
  const specs = [
    { name: "okspec", version: "1", purpose: null, targetRig: null, coordinationTerminalTurnRule: "x", sourcePath: "/s/ok.yaml", cachedAt: "t", isBuiltIn: false },
    { name: "badspec", version: "2", purpose: null, targetRig: null, coordinationTerminalTurnRule: "x", sourcePath: "/s/bad.yaml", cachedAt: "t", isBuiltIn: false, unreadable: ["steps_json"] },
  ];
  function stubWorkflowApi(instances: unknown[]) {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (String(url).includes("/api/workflow/list")) return json(200, instances);
      if (String(url).includes("/api/workflow/specs")) return json(200, { specs });
      return json(404, {});
    }));
  }

  it("an idle damaged spec is listed as DAMAGED with its columns and cannot be opened; a readable one still can", async () => {
    stubWorkflowApi([]);
    const view = inRouter(<WorkflowsPage />, "/");
    const bad = await waitFor(() => view.getByTestId("workflows-idle-spec-damaged-badspec"));
    expect(bad.textContent).toContain("DAMAGED");
    expect(bad.textContent).toContain("steps_json");
    expect(view.queryByTestId("workflows-idle-spec-badspec")).toBeNull();
    expect(view.getByTestId("workflows-idle-spec-okspec").tagName).toBe("BUTTON");
  });

  it("a damaged instance is counted as needing attention and shown as DAMAGED, not as a live healthy run", async () => {
    stubWorkflowApi([{ ...instance({ instanceId: "01WFDAMAGEDAAAAAAAAAAAAAA", status: "active", unreadable: ["current_frontier_json"] }) }]);
    const view = inRouter(<WorkflowsPage />, "/");
    await waitFor(() => view.getByTestId("workflow-instance-row-01WFDAMAGEDAAAAAAAAAAAAAA"));
    expect(view.container.textContent).toContain("1 need attention");
    expect(view.getByTestId("workflow-instance-row-01WFDAMAGEDAAAAAAAAAAAAAA").textContent).toContain("DAMAGED");
  });

  it("the group header flags a damaged spec that instances were started from", async () => {
    stubWorkflowApi([instance({ workflowName: "badspec", workflowVersion: "2" })]);
    const view = inRouter(<WorkflowsPage />, "/");
    const flag = await waitFor(() => view.getByTestId("workflows-group-spec-damaged-badspec"));
    expect(flag.textContent).toContain("steps_json");
  });
});

describe("OF-136 the For You feed card", () => {
  const attention = (over: Partial<AttentionQueueItem> = {}): AttentionQueueItem => ({
    qitemId: "qitem-20261027000000-aaaa",
    tsCreated: "2026-10-27T00:00:00.000Z",
    tsUpdated: "2026-10-27T00:00:00.000Z",
    sourceSession: "advisor@rig",
    destinationSession: "human-bob@kernel",
    state: "pending",
    priority: "routine",
    tier: "human-gate",
    tags: ["slice:alpha"],
    blockedOn: null,
    handedOffTo: null,
    handedOffFrom: null,
    body: "approve the cut",
    ...over,
  });

  it("the adapter carries the marker onto the card, and only when there is one", () => {
    expect(attentionItemToFeedCard(attention({ tags: null, unreadable: ["tags"] })).unreadable).toEqual(["tags"]);
    expect("unreadable" in attentionItemToFeedCard(attention())).toBe(false);
    expect("unreadable" in attentionItemToFeedCard(attention({ unreadable: [] }))).toBe(false);
  });

  it("a card for a damaged queue row names the damage and offers neither APPROVE nor CHAT", async () => {
    const card = attentionItemToFeedCard(attention({ tags: null, unreadable: ["tags", "chain_of_record"] }));
    const view = inRouter(<FeedCard card={card} />);
    const notice = await waitFor(() => view.getByTestId(`feed-card-damaged-${card.id}`));
    expect(notice.getAttribute("role")).toBe("alert");
    expect(notice.textContent).toContain("tags, chain_of_record");
    expect(notice.textContent).toContain("unknown, not empty");
    expect(view.queryByTestId("mc-verb-approve")).toBeNull();
    expect(view.queryByTestId(`feed-card-chat-${card.id}`)).toBeNull();
    expect(view.queryByTestId(`feed-card-actions-${card.id}`)).toBeNull();
  });

  it("control: the same card without the marker offers APPROVE and CHAT and shows no damaged notice", async () => {
    const card = attentionItemToFeedCard(attention());
    const view = inRouter(<FeedCard card={card} />);
    await waitFor(() => view.getByTestId("mc-verb-approve"));
    expect(view.getByTestId(`feed-card-chat-${card.id}`)).toBeTruthy();
    expect(view.queryByTestId(`feed-card-damaged-${card.id}`)).toBeNull();
  });
});

describe("OF-136 the refusal helper", () => {
  it("throws only for the daemon's saved_row_unreadable 422, and keeps the body readable for the caller", async () => {
    const refusal = { error: "x", code: "saved_row_unreadable", table: "queue_items", rowId: "q1", columns: ["tags"] };
    const res = json(422, refusal);
    await expect(throwIfSavedRowUnreadable(res)).rejects.toBeInstanceOf(SavedRowUnreadableError);
    expect(await res.json()).toEqual(refusal);
    await expect(throwIfSavedRowUnreadable(json(422, { error: "other", code: "something_else" }))).resolves.toBeUndefined();
    await expect(throwIfSavedRowUnreadable(json(404, refusal))).resolves.toBeUndefined();
    await expect(throwIfSavedRowUnreadable(new Response("not json", { status: 422 }))).resolves.toBeUndefined();
  });

  it("damagedColumns ignores a missing, empty or non-list marker", () => {
    expect(damagedColumns({ unreadable: ["a", "b"] })).toEqual(["a", "b"]);
    expect(damagedColumns({ unreadable: [] })).toEqual([]);
    expect(damagedColumns({})).toEqual([]);
    expect(damagedColumns(null)).toEqual([]);
  });
});
