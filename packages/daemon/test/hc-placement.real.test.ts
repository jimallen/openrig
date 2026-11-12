import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { hcScratchBase, hcScratchFallback } from "./helpers/hc-scratch.js";
import { join } from "node:path";
import { HcClient, type HcTerminal, resolveHcSocket } from "../src/adapters/hc-client.js";
import { HcHost, hcTerminalName } from "../src/adapters/hc-host.js";
import { HcPlacement, planRigTabs, type AppLs, type AppPort } from "../src/adapters/hc-placement.js";

const HC = spawnSync("sh", ["-c", "command -v hc"], { encoding: "utf8" }).stdout.trim();

/** The app is never run here. This one does what design 5 says a park does to the core terminal (strips the app's two
 *  labels) by the one hc method that exists for it, so the core's side of placement is real and the app's is assumed. */
class LabelStrippingApp implements AppPort {
  done: [string, Record<string, unknown>][] = [];
  constructor(private readonly client: HcClient) {}
  async ls(): Promise<AppLs> { return { spaces: [] }; }
  async do(command: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.done.push([command, args]);
    if (command === "terminal.park") {
      await this.client.call("terminal.label", { terminal: String(args.terminal), labels: { "herdr.space": "", "herdr.tab": "" } });
    }
    return {};
  }
}

/** A private core only: own HOME, HC_SESSION and XDG paths. No app, so no window and no adoption. */
describe.skipIf(!HC)("HcPlacement against a private hc core", () => {
  const root = mkdtempSync(join(hcScratchBase(process.env, hcScratchFallback(tmpdir())), "hcp-"));
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, HOME: join(root, "h"), HC_SESSION: `p${process.pid}`,
    XDG_CONFIG_HOME: join(root, "c"), XDG_DATA_HOME: join(root, "d"), XDG_STATE_HOME: join(root, "s"), XDG_RUNTIME_DIR: join(root, "r"),
  };
  let client: HcClient;
  let host: HcHost;
  let app: LabelStrippingApp;
  let placement: HcPlacement;

  beforeAll(() => {
    for (const d of ["h", "c", "d", "s", "r"]) mkdirSync(join(root, d), { recursive: true, mode: 0o700 });
    execFileSync(HC, ["server", "start"], { env, stdio: "ignore" });
    client = new HcClient(resolveHcSocket(env, env.HOME));
    host = new HcHost(client, { daemonEnv: { PATH: process.env.PATH, HOME: env.HOME, SHELL: "/bin/sh" } });
    app = new LabelStrippingApp(client);
    placement = new HcPlacement(client, app, { intervalMs: 50, attempts: 20 });
  });

  afterAll(() => {
    spawnSync(HC, ["server", "stop"], { env, stdio: "ignore" });
    rmSync(root, { recursive: true, force: true });
  });

  const seats = ["exec-cos@pr", "dev-impl@pr", "verify-qa@pr"];

  it("labels real seats by the plan and the core filters them by the exact tab id", async () => {
    for (const seat of seats) await expect(host.createSession(seat, root)).resolves.toEqual({ ok: true });
    const results = await placement.showTabs(planRigTabs("pr", seats));
    expect(results.map((r) => r.outcome)).toEqual(["shown", "shown", "shown"]);
    const team = await client.call<{ terminals: HcTerminal[] }>("terminal.list", { labels: { "herdr.tab": "rig:pr/team" } });
    expect(team.terminals.map((t) => t.labels["openrig.seat"]).sort()).toEqual(["dev-impl@pr", "verify-qa@pr"]);
    const cos = await client.call<HcTerminal>("terminal.get", { terminal: hcTerminalName("exec-cos@pr") });
    expect(cos.labels).toMatchObject({ "openrig.seat": "exec-cos@pr", "herdr.space": "rig:pr", "herdr.tab": "rig:pr/cos" });
  });

  it("starts seats without core keep, which is what show keeps", async () => {
    const t = await client.call<HcTerminal & { keep?: boolean }>("terminal.get", { terminal: hcTerminalName("exec-cos@pr") });
    expect(t.keep).toBe(false);
  });

  it("turns a keep that adoption would have set back off, on a real terminal", async () => {
    await client.call("terminal.keep", { terminal: hcTerminalName("dev-impl@pr"), keep: true });
    const result = await placement.show("dev-impl@pr", "pr", "team");
    expect(result).toMatchObject({ outcome: "shown", keepTurnedOff: true });
    const t = await client.call<HcTerminal & { keep?: boolean }>("terminal.get", { terminal: hcTerminalName("dev-impl@pr") });
    expect(t.keep).toBe(false);
  });

  it("parks the rig's seats alive and finds them by seat label", async () => {
    const report = await placement.parkRig("pr");
    expect(report.safeToClose).toBe(true);
    expect(report.results.map((r) => `${r.seat}:${r.outcome}`).sort()).toEqual(seats.map((s) => `${s}:parked`).sort());
    const after = await client.call<HcTerminal>("terminal.get", { terminal: hcTerminalName("verify-qa@pr") });
    expect(after.state).toBe("live");
    expect(after.labels["herdr.space"]).toBeUndefined();
    expect(after.labels["herdr.tab"]).toBeUndefined();
    expect(after.labels["openrig.seat"]).toBe("verify-qa@pr");
    // A second park finds nothing in a pane: it is idempotent and asks the app for nothing more.
    const before = app.done.length;
    await expect(placement.parkRig("pr")).resolves.toMatchObject({ safeToClose: true });
    expect(app.done.length).toBe(before);
  });

  it("shows a parked seat again with both labels", async () => {
    await expect(placement.show("verify-qa@pr", "pr", "team")).resolves.toMatchObject({ outcome: "shown" });
    const t = await client.call<HcTerminal>("terminal.get", { terminal: hcTerminalName("verify-qa@pr") });
    expect(t.labels).toMatchObject({ "herdr.space": "rig:pr", "herdr.tab": "rig:pr/team" });
  });

  it("reads a seat that is not there as not_found, never as parked", async () => {
    await expect(placement.park("nobody@pr")).resolves.toEqual({ seat: "nobody@pr", outcome: "not_found" });
  });
});
