// hc cutover W37: `rig terminal open` has a working app path. The daemon's only provider spoke the OLD herdr multiplexer's
// control socket, so against the Herdr app every open answered `herdr_unavailable` (live-pi-hc-20261101.md 4b). These rows pin
// the app provider with an injected `AppPort` and, for the real `herdr-app` boundary, `createHerdrAppCli` over an injected exec.
// The real-process and private-core proof is herdr-app-provider.real.test.ts. No app is started anywhere.
import { describe, expect, it } from "vitest";
import type { AppLs, AppPort } from "../src/adapters/hc-placement.js";
import {
  balancedSplits, createHerdrAppCli, HerdrAppCommandError, HerdrAppProvider, HerdrAppUnavailableError, type HerdrAppExec,
} from "../src/domain/terminal/herdr-app-provider.js";
import type { ComposedPane, ComposedView } from "../src/domain/terminal/terminal-provider.js";

// Restated, not imported: rig-here's `balanced_splits` (~/.agents/scripts/rig-here, measured there on herdr-app 0.1.10),
// run for 1..8 panes. [pane to split, direction, new pane].
const RIG_HERE_SPLITS: Record<number, Array<[number, string, number]>> = {
  1: [], 2: [[0, "right", 1]], 3: [[0, "right", 1], [1, "down", 2]],
  4: [[0, "right", 2], [0, "down", 1], [2, "down", 3]],
  5: [[0, "right", 2], [0, "down", 1], [2, "down", 4], [2, "right", 3]],
  6: [[0, "right", 3], [0, "down", 2], [0, "right", 1], [3, "down", 5], [3, "right", 4]],
  7: [[0, "right", 3], [0, "down", 2], [0, "right", 1], [3, "down", 5], [3, "right", 4], [5, "right", 6]],
  8: [[0, "right", 4], [0, "down", 2], [0, "right", 1], [2, "right", 3], [4, "down", 6], [4, "right", 5], [6, "right", 7]],
};

describe("balancedSplits", () => {
  it.each(Object.keys(RIG_HERE_SPLITS).map(Number))("%i panes are split as rig-here splits them", (n) => {
    expect(balancedSplits(n).map((s) => [s.pane, s.direction, s.new])).toEqual(RIG_HERE_SPLITS[n]);
  });
  it.each([1, 2, 5, 9, 16])("%i panes: every new pane is made once, after the pane it splits", (n) => {
    const made = new Set([0]);
    for (const s of balancedSplits(n)) {
      expect(made.has(s.pane), `pane ${s.pane} exists before it is split`).toBe(true);
      expect(made.has(s.new), `pane ${s.new} is new`).toBe(false);
      made.add(s.new);
    }
    expect([...made].sort((a, b) => a - b)).toEqual([...Array(n).keys()]);
  });
});

const pane = (seat: string, command = `'/x/hc' attach -- 'term-${seat}'`): ComposedPane => ({ seat, label: seat, paneCommand: command, readOnly: false });
const view = (pages: ComposedPane[][], extra: Partial<ComposedView> = {}): ComposedView => ({
  id: "demo", opened: pages.flat(), absent: [], degraded: [], pages, ...extra,
});

/** An AppPort that behaves like the app for the three commands the provider uses, and records every call. */
function fakeApp(opts: { down?: boolean; failDo?: (command: string, args: Record<string, unknown>, n: number) => boolean } = {}) {
  const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
  // A window that already shows something else: the new terminal must be found by its own address, not by being first.
  const spaces: AppLs["spaces"] = [{ id: "sp0", name: "someone else's", tabs: [{ id: "tb0", name: "t", terminals: [{ terminal: "t0", pane: "pn0" }] }] }];
  let seq = 0;
  let doCount = 0;
  const app: AppPort = {
    async ls() {
      calls.push({ command: "ls", args: {} });
      if (opts.down) throw new HerdrAppUnavailableError("the Herdr app is not running (herdr-app ls found no window)");
      return { spaces: structuredClone(spaces) };
    },
    async do(command, args) {
      calls.push({ command, args });
      doCount++;
      if (opts.failDo?.(command, args, doCount)) throw new HerdrAppCommandError(`herdr-app do ${command} failed: refused`);
      const id = ++seq;
      if (command === "space.new" || command === "tab.new") {
        let space = spaces.find((s) => s.id === args["space"]);
        if (!space) { space = { id: `sp${id}`, name: String(args["name"] ?? ""), tabs: [] }; spaces.push(space); }
        const tabName = String(command === "space.new" ? args["tab"] : args["name"]);
        space.tabs.push({ id: `tb${id}`, name: tabName, terminals: [{ terminal: `t${id}`, pane: `pn${id}` }] });
        return { space: space.id, tab: `tb${id}`, terminal: `t${id}` };
      }
      if (command === "pane.split") return { pane: `pn${id}`, terminal: `t${id}` };
      return {};
    },
  };
  return { app, calls, spaces };
}

