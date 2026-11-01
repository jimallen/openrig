// hc cutover W37: `rig terminal open` through the real TerminalService, the real app provider and the real `herdr-app` process
// boundary (a FAKE `herdr-app` executable in the test's own directory, found by absolute path), over seats that are real
// terminals on a PRIVATE herdr-core (helpers/hc-scratch.ts: own HOME, HC_SESSION and XDG paths; Jim's core and the app are
// never contacted). No Herdr app is started or contacted anywhere.
//
// What the private core adds beyond the unit rows: (1) the daemon's own liveness probe (HcHost.hasSession) finds the live seat
// by its hashed terminal name, so the composed view is not "absent: hc terminal X is not alive" for a seat the core lists
// live; (2) the argv the provider hands the app, run as the app would run it in a pane, really attaches to the seat and shows
// its screen; (3) closing that viewer leaves the seat running (decision row 20).
//
// Not proven here: the real app accepting this argv shape (unverified, see herdr-app-provider.ts), layout on a real window,
// the CLI's default/--window flow (unchanged, still the old window launcher), macOS.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { HcHost, SEAT_LABEL, hcTerminalName } from "../src/adapters/hc-host.js";
import type { HcTerminal } from "../src/adapters/hc-client.js";
import { createHerdrAppCli, HerdrAppProvider } from "../src/domain/terminal/herdr-app-provider.js";
import { TerminalService, type TerminalServiceDeps } from "../src/domain/terminal/terminal-service.js";
import type { LiveSeatRow } from "../src/domain/terminal/terminal-views-store.js";
import { findHc, startHcScratch, type HcScratch } from "./helpers/hc-scratch.js";

