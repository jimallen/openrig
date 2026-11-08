import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { HcClient, HcError, HcOutcomeUnknownError, HcUnavailableError, type HcTerminal } from "../src/adapters/hc-client.js";
import { HcHost, SEAT_LABEL, hcTerminalName } from "../src/adapters/hc-host.js";
import { HcLifecycle } from "../src/adapters/hc-lifecycle.js";
import { HcAdapter } from "../src/adapters/hc-adapter.js";
import { createPlacementNameRestorer, type PlacementNameRestorer } from "../src/adapters/hc-placement-names.js";
import { HerdrAppUnavailableError } from "../src/domain/terminal/herdr-app-provider.js";
import type { AppLs, AppPort } from "../src/adapters/hc-placement.js";

/**
 * OF-280. A new terminal for an existing seat carries the `herdr.space` and `herdr.tab` labels of the seat's most recent terminal.
 *
 * Why it matters: the placer (rig-here) puts a seat in the app by labelling its terminal straight in the core, so the daemon never
 * sees the placement. A relaunch that made the seat's new terminal with only the session and seat labels left it off-screen until the
 * placer ran again (exec-cos@cel-identity: t6g was "rig:cel-identity / cos", the relaunched t73 was nowhere).
 *
 * The oracle is restated here, independently of the code: the label keys are literal strings, and the fake core follows the facts
 * measured on a private hc 0.1.18 core (a finished record keeps its name and labels; `terminal.get <name>` answers the live
 * terminal, else the newest finished one; `terminal.run` of a live name is `name_taken`).
 */

const SPACE = "herdr.space";
const TAB = "herdr.tab";
const here = dirname(fileURLToPath(import.meta.url));

class FakeCore extends HcClient {
  records: HcTerminal[] = [];
  calls: [string, Record<string, unknown> | undefined][] = [];
  /** An error to answer `terminal.get` with, instead of the record. */
  failGet: Error | null = null;
  private next = 1;
  constructor() { super("/nonexistent"); }

  override async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.calls.push([method, params]);
    return this.answer(method, params) as T;
  }

  runs(): Record<string, unknown>[] { return this.calls.filter(([m]) => m === "terminal.run").map(([, p]) => p!); }

  /** What a person (the placer) does: label the seat's live terminal in the core. */
  place(seat: string, labels: Record<string, string>): void { Object.assign(this.byName(hcTerminalName(seat))!.labels, labels); }

  /** The record a name or address answers: the live one, else the newest finished one. */
  private byName(ref: string): HcTerminal | undefined {
    const byAddress = this.records.find((t) => t.address === ref);
    if (byAddress) return byAddress;
    const named = this.records.filter((t) => t.name === ref);
    return named.find((t) => t.state === "live") ?? named[named.length - 1];
  }

  private answer(method: string, params: Record<string, unknown>): unknown {
    if (method === "terminal.get") {
      if (this.failGet) throw this.failGet;
      const found = this.byName(String(params.terminal));
      if (!found) throw new HcError("no", "not_found", -32000);
      return found;
    }
    if (method === "terminal.run") {
      const name = String(params.name);
      if (this.records.some((t) => t.name === name && t.state === "live")) throw new HcError("taken", "name_taken", -32000);
      const created: HcTerminal = {
        address: `t${this.next++}`, name, labels: { ...(params.labels as Record<string, string>) }, argv: params.argv as string[],
        cwd: String(params.cwd ?? "/"), state: "live", created_ms: 0, screen: "exact", cols: 80, rows: 24,
      };
      this.records.push(created);
      return { address: created.address };
    }
    if (method === "terminal.kill") {
      const found = this.byName(String(params.terminal))!;
      found.state = "finished";
      return found;
    }
    if (method === "terminal.list") return { terminals: this.records };
    if (method === "terminal.rm") { this.records = this.records.filter((t) => t.address !== params.terminal); return {}; }
    throw new Error(`unexpected ${method}`);
  }
}

