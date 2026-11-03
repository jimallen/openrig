import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HcTerminal } from "../src/adapters/hc-client.js";
import { HcAdapter } from "../src/adapters/hc-adapter.js";
import { HcHost, SEAT_LABEL, hcTerminalName } from "../src/adapters/hc-host.js";
import { sessionEnvLabels } from "../src/adapters/hc-identity.js";
import { SeatLaunchRecords } from "../src/adapters/hc-seat.js";
import { seatRestartEnv } from "../src/domain/seat-restart-env.js";
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
    // Three terminals were started, and a respawn keeps one predecessor, so the oldest record is gone (it was 3 before the
    // lifecycle pruned: every restart left a finished record in the core until someone ran terminal.rm).
    expect(labelled.terminals.map((t) => t.address).sort()).toEqual([addresses[1], addresses[2]].sort());
    await lifecycle.killSession("many@rig");
    expect((await get("many@rig")).state).toBe("finished");
  });

  it("respawns by the pane id a binding holds: the terminal keeps the seat's name and label, never the address's", async () => {
    await host.createSession("byaddr@rig", core.root);
    const before = await get("byaddr@rig");
    await expect(lifecycle.respawnPane(before.address, "exec sleep 120")).resolves.toEqual({ ok: true });
    const after = await get("byaddr@rig");
    expect(after).toMatchObject({ state: "live", labels: { [SEAT_LABEL]: "byaddr@rig" } });
    expect(after.address).not.toBe(before.address);
    expect(await core.client.call<HcTerminal>("terminal.get", { terminal: before.address })).toMatchObject({ state: "finished" });
    // The address is stale now: it names a finished record while a live terminal holds the seat's name. Nothing is started or killed.
    await expect(lifecycle.respawnPane(before.address, "exec sleep 120")).resolves.toMatchObject({ ok: false, code: "pane_superseded" });
    expect(await get("byaddr@rig")).toMatchObject({ state: "live", address: after.address, pid: after.pid });
  });

  it("reads and signals a seat by its address as it does by its name", async () => {
    await host.createSession("addr@rig", core.root);
    const live = await get("addr@rig");
    await expect(lifecycle.isPaneDead(live.address)).resolves.toBe(false);
    await expect(lifecycle.paneLocalOption(live.address, "remain-on-exit")).resolves.toBe("on");
    await expect(lifecycle.signalPaneProcess(live.address, "KILL")).resolves.toEqual({ ok: true });
    await until(() => lifecycle.isPaneDead(live.address), (dead) => dead, "KILL to end the shell, named by its address");
    await expect(lifecycle.paneLocalOption(live.address, "remain-on-exit")).resolves.toBe("on");
    await expect(lifecycle.paneLocalOption("t99999", "remain-on-exit")).resolves.toBeNull();
  });

  it("reaches a terminal by an address with a letter in it (the 20th terminal of a core is t1b, in base 30)", async () => {
    // Taken as decimal only, `t1b` was read as a seat's name: isPaneDead said "dead" for a live terminal, nothing was signalled
    // and a cutover respawned over a retiree it never stopped. 25 fillers push the seat past t19.
    for (let i = 0; i < 25; i++) await core.client.call("terminal.run", { argv: ["sleep", "300"], name: `filler-${i}`, no_parent: true, no_notify: true, outlive_parent: true });
    await host.createSession("late@rig", core.root);
    const live = await get("late@rig");
    expect(live.address, "the seat's address has a letter in it").toMatch(/^t[0-9]*[b-z][0-9a-z]*$/);
    await expect(lifecycle.isPaneDead(live.address)).resolves.toBe(false);
    await expect(lifecycle.paneLocalOption(live.address, "remain-on-exit")).resolves.toBe("on");
    await expect(lifecycle.respawnPane(live.address, "exec sleep 120")).resolves.toEqual({ ok: true });
    const after = await get("late@rig");
    expect(after).toMatchObject({ state: "live", labels: { [SEAT_LABEL]: "late@rig" } });
    expect(await core.client.call<HcTerminal>("terminal.get", { terminal: live.address })).toMatchObject({ state: "finished" });
    await expect(lifecycle.signalPaneProcess(after.address, "KILL")).resolves.toEqual({ ok: true });
    await until(() => lifecycle.isPaneDead(after.address), (dead) => dead, "KILL to end the program, named by an address with a letter");
  });

  it("removes only the seat's own older finished records, and a terminal.list that is not asked for them never shows one", async () => {
    await host.createSession("prune@rig", core.root);
    await host.createSession("bystander@rig", core.root);
    await lifecycle.killSession("bystander@rig");  // another seat's finished record: not this seat's to remove
    const first = (await get("prune@rig")).address;
    for (let i = 0; i < 3; i++) await lifecycle.respawnPane("prune@rig", "exec sleep 120");
    const all = await core.client.call<{ terminals: HcTerminal[] }>("terminal.list", { all: true, labels: { [SEAT_LABEL]: "prune@rig" } });
    expect(all.terminals.filter((t) => t.state === "finished")).toHaveLength(1);
    expect(all.terminals.map((t) => t.address)).not.toContain(first);
    const live = await core.client.call<{ terminals: HcTerminal[] }>("terminal.list", { labels: { [SEAT_LABEL]: "prune@rig" } });
    expect(live.terminals).toHaveLength(1);
    expect(await get("prune@rig")).toMatchObject({ state: "live", address: live.terminals[0]!.address });
    expect(await get("bystander@rig")).toMatchObject({ state: "finished" });
  });

  it("keeps a new terminal that has already finished, and the predecessor it replaced", async () => {
    await host.createSession("quick@rig", core.root);
    await lifecycle.respawnPane("quick@rig", "exec sleep 120");
    const predecessor = await get("quick@rig");
    await expect(lifecycle.respawnPane("quick@rig", "exit 0")).resolves.toEqual({ ok: true });
    await until(() => get("quick@rig"), (t) => t.state === "finished", "the new program's own exit");
    const all = await core.client.call<{ terminals: HcTerminal[] }>("terminal.list", { all: true, labels: { [SEAT_LABEL]: "quick@rig" } });
    expect(all.terminals.map((t) => t.address)).toContain(predecessor.address);
    expect(all.terminals.length).toBe(2);
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

  // OF-200: an agent that is its terminal's own program ends the terminal, so its restart is a respawn, and a respawn starts the new program from
  // the env it is given alone (hc cannot read a terminal's launch env back). Without the seat's own names the restarted agent would run as a
  // different seat: this pins that they follow.
  describe("a respawn that names no env keeps the seat's own (OF-200)", () => {
    const CODEX_HOME = "/seat/codex-home";
    const SEAT_ENV = { OPENRIG_NODE_ID: "node-of200", OPENRIG_SESSION_NAME: "env@rig", OPENRIG_RUNTIME: "codex", CODEX_HOME, OF200_ONLY_IN_SEAT_ENV: `own-${process.pid}` };
    const seen = async (out: string) => { await until(() => { try { return readFileSync(out, "utf8"); } catch { return ""; } }, (t) => t.includes("OPENRIG_NODE_ID="), "the respawned program's env"); return readFileSync(out, "utf8"); };

    it("from the record the host that made the terminal kept: every name the seat was created with", async () => {
      const launches = new SeatLaunchRecords();
      const made = new HcHost(core.client, { daemonEnv, launches });
      const mine = new HcLifecycle(core.client, { daemonEnv, launches });
      await made.createSession("env@rig", core.root, SEAT_ENV);
      const out = join(core.root, "env-record.txt");
      await expect(mine.respawnPane("env@rig", `env > ${out}; exec sleep 120`)).resolves.toEqual({ ok: true });
      const env = await seen(out);
      for (const [key, value] of Object.entries(SEAT_ENV)) expect(env, key).toContain(`${key}=${value}`);
      await expect(mine.killSession("env@rig")).resolves.toEqual({ ok: true });
    });

    it("from the labels its launch wrote when no record is kept (a daemon restart since): the identity names and CODEX_HOME, and nothing else", async () => {
      await host.createSession("env2@rig", core.root, SEAT_ENV);   // this host keeps no record the lifecycle below could read
      const out = join(core.root, "env-labels.txt");
      await expect(new HcLifecycle(core.client, { daemonEnv }).respawnPane("env2@rig", `env > ${out}; exec sleep 120`)).resolves.toEqual({ ok: true });
      const env = await seen(out);
      for (const key of ["OPENRIG_NODE_ID", "OPENRIG_SESSION_NAME", "OPENRIG_RUNTIME", "CODEX_HOME"] as const) expect(env, key).toContain(`${key}=${SEAT_ENV[key]}`);
      expect(env, "a name that is not a label is not invented").not.toContain("OF200_ONLY_IN_SEAT_ENV=");
      await expect(new HcLifecycle(core.client, { daemonEnv }).killSession("env2@rig")).resolves.toEqual({ ok: true });
    });

    // OF-200 review F3, measured on a real Codex on Sparky at 34bae43a (kit of200cx, case env-names): after a daemon restart the in-place restart's new Codex had
    // no OPENRIG_ACTIVITY_HOOK_TOKEN, so the seat's activity reports to the daemon would no longer authenticate. The daemon rebuilds what the labels cannot hold.
    it("after a daemon restart, from the labels plus what the daemon rebuilds: the activity-hook token and the shim PATH are back, and the labels' identity wins over the daemon's", async () => {
      const TOKEN = `tok-of200-${process.pid}`;
      const OPENRIG_HOME = join(core.root, "orhome");
      const launches = new SeatLaunchRecords();
      launches.rebuildFrom((identity) => seatRestartEnv(identity, { sessionEnv: { PATH: process.env.PATH, OPENRIG_HOME, OPENRIG_ACTIVITY_HOOK_TOKEN: TOKEN, CODEX_HOME: "/the/shared/home" }, runtimeSessionEnv: {} }));
      await host.createSession("env5@rig", core.root, SEAT_ENV);          // a host with no record: the daemon "restarted" since
      const out = join(core.root, "env-rebuilt.txt");
      const mine = new HcLifecycle(core.client, { daemonEnv, launches });
      await expect(mine.respawnPane("env5@rig", `env > ${out}; exec sleep 120`)).resolves.toEqual({ ok: true });
      const env = await seen(out);
      expect(env, "the activity-hook token the daemon holds again").toContain(`OPENRIG_ACTIVITY_HOOK_TOKEN=${TOKEN}`);
      expect(env, "the worktree shim at the head of PATH").toContain(`PATH=${OPENRIG_HOME}/rig-bin:`);
      expect(env, "the seat's own CODEX_HOME (a label) beats the daemon's shared one").toContain(`CODEX_HOME=${CODEX_HOME}`);
      expect(env).not.toContain("CODEX_HOME=/the/shared/home");
      expect(env, "a name no launch wrote and no daemon source holds is not invented").not.toContain("OF200_ONLY_IN_SEAT_ENV=");
      await expect(mine.killSession("env5@rig")).resolves.toEqual({ ok: true });
    });

    it("an env the caller names wins, and is what the next respawn keeps", async () => {
      const launches = new SeatLaunchRecords();
      const mine = new HcLifecycle(core.client, { daemonEnv, launches });
      await new HcHost(core.client, { daemonEnv, launches }).createSession("env3@rig", core.root, SEAT_ENV);
      const out = join(core.root, "env-named.txt");
      await mine.respawnPane("env3@rig", `env > ${out}; exec sleep 120`, { env: { OPENRIG_NODE_ID: "named-node" } });
      expect(await seen(out)).toContain("OPENRIG_NODE_ID=named-node");
      const next = join(core.root, "env-next.txt");
      await mine.respawnPane("env3@rig", `env > ${next}; exec sleep 120`);
      const again = await seen(next);
      expect(again).toContain("OPENRIG_NODE_ID=named-node");
      expect(again, "the caller's env replaced the creation env; it did not merge with it").not.toContain("OF200_ONLY_IN_SEAT_ENV=");
      await expect(mine.killSession("env3@rig")).resolves.toEqual({ ok: true });
    });

    it("through the adapter the daemon builds: its host's createSession and its lifecycle's respawn share the record", async () => {
      const adapter = new HcAdapter(core.client);
      await adapter.createSession("env4@rig", core.root, SEAT_ENV);
      const out = join(core.root, "env-adapter.txt");
      await expect(adapter.respawnPane("env4@rig", `env > ${out}; exec sleep 120`)).resolves.toEqual({ ok: true });
      const env = await seen(out);
      expect(env).toContain(`OF200_ONLY_IN_SEAT_ENV=${SEAT_ENV.OF200_ONLY_IN_SEAT_ENV}`);
      await expect(adapter.killSession("env4@rig")).resolves.toEqual({ ok: true });
    });

    it("labels carry only the names a launch is allowed to write, so no credential rides a respawn from them", () => {
      expect(Object.keys(sessionEnvLabels({ ...SEAT_ENV, API_KEY: SECRET })).some((key) => key.includes("API_KEY"))).toBe(false);
    });
  });
});
