import { describe, expect, it } from "vitest";
import { planRigTabs, rigSpaceId } from "@openrig/daemon/hc";
import { describeExpectedTabs, expectedViewerTabs } from "../src/terminal-labels.js";

// The scheme is the daemon's, imported through the hc surface: there is no restated copy left to drift. What is left to
// pin is the CLI's own part: it expects exactly the tabs the daemon's plan gives, and nothing when it cannot derive them.
describe("the CLI's expected tabs are the daemon's plan", () => {
  // Every shape of lead: the Chief of Staff, a lead-looking name, and the first seat when none looks like a lead.
  it.each([
    ["the Chief of Staff among others", ["dev-impl@r", "exec-cos@r", "dev-qa@r"]],
    ["the Chief of Staff after a lead-looking seat", ["dev.lead.x@r", "exec-cos@r"]],
    ["a lead-looking name", ["dev-impl@r", "dev-lead@r", "dev-qa@r"]],
    ["an orchestrator", ["dev-impl@r", "orch.main@r"]],
    ["no lead-looking name", ["dev-impl@r", "dev-qa@r"]],
    ["one seat", ["dev-impl@r"]],
  ])("plans %s the way hc-placement does", (_name, seats) => {
    expect(expectedViewerTabs(seats).map(t => ({ space: t.space, name: t.name, tab: t.tab, seats: t.seats })))
      .toEqual(planRigTabs("r", seats).map(t => ({ space: rigSpaceId("r"), name: t.name, tab: t.id, seats: t.seats })));
  });

  it("plans each rig of a mixed view on its own space", () => {
    const tabs = expectedViewerTabs(["exec-cos@a", "dev-x@b", "dev-y@a"]);
    expect(tabs.map(t => t.tab)).toEqual(["rig:a/cos", "rig:a/team", "rig:b/cos"]);
    expect(tabs.map(t => t.space)).toEqual(["rig:a", "rig:a", "rig:b"]);
  });
});

describe("the CLI states a placement only when it can derive all of it", () => {
  it.each([
    ["a seat that is not <pod>-<member>@<rig>", ["tui"]],
    ["a seat with an empty rig", ["dev-x@"]],
    ["a seat with no pod", ["@rig"]],
    ["a kernel seat", ["operator-human@kernel"]],
    ["a repeated seat", ["dev-x@r", "dev-x@r"]],
    ["a rig name holding the id separator", ["dev-x@a/b"]],
    ["a rig name with surrounding space", ["dev-x@ r"]],
    ["a rig name with a control character", ["dev-x@r\u0007"]],
    ["one good seat and one bad", ["dev-x@r", "tui"]],
    ["no seats", []],
  ])("says nothing for %s", (_name, seats) => {
    expect(expectedViewerTabs(seats)).toEqual([]);
    expect(describeExpectedTabs(expectedViewerTabs(seats))).toBeUndefined();
  });

  it("the note names the labels, every tab and the consequence of closing", () => {
    const note = describeExpectedTabs(expectedViewerTabs(["exec-cos@r", "dev-x@r"]))!;
    expect(note).toBe("Seats are placed by label (herdr.space, herdr.tab): rig:r/cos holds exec-cos@r; rig:r/team holds dev-x@r. Closing a tab or space ends the seats shown in it.");
  });
});