const SEAT = "exec-cos@cel-identity";
const PLACED = { [SPACE]: "rig:cel-identity", [TAB]: "rig:cel-identity/cos" };
const hostOn = (core: FakeCore) => new HcHost(core, { daemonEnv: { SHELL: "/bin/sh" } });
const seatEnv = { OPENRIG_NODE_ID: "n1", OPENRIG_SESSION_NAME: SEAT };

/** A seat made once, placed by the placer, then ended: the state every relaunch path starts from. */
async function placedAndStopped(core: FakeCore, seat = SEAT): Promise<void> {
  await expect(hostOn(core).createSession(seat, "/w", seatEnv)).resolves.toMatchObject({ ok: true });
  core.place(seat, PLACED);
  await expect(new HcLifecycle(core).killSession(seat)).resolves.toEqual({ ok: true });
}
const lastRun = (core: FakeCore) => core.runs()[core.runs().length - 1]!;

describe("a relaunched seat keeps its Herdr placement (OF-280)", () => {
  // Paths that make a new terminal for an existing seat. Every one reaches the core through NodeLauncher.launchNode, which makes
  // the terminal with one createSession call; the census at the foot of this file pins that. Each row below is the sequence of
  // core calls that path makes.
  it("stop + launch (resume): the new terminal carries the previous terminal's space and tab", async () => {
    const core = new FakeCore();
    await placedAndStopped(core);
    await expect(hostOn(core).createSession(SEAT, "/w", seatEnv)).resolves.toEqual({ ok: true });
    expect(lastRun(core).labels).toMatchObject({ ...PLACED, [SEAT_LABEL]: SEAT });
  });

  it("seat launch --fresh --stop: the same, whether or not a program was still live when the stop ran", async () => {
    const core = new FakeCore();
    await placedAndStopped(core);
    await hostOn(core).createSession(SEAT, "/w", seatEnv);
    // --fresh --stop: the occupant is ended, then a new terminal is made; the record read is the finished one just ended.
    await expect(new HcLifecycle(core).killSession(SEAT)).resolves.toEqual({ ok: true });
    await hostOn(core).createSession(SEAT, "/w", seatEnv);
    expect(lastRun(core).labels).toMatchObject(PLACED);
  });

  it("rig up --existing / restore of a stopped seat: the same, from the finished record alone (no live terminal anywhere)", async () => {
    const core = new FakeCore();
    await placedAndStopped(core);
    expect(core.records.every((t) => t.state === "finished")).toBe(true);
    await hostOn(core).createSession(SEAT, "/w", seatEnv);
    expect(lastRun(core).labels).toMatchObject(PLACED);
  });

  it("restore after the core itself restarted: the finished record the core kept still names the placement", async () => {
    const core = new FakeCore();
    await placedAndStopped(core);
    // A core restart keeps finished records with their labels (measured on a private core: restart, stop+start and kill -9 of
    // the core and holder). The fake keeps the same records, so this row is the carry from a record the daemon holds no memory of.
    const afterRestart = new FakeCore();
    afterRestart.records = core.records.map((t) => ({ ...t, labels: { ...t.labels } }));
    await hostOn(afterRestart).createSession(SEAT, "/w", seatEnv);
    expect(lastRun(afterRestart).labels).toMatchObject(PLACED);
  });

  it("reads the NEWEST terminal's placement when the seat has had several, not the first", async () => {
    const core = new FakeCore();
    await placedAndStopped(core);
    await hostOn(core).createSession(SEAT, "/w", seatEnv);
    core.place(SEAT, { [SPACE]: "rig:moved", [TAB]: "rig:moved/team" });
    await new HcLifecycle(core).killSession(SEAT);
    await hostOn(core).createSession(SEAT, "/w", seatEnv);
    expect(lastRun(core).labels).toMatchObject({ [SPACE]: "rig:moved", [TAB]: "rig:moved/team" });
  });

  it("handover successor / restart in place (respawn): the new terminal carries the same placement", async () => {
    const core = new FakeCore();
    await hostOn(core).createSession(SEAT, "/w", seatEnv);
    core.place(SEAT, PLACED);
    await expect(new HcLifecycle(core).respawnPane(SEAT, "true", { cwd: "/w", env: seatEnv })).resolves.toMatchObject({ ok: true });
    expect(lastRun(core).labels).toMatchObject({ ...PLACED, [SEAT_LABEL]: SEAT });
  });

  it("carries only herdr.space and herdr.tab: the old terminal's identity, session and other labels stay behind", async () => {
    const core = new FakeCore();
    await placedAndStopped(core);
    core.records[0]!.labels["openrig.session.OPENRIG_NODE_ID"] = "OLD-NODE";
    core.records[0]!.labels["openrig.seat.stale"] = "x";
    core.records[0]!.labels["other"] = "kept-off";
    await hostOn(core).createSession(SEAT, "/w", { ...seatEnv, OPENRIG_NODE_ID: "NEW-NODE" });
    const labels = lastRun(core).labels as Record<string, string>;
    expect(labels[SPACE]).toBe(PLACED[SPACE]);
    expect(labels[TAB]).toBe(PLACED[TAB]);
    expect(Object.keys(labels).filter((k) => k.startsWith("herdr.")).sort()).toEqual([SPACE, TAB]);
    expect(JSON.stringify(labels)).not.toContain("OLD-NODE");
    expect(labels["openrig.seat.stale"]).toBeUndefined();
    expect(labels.other).toBeUndefined();
    expect(labels[SEAT_LABEL]).toBe(SEAT);
  });

  it("does not carry herdr.seen (the app's own bookkeeping, meaning unmeasured) or any other herdr.* key", async () => {
    const core = new FakeCore();
    await placedAndStopped(core);
    core.records[0]!.labels["herdr.seen"] = "7";
    core.records[0]!.labels["herdr.pane"] = "p9";
    core.records[0]!.labels["herdrx"] = "near-prefix";
    await hostOn(core).createSession(SEAT, "/w", seatEnv);
    const labels = lastRun(core).labels as Record<string, string>;
    expect(labels).toMatchObject(PLACED);
    expect(labels["herdr.seen"]).toBeUndefined();
    expect(labels["herdr.pane"]).toBeUndefined();
    expect(labels["herdrx"]).toBeUndefined();
  });

  it("carries a space with no tab, and a tab with no space, as they are", async () => {
    const core = new FakeCore();
    await placedAndStopped(core);
    delete core.records[0]!.labels[TAB];
    await hostOn(core).createSession(SEAT, "/w", seatEnv);
    expect(lastRun(core).labels).toMatchObject({ [SPACE]: PLACED[SPACE] });
    expect((lastRun(core).labels as Record<string, string>)[TAB]).toBeUndefined();
  });

  it("a seat that never had a terminal is launched exactly as before: seat label and session labels only", async () => {
    const core = new FakeCore();
    await expect(hostOn(core).createSession("new@rig", "/w", seatEnv)).resolves.toEqual({ ok: true });
    const labels = lastRun(core).labels as Record<string, string>;
    expect(Object.keys(labels).filter((k) => k.startsWith("herdr."))).toEqual([]);
    expect(labels[SEAT_LABEL]).toBe("new@rig");
    expect(core.calls.map(([m]) => m)).toEqual(["terminal.get", "terminal.run"]);
  });

  it("a placement does not leak to another seat", async () => {
    const core = new FakeCore();
    await placedAndStopped(core);
    await hostOn(core).createSession("other@cel-identity", "/w", { ...seatEnv, OPENRIG_SESSION_NAME: "other@cel-identity" });
    expect((lastRun(core).labels as Record<string, string>)[TAB]).toBeUndefined();
  });

  it("a seat that still has a live terminal is refused as before (duplicate_session), not relabelled", async () => {
    const core = new FakeCore();
    await hostOn(core).createSession(SEAT, "/w", seatEnv);
    core.place(SEAT, PLACED);
    await expect(hostOn(core).createSession(SEAT, "/w", seatEnv)).resolves.toMatchObject({ ok: false, code: "duplicate_session" });
    expect(core.records).toHaveLength(1);
  });

  it("never creates, closes or relabels anything in the core: the carry is one read before the one run", async () => {
    const core = new FakeCore();
    await placedAndStopped(core);
    const before = core.calls.length;
    await hostOn(core).createSession(SEAT, "/w", seatEnv);
    expect(core.calls.slice(before).map(([m]) => m)).toEqual(["terminal.get", "terminal.run"]);
  });

  describe("when the previous terminal cannot be read", () => {
    it("launches without a placement and says so, for an unreachable core, a lost reply and a refusal", async () => {
      for (const err of [new HcUnavailableError("down"), new HcOutcomeUnknownError("lost", "terminal.get"), new HcError("x", "internal", -32000)]) {
        const core = new FakeCore();
        core.failGet = err;
        const result = await hostOn(core).createSession(SEAT, "/w", seatEnv);
        expect(result).toMatchObject({ ok: true, warnings: [expect.stringContaining("Herdr placement")] });
        expect(core.runs()).toHaveLength(1);
        expect(Object.keys(lastRun(core).labels as object).some((k) => k.startsWith("herdr."))).toBe(false);
      }
    });
    it("a seat that is simply not there is not a warning", async () => {
      const result = await hostOn(new FakeCore()).createSession(SEAT, "/w", seatEnv);
      expect(result).toEqual({ ok: true });
    });
  });
});