describe("HerdrAppProvider.openView", () => {
  it("refuses by name, and touches nothing, when no app window answers", async () => {
    const f = fakeApp({ down: true });
    const result = await new HerdrAppProvider(f.app).openView(view([[pane("a@r")]]));
    expect(result).toMatchObject({ provider: "herdr", ok: false, opened: [], pages: 0, code: "herdr_unavailable" });
    expect(result.error).toMatch(/Herdr app is not running.*nothing was opened/);
    expect(f.calls.map((c) => c.command)).toEqual(["ls"]);
  });

  it("one seat: one new space and tab running the composed command as sh -c, named for the view, never rig:", async () => {
    const f = fakeApp();
    const result = await new HerdrAppProvider(f.app).openView(view([[pane("a@r", "'/x/hc' attach -- 'term a'")]]));
    expect(result).toMatchObject({ ok: true, opened: ["a@r"], pages: 1, absent: [], degraded: [] });
    const made = f.calls.filter((c) => c.command !== "ls");
    expect(made).toEqual([{ command: "space.new", args: { name: "view:demo", tab: "view", argv: ["sh", "-c", "'/x/hc' attach -- 'term a'"] } }]);
    expect(String(made[0]!.args["name"]).startsWith("rig:"), "rig-here owns rig:<rig> spaces and closes a duplicate").toBe(false);
  });

  it("the kernel view keeps its own space label and names each tab for what it shows", async () => {
    const f = fakeApp();
    await new HerdrAppProvider(f.app).openView(view([[pane("a@r"), pane("b@r")], [pane("c@r")]], { spaceLabel: "openrig kernel" }));
    const made = f.calls.filter((c) => c.command === "space.new" || c.command === "tab.new");
    expect(made[0]!.args).toMatchObject({ name: "openrig kernel", tab: "a@r · b@r" });
    expect(made[1]!.args).toMatchObject({ name: "c@r" });
  });

  it("three seats: splits in rig-here's order, each pane running its own command, all reported opened", async () => {
    const f = fakeApp();
    const result = await new HerdrAppProvider(f.app).openView(view([[pane("a@r"), pane("b@r"), pane("c@r")]]));
    expect(result.opened.sort()).toEqual(["a@r", "b@r", "c@r"]);
    const splits = f.calls.filter((c) => c.command === "pane.split");
    expect(splits.map((c) => [c.args["direction"], (c.args["argv"] as string[])[2]])).toEqual([
      ["right", "'/x/hc' attach -- 'term-b@r'"], ["down", "'/x/hc' attach -- 'term-c@r'"],
    ]);
    // the first split is of the lead's pane (found through ls), the second of the pane the first split made
    expect(splits[0]!.args["pane"]).toBe("pn1");
    expect(splits[1]!.args["pane"]).toBe("pn2");
  });

  it("lists the opened seats in the composed view's order, though splits make the panes out of it", async () => {
    const f = fakeApp();
    const seats = ["a@r", "b@r", "c@r", "d@r", "e@r"];
    const result = await new HerdrAppProvider(f.app).openView(view([seats.map((s) => pane(s))]));
    expect(result.opened).toEqual(seats);
  });

  it("two pages: the first page makes the space, the second a tab in it, and the first tab is selected again", async () => {
    const f = fakeApp();
    const result = await new HerdrAppProvider(f.app).openView(view([[pane("a@r")], [pane("b@r")]]));
    expect(result).toMatchObject({ ok: true, pages: 2 });
    const made = f.calls.filter((c) => c.command !== "ls" && c.command !== "pane.split");
    expect(made.map((c) => c.command)).toEqual(["space.new", "tab.new", "tab.select"]);
    expect(made[1]!.args).toMatchObject({ name: "view 2", space: "sp1" });
    expect(made[0]!.args["tab"]).toBe("view 1");
    expect(made[2]!.args).toEqual({ id: "tb1" });
  });

  it("a split the app refuses degrades that seat alone; a seat whose own split does not depend on it stays opened", async () => {
    // three panes: b splits a's pane, c splits b's. Refusing c leaves a and b.
    const f = fakeApp({ failDo: (command, args) => command === "pane.split" && (args["argv"] as string[])[2]!.includes("term-c@r") });
    const result = await new HerdrAppProvider(f.app).openView(view([[pane("a@r"), pane("b@r"), pane("c@r")]]));
    expect(result.opened.sort()).toEqual(["a@r", "b@r"]);
    expect(result.degraded).toEqual([{ seat: "c@r", host: "herdr", reason: expect.stringContaining("herdr-app could not open the pane") }]);
    expect(result.ok).toBe(true);
  });

  it("a pane that was never made cannot be split: its dependants are degraded by name, not sent to the app", async () => {
    const f = fakeApp({ failDo: (command, args) => command === "pane.split" && (args["argv"] as string[])[2]!.includes("term-b@r") });
    const result = await new HerdrAppProvider(f.app).openView(view([[pane("a@r"), pane("b@r"), pane("c@r")]]));
    expect(result.opened).toEqual(["a@r"]);
    expect(result.degraded.map((d) => d.seat).sort()).toEqual(["b@r", "c@r"]);
    expect(result.degraded.find((d) => d.seat === "c@r")!.reason).toMatch(/pane to split was not made/);
    expect(f.calls.filter((c) => c.command === "pane.split")).toHaveLength(1);
  });

  it("a refused space.new degrades every seat of the page and opens nothing", async () => {
    const f = fakeApp({ failDo: () => true });
    const result = await new HerdrAppProvider(f.app).openView(view([[pane("a@r"), pane("b@r")]]));
    expect(result).toMatchObject({ ok: false, opened: [], pages: 0 });
    expect(result.degraded.map((d) => d.seat).sort()).toEqual(["a@r", "b@r"]);
    expect(f.calls.map((c) => c.command)).toEqual(["ls", "space.new"]);
  });

  it("carries the composer's absent and degraded seats through, and an all-absent view makes no space", async () => {
    const f = fakeApp();
    const absent = [{ seat: "z@r", host: null, reason: "hc terminal z@r is not alive" }];
    const result = await new HerdrAppProvider(f.app).openView(view([], { absent }));
    expect(result).toMatchObject({ ok: true, opened: [], absent, pages: 0 });
    expect(f.calls.map((c) => c.command)).toEqual(["ls"]);
  });

  it("status and liveness follow the window: alive when ls answers, not alive with the reason when it does not", async () => {
    expect(await new HerdrAppProvider(fakeApp().app).liveness()).toEqual({ alive: true });
    expect(await new HerdrAppProvider(fakeApp().app).status()).toMatchObject({ provider: "herdr", available: true });
    const down = new HerdrAppProvider(fakeApp({ down: true }).app);
    expect(await down.liveness()).toEqual({ alive: false, detail: expect.stringContaining("not running") });
    expect(await down.status()).toMatchObject({ available: false, capabilities: { app: false } });
  });
});

