import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HcClient, type HcTerminal, resolveHcSocket } from "../src/adapters/hc-client.js";
import { HcHost, hcTerminalName } from "../src/adapters/hc-host.js";

const HC = spawnSync("sh", ["-c", "command -v hc"], { encoding: "utf8" }).stdout.trim();
const SECRET = `sv-${process.pid}-needle`;

/** A private core only, started with a parent session's identity in its env, as a core started from a seat would be. */
describe.skipIf(!HC)("HcHost launch against a private hc core", () => {
  const root = mkdtempSync(join(tmpdir(), "hch-"));
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, HOME: join(root, "h"), HC_SESSION: `h${process.pid}`, CLAUDECODE: "1", HERDR_PANE_ID: "p1",
    XDG_CONFIG_HOME: join(root, "c"), XDG_DATA_HOME: join(root, "d"), XDG_STATE_HOME: join(root, "s"), XDG_RUNTIME_DIR: join(root, "r"),
  };
  let client: HcClient;
  let host: HcHost;

  beforeAll(() => {
    for (const d of ["h", "c", "d", "s", "r"]) mkdirSync(join(root, d), { recursive: true, mode: 0o700 });
    execFileSync(HC, ["server", "start"], { env, stdio: "ignore" });
    client = new HcClient(resolveHcSocket(env, env.HOME));
    host = new HcHost(client, { daemonEnv: { PATH: process.env.PATH, HOME: env.HOME, SHELL: "/bin/sh", DOCKER_HOST: "tcp://d", CLAUDECODE: "1" } });
  });

  afterAll(() => {
    spawnSync(HC, ["server", "stop"], { env, stdio: "ignore" });
    rmSync(root, { recursive: true, force: true });
  });

  it("gives the seat a stated env, its hc identity and no parent session, with the secret off every argv", async () => {
    const out = join(root, "seat-env.txt");
    await expect(host.createSession("qa@rig", root, { API_KEY: SECRET })).resolves.toEqual({ ok: true });
    const address = hcTerminalName("qa@rig");
    await client.call("terminal.send", { terminal: address, text: `env > ${out}` });
    await expect.poll(() => { try { return readFileSync(out, "utf8"); } catch { return ""; } }).toContain("API_KEY=");
    const seen = readFileSync(out, "utf8");
    expect(seen).toContain(`API_KEY=${SECRET}`);
    expect(seen).toContain("DOCKER_HOST=tcp://d");
    expect(seen).toMatch(/^HC_TERMINAL_ID=/m);
    expect(seen).toMatch(/^TERM=/m);
    expect(seen).not.toMatch(/^CLAUDECODE=/m);
    expect(seen).not.toMatch(/^HERDR_PANE_ID=/m);
    const argvs = spawnSync("ps", ["-axww", "-o", "args"], { encoding: "utf8" }).stdout;
    expect(argvs).not.toContain(SECRET);
    const terminal = await client.call<HcTerminal>("terminal.get", { terminal: address });
    expect(terminal.labels["openrig.seat"]).toBe("qa@rig");
    expect(terminal.cwd).toBe(root);
  });

  it("reads present, then absent once killed", async () => {
    await host.createSession("gone@rig", root);
    await expect(host.probeSession("gone@rig")).resolves.toEqual({ state: "present" });
    await client.call("terminal.kill", { terminal: hcTerminalName("gone@rig") });
    await expect.poll(() => host.probeSession("gone@rig")).toEqual({ state: "absent" });
  });

  it("refuses a second seat of one name atomically", async () => {
    await host.createSession("dup@rig", root);
    await expect(host.createSession("dup@rig", root)).resolves.toMatchObject({ ok: false, code: "duplicate_session" });
  });

  it("reports the wrapper's own failure as a finished seat, never a live one", async () => {
    const bad = new HcHost(client, { daemonEnv: { SHELL: "/nonexistent/shell" } });
    await bad.createSession("noshell@rig", root);
    await expect.poll(() => bad.probeSession("noshell@rig")).toEqual({ state: "absent" });
    writeFileSync(join(root, "done"), "");
  });
  // OF-280, on a real core (private: its own HC_SESSION, HOME and XDG paths). The placer's labels are set after creation, as rig-here
  // sets them; the seat's terminal is ended; the core is stopped and started (a finished record must survive that, which is what
  // makes the core, not the daemon, the source); and the relaunch must carry the herdr.* labels and nothing else of the old one.
  it("a relaunched seat carries its Herdr placement from the finished record, across a core stop and start", async () => {
    await host.createSession("placed@rig", root, { OPENRIG_NODE_ID: "old-node" });
    await client.call("terminal.label", { terminal: hcTerminalName("placed@rig"), labels: { "herdr.space": "rig:rig", "herdr.tab": "rig:rig/team" } });
    await client.call("terminal.kill", { terminal: hcTerminalName("placed@rig") });
    await expect.poll(() => host.probeSession("placed@rig")).toEqual({ state: "absent" });
    spawnSync(HC, ["server", "stop"], { env, stdio: "ignore" });
    execFileSync(HC, ["server", "start"], { env, stdio: "ignore" });
    await expect(host.createSession("placed@rig", root, { OPENRIG_NODE_ID: "new-node" })).resolves.toEqual({ ok: true });
    const terminal = await client.call<HcTerminal>("terminal.get", { terminal: hcTerminalName("placed@rig") });
    expect(terminal.state).toBe("live");
    expect(terminal.labels).toMatchObject({ "openrig.seat": "placed@rig", "herdr.space": "rig:rig", "herdr.tab": "rig:rig/team", "openrig.env.OPENRIG_NODE_ID": "new-node" });
  });
});
