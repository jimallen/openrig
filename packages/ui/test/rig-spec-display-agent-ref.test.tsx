// workspaces-o9o.1: a member's `shipped:<rel>` agent_ref names a persona in the running OpenRig install's own specs folder.
// The rig spec display's sub-spec trigger must hand the drawer that persona's name and say it ships with OpenRig (builtin),
// not the whole ref as the name with source user_file.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent, cleanup, screen } from "@testing-library/react";
import { DrawerSelectionContext } from "../src/components/AppShell.js";
import { RigSpecDisplay } from "../src/components/RigSpecDisplay.js";
import type { RigSpecReview } from "../src/hooks/useSpecReview.js";

afterEach(() => cleanup());

function reviewWith(agentRef: string): RigSpecReview {
  return {
    sourceState: "library_item", kind: "rig", name: "team", version: "0.2", format: "pod_aware",
    pods: [{ id: "dev", label: "Dev", members: [{ id: "impl", agentRef, runtime: "claude-code", profile: "default" }], edges: [] }],
    edges: [], graph: { nodes: [], edges: [] }, raw: "name: team\n",
  } as RigSpecReview;
}

/** The drawer selection the member's sub-spec trigger sets, read through the real context. */
function selectionFor(agentRef: string): unknown {
  const setSelection = vi.fn();
  render(
    <DrawerSelectionContext.Provider value={{ selection: null, setSelection }}>
      <RigSpecDisplay review={reviewWith(agentRef)} yaml="name: team\n" />
    </DrawerSelectionContext.Provider>,
  );
  fireEvent.click(screen.getByTestId("tab-configuration"));
  fireEvent.click(screen.getByTestId("member-sub-spec-dev-impl"));
  expect(setSelection).toHaveBeenCalledTimes(1);
  return setSelection.mock.calls[0]![0];
}

describe("RigSpecDisplay: the member sub-spec trigger for each agent_ref scheme", () => {
  it("shipped:agents/<path> names the persona after agents/ and says it is builtin", () => {
    expect(selectionFor("shipped:agents/development/implementer")).toEqual({
      type: "sub-spec", data: { specKind: "agent", specName: "development/implementer", source: "builtin" },
    });
  });

  it("a shipped: persona nested in a shipped rig (the kernel's) is named after its LAST agents/ segment", () => {
    expect(selectionFor("shipped:rigs/launch/kernel/agents/operator/agent")).toEqual({
      type: "sub-spec", data: { specKind: "agent", specName: "operator/agent", source: "builtin" },
    });
  });

  it("CONTROL: local:agents/<name> is unchanged (name after agents/, user_file)", () => {
    expect(selectionFor("local:agents/impl")).toEqual({
      type: "sub-spec", data: { specKind: "agent", specName: "impl", source: "user_file" },
    });
  });
});
