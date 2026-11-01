import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SEAT_LABEL, hcTerminalName } from "../src/adapters/hc-seat.js";
import {
  KERNEL_RIG, KERNEL_TAB, SPACE_LABEL, TAB_LABEL, placementLabels, planKernelTabs, planLabels, planRigTabs,
} from "../src/adapters/hc-placement.js";

/**
 * rig-here (~/.agents, another repository) places and parks seats in Python with the same scheme as hc-placement.ts. The
 * two must agree, or a seat that rig-here labels is not the seat the daemon expects, and the daemon's tab ids and
 * rig-here's would name different tabs. `fixtures/rig-here-scheme.py` is a verbatim copy of the scheme functions (its
 * header names the commit and line ranges); this test RUNS that copy and compares its answers with the TypeScript ones.
 */
const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "rig-here-scheme.py");

const python = (() => {
  const probe = spawnSync("python3", ["-I", "-c", "print(1)"], { encoding: "utf8" });
  return probe.status === 0 && probe.stdout.trim() === "1";
})();

/** The fixture's answers for one input, as JSON. Runs only the copied functions, in isolated mode. */
function fromRigHere(query: unknown) {
  const driver = `
import json, runpy, sys
m = runpy.run_path(sys.argv[1])
q = json.loads(sys.argv[2])
out = {}
if q["op"] == "constants":
    out = {"seat": m["SEAT_LABEL"], "space": m["SPACE_LABEL"], "tab": m["TAB_LABEL"]}
elif q["op"] == "names":
    out = {s: m["hc_name"](s) for s in q["seats"]}
elif q["op"] == "plan":
    rig = q["rig"]
    alive = [{"canonicalSessionName": s} for s in q["seats"]]
    for tab, seats in m["rig_tabs"](alive):
        for s in seats:
            out[s] = m["placement_labels"](rig, tab)
elif q["op"] == "labels":
    try:
        out = {"labels": m["placement_labels"](q["rig"], q["tab"])}
    except m["AppError"]:
        out = {"refused": True}
print(json.dumps(out))
`;
  return JSON.parse(execFileSync("python3", ["-I", "-c", driver, fixture, JSON.stringify(query)], { encoding: "utf8" }));
}

const tsPlacement = (rig: string, seats: string[]): Record<string, Record<string, string>> =>
  Object.fromEntries(planLabels(rig, planRigTabs(rig, seats)));

describe.skipIf(!python)("hc-placement.ts and rig-here place seats by the same scheme", () => {
  it("uses the same three label keys", () => {
    expect(fromRigHere({ op: "constants" })).toEqual({ seat: SEAT_LABEL, space: SPACE_LABEL, tab: TAB_LABEL });
  });

  it("names a seat's hc terminal the same way, so the label rig-here sets lands on the terminal the daemon launched", () => {
    const seats = ["verify-qa@eztrack", "exec-cos@jims-team", "operator-human@kernel", "é@r"];
    expect(fromRigHere({ op: "names", seats })).toEqual(Object.fromEntries(seats.map((s) => [s, hcTerminalName(s)])));
  });

  const rigs: [string, string[]][] = [
    ["eztrack", ["exec-cos@eztrack", "dev-impl@eztrack", "dev-qa@eztrack"]],
    ["eztrack", ["dev-impl@eztrack", "dev-qa@eztrack"]],
    ["eztrack", ["dev-impl@eztrack", "orch-x@eztrack", "lead-x@eztrack"]],
    ["eztrack", ["dev-impl@eztrack", "verify-lead.qa@eztrack", "exec-cos@eztrack"]],
    ["jims-team", ["solo@jims-team"]],
    ["my.rig", ["a@my.rig", "b-cos-c@my.rig", "cos.d@my.rig"]],
  ];
  it.each(rigs)("gives every seat of %s the same space and tab ids: %j", (rig, seats) => {
    const theirs = fromRigHere({ op: "plan", rig, seats });
    expect(Object.keys(theirs).sort()).toEqual([...seats].sort());
    expect(tsPlacement(rig, seats)).toEqual(theirs);
  });

  it("shows the kernel's human seat in the same tab", () => {
    // rig-here `tile_kernel` shows [("human", [KERNEL_HUMAN])] in rig "kernel" (not in the copy: it calls the app).
    const human = "operator-human@kernel";
    expect(tsPlacement(KERNEL_RIG, [human])).toEqual({ [human]: fromRigHere({ op: "labels", rig: KERNEL_RIG, tab: KERNEL_TAB }).labels });
    expect(Object.fromEntries(planLabels(KERNEL_RIG, planKernelTabs(human)))).toEqual(tsPlacement(KERNEL_RIG, [human]));
  });

  it("refuses the same rig and tab names that would make a second separator or an empty id", () => {
    for (const [rig, tab] of [["a/b", "team"], ["a", "x/y"], ["", "team"], ["a", ""]] as const) {
      expect(fromRigHere({ op: "labels", rig, tab })).toEqual({ refused: true });
      expect(() => placementLabels(rig, tab)).toThrow();
    }
    expect(fromRigHere({ op: "labels", rig: "a", tab: "team" }).labels).toEqual(placementLabels("a", "team"));
  });
});

describe("the fixture runs", () => {
  it("is runnable here (a skipped pin above would pin nothing)", () => {
    expect(python).toBe(true);
  });
});
