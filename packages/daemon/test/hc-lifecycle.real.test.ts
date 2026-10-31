import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HcTerminal } from "../src/adapters/hc-client.js";
import { HcHost, SEAT_LABEL, hcTerminalName } from "../src/adapters/hc-host.js";
import { HcLifecycle, PROBE_LABEL } from "../src/adapters/hc-lifecycle.js";
import { HC, PrivateCore, until } from "./hc-private-core.js";

const SECRET = `sv-${process.pid}-needle`;

describe.skipIf(!HC)("HcLifecycle against a private hc core", () => {
  const core = new PrivateCore("hcl");
  let lifecycle: HcLifecycle;
  let host: HcHost;
  const get = (seat: string) => core.client.call<HcTerminal>("terminal.get", { terminal: hcTerminalName(seat) });
  const daemonEnv = { PATH: process.env.PATH, SHELL: "/bin/sh" };

  beforeAll(() => {
    core.start();
    lifecycle = new HcLifecycle(core.client, { daemonEnv });
    host = new HcHost(core.client, { daemonEnv });
  });
  afterAll(() => core.stop());

  it("kills a live seat, leaves its finished record readable, and a second kill finds nothing live", async () => {
    await host.createSession("kill@rig", core.root);
    await expect(lifecycle.killSession("kill@rig")).resolves.toEqual({ ok: true });
    const record = await get("kill@rig");
    expect(record).toMatchObject({ state: "finished", reason: "killed" });
    await expect(host.probeSession("kill@rig")).resolves.toEqual({ state: "absent" });
    await expect(lifecycle.killSession("kill@rig")).resolves.toMatchObject({ ok: false, code: "session_not_found" });
    await expect(lifecycle.killSession("never@rig")).resolves.toMatchObject({ ok: false, code: "session_not_found" });
  });

  it("respawns in place: the old program ends, the address changes, the name, labels and cwd follow, the secret stays off argv", async () => {
    await host.createSession("resp@rig", core.root);
    const before = await get("resp@rig");
    await core.client.call("terminal.label", { terminal: before.address, labels: { "herdr.space": "rig:t", "herdr.tab": "rig:t/team" } });
    const out = join(core.root, "resp-env.txt");
    await expect(lifecycle.respawnPane("resp@rig", `echo marker-resp; env > ${out}; exec sleep 120`, { env: { API_KEY: SECRET } })).resolves.toEqual({ ok: true });
    const after = await get("resp@rig");
    expect(after.address).not.toBe(before.address);
    expect(after).toMatchObject({ state: "live", cwd: core.root, labels: { [SEAT_LABEL]: "resp@rig", "herdr.space": "rig:t", "herdr.tab": "rig:t/team" } });
    expect(after.pid).not.toBe(before.pid);
    expect(await core.client.call<HcTerminal>("terminal.get", { terminal: before.address })).toMatchObject({ state: "finished", reason: "killed" });
    await until(() => { try { return readFileSync(out, "utf8"); } catch { return ""; } }, (t) => t.includes("API_KEY="), "the respawned program's env");
    const seen = readFileSync(out, "utf8");
    expect(seen).toContain(`API_KEY=${SECRET}`);
    expect(seen).toMatch(/^HC_TERMINAL_ID=/m);
    const read = await core.client.call<{ text?: string }>("terminal.read", { terminal: hcTerminalName("resp@rig"), lines: 20 });
    expect(JSON.stringify(read)).toContain("marker-resp");
    await expect(host.probeSession("resp@rig")).resolves.toEqual({ state: "present" });
  });

  it("keeps resolving the seat's name to the live terminal across repeated respawns, and to a finished one once all are dead", async () => {
    await host.createSession("many@rig", core.root);
    const addresses = [(await get("many@rig")).address];
    for (let i = 0; i < 2; i++) {
      await lifecycle.respawnPane("many@rig", "exec sleep 120");
      const now = await get("many@rig");
      expect(now.state).toBe("live");
      addresses.push(now.address);
    }
    expect(new Set(addresses).size).toBe(3);
    const labelled = await core.client.call<{ terminals: HcTerminal[] }>("terminal.list", { all: true, labels: { [SEAT_LABEL]: "many@rig" } });
    expect(labelled.terminals.filter((t) => t.state === "live")).toHaveLength(1);
    expect(labelled.terminals).toHaveLength(3);
    await lifecycle.killSession("many@rig");
    expect((await get("many@rig")).state).toBe("finished");
  });

  it("respawns a seat that already ended on its own, and starts a blank login shell without a command", async () => {
    await host.createSession("dead@rig", core.root);
    await lifecycle.respawnPane("dead@rig", "exit 3");
    await until(() => get("dead@rig"), (t) => t.state === "finished", "the program's own exit");
    expect(await get("dead@rig")).toMatchObject({ exit_code: 3, reason: "exited" });
    await expect(lifecycle.respawnPane("dead@rig")).resolves.toEqual({ ok: true });
    const shell = await until(() => get("dead@rig"), (t) => t.foreground != null, "the shell to be the foreground program");
    expect(shell.state).toBe("live");
    expect(shell.foreground?.argv).toEqual(expect.arrayContaining(["-l"]));
    expect(shell.argv).not.toContain("-c");
  });

  it("signals the live seat's root process: TERM ends a program, and KILL ends one that ignores TERM", async () => {
    await host.createSession("sig@rig", core.root);
    await lifecycle.respawnPane("sig@rig", "exec sleep 120");
    await expect(lifecycle.signalPaneProcess("sig@rig", "TERM")).resolves.toEqual({ ok: true });
    await until(() => get("sig@rig"), (t) => t.state === "finished", "TERM to end sleep");
    expect(await get("sig@rig")).toMatchObject({ signal: 15, reason: "exited" });

    await lifecycle.respawnPane("sig@rig", "trap '' TERM; while :; do sleep 1; done");
    await expect(lifecycle.isPaneDead("sig@rig")).resolves.toBe(false);
    await expect(lifecycle.signalPaneProcess("sig@rig", "TERM")).resolves.toEqual({ ok: true });
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect((await get("sig@rig")).state).toBe("live");
    await expect(lifecycle.signalPaneProcess("sig@rig", "KILL")).resolves.toEqual({ ok: true });
    await until(() => lifecycle.isPaneDead("sig@rig"), (dead) => dead, "KILL to end the trapped program");
    expect(await get("sig@rig")).toMatchObject({ signal: 9 });
  });

  it("will not signal a finished terminal, whose recorded pid the OS may have given to another process", async () => {
    await host.createSession("old@rig", core.root);
    const live = await get("old@rig");
    await lifecycle.killSession("old@rig");
    const finished = await get("old@rig");
    expect(finished.pid).toBe(live.pid);  // hc still reports the dead program's pid: the reason for the refusal
    await expect(lifecycle.signalPaneProcess("old@rig", "KILL")).resolves.toMatchObject({ ok: false, code: "pane_pid_unavailable" });
  });

  it("signals a pid by number, with no shell, and names a pid that is gone", async () => {
    const child = spawn("sleep", ["120"], { stdio: "ignore" });
    const exited = new Promise<string | null>((resolve) => child.once("exit", (_code, signal) => resolve(signal)));
    await expect(lifecycle.signalPid(child.pid!, "TERM")).resolves.toEqual({ ok: true });
    await expect(exited).resolves.toBe("SIGTERM");
    await expect(lifecycle.signalPid(child.pid!, "TERM")).resolves.toMatchObject({ ok: false, code: "process_not_found" });
  });

  it("keeps a finished terminal readable, which is what remain-on-exit becomes", async () => {
    await host.createSession("remain@rig", core.root);
    await lifecycle.respawnPane("remain@rig", "echo last-words; exit 0");
    await expect(lifecycle.setRemainOnExit("remain@rig", true)).resolves.toEqual({ ok: true });
    await until(() => lifecycle.isPaneDead("remain@rig"), (dead) => dead, "the program to exit");
    await expect(lifecycle.setRemainOnExit("remain@rig", true)).resolves.toEqual({ ok: true });
    const read = await core.client.call("terminal.read", { terminal: hcTerminalName("remain@rig"), lines: 20 });
    expect(JSON.stringify(read)).toContain("last-words");
    await expect(lifecycle.setRemainOnExit("remain@rig", false)).resolves.toMatchObject({ ok: true, warnings: [expect.any(String)] });
    await expect(lifecycle.setRemainOnExit("nobody@rig", true)).resolves.toMatchObject({ ok: false, code: "session_not_found" });
  });

  it("runs a probe session that is labelled as a probe, is not a seat, and goes away with killSession", async () => {
    await expect(lifecycle.createProbeSession("rigged-refresh-x", core.root)).resolves.toEqual({ ok: true });
    expect(await get("rigged-refresh-x")).toMatchObject({ state: "live", labels: { [PROBE_LABEL]: "rigged-refresh-x" } });
    const seats = await core.client.call<{ terminals: HcTerminal[] }>("terminal.list", { labels: { [SEAT_LABEL]: "rigged-refresh-x" } });
    expect(seats.terminals).toEqual([]);
    await expect(lifecycle.createProbeSession("rigged-refresh-x")).resolves.toMatchObject({ ok: false, code: "duplicate_session" });
    await expect(lifecycle.killSession("rigged-refresh-x")).resolves.toEqual({ ok: true });
    writeFileSync(join(core.root, "probe-done"), "");
  });
});