describe("createHerdrAppCli (the process boundary, exec injected)", () => {
  const exec = (answer: Awaited<ReturnType<HerdrAppExec>>, seen: Array<[string, string[]]> = []): HerdrAppExec => async (file, args) => { seen.push([file, args]); return answer; };

  it("ls: `herdr-app ls`, JSON parsed; a non-zero exit is 'not running', a missing binary is 'not installed'", async () => {
    const seen: Array<[string, string[]]> = [];
    await expect(createHerdrAppCli("/opt/herdr-app", exec({ code: 0, stdout: '{"spaces":[]}', stderr: "" }, seen)).ls()).resolves.toEqual({ spaces: [] });
    expect(seen).toEqual([["/opt/herdr-app", ["ls"]]]);
    await expect(createHerdrAppCli("h", exec({ code: 1, stdout: "", stderr: "no window" })).ls()).rejects.toThrow(/not running/);
    await expect(createHerdrAppCli("h", exec({ code: null, stdout: "", stderr: "", missing: true })).ls()).rejects.toThrow(/not installed/);
    await expect(createHerdrAppCli("h", exec({ code: 0, stdout: "garbage", stderr: "" })).ls()).rejects.toBeInstanceOf(HerdrAppCommandError);
  });

  it("do: `herdr-app do <command> <json>` as rig-here passes it; an {error} answer or a non-zero exit is a command error", async () => {
    const seen: Array<[string, string[]]> = [];
    await expect(createHerdrAppCli("h", exec({ code: 0, stdout: '{"pane":"p2"}', stderr: "" }, seen)).do("pane.split", { direction: "right", pane: "p1", argv: ["sh", "-c", "x"] }))
      .resolves.toEqual({ pane: "p2" });
    expect(seen).toEqual([["h", ["do", "pane.split", '{"direction":"right","pane":"p1","argv":["sh","-c","x"]}']]]);
    await expect(createHerdrAppCli("h", exec({ code: 1, stdout: '{"error":"unknown pane"}', stderr: "" })).do("pane.split", {})).rejects.toThrow(/pane\.split failed: unknown pane/);
    await expect(createHerdrAppCli("h", exec({ code: 0, stdout: '{"error":"x"}', stderr: "" })).do("tab.new", {})).rejects.toBeInstanceOf(HerdrAppCommandError);
    await expect(createHerdrAppCli("h", exec({ code: 1, stdout: "", stderr: "boom" })).do("tab.new", {})).rejects.toThrow(/boom/);
  });
});