/** The state the scratch app was measured in after a one-pane tab's terminal was replaced (Herdr 0.1.13, hc 0.1.18): the ids from the labels, the
 *  space named after its folder, the tab by its position. It shows whichever terminal the core made last, by address. */
class AppAfterRelaunch implements AppPort {
  calls: [string, unknown][] = [];
  failWith: Error | null = null;
  constructor(private readonly core: FakeCore, private readonly ids = { space: PLACED[SPACE]!, tab: PLACED[TAB]! }) {}
  async ls(): Promise<AppLs> {
    this.calls.push(["ls", null]);
    if (this.failWith) throw this.failWith;
    const run = this.core.records[this.core.records.length - 1];
    return { spaces: run ? [{ id: this.ids.space, name: "cel-identity", tabs: [{ id: this.ids.tab, name: "1", terminals: [{ terminal: run.address, pane: "p1" }] }] }] : [] };
  }
  async do(command: string, args: Record<string, unknown>): Promise<Record<string, unknown>> { this.calls.push([command, args]); return { ok: true }; }
  renames() { return this.calls.filter(([c]) => c !== "ls"); }
}
const WHERE = "rig:cel-identity / cos";
const placedWithNames = (core: FakeCore, seat = SEAT, where: string | null = WHERE) => core.place(seat, where === null ? PLACED : { ...PLACED, where });
const RENAMES = [["space.rename", { id: "rig:cel-identity", name: "rig:cel-identity" }], ["tab.rename", { id: "rig:cel-identity/cos", name: "cos" }]];