async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, what: string, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}; last: ${JSON.stringify(v).slice(0, 400)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const SEATS = ["pi-test@w37", "cos-lead@w37", "dev-one@w37"];

describe.skipIf(!findHc())("rig terminal open through the app provider, on a private hc core", () => {
  let scratch: HcScratch;
  let dir: string;
  let service: TerminalService;
  const log = (): Array<{ argv: string[] }> => (fs.existsSync(path.join(dir, "calls.log")) ? fs.readFileSync(path.join(dir, "calls.log"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { argv: string[] }) : []);
  const get = (name: string) => scratch.client().call<HcTerminal>("terminal.get", { terminal: name });
  const screen = async (name: string) => (await scratch.client().call<{ text: string }>("terminal.read", { terminal: name, lines: 0 })).text;

  beforeAll(async () => {
    scratch = startHcScratch();
    dir = fs.mkdtempSync(path.join(scratch.root, "app-"));
    // A fake `herdr-app`: `ls` answers the state file (exit 1 while the `down` file exists, as the real one with no window),
    // `do space.new | tab.new | pane.split` add to it and answer the ids the real one is documented to answer. It logs argv.
    fs.writeFileSync(path.join(dir, "herdr-app"), `#!${process.execPath}
const fs = require("node:fs"), path = require("node:path");
const dir = path.dirname(process.argv[1]);
const argv = process.argv.slice(2);
fs.appendFileSync(path.join(dir, "calls.log"), JSON.stringify({ argv }) + "\\n");
const stateFile = path.join(dir, "state.json");
const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, "utf8")) : { seq: 0, spaces: [] };
const save = () => fs.writeFileSync(stateFile, JSON.stringify(state));
if (argv[0] === "ls") {
  if (fs.existsSync(path.join(dir, "down"))) process.exit(1);
  process.stdout.write(JSON.stringify({ spaces: state.spaces }));
} else if (argv[0] === "do") {
  const a = JSON.parse(argv[2]);
  const id = ++state.seq;
  let out = {};
  if (argv[1] === "space.new" || argv[1] === "tab.new") {
    let space = state.spaces.find((s) => s.id === a.space);
    if (!space) { space = { id: "sp" + id, name: a.name, tabs: [] }; state.spaces.push(space); }
    space.tabs.push({ id: "tb" + id, name: argv[1] === "space.new" ? a.tab : a.name, terminals: [{ terminal: "t" + id, pane: "pn" + id }] });
    out = { space: space.id, tab: "tb" + id, terminal: "t" + id };
  } else if (argv[1] === "pane.split") out = { pane: "pn" + id, terminal: "t" + id };
  save();
  process.stdout.write(JSON.stringify(out));
}
`, { mode: 0o700 });
    // Three seats: real terminals named the way HcHost names a seat, each printing a marker that is on its screen.
    for (const seat of SEATS) {
      await scratch.client().call("terminal.run", {
        argv: [process.execPath, "-e", `process.stdout.write("MARK-${seat}\\r\\n");setInterval(()=>{},1e6)`], name: hcTerminalName(seat),
        labels: { [SEAT_LABEL]: seat }, cwd: scratch.root, no_parent: true, no_notify: true, outlive_parent: true,
      });
    }
    const rows: LiveSeatRow[] = SEATS.map((seat) => ({ canonicalSessionName: seat, attachmentType: "hc", tmuxSession: seat, rigName: "w37", logicalId: seat.split("@")[0]! }));
    const host = new HcHost(scratch.client());
    const deps: TerminalServiceDeps = {
      resolveProvider: (name) => (name === "herdr" ? new HerdrAppProvider(createHerdrAppCli(path.join(dir, "herdr-app"))) : null),
      viewsStore: { get: () => null, list: () => [] },
      listRigSeats: (rig) => (rig === "w37" ? rows : null),
      listPodSeats: () => null, listScopeSeats: () => null, listRigNames: () => ["w37"], resolveHost: () => null,
      hasSession: (session) => host.hasSession(session),
      resolveLocalHc: () => scratch.hcBin,
    };
    service = new TerminalService(deps);
    await until(() => Promise.all(SEATS.map((s) => screen(hcTerminalName(s)))), (all) => all.every((t, i) => t.includes(`MARK-${SEATS[i]}`)), "the seats' markers");
  }, 60_000);

  afterAll(() => {
    scratch?.cleanup();
  });

  it("opens every live seat: one new space, the lead's pane first, two splits, each pane the composer's hc attach", async () => {
    const result = await service.openView({ view: "w37" });
    expect(result).toMatchObject({ provider: "herdr", ok: true, absent: [], degraded: [], pages: 1 });
    expect([...result.opened].sort()).toEqual([...SEATS].sort());
    const calls = log().map((c) => c.argv);
    expect(calls.map((a) => a.slice(0, a[0] === "do" ? 2 : 1).join(" "))).toEqual(["ls", "do space.new", "ls", "do pane.split", "do pane.split"]);
    const sent = calls.filter((a) => a[0] === "do").map((a) => ({ command: a[1]!, args: JSON.parse(a[2]!) as { name?: string; argv: string[] } }));
    expect(sent[0]!.args.name, "the composer names a rig view rig:<rig>; the space is never that name itself (rig-here closes a second rig:<rig>)").toBe("view:rig:w37");
    // every pane runs `<this scratch's hc> attach -- '<hashed terminal name>'` through sh -c, and nothing else
    for (const [i, s] of sent.entries()) {
      expect(s.args.argv.slice(0, 2)).toEqual(["sh", "-c"]);
      expect(s.args.argv[2], `pane ${i}`).toMatch(new RegExp(`^'${scratch.hcBin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}' attach -- 's-[0-9a-f]{24}'$`));
    }
    expect(sent.map((s) => s.args.argv[2]!.match(/'(s-[0-9a-f]{24})'$/)![1]).sort()).toEqual(SEATS.map(hcTerminalName).sort());
  });

  it("the argv handed to the app, run in a pane as the app would, attaches to the seat and shows its screen; closing the viewer leaves the seat running", async () => {
    const sent = log().map((c) => c.argv).filter((a) => a[0] === "do" && a[1] === "space.new").map((a) => (JSON.parse(a[2]!) as { argv: string[] }).argv);
    expect(sent.length).toBeGreaterThan(0);
    const argv = sent[0]!;
    await scratch.client().call("terminal.run", { argv, name: "viewer1", cwd: scratch.root, no_parent: true, no_notify: true, outlive_parent: true });
    const lead = SEATS.find((s) => argv[2]!.includes(hcTerminalName(s)))!;
    const shown = await until(() => screen("viewer1"), (t) => t.includes(`MARK-${lead}`), "the viewer to show the seat's screen");
    expect(shown).toContain(`MARK-${lead}`);
    await scratch.client().call("terminal.kill", { terminal: "viewer1" });
    await until(() => get("viewer1"), (t) => t.state !== "live", "the viewer to end");
    expect((await get(hcTerminalName(lead))).state, "the seat outlives its viewer").toBe("live");
  });

  it("a seat the core no longer lists live is named absent, not opened (the liveness probe has a positive control above)", async () => {
    await scratch.client().call("terminal.kill", { terminal: hcTerminalName("dev-one@w37") });
    await until(() => get(hcTerminalName("dev-one@w37")), (t) => t.state !== "live", "the seat to end");
    const before = log().length;
    const result = await service.openView({ view: "w37" });
    expect(result.absent).toEqual([{ seat: "dev-one@w37", host: null, reason: "hc terminal dev-one@w37 is not alive" }]);
    expect([...result.opened].sort()).toEqual(["cos-lead@w37", "pi-test@w37"]);
    expect(log().length).toBeGreaterThan(before);
  });

  it("with no app window the open is refused by name before anything is made, and the status says why", async () => {
    fs.writeFileSync(path.join(dir, "down"), "");
    const before = log().filter((c) => c.argv[0] === "do").length;
    const result = await service.openView({ view: "w37" });
    expect(result).toMatchObject({ ok: false, opened: [], code: "herdr_unavailable" });
    expect(result.error).toMatch(/Herdr app is not running/);
    expect(log().filter((c) => c.argv[0] === "do").length, "no do command ran").toBe(before);
    const status = await service.status();
    expect(status.providers[0]).toMatchObject({ name: "herdr", liveness: { alive: false } });
  });
});
