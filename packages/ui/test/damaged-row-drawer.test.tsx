// @vitest-environment jsdom

// OF-136 F2: the For You card's "show context" drawer showed a damaged queue row as an ordinary row without tags. The drawer
// now carries the same DAMAGED notice and columns as the card.

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const selections: Array<{ type: string; data: Record<string, unknown> }> = [];
vi.mock("../src/components/AppShell.js", () => ({
  useDrawerSelection: () => ({ setSelection: (s: { type: string; data: Record<string, unknown> }) => { selections.push(s); } }),
}));
vi.mock("../src/components/terminal/ProgressiveTerminal.js", () => ({ ProgressiveTerminal: () => <div /> }));

import { FeedCard } from "../src/components/for-you/FeedCard.js";
import { QueueItemViewer } from "../src/components/drawer-viewers/QueueItemViewer.js";
import { attentionItemToFeedCard } from "../src/lib/attention-feed.js";
import type { AttentionQueueItem } from "../src/hooks/useAttentionItems.js";

afterEach(() => { cleanup(); selections.length = 0; });

function inRouter(node: ReactElement) {
  const root = createRootRoute();
  const r = createRoute({ getParentRoute: () => root, path: "/", component: () => node });
  const router = createRouter({ routeTree: root.addChildren([r]), history: createMemoryHistory({ initialEntries: ["/"] }) });
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><RouterProvider router={router as never} /></QueryClientProvider>);
}

const item = (over: Partial<AttentionQueueItem> = {}): AttentionQueueItem => ({
  qitemId: "qitem-drawer-1", tsCreated: "2026-10-27T00:00:00.000Z", tsUpdated: "2026-10-27T00:00:00.000Z",
  sourceSession: "advisor@rig", destinationSession: "human-bob@kernel", state: "pending", priority: "routine",
  tier: "human-gate", tags: ["x"], blockedOn: null, handedOffTo: null, handedOffFrom: null, body: "approve", ...over,
});

describe("OF-136 the show-context drawer", () => {
  it("the viewer names the damage and its columns when the row is flagged", () => {
    const view = render(<QueueItemViewer qitemId="q1" body="b" unreadable={["tags", "chain_of_record"]} />);
    const note = view.getByTestId("queue-item-viewer-damaged");
    expect(note.getAttribute("role")).toBe("note");
    expect(note.textContent).toContain("tags, chain_of_record");
    expect(note.textContent).toContain("unknown, not empty");
  });

  it("control: an unflagged row has no damaged note", () => {
    const view = render(<QueueItemViewer qitemId="q1" body="b" />);
    expect(view.queryByTestId("queue-item-viewer-damaged")).toBeNull();
  });

  it("'show context' on a damaged card hands the drawer the marker; on a readable card it does not", async () => {
    const damagedCard = attentionItemToFeedCard(item({ tags: null, unreadable: ["tags"] }));
    const view = inRouter(<FeedCard card={damagedCard} />);
    fireEvent.click(await waitFor(() => view.getByTestId(`feed-card-show-context-${damagedCard.id}`)));
    expect(selections).toHaveLength(1);
    expect(selections[0]!.data.unreadable).toEqual(["tags"]);
    cleanup();
    selections.length = 0;
    const okCard = attentionItemToFeedCard(item());
    const ok = inRouter(<FeedCard card={okCard} />);
    fireEvent.click(await waitFor(() => ok.getByTestId(`feed-card-show-context-${okCard.id}`)));
    expect(selections).toHaveLength(1);
    expect("unreadable" in selections[0]!.data).toBe(false);
  });
});
