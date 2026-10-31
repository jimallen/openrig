import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { HcClient, type HcTerminal } from "../src/adapters/hc-client.js";
import { HcHost, hcTerminalName, SEAT_LABEL } from "../src/adapters/hc-host.js";
import { HcIdentity, sessionEnvLabels } from "../src/adapters/hc-identity.js";
import { HC, PrivateCore, waitUntil } from "./helpers/hc-private-core.js";

const comm = (pid: number) => spawnSync("ps", ["-p", String(pid), "-o", "comm="], { encoding: "utf8" }).stdout.trim();

/** Pane identity, listing and options against a private hc core, with seats launched the way HcHost launches them. */
describe.skipIf(!HC)("HcIdentity against a private hc core", () => {
  const core = new PrivateCore();
  let identity: HcIdentity;
  let host: HcHost;
  const get = (seat: string) => core.client.call<HcTerminal>("terminal.get", { terminal: hcTerminalName(seat) });

  beforeAll(async () => {
    core.start();
    identity = new HcIdentity(core.client);
    host = new HcHost(core.client, { daemonEnv: { PATH: process.env.PATH, HOME: core.env.HOME, SHELL: "/bin/sh" } });
    await expect(host.createSession("qa@rig", core.root, { OPENRIG_NODE_ID: "node-qa" })).resolves.toEqual({ ok: true });
    await expect(host.createSession("dev@rig", core.root)).resolves.toEqual({ ok: true });
    await core.client.call("terminal.run", { argv: ["sleep", "600"], name: "plain", no_parent: true, no_notify: true, outlive_parent: true });
    await waitUntil(async () => (await get("qa@rig")).foreground?.name, (name) => name === "sh", "qa@rig shell");
  }, 30_000);

  afterAll(() => core.stop());

  it("lists the seats and not a terminal without the seat label", async () => {
    const names = (await identity.listSessions()).map((s) => s.name).sort();
    expect(names).toEqual(["dev@rig", "qa@rig"]);
    const all = await core.client.call<{ terminals: HcTerminal[] }>("terminal.list", {});
    expect(all.terminals.length).toBe(3);
  });

  it("lists one pane, by the terminal's address, at the terminal's size", async () => {
    const terminal = await get("qa@rig");
    await expect(identity.listPanes("=qa@rig")).resolves.toEqual([
      { id: terminal.address, index: 0, cwd: core.root, width: terminal.cols, height: terminal.rows, active: true },
    ]);
    await expect(identity.listPanes(terminal.address)).resolves.toHaveLength(1);
    await expect(identity.listPanes("nobody@rig")).resolves.toEqual([]);
    await expect(identity.listWindows("qa@rig")).resolves.toEqual([{ index: 0, name: "qa@rig", panes: 1, active: true }]);
  });

  it("reads the shell's own pid, and its name, from the address or the seat", async () => {
    const terminal = await get("qa@rig");
    const pid = await identity.getPanePid("qa@rig");
    expect(pid).toBe(terminal.pid);
    expect(await identity.getPanePid(terminal.address)).toBe(pid);
    expect(comm(pid!)).toBe("sh");
    await expect(identity.getPaneCommand("qa@rig")).resolves.toBe("sh");
  });

  it("follows the foreground process: a command typed into the shell becomes the pane command, the pid stays the shell's", async () => {
    const pid = await identity.getPanePid("dev@rig");
    await core.client.call("terminal.send", { terminal: hcTerminalName("dev@rig"), text: "sleep 31" });
    await expect.poll(() => identity.getPaneCommand("dev@rig")).toBe("sleep");
    expect(await identity.getPanePid("dev@rig")).toBe(pid);
  });

  it("reads every pid and command at once, keyed by address", async () => {
    const all = await identity.readAllPaneProcesses();
    const qa = await get("qa@rig");
    expect(all?.get(qa.address)).toEqual({ pid: qa.pid, command: "sh" });
    expect(all?.size).toBe(3);
  });

  it("sets, reads and clears a user option as a label, and keeps unset apart from a missing seat", async () => {
    await expect(identity.setSessionOption("qa@rig", "@rigged_node_id", "node-1")).resolves.toEqual({ ok: true });
    await expect(identity.readSessionOption("qa@rig", "@rigged_node_id")).resolves.toEqual({ ok: true, value: "node-1" });
    await expect(identity.getSessionOption("qa@rig", "@rigged_node_id")).resolves.toBe("node-1");
    expect((await get("qa@rig")).labels[SEAT_LABEL]).toBe("qa@rig");
    await expect(identity.setSessionOption("qa@rig", "@rigged_node_id", "")).resolves.toEqual({ ok: true });
    await expect(identity.readSessionOption("qa@rig", "@rigged_node_id")).resolves.toEqual({ ok: true, value: null });
    await expect(identity.readSessionOption("nobody@rig", "@rigged_node_id")).resolves.toMatchObject({ ok: false });
    await expect(identity.setSessionOption("nobody@rig", "@x", "v")).resolves.toMatchObject({ ok: false, code: "session_not_found" });
    await expect(identity.setSessionOption("qa@rig", "mouse", "on")).resolves.toMatchObject({ ok: false, code: "unsupported_option" });
  });

  it("holds a long value with newlines and quotes whole", async () => {
    const value = `${"é日".repeat(2000)}\nline "two" 'three' \\ end`;
    await identity.setSessionOption("dev@rig", "@rigged_logical_id", value);
    await expect(identity.getSessionOption("dev@rig", "@rigged_logical_id")).resolves.toBe(value);
  });

  it("reads the launch environment back from the labels the launch wrote", async () => {
    await core.client.call("terminal.label", { terminal: hcTerminalName("qa@rig"), labels: sessionEnvLabels({ OPENRIG_NODE_ID: "node-qa", OPENRIG_ACTIVITY_HOOK_TOKEN: "t0ken" }) });
    await expect(identity.getSessionEnv("qa@rig", "OPENRIG_NODE_ID")).resolves.toBe("node-qa");
    await expect(identity.getSessionEnv("qa@rig", "CODEX_HOME")).resolves.toBeUndefined();
    await expect(identity.hasSessionEnv("qa@rig", "OPENRIG_ACTIVITY_HOOK_TOKEN")).resolves.toBe(true);
    expect(JSON.stringify((await get("qa@rig")).labels)).not.toContain("t0ken");
  });

  it("names the seats in the snapshot, with their terminals, and no activity without a clock", async () => {
    const snapshot = await identity.readSessionWindowSnapshot();
    expect([...snapshot!.sessions].sort()).toEqual(["dev@rig", "qa@rig"]);
    expect(snapshot!.targets.get("qa@rig")).toBe((await get("qa@rig")).address);
    expect(snapshot!.activity.size).toBe(0);
  });

  it("takes a seat's activity from the clock it is given: status_ms, once a program reports", async () => {
    await core.runSeat("rep@rig", "printf '\\033]7501;state=working:app=t\\033\\\\'; sleep 600");
    // HcTerminal does not declare status_ms yet (hc-client.ts is not this piece's), so the clock narrows it.
    const statusSeconds = (t: HcTerminal) => ("status_ms" in t && typeof t.status_ms === "number" ? t.status_ms / 1000 : null);
    const clocked = new HcIdentity(core.client, { activity: statusSeconds });
    await expect.poll(async () => (await clocked.readAllSessionWindowActivity())?.has("rep@rig")).toBe(true);
    const activity = (await clocked.readAllSessionWindowActivity())!;
    expect(activity.size).toBe(1);
    expect(Math.abs(activity.get("rep@rig")! - Date.now() / 1000)).toBeLessThan(60);
  });

  it("reads a seat killed as dead, with no pid and no command, and gone from the listing", async () => {
    await core.client.call("terminal.kill", { terminal: hcTerminalName("dev@rig") });
    await expect.poll(() => identity.isPaneDead("dev@rig")).toBe(true);
    await expect(identity.getPanePid("dev@rig")).resolves.toBeNull();
    await expect(identity.getPaneCommand("dev@rig")).resolves.toBeNull();
    await expect(identity.listPanes("dev@rig")).resolves.toEqual([]);
    expect((await identity.listSessions()).map((s) => s.name)).not.toContain("dev@rig");
    await expect(identity.isPaneDead("qa@rig")).resolves.toBe(false);
  });

  it("throws, and does not list nothing, where the core is not running", async () => {
    const gone = new HcIdentity(new HcClient(`${core.root}/no-such.sock`));
    await expect(gone.listSessions()).rejects.toThrow();
    await expect(gone.readAllPaneProcesses()).resolves.toBeNull();
    await expect(gone.isPaneDead("qa@rig")).resolves.toBe(false);
    await expect(gone.getPanePid("qa@rig")).resolves.toBeNull();
  });
});
