// @vitest-environment jsdom

// OF-146: (1) the mission-control row carries the daemon's `unreadable` marker (OF-117) and shows it; the renderer is not
// mounted on a shipped route today, so this is a component-level pin. (2) The instance heading breaks a long unbreakable id.
//
// jsdom computes no layout: the heading row proves the class is present, NOT that the id fits. The 375 px fit was measured
// in a real browser (see the unit report).

import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import { CompactStatusRow } from "../src/components/mission-control/components/CompactStatusRow.js";
import type { CompactStatusRow as Row } from "../src/components/mission-control/hooks/useMissionControlView.js";
import { WorkflowHeader } from "../src/components/WorkflowScaffold.js";

afterEach(cleanup);

const row = (over: Partial<Row> = {}): Row => ({
  rigOrMissionName: "human-operator@kernel", currentPhase: "human-gate", state: "attention", nextAction: null,
  pendingHumanDecision: "high human-gate item", readCost: "skim/approve", lastUpdate: "2026-10-27T10:00:00.000Z",
  confidenceFreshness: "high", evidenceLink: null, qitemId: "qitem-1", rawSourceRef: "src@rig", qitemSummary: "Choose the cover",
  qitemBody: "Choose the cover", ...over,
});

describe("OF-146 CompactStatusRow shows a damaged qitem", () => {
  it("names the unreadable columns, marks the row and offers no ACT; a readable row is unchanged", () => {
    const { rerender } = render(<CompactStatusRow row={row({ unreadable: ["tags"] })} onAction={() => {}} />);
    const damaged = screen.getByTestId("mc-status-row");
    expect(damaged.getAttribute("data-damaged")).toBe("true");
    expect(screen.getByTestId("mc-damaged-note").textContent).toBe("▲ DAMAGED · tags unreadable · do not act on it");
    expect(screen.queryByTestId("mc-row-action")).toBeNull();

    rerender(<CompactStatusRow row={row()} onAction={() => {}} />);
    expect(screen.getByTestId("mc-status-row").hasAttribute("data-damaged")).toBe(false);
    expect(screen.queryByTestId("mc-damaged-note")).toBeNull();
    expect(screen.getByTestId("mc-row-action")).toBeTruthy();
  });

  it("an unnamed marker still shows damage", () => {
    render(<CompactStatusRow row={row({ unreadable: [""] })} />);
    expect(screen.getByTestId("mc-damaged-note").textContent).toContain("unknown columns");
  });
});

describe("OF-146 instance heading", () => {
  it("allows the 26-character id to break (class pin only; the fit is a browser measurement)", () => {
    render(<WorkflowHeader eyebrow="Workflow" title="01JXWFINSTANCEAAAAAAAAAAAA" />);
    expect(screen.getByRole("heading", { name: "01JXWFINSTANCEAAAAAAAAAAAA" }).className).toContain("break-words");
  });
});
