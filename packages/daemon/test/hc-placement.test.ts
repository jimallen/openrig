import { describe, expect, it } from "vitest";
import { HcError, HcOutcomeUnknownError, HcUnavailableError, type HcTerminal } from "../src/adapters/hc-client.js";
import { hcTerminalName } from "../src/adapters/hc-host.js";
import {
  HcPlacement, pickLead, placementLabels, planKernelTabs, planLabels, planRigTabs, rigOfSeat, rigSpaceId, rigTabId,
  type AppLs, type AppPort,
} from "../src/adapters/hc-placement.js";

type Seat = HcTerminal & { keep?: boolean };

/** A core that holds terminals by hcTerminalName and answers the four methods placement uses. */
class FakeCore {
  terminals = new Map<string, Seat>();
  calls: [string, Record<string, unknown>][] = [];
  failList: Error | null = null;
  failGet: Error | null = null;
  /** What the app does when a terminal is labelled: adopts it and turns core keep on (guide). */
  adoptTurnsKeepOn = false;
  /** address -> reads of terminal.get left before the app's labels go (a park the app applies later). */
  stripAfter = new Map<string, number>();

  add(seat: string, over: Partial<Seat> = {}, address = `t${this.terminals.size + 1}`): void {
    this.terminals.set(hcTerminalName(seat), {
      address, labels: { "openrig.seat": seat }, argv: [], cwd: "/", state: "live", created_ms: 0, screen: "exact", cols: 80, rows: 24, keep: false, ...over,
    });
  }

  async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.calls.push([method, params]);
    return this.answer(method, params) as T;
  }

  private answer(method: string, params: Record<string, unknown>): unknown {
    if (method === "terminal.list") {
      if (this.failList) throw this.failList;
      return { terminals: [...this.terminals.values()], hidden_finished: 0, machines: [] };
    }
    if (this.failGet) throw this.failGet;
    const key = String(params.terminal);
    const terminal = this.terminals.get(key);
    if (!terminal) throw new HcError("no", "not_found", -32000);
    if (method === "terminal.get") {
      const left = this.stripAfter.get(terminal.address);
      if (left !== undefined && left <= 0) {
        delete terminal.labels["herdr.space"];
        delete terminal.labels["herdr.tab"];
        this.stripAfter.delete(terminal.address);
      } else if (left !== undefined) {
        this.stripAfter.set(terminal.address, left - 1);
      }
      return terminal;
    }
    if (method === "terminal.label") {
      Object.assign(terminal.labels, params.labels);
      if (this.adoptTurnsKeepOn) terminal.keep = true;
      return terminal;
    }
    if (method === "terminal.keep") {
      terminal.keep = Boolean(params.keep);
      return terminal;
    }
    throw new Error(`unexpected ${method}`);
  }

  methods(): string[] { return this.calls.map(([m]) => m); }
}

class FakeApp implements AppPort {
  done: [string, Record<string, unknown>][] = [];
  tree: AppLs = { spaces: [] };
  failPark = false;
  /** Park strips the app's labels after this many reads of the terminal; Infinity: never. */
  constructor(private readonly core: FakeCore, private readonly stripAfterReads = 0) {}

  async ls(): Promise<AppLs> { return this.tree; }

  async do(command: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.done.push([command, args]);
    if (command === "terminal.park") {
      if (this.failPark) throw new Error("window gone");
      this.core.stripAfter.set(String(args.terminal), this.stripAfterReads);
    }
    return {};
  }
}

const noSleep = async (): Promise<void> => {};
const setup = (stripAfterReads = 0) => {
  const core = new FakeCore();
  const app = new FakeApp(core, stripAfterReads);
  return { core, app, placement: new HcPlacement(core, app, { sleep: noSleep, attempts: 5 }) };
};
const withSeat = (seat: string, rig: string, tab: string): Partial<Seat> => ({ labels: { "openrig.seat": seat, ...placementLabels(rig, tab) } });

describe("ids", () => {
  it("restates design 5: the space is rig:<rig>, the tab carries the rig", () => {
    expect(rigSpaceId("eztrack")).toBe("rig:eztrack");
    expect(rigTabId("eztrack", "team")).toBe("rig:eztrack/team");
  });
  it("gives the same tab name in two rigs two ids, since tab ids are global", () => {
    expect(rigTabId("a", "team")).not.toBe(rigTabId("b", "team"));
  });
  it("labels with the app's two keys, both together", () => {
    expect(placementLabels("eztrack", "cos")).toEqual({ "herdr.space": "rig:eztrack", "herdr.tab": "rig:eztrack/cos" });
  });
  it.each([[""], [" a"], ["a/b"], ["a\nb"], ["a\u0000"]])("refuses the rig name %j", (rig) => {
    expect(() => rigSpaceId(rig)).toThrow();
    expect(() => rigTabId(rig, "team")).toThrow();
  });
  it("refuses a tab name that would make a second separator", () => {
    expect(() => rigTabId("a", "t/x")).toThrow();
  });
  it("reads the rig from the last @", () => {
    expect(rigOfSeat("verify-qa@eztrack")).toBe("eztrack");
    expect(rigOfSeat("odd@name@rig")).toBe("rig");
    expect(() => rigOfSeat("no-rig")).toThrow();
    expect(() => rigOfSeat("x@")).toThrow();
  });
});