describe("a relaunched seat gets its Herdr space and tab names back (OF-281)", () => {
  const hostWith = (core: FakeCore, restorer: PlacementNameRestorer | undefined) => new HcHost(core, { daemonEnv: { SHELL: "/bin/sh" }, ...(restorer ? { placementNames: restorer } : {}) });
  const lifecycleWith = (core: FakeCore, restorer: PlacementNameRestorer | undefined) => new HcLifecycle(core, { daemonEnv: { SHELL: "/bin/sh" }, ...(restorer ? { placementNames: restorer } : {}) });

  it("stop + launch (createSession): the names come back after the run, by the new terminal's address", async () => {
    const core = new FakeCore();
    await hostOn(core).createSession(SEAT, "/w", seatEnv);
    placedWithNames(core);
    await new HcLifecycle(core).killSession(SEAT);
    const app = new AppAfterRelaunch(core);
    await expect(hostWith(core, createPlacementNameRestorer(app)).createSession(SEAT, "/w", seatEnv)).resolves.toEqual({ ok: true });
    expect(app.renames()).toEqual(RENAMES);
    expect(core.records[core.records.length - 1]!.address).not.toBe(core.records[0]!.address);
  });

  it("handover successor / restart in place (respawnPane): the same, and the new terminal carries the placement", async () => {
    const core = new FakeCore();
    await hostOn(core).createSession(SEAT, "/w", seatEnv);
    placedWithNames(core);
    const app = new AppAfterRelaunch(core);
    await expect(lifecycleWith(core, createPlacementNameRestorer(app)).respawnPane(SEAT, "true", { cwd: "/w", env: seatEnv })).resolves.toEqual({ ok: true });
    expect(app.renames()).toEqual(RENAMES);
    expect(lastRun(core).labels).toMatchObject(PLACED);
  });

  it("the whole launch goes through HcAdapter: both the host and the lifecycle are given the restorer", async () => {
    const core = new FakeCore();
    const app = new AppAfterRelaunch(core);
    const adapter = new HcAdapter(core, { app });
    await adapter.createSession(SEAT, "/w", seatEnv);
    placedWithNames(core);
    await adapter.killSession(SEAT);
    await expect(adapter.createSession(SEAT, "/w", seatEnv)).resolves.toMatchObject({ ok: true });
    expect(app.renames()).toEqual(RENAMES);
    app.calls.length = 0;
    placedWithNames(core);
    await expect(adapter.respawnPane(SEAT, "true", { cwd: "/w", env: seatEnv })).resolves.toMatchObject({ ok: true });
    expect(app.renames()).toEqual(RENAMES);
  });

  it("an adapter given no app port restores nothing and launches as before", async () => {
    const core = new FakeCore();
    const adapter = new HcAdapter(core);
    await adapter.createSession(SEAT, "/w", seatEnv);
    placedWithNames(core);
    await adapter.killSession(SEAT);
    await expect(adapter.createSession(SEAT, "/w", seatEnv)).resolves.toEqual({ ok: true });
  });

  it.each([
    ["has no where label", null],
    ["has a where label with no separator", "just-a-folder"],
    ["has a where label with an empty tab name", "rig:cel-identity / "],
  ])("a previous terminal that %s: the app is not asked anything", async (_why, where) => {
    const core = new FakeCore();
    await hostOn(core).createSession(SEAT, "/w", seatEnv);
    placedWithNames(core, SEAT, where);
    await new HcLifecycle(core).killSession(SEAT);
    const app = new AppAfterRelaunch(core);
    await expect(hostWith(core, createPlacementNameRestorer(app)).createSession(SEAT, "/w", seatEnv)).resolves.toEqual({ ok: true });
    expect(app.calls).toEqual([]);
  });

  it("a seat that never had a terminal, and one with names but no placement labels, ask the app nothing", async () => {
    const core = new FakeCore();
    const app = new AppAfterRelaunch(core);
    await expect(hostWith(core, createPlacementNameRestorer(app)).createSession("new@rig", "/w", { ...seatEnv, OPENRIG_SESSION_NAME: "new@rig" })).resolves.toEqual({ ok: true });
    core.place("new@rig", { where: WHERE });
    await new HcLifecycle(core).killSession("new@rig");
    await hostWith(core, createPlacementNameRestorer(app)).createSession("new@rig", "/w", { ...seatEnv, OPENRIG_SESSION_NAME: "new@rig" });
    expect(app.calls).toEqual([]);
  });

  it("the same for a respawn: a terminal with names but no placement labels asks the app nothing", async () => {
    const core = new FakeCore();
    await hostOn(core).createSession("new@rig", "/w", { ...seatEnv, OPENRIG_SESSION_NAME: "new@rig" });
    core.place("new@rig", { where: WHERE });
    const app = new AppAfterRelaunch(core);
    await expect(lifecycleWith(core, createPlacementNameRestorer(app)).respawnPane("new@rig", "true", { cwd: "/w", env: seatEnv })).resolves.toEqual({ ok: true });
    expect(app.calls).toEqual([]);
  });

  describe("the launch never fails for the rename", () => {
    it("no app or no window: createSession and respawnPane answer exactly as before, with no warning", async () => {
      const core = new FakeCore();
      await hostOn(core).createSession(SEAT, "/w", seatEnv);
      placedWithNames(core);
      const app = new AppAfterRelaunch(core);
      app.failWith = new HerdrAppUnavailableError("the Herdr app is not running");
      await expect(lifecycleWith(core, createPlacementNameRestorer(app)).respawnPane(SEAT, "true", { cwd: "/w", env: seatEnv })).resolves.toEqual({ ok: true });
      await new HcLifecycle(core).killSession(SEAT);
      await expect(hostWith(core, createPlacementNameRestorer(app)).createSession(SEAT, "/w", seatEnv)).resolves.toEqual({ ok: true });
    });
    it("an app that fails: one warning line, the terminal is made, ok stays true", async () => {
      const core = new FakeCore();
      await hostOn(core).createSession(SEAT, "/w", seatEnv);
      placedWithNames(core);
      await new HcLifecycle(core).killSession(SEAT);
      const app = new AppAfterRelaunch(core);
      app.failWith = new Error("socket closed");
      const result = await hostWith(core, createPlacementNameRestorer(app)).createSession(SEAT, "/w", seatEnv);
      expect(result).toEqual({ ok: true, warnings: [`${SEAT}: its Herdr space and tab names were not restored (socket closed)`] });
      expect(core.records.filter((t) => t.state === "live")).toHaveLength(1);
    });
    it("a restorer that throws is caught in both paths: ok stays true, the throw becomes the warning", async () => {
      const boom: PlacementNameRestorer = async () => { throw new Error("boom"); };
      const core = new FakeCore();
      await hostOn(core).createSession(SEAT, "/w", seatEnv);
      placedWithNames(core);
      const respawned = await lifecycleWith(core, boom).respawnPane(SEAT, "true", { cwd: "/w", env: seatEnv });
      expect(respawned).toEqual({ ok: true, warnings: [`${SEAT}: its Herdr space and tab names were not restored (boom)`] });
      placedWithNames(core);  // the app wrote `where` on the respawned terminal too
      await new HcLifecycle(core).killSession(SEAT);
      const created = await hostWith(core, boom).createSession(SEAT, "/w", seatEnv);
      expect(created).toEqual({ ok: true, warnings: [`${SEAT}: its Herdr space and tab names were not restored (boom)`] });
    });
    it("a launch the core refuses never reaches the app", async () => {
      const core = new FakeCore();
      await hostOn(core).createSession(SEAT, "/w", seatEnv);
      placedWithNames(core);
      const app = new AppAfterRelaunch(core);
      await expect(hostWith(core, createPlacementNameRestorer(app)).createSession(SEAT, "/w", seatEnv)).resolves.toMatchObject({ ok: false, code: "duplicate_session" });
      expect(app.calls).toEqual([]);
    });
  });

  describe("what a respawn carries (the createSession and respawnPane paths carry one label set)", () => {
    it("drops the app's own labels (herdr.seen, herdr.pinned, where) and keeps the placement, the seat and the launch identity", async () => {
      const core = new FakeCore();
      await hostOn(core).createSession(SEAT, "/w", seatEnv);
      placedWithNames(core);
      Object.assign(core.records[0]!.labels, { "herdr.seen": "57", "herdr.pinned": "1", "herdr.right-click": "program" });
      const identity = Object.entries(core.records[0]!.labels).filter(([k]) => k.startsWith("openrig.env."));
      expect(identity.length).toBeGreaterThan(0);  // positive control: the launch wrote identity labels, so keeping them is observable
      await new HcLifecycle(core).respawnPane(SEAT, "true", { cwd: "/w", env: seatEnv });
      const labels = lastRun(core).labels as Record<string, string>;
      expect(Object.keys(labels).filter((k) => k.startsWith("herdr.")).sort()).toEqual([SPACE, TAB]);
      expect(labels.where).toBeUndefined();
      expect(labels[SEAT_LABEL]).toBe(SEAT);
      for (const [k, v] of identity) expect(labels[k]).toBe(v);
    });
  });
});

