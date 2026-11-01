// hc cutover W44: `rig terminal open --window` on a host that cannot show the Herdr app, end to end. The old row "--window
// reports a headless refusal without a provider POST" went with the window launcher; the flag is now accepted and the view goes
// through POST /api/terminal/open to the app provider. This runs the shipped CLI against a real scratch daemon (own OPENRIG_HOME,
// ephemeral port) over seats that are real terminals on a PRIVATE hc core, with no Herdr app anywhere:
//   - no `herdr-app` on the daemon's PATH (a host with the app not installed, e.g. a server or SSH-only box), and
//   - a `herdr-app` that is there but answers like an app with no window (`ls` exits 1: no desktop session), which also logs
//     every call so "nothing half-opened" is read off the app's own record, not assumed.
// What the operator must see: a nonzero exit, the reason, the fix that fits THAT host (not "start the app" where there is no app
// or no desktop), the seats' own `hc attach` commands, and nothing created: the core's terminals are the same before and after.
// Not proven: a real Herdr app (none is started or contacted), a real herdr-app on a machine whose window server is absent
// (unverified: how the real binary behaves there; this fake exits 1 as the provider's own comment says the real one does with no
// window), Linux.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { delimiter } from "node:path";
import type { HcTerminal } from "../src/adapters/hc-client.js";
import { type HermeticScaffold } from "./helpers/hermetic-env.js";
import { installTrustedScenario, prepareTrustedHermeticEnv } from "./helpers/trusted-scaffold.js";
import { runRig, spawnScenarioDaemon, type RigResult, type ScenarioDaemon } from "./helpers/scenario-daemon.js";
import { findHc, startHcScratch, type HcScratch } from "./helpers/hc-scratch.js";

const here = dirname(fileURLToPath(import.meta.url));
const rigBin = resolve(here, "../../cli/dist/bin-wrapper.js");
const topology = resolve(here, "../../test-system/scenarios/dev-pair-stub.yaml");
const rigName = "dev-pair-stub";

function useHost(fakeApp: boolean) {
  const ctx: { core?: HcScratch; scaffold?: HermeticScaffold; daemon?: ScenarioDaemon; appDir?: string } = {};
  const rig = (args: string[]): Promise<RigResult> => runRig(args, ctx.daemon!.readEnv, rigBin, 120_000);
  const terminals = async (): Promise<string[]> =>
    (await ctx.core!.client().call<{ terminals: HcTerminal[] }>("terminal.list", {})).terminals.map((t) => t.name ?? t.address).sort();
  const appCalls = (): string[][] => {
    const file = join(ctx.appDir!, "calls.log");
    return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]) : [];
  };
  beforeAll(async () => {
    ctx.core = startHcScratch();
    ctx.scaffold = prepareTrustedHermeticEnv({ baseEnv: { PATH: process.env.PATH, TERM: "xterm-256color", SHELL: "/bin/bash" } });
    Object.assign(ctx.scaffold.env, { HC_SESSION: ctx.core.session, XDG_RUNTIME_DIR: ctx.core.env.XDG_RUNTIME_DIR, HC_SOCKET: ctx.core.socketPath });
    if (fakeApp) {
      ctx.appDir = join(ctx.scaffold.root, "fake-app");
      mkdirSync(ctx.appDir);
      writeFileSync(join(ctx.appDir, "herdr-app"), `#!${process.execPath}
require("node:fs").appendFileSync(require("node:path").join(__dirname, "calls.log"), JSON.stringify(process.argv.slice(2)) + "\\n");
process.stderr.write("no window server\\n");
process.exit(1);
`);
      chmodSync(join(ctx.appDir, "herdr-app"), 0o700);
      ctx.scaffold.env.PATH = `${ctx.appDir}${delimiter}${ctx.scaffold.env.PATH ?? ""}`;
    }
    ctx.daemon = await spawnScenarioDaemon(ctx.scaffold, { rigBin });
    const cwd = join(ctx.scaffold.root, "project");
    mkdirSync(cwd);
    const up = await rig(["up", installTrustedScenario(ctx.scaffold, topology), "--cwd", cwd, "--json", "--yes"]);
    expect(up.code, JSON.stringify(up)).toBe(0);
  }, 200_000);
  afterAll(async () => {
    try { await rig(["down", rigName, "--json", "--force"]); } finally {
      try { await ctx.daemon?.stop(); ctx.scaffold?.cleanup(); } finally { ctx.core?.cleanup(); }
    }
  }, 60_000);
  return { ctx, rig, terminals, appCalls };
}

type Open = { human: RigResult; json: RigResult; body: { ok: boolean; opened: string[]; code?: string; error?: string; notes?: string[] }; before: string[]; after: string[] };

async function openHeadless(h: ReturnType<typeof useHost>): Promise<Open> {
  const before = await h.terminals();
  const human = await h.rig(["terminal", "open", "--window", "--", rigName]);
  const json = await h.rig(["terminal", "open", "--window", "--json", "--", rigName]);
  return { human, json, body: JSON.parse(json.stdout) as Open["body"], before, after: await h.terminals() };
}

/** What every host that cannot show the app owes the operator, whatever the reason. */
function expectTruthfulRefusal(o: Open): void {
  expect(o.before.length, "two seats are live to be opened (positive control for the nothing-created check)").toBe(2);
  expect(o.human.code, "a refusal is a nonzero exit").toBe(1);
  expect(o.json.code).toBe(1);
  expect(o.body).toMatchObject({ ok: false, opened: [], code: "herdr_unavailable" });
  expect(o.human.stdout).toContain("nothing was opened");
  // The one thing that works on such a host: each seat's own attach command, in full.
  for (const seat of o.before) expect(o.human.stdout).toMatch(new RegExp(`attach -- '${seat}'`));
  expect(o.after, "nothing was created or killed in the core").toEqual(o.before);
}

describe.skipIf(findHc() === null)("rig terminal open --window where the Herdr app is not installed", () => {
  const h = useHost(false);
  it("refuses with a nonzero exit, says the app is not installed, and names a fix that fits (install it, or attach by hand)", async () => {
    const o = await openHeadless(h);
    expectTruthfulRefusal(o);
    expect(o.body.error).toMatch(/herdr-app is not installed/);
    expect(o.body.error, "the old advice, to start an app that is not there").not.toMatch(/Start the Herdr app/);
    expect(o.body.error).toMatch(/Install the Herdr app on the daemon's host/);
    expect(o.body.error).toMatch(/`hc attach`/);
  }, 200_000);
});

describe.skipIf(findHc() === null)("rig terminal open --window on a host with no desktop session (herdr-app finds no window)", () => {
  const h = useHost(true);
  it("refuses with a nonzero exit, says the app is not running, names the desktop and the hc attach fallback, and never asks the app to make anything", async () => {
    const o = await openHeadless(h);
    expectTruthfulRefusal(o);
    expect(o.body.error).toMatch(/Herdr app is not running/);
    expect(o.body.error).toMatch(/Open the Herdr app on that machine's desktop/);
    expect(o.body.error).toMatch(/with no desktop session/);
    expect(o.body.error).toMatch(/`hc attach`/);
    const calls = h.appCalls();
    expect(calls.length, "the app was asked (positive control: the fake is the one on the daemon's PATH)").toBeGreaterThan(0);
    expect(calls.filter((c) => c[0] !== "ls"), "only `ls` ran: no do space.new / tab.new / pane.split").toEqual([]);
  }, 200_000);
});