describe("planning tabs", () => {
  const seats = ["dev-impl@r", "exec-cos@r", "verify-qa@r"];
  it("puts the lead alone in cos and the rest in team, in order", () => {
    expect(planRigTabs("r", seats)).toEqual([
      { name: "cos", id: "rig:r/cos", seats: ["exec-cos@r"] },
      { name: "team", id: "rig:r/team", seats: ["dev-impl@r", "verify-qa@r"] },
    ]);
  });
  it("plans no team tab for a rig of one seat", () => {
    expect(planRigTabs("r", ["exec-cos@r"]).map((t) => t.name)).toEqual(["cos"]);
  });
  it("picks the lead as rig-here does", () => {
    expect(pickLead(["a@r", "x-lead.1@r", "exec-cos@r"])).toBe("exec-cos@r");
    expect(pickLead(["a@r", "x-lead-1@r"])).toBe("x-lead-1@r");
    expect(pickLead(["a@r", "b@r"])).toBe("a@r");
    expect(() => pickLead([])).toThrow();
  });
  it("refuses a seat of another rig and a repeated seat", () => {
    expect(() => planRigTabs("r", ["a@r", "b@other"])).toThrow(/other/);
    expect(() => planRigTabs("r", ["a@r", "a@r"])).toThrow(/twice/);
  });
  it("shows the kernel's human seat alone", () => {
    expect(planKernelTabs("operator-human@kernel")).toEqual([{ name: "human", id: "rig:kernel/human", seats: ["operator-human@kernel"] }]);
    expect(() => planKernelTabs("a@r")).toThrow();
  });
  it("labels each seat with its own tab", () => {
    const labels = planLabels("r", planRigTabs("r", seats));
    expect(labels.get("exec-cos@r")?.["herdr.tab"]).toBe("rig:r/cos");
    expect(labels.get("verify-qa@r")?.["herdr.tab"]).toBe("rig:r/team");
    expect(labels.size).toBe(3);
  });
});

describe("show", () => {
  it("sets the space and the tab in one label call, on the mapped terminal", async () => {
    const { core, placement } = setup();
    core.add("qa@r");
    await expect(placement.show("qa@r", "r", "team")).resolves.toEqual({ seat: "qa@r", outcome: "shown", keepTurnedOff: false });
    expect(core.calls.filter(([m]) => m === "terminal.label")).toEqual([
      ["terminal.label", { terminal: hcTerminalName("qa@r"), labels: { "herdr.space": "rig:r", "herdr.tab": "rig:r/team" } }],
    ]);
  });
  it("turns core keep off when the app's adoption turned it on, so a lost seat still reads as lost", async () => {
    const { core, placement } = setup();
    core.adoptTurnsKeepOn = true;
    core.add("qa@r");
    await expect(placement.show("qa@r", "r", "team")).resolves.toMatchObject({ outcome: "shown", keepTurnedOff: true });
    expect(core.calls.filter(([m]) => m === "terminal.keep")).toEqual([["terminal.keep", { terminal: hcTerminalName("qa@r"), keep: false }]]);
    expect(core.terminals.get(hcTerminalName("qa@r"))?.keep).toBe(false);
  });
  it("leaves keep alone when it is already off", async () => {
    const { core, placement } = setup();
    core.add("qa@r");
    await placement.show("qa@r", "r", "team");
    expect(core.methods()).not.toContain("terminal.keep");
  });
  it("does not label a finished seat", async () => {
    const { core, placement } = setup();
    core.add("qa@r", { state: "finished" });
    await expect(placement.show("qa@r", "r", "team")).resolves.toMatchObject({ outcome: "finished" });
    expect(core.methods()).not.toContain("terminal.label");
  });
  it("reports a missing seat, an unreachable core and a refusal apart", async () => {
    const { core, placement } = setup();
    await expect(placement.show("none@r", "r", "team")).resolves.toMatchObject({ outcome: "not_found" });
    core.failGet = new HcUnavailableError("down");
    await expect(placement.show("none@r", "r", "team")).resolves.toMatchObject({ outcome: "transport_unavailable" });
    core.failGet = new HcError("x", "invalid_params", -32602);
    await expect(placement.show("none@r", "r", "team")).resolves.toMatchObject({ outcome: "refused" });
  });
  it("shows a plan in plan order", async () => {
    const { core, placement } = setup();
    for (const s of ["a@r", "exec-cos@r", "b@r"]) core.add(s);
    const results = await placement.showTabs(planRigTabs("r", ["a@r", "exec-cos@r", "b@r"]));
    expect(results.map((r) => r.seat)).toEqual(["exec-cos@r", "a@r", "b@r"]);
    expect(core.terminals.get(hcTerminalName("exec-cos@r"))?.labels["herdr.tab"]).toBe("rig:r/cos");
  });
});

