import { describe, expect, it } from "vitest";
import { HerdrAppCommandError, HerdrAppUnavailableError } from "../src/domain/terminal/herdr-app-provider.js";
import { createPlacementNameRestorer, restorePlacementNames } from "../src/adapters/hc-placement-names.js";
import { isAppOwnedLabel, placementNamesOf, withoutAppOwnedLabels } from "../src/adapters/hc-placement-carry.js";
import type { AppLs, AppPort } from "../src/adapters/hc-placement.js";

/**
 * OF-281. A seat alone in its Herdr tab loses the tab, and with it the space's and the tab's NAMES, when its terminal ends: the app removes the tab from its
 * document with no grace period, and names the one it makes again from a label by the folder (space) and the position (tab). Measured on a scratch Herdr
 * 0.1.13 with a private hc 0.1.18 core, 2026-11-08: a new terminal carrying the same `herdr.space` / `herdr.tab` 8 ms after the kill got the same ids, the
 * space named after its folder ("o281") and the tab "1"; `where` on the old record read "rig:demo / cos".
 *
 * These rows pin the rename that gives the names back. The oracle is restated here, not imported: the label key `where` and its " / " separator, the app
 * command names `space.rename` and `tab.rename` and their arguments `{id, name}`, and the app's automatic tab name (a position).
 * The fake app answers what `herdr-app ls` answered in the scratch app: space/tab ids and names, and terminals by address.
 */

const ADDRESS = "t9";
const NAMES = { space: "rig:eztrack", tab: "cos" };

interface FakeTab { id: string; name: string; terminals: string[] }
interface FakeSpace { id: string; name: string; tabs: FakeTab[] }

class FakeApp implements AppPort {
  calls: [string, unknown][] = [];
  /** What `ls` answers, per call; the last answer repeats. */
  constructor(public answers: FakeSpace[][], public lsError: Error | null = null, public doError: Error | null = null) {}
  async ls(): Promise<AppLs> {
    this.calls.push(["ls", null]);
    if (this.lsError) throw this.lsError;
    const spaces = this.answers.length > 1 ? this.answers.shift()! : this.answers[0]!;
    return { spaces: spaces.map((s) => ({ id: s.id, name: s.name, tabs: s.tabs.map((t) => ({ id: t.id, name: t.name, terminals: t.terminals.map((terminal) => ({ terminal, pane: `p-${terminal}` })) })) })) };
  }
  async do(command: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.calls.push([command, args]);
    if (this.doError) throw this.doError;
    return { ok: true };
  }
  renames() { return this.calls.filter(([c]) => c !== "ls"); }
}

/** The state the scratch app was measured in after the relaunch: its own folder name for the space, the position for the tab. */
const madeAgain = (over: { space?: string; tab?: string; extraTabs?: FakeTab[]; others?: string[] } = {}): FakeSpace[] => [
  { id: "rig:eztrack", name: over.space ?? "eztrack", tabs: [{ id: "rig:eztrack/cos", name: over.tab ?? "1", terminals: [ADDRESS, ...(over.others ?? [])] }, ...(over.extraTabs ?? [])] },
];