// The census: every place the daemon makes a terminal for a seat, from the source, not from a list in this file.
describe("census of the code that makes a seat's terminal (OF-280)", () => {
  const src = join(here, "..", "src");
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (full.endsWith(".ts")) files.push(full);
    }
  };
  walk(src);
  const rel = (f: string) => relative(src, f).split("\\").join("/");
  const sitesOf = (re: RegExp) => files.filter((f) => re.test(readFileSync(f, "utf8"))).map(rel).sort();

  it("positive control: the walk saw the adapters and the domain", () => {
    expect(files.length).toBeGreaterThan(300);
    expect(sitesOf(/class HcHost\b/)).toEqual(["adapters/hc-host.ts"]);
  });

  it("`terminal.run` is called from exactly: the seat host, the respawn, and the probe's own terminal", () => {
    // hc-client.ts only names the method in a comparison (it clears its launch block on a run); it never makes one.
    expect(sitesOf(/call(?:<[^>]*>)?\(\s*["']terminal\.run["']/)).toEqual(["adapters/hc-host.ts", "adapters/hc-lifecycle.ts"]);
    const lifecycle = readFileSync(join(src, "adapters/hc-lifecycle.ts"), "utf8");
    expect(lifecycle.match(/call(?:<[^>]*>)?\(\s*["']terminal\.run["']/g)).toHaveLength(2); // respawn (carries before.labels) and createProbeSession (a probe, never a seat)
    // OF-281: it carries the old terminal's labels except the app's own (herdr.seen, herdr.pinned, where...), which are the app's to write.
    expect(lifecycle).toContain("...withoutAppOwnedLabels(before.labels)");
    expect(lifecycle).not.toContain("...before.labels");
  });

  it("a seat's session is created only by NodeLauncher (the metadata probe's fallback is a probe, not a seat)", () => {
    expect(sitesOf(/\.createSession\(/)).toEqual(["adapters/hc-adapter.ts", "domain/node-launcher.ts", "domain/resume-metadata-refresher.ts"]);
    expect(readFileSync(join(src, "domain/node-launcher.ts"), "utf8").match(/\.createSession\(/g)).toHaveLength(1);
  });

  it("the paths that reach NodeLauncher.launchNode: resume, fresh, restore, up/fork instantiation, the route", () => {
    expect(sitesOf(/\bnodeLauncher\.launchNode\(/)).toEqual([
      "domain/restore-orchestrator.ts", "domain/rigspec-instantiator.ts", "domain/seat-lifecycle-service.ts", "routes/sessions.ts",
    ]);
  });

  it("the daemon gives the seat host the Herdr app's port, bounded to 2 s a call (OF-281)", () => {
    const startup = readFileSync(join(src, "startup.ts"), "utf8");
    expect(startup).toContain("new HcAdapter(hcClient, { app: createHerdrAppCli(resolveOnPath(\"herdr-app\", process.env.PATH) ?? \"herdr-app\", undefined, 2000) })");
    expect(sitesOf(/new HcAdapter\(/)).toEqual(["startup.ts"]);
  });

  it("the paths that reach respawnPane (which carries the placement itself): restart in place, successor", () => {
    expect(sitesOf(/\.respawnPane\(/)).toEqual(["adapters/hc-adapter.ts", "domain/seat-restart-in-place.ts", "domain/successor-session-launcher.ts"]);
  });
});