describe("park", () => {
  it("asks the app to park the terminal's address and reads the app's labels going as done", async () => {
    const { core, app, placement } = setup(2);
    core.add("qa@r", withSeat("qa@r", "r", "team"), "t9");
    await expect(placement.park("qa@r")).resolves.toEqual({ seat: "qa@r", outcome: "parked" });
    expect(app.done).toEqual([["terminal.park", { terminal: "t9" }]]);
    expect(core.terminals.get(hcTerminalName("qa@r"))?.state).toBe("live");
  });
  it("does not call a park done while the app's labels are still on", async () => {
    const { core, placement } = setup(Infinity);
    core.add("qa@r", withSeat("qa@r", "r", "team"));
    await expect(placement.park("qa@r")).resolves.toEqual({ seat: "qa@r", outcome: "unconfirmed" });
  });
  it("leaves a seat that shows nowhere alone", async () => {
    const { core, app, placement } = setup();
    core.add("qa@r");
    await expect(placement.park("qa@r")).resolves.toMatchObject({ outcome: "already_parked" });
    expect(app.done).toEqual([]);
  });
  it("counts a tab label alone as shown", async () => {
    const { core, app, placement } = setup();
    core.add("qa@r", { labels: { "openrig.seat": "qa@r", "herdr.tab": "rig:r/team" } });
    await placement.park("qa@r");
    expect(app.done.length).toBe(1);
  });
  it("reports an app failure and never a park", async () => {
    const { core, app, placement } = setup();
    app.failPark = true;
    core.add("qa@r", withSeat("qa@r", "r", "team"));
    await expect(placement.park("qa@r")).resolves.toMatchObject({ outcome: "app_failed" });
  });
  it("has nothing to protect in a finished or missing seat", async () => {
    const { core, placement } = setup();
    core.add("fin@r", { state: "finished" });
    await expect(placement.park("fin@r")).resolves.toMatchObject({ outcome: "finished" });
    await expect(placement.park("gone@r")).resolves.toMatchObject({ outcome: "not_found" });
  });
  it("never reads an unreachable core or a lost reply as parked", async () => {
    const { core, placement } = setup();
    core.add("qa@r", withSeat("qa@r", "r", "team"));
    core.failGet = new HcOutcomeUnknownError("lost", "terminal.get");
    await expect(placement.park("qa@r")).resolves.toMatchObject({ outcome: "transport_unavailable" });
  });
});

describe("parkRig", () => {
  it("parks the rig's shown seats and no other rig's, found by openrig.seat", async () => {
    const { core, app, placement } = setup();
    core.add("a@r", withSeat("a@r", "r", "team"), "t1");
    core.add("b@r", withSeat("b@r", "r", "cos"), "t2");
    core.add("c@other", withSeat("c@other", "other", "team"), "t3");
    core.add("d@rx", withSeat("d@rx", "rx", "team"), "t4");
    const report = await placement.parkRig("r");
    expect(report.results.map((r) => r.seat).sort()).toEqual(["a@r", "b@r"]);
    expect(report.safeToClose).toBe(true);
    expect(app.done.map(([, a]) => a.terminal).sort()).toEqual(["t1", "t2"]);
    expect(core.terminals.get(hcTerminalName("c@other"))?.labels["herdr.tab"]).toBe("rig:other/team");
  });
  it("parks one tab only when asked", async () => {
    const { core, app, placement } = setup();
    core.add("a@r", withSeat("a@r", "r", "team"), "t1");
    core.add("b@r", withSeat("b@r", "r", "cos"), "t2");
    const report = await placement.parkRig("r", "cos");
    expect(report.results.map((r) => r.seat)).toEqual(["b@r"]);
    expect(app.done.map(([, a]) => a.terminal)).toEqual(["t2"]);
  });
  it("is not safe to close when one seat stays in its pane, though the others parked", async () => {
    const { core, placement } = setup(Infinity);
    core.add("a@r", withSeat("a@r", "r", "team"));
    const report = await placement.parkRig("r");
    expect(report).toEqual({ results: [{ seat: "a@r", outcome: "unconfirmed" }], safeToClose: false });
  });
  it("is not safe to close when the core cannot be read: an unknown rig is not an empty one", async () => {
    const { core, placement } = setup();
    core.failList = new HcUnavailableError("down");
    const report = await placement.parkRig("r");
    expect(report.safeToClose).toBe(false);
    expect(report.results[0]?.outcome).toBe("transport_unavailable");
  });
  it("is safe to close a rig with no seat, when the core answered with other rigs' seats", async () => {
    const { core, placement } = setup();
    core.add("c@other", withSeat("c@other", "other", "team"));
    await expect(placement.parkRig("r")).resolves.toEqual({ results: [], safeToClose: true });
  });
  it("skips finished seats and terminals that are not seats", async () => {
    const { core, app, placement } = setup();
    core.add("a@r", { ...withSeat("a@r", "r", "team"), state: "finished" });
    core.add("plain@r", { labels: placementLabels("r", "team") }, "t7");
    await expect(placement.parkRig("r")).resolves.toEqual({ results: [], safeToClose: true });
    expect(app.done).toEqual([]);
  });
});