describe("restorePlacementNames (OF-281)", () => {
  it("names the space and the tab the app made again, by id, with the old names", async () => {
    const app = new FakeApp([madeAgain()]);
    await expect(restorePlacementNames(app, ADDRESS, NAMES)).resolves.toEqual({ kind: "renamed", renamed: ["space", "tab"] });
    expect(app.renames()).toEqual([["space.rename", { id: "rig:eztrack", name: "rig:eztrack" }], ["tab.rename", { id: "rig:eztrack/cos", name: "cos" }]]);
  });

  it("finds the terminal by its address, not by the id the label carried", async () => {
    const app = new FakeApp([[{ id: "sp-opaque", name: "x", tabs: [{ id: "tb-opaque", name: "2", terminals: [ADDRESS] }] }]]);
    await restorePlacementNames(app, ADDRESS, NAMES);
    expect(app.renames()).toEqual([["space.rename", { id: "sp-opaque", name: "rig:eztrack" }], ["tab.rename", { id: "tb-opaque", name: "cos" }]]);
  });

  it("waits for the app to show the terminal (it applies a label asynchronously), then renames", async () => {
    const app = new FakeApp([[], [], madeAgain()]);
    await expect(restorePlacementNames(app, ADDRESS, NAMES, { intervalMs: 1 })).resolves.toMatchObject({ kind: "renamed" });
    expect(app.calls.filter(([c]) => c === "ls")).toHaveLength(3);
  });

  describe("guards: what a person named is not touched", () => {
    it("a tab whose name is not a position is not renamed (a person's name, or the placer's)", async () => {
      const app = new FakeApp([madeAgain({ tab: "fix login" })]);
      await restorePlacementNames(app, ADDRESS, NAMES);
      expect(app.renames()).toEqual([["space.rename", { id: "rig:eztrack", name: "rig:eztrack" }]]);
    });
    it("a position that merely STARTS with digits is a name, not a position", async () => {
      const app = new FakeApp([madeAgain({ tab: "2fa" })]);
      await restorePlacementNames(app, ADDRESS, NAMES);
      expect(app.renames().map(([c]) => c)).toEqual(["space.rename"]);
    });
    it("a space that holds another tab is not renamed (it was not made by this launch)", async () => {
      const app = new FakeApp([madeAgain({ space: "rig:eztrack-old", extraTabs: [{ id: "rig:eztrack/team", name: "team", terminals: ["t1", "t2"] }] })]);
      await restorePlacementNames(app, ADDRESS, NAMES);
      expect(app.renames()).toEqual([["tab.rename", { id: "rig:eztrack/cos", name: "cos" }]]);
    });
    it("a space whose one tab holds another terminal too is not renamed", async () => {
      const app = new FakeApp([madeAgain({ space: "mine", others: ["t5"] })]);
      await restorePlacementNames(app, ADDRESS, NAMES);
      expect(app.renames().map(([c]) => c)).toEqual(["tab.rename"]);
    });
    it("names that already read as wanted are not renamed again", async () => {
      const app = new FakeApp([madeAgain({ space: "rig:eztrack", tab: "cos" })]);
      await expect(restorePlacementNames(app, ADDRESS, NAMES)).resolves.toEqual({ kind: "unchanged" });
      expect(app.renames()).toEqual([]);
    });
    it("a wanted tab name that is itself a position is not written (the app names it that already)", async () => {
      const app = new FakeApp([madeAgain({ tab: "3" })]);
      await restorePlacementNames(app, ADDRESS, { space: "rig:eztrack", tab: "3" });
      expect(app.renames().map(([c]) => c)).toEqual(["space.rename"]);
    });
  });

  describe("when the app cannot be used, the launch is never the casualty", () => {
    it("no herdr-app, or no window: a no-op, with no failure to report", async () => {
      const app = new FakeApp([[]], new HerdrAppUnavailableError("the Herdr app is not running"));
      await expect(restorePlacementNames(app, ADDRESS, NAMES)).resolves.toEqual({ kind: "no_app" });
      expect(app.renames()).toEqual([]);
    });
    it("a rename the app refuses is a failure with its reason, not an exception", async () => {
      const app = new FakeApp([madeAgain()], null, new HerdrAppCommandError("herdr-app do space.rename failed: no such space"));
      await expect(restorePlacementNames(app, ADDRESS, NAMES)).resolves.toEqual({ kind: "failed", reason: "herdr-app do space.rename failed: no such space" });
    });
    it("a terminal the app never shows is a failure after the bound, and nothing is renamed", async () => {
      const app = new FakeApp([[]]);
      const outcome = await restorePlacementNames(app, ADDRESS, NAMES, { timeoutMs: 60, intervalMs: 10 });
      expect(outcome.kind).toBe("failed");
      expect(app.renames()).toEqual([]);
    });
    it("an app call that never answers is cut at the bound, and the step does not touch the app afterwards", async () => {
      const app = new FakeApp([madeAgain()]);
      let release!: () => void;
      const hung = new Promise<void>((resolve) => { release = resolve; });
      const realLs = app.ls.bind(app);
      app.ls = async () => { await hung; return realLs(); };
      const started = Date.now();
      const outcome = await restorePlacementNames(app, ADDRESS, NAMES, { timeoutMs: 50 });
      expect(outcome).toEqual({ kind: "failed", reason: "timed out after 50 ms" });
      expect(Date.now() - started).toBeLessThan(1000);
      release();
      await new Promise((r) => setTimeout(r, 30));
      expect(app.renames()).toEqual([]);  // the late answer found the terminal, but the deadline had passed
    });
    it("a rename that never answers is cut at the bound, and the tab rename is not sent after it", async () => {
      const app = new FakeApp([madeAgain()]);
      let release!: () => void;
      const hung = new Promise<void>((resolve) => { release = resolve; });
      const realDo = app.do.bind(app);
      app.do = async (command, args) => { if (command === "space.rename") await hung; return realDo(command, args); };
      const outcome = await restorePlacementNames(app, ADDRESS, NAMES, { timeoutMs: 50 });
      expect(outcome).toEqual({ kind: "failed", reason: "timed out after 50 ms" });
      release();
      await new Promise((r) => setTimeout(r, 30));
      expect(app.renames().map(([c]) => c)).toEqual(["space.rename"]);  // the space rename was already on its way; the tab's was never sent
    });
  });
});