describe("nameShown", () => {
  const tree = (spaceName: string, tabName: string): AppLs => ({ spaces: [{ id: "s5", name: spaceName, tabs: [{ id: "tb3", name: tabName, terminals: [{ terminal: "t1", pane: "p1" }] }] }] });
  it("renames the space and tab the terminal is shown in, found by its address", async () => {
    const { core, app, placement } = setup();
    core.add("exec-cos@r", {}, "t1");
    app.tree = tree("tmp", "1");
    await expect(placement.nameShown("r", planRigTabs("r", ["exec-cos@r"]))).resolves.toEqual(["space:s5", "tab:tb3"]);
    expect(app.done).toEqual([["space.rename", { id: "s5", name: "rig:r" }], ["tab.rename", { id: "tb3", name: "cos" }]]);
  });
  it("renames nothing that is already named", async () => {
    const { core, app, placement } = setup();
    core.add("exec-cos@r", {}, "t1");
    app.tree = tree("rig:r", "cos");
    await expect(placement.nameShown("r", planRigTabs("r", ["exec-cos@r"]))).resolves.toEqual([]);
    expect(app.done).toEqual([]);
  });
  it("renames nothing when the app does not show the terminal yet", async () => {
    const { core, app, placement } = setup();
    core.add("exec-cos@r", {}, "t1");
    await expect(placement.nameShown("r", planRigTabs("r", ["exec-cos@r"]))).resolves.toEqual([]);
    expect(app.done).toEqual([]);
  });
});

describe("showing a plan again (the premise of a repeat `rig terminal open`: reopening a view changes nothing)", () => {
  const seats = ["exec-cos@r", "dev-a@r", "dev-b@r"];
  const snapshot = (core: FakeCore): string => JSON.stringify([...core.terminals.entries()]);

  it("leaves every terminal exactly as the first show left it, creates none and asks the app for nothing", async () => {
    const { core, app, placement } = setup();
    core.adoptTurnsKeepOn = true;
    for (const s of seats) core.add(s);
    const plan = planRigTabs("r", seats);
    await placement.showTabs(plan);
    const first = snapshot(core);
    core.calls.length = 0;

    const again = await placement.showTabs(plan);

    expect(snapshot(core)).toBe(first);
    expect(core.terminals.size).toBe(3);
    expect(again.map((r) => r.outcome)).toEqual(["shown", "shown", "shown"]);
    // Only reads and the two label/keep writes on the seats' own terminals: nothing that would run, kill or park one.
    expect(new Set(core.methods())).toEqual(new Set(["terminal.get", "terminal.label", "terminal.keep"]));
    expect(core.calls.every(([, p]) => seats.map(hcTerminalName).includes(String(p.terminal)))).toBe(true);
    expect(app.done).toEqual([]);
    for (const s of seats) expect(core.terminals.get(hcTerminalName(s))?.keep).toBe(false);
  });

  it("puts a seat back in its tab with both labels after it was parked, and no other seat moves", async () => {
    const { core, placement } = setup();
    for (const s of seats) core.add(s);
    const plan = planRigTabs("r", seats);
    await placement.showTabs(plan);
    const before = snapshot(core);
    const parked = core.terminals.get(hcTerminalName("dev-a@r"))!;
    delete parked.labels["herdr.space"];
    delete parked.labels["herdr.tab"];

    await placement.showTabs(plan);

    // Restated, not read back from a first show: a show that labels the tab alone would agree with itself.
    expect(parked.labels).toEqual({ "openrig.seat": "dev-a@r", "herdr.space": "rig:r", "herdr.tab": "rig:r/team" });
    expect(snapshot(core)).toBe(before);
  });
});