describe("createPlacementNameRestorer (OF-281)", () => {
  it("returns no warning for a rename, for names already right, and for no app", async () => {
    expect(await createPlacementNameRestorer(new FakeApp([madeAgain()]))("s@r", ADDRESS, NAMES)).toEqual([]);
    expect(await createPlacementNameRestorer(new FakeApp([madeAgain({ space: "rig:eztrack", tab: "cos" })]))("s@r", ADDRESS, NAMES)).toEqual([]);
    expect(await createPlacementNameRestorer(new FakeApp([[]], new HerdrAppUnavailableError("none")))("s@r", ADDRESS, NAMES)).toEqual([]);
  });
  it("returns one line naming the seat and the reason for a failure", async () => {
    const app = new FakeApp([madeAgain()], null, new HerdrAppCommandError("refused"));
    expect(await createPlacementNameRestorer(app)("exec-cos@eztrack", ADDRESS, NAMES)).toEqual(["exec-cos@eztrack: its Herdr space and tab names were not restored (refused)"]);
  });
});

describe("placementNamesOf: the old terminal's `where` label (OF-281)", () => {
  it("splits `<space> / <tab>`", () => {
    expect(placementNamesOf({ where: "rig:cel-identity / cos" })).toEqual({ space: "rig:cel-identity", tab: "cos" });
  });
  it("splits at the FIRST separator, so a tab name may hold one", () => {
    expect(placementNamesOf({ where: "rig:x / a / b" })).toEqual({ space: "rig:x", tab: "a / b" });
  });
  it("keeps a slash that has no spaces around it (a view's space name)", () => {
    expect(placementNamesOf({ where: "view:pod:kernel/improve / view" })).toEqual({ space: "view:pod:kernel/improve", tab: "view" });
  });
  it.each([
    ["no label", {}],
    ["no separator", { where: "just-a-folder" }],
    ["separator without spaces", { where: "a/b" }],
    ["empty space", { where: " / cos" }],
    ["empty tab", { where: "rig:x / " }],
    ["a control character", { where: "rig:x / co\u0007s" }],
  ])("reads %s as no names", (_why, labels) => {
    expect(placementNamesOf(labels)).toBeNull();
  });
  it("reads no labels at all as no names", () => {
    expect(placementNamesOf(undefined)).toBeNull();
  });
});

describe("the labels the app owns are not carried by a respawn (OF-281)", () => {
  it("drops `where` and every herdr.* key but the space and the tab; keeps all else", () => {
    const old = { "herdr.space": "s", "herdr.tab": "t", "herdr.seen": "7", "herdr.pinned": "1", "herdr.right-click": "program", where: "s / t", "openrig.seat": "a@b", "openrig.session.OPENRIG_NODE_ID": "n", other: "o", herdrx: "near" };
    expect(withoutAppOwnedLabels(old)).toEqual({ "herdr.space": "s", "herdr.tab": "t", "openrig.seat": "a@b", "openrig.session.OPENRIG_NODE_ID": "n", other: "o", herdrx: "near" });
    expect(isAppOwnedLabel("herdr.seen")).toBe(true);
    expect(isAppOwnedLabel("herdr.space")).toBe(false);
    expect(isAppOwnedLabel("where")).toBe(true);
    expect(isAppOwnedLabel("whereabouts")).toBe(false);
  });
});
