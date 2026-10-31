import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import type { HcTerminal } from "../src/adapters/hc-client.js";
import { hcTerminalName } from "../src/adapters/hc-host.js";
import { HcLifecycle } from "../src/adapters/hc-lifecycle.js";
import { HcCoreWatch, HC_PINNED_VERSION, lossReason, probeCore, startCoreWithCli, type HcNotice, type HcViewTerminal } from "../src/adapters/hc-core-watch.js";
import { HC, PrivateCore, until } from "./hc-private-core.js";

const linux = process.platform === "linux";
const SEAT = { "openrig.seat": "w@rig" };
const RUN = { no_parent: true, no_notify: true, outlive_parent: true };

describe.skipIf(!HC)("HcCoreWatch against a private hc core", () => {
  let core: PrivateCore;
  let watch: HcCoreWatch | null = null;
  let notices: HcNotice[];
  let starts: number;
  let stopped: number[];

  beforeEach(() => {
    core = new PrivateCore("hcw");
    core.start();
    notices = [];
    starts = 0;
    stopped = [];
  });
  afterEach(async () => {
    watch?.stop();
    watch = null;
    for (const pid of stopped) { try { process.kill(pid, "SIGCONT"); } catch { /* gone */ } }
    core.stop();
  });

  const startWatch = (extra: Partial<ConstructorParameters<typeof HcCoreWatch>[0]> = {}) => {
    const cli = startCoreWithCli({ env: core.env });
    watch = new HcCoreWatch({
      socketPath: core.socketPath, reconnectDelaysMs: [50, 100, 200], helloTimeoutMs: 2000,
      startCore: async () => { starts++; await cli(); },
      onNotice: (n) => notices.push(n),
      ...extra,
    });
    return watch.start();
  };
  const run = (name: string, argv: string[], labels: Record<string, string> = SEAT) =>
    core.client.call<HcTerminal>("terminal.run", { argv, name, labels, ...RUN });
  const connected = () => notices.filter((n) => n.kind === "connected").length;

  it("pins this build's hc version, and the core answering is that version", async () => {
    expect((await probeCore(core.socketPath))).toMatchObject({ state: "present", hello: { version: HC_PINNED_VERSION, generation: 1 } });
    await expect(startWatch({ pin: { versions: ["0.0.0"] } })).rejects.toMatchObject({ kind: "unsupported_version" });
    expect(watch!.state()).toBe("refused");
  });

  it("follows a real terminal through created, status, turn, title, labels and finished, and agrees with terminal.get", async () => {
    await startWatch();
    await run("s-w", ["sh", "-c", "printf '\\033]7501;state=working:app=stub\\033\\\\'; sleep 1; printf '\\033]7501;state=done:app=stub\\033\\\\'; printf '\\033]2;mytitle\\007'; exec sleep 300"]);
    await until(() => watch!.view().terminals.get("t1"), (t) => t?.turn === 1 && t.status?.state === "done", "the turn to be completed in the view");
    await core.client.call("terminal.label", { terminal: "s-w", labels: { extra: "1" } });
    await until(() => watch!.view().terminals.get("t1")?.labels, (l) => l?.extra === "1", "the label event");
    await until(() => watch!.view(), (v) => v.stale.size === 0 && v.terminals.get("t1")?.title === "mytitle", "the title, re-read after an event the reducer does not model");
    const truth = await core.client.call<HcViewTerminal>("terminal.get", { terminal: "t1" });
    const seen = watch!.view().terminals.get("t1")!;
    for (const key of ["labels", "turn", "status", "state", "pid", "title", "screen", "name"] as const) expect(seen[key], key).toEqual(truth[key]);
    await core.client.call("terminal.kill", { terminal: "t1" });
    await until(() => watch!.view().terminals.get("t1"), (t) => t?.state === "finished", "the finish");
    expect(notices).toContainEqual({ kind: "finished", address: "t1", reason: "killed", seat: "w@rig" });
    expect(watch!.view().terminals.get("t1")).toMatchObject({ reason: "killed", exit_code: null, signal: 1 });
  });

  it("reconnects after `hc server restart`: programs live, the same core, a fresh snapshot with seq from zero", async () => {
    const seat = await run("s-w", ["sleep", "300"]);
    await startWatch();
    await core.client.call("terminal.label", { terminal: "s-w", labels: { a: "1" } });
    await until(() => watch!.view().seq, (seq) => seq >= 1, "an event on the first connection");
    const coreId = watch!.pinnedCoreId();
    core.restart();
    await until(() => connected(), (n) => n >= 2, "the second connection");
    expect(notices).toContainEqual(expect.objectContaining({ kind: "disconnected" }));
    expect(starts).toBe(0);
    const after = watch!.view().terminals.get(seat.address)!;
    expect(after).toMatchObject({ state: "live", pid: seat.pid, screen: "exact" });
    expect(watch!.view().seq).toBe(0);
    expect(watch!.pinnedCoreId()).toBe(coreId);
    await core.client.call("terminal.label", { terminal: "s-w", labels: { b: "2" } });
    await until(() => watch!.view().terminals.get(seat.address)?.labels, (l) => l?.b === "2", "an event on the new connection");
  });

  it.skipIf(!linux)("reads a SIGKILLed core as a stale socket that nothing restarts, then starts it and re-verifies it: programs live, screen inexact", async () => {
    const seat = await run("s-w", ["sleep", "300"]);
    const before = await probeCore(core.socketPath);
    const pid = await core.corePid();
    expect(core.isMine(pid)).toBe(true);
    process.kill(pid, "SIGKILL");
    await until(() => probeCore(core.socketPath), (p) => p.state === "stale_socket", "ECONNREFUSED with the socket file left behind");
    expect(existsSync(core.socketPath)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect((await probeCore(core.socketPath)).state).toBe("stale_socket");  // nothing restarted it
    await startCoreWithCli({ env: core.env })();
    const after = await probeCore(core.socketPath);
    expect(after).toMatchObject({ state: "present", hello: { generation: 1, core: { id: before.state === "present" ? before.hello.core.id : "?" } } });
    const terminal = await core.client.call<HcTerminal>("terminal.get", { terminal: seat.address });
    expect(terminal).toMatchObject({ state: "live", pid: seat.pid, screen: "inexact" });
  });

  it.skipIf(!linux)("starts a killed core itself, only when its socket is stale, and notes screen: inexact", async () => {
    const seat = await run("s-w", ["sleep", "300"]);
    await startWatch();
    const pid = await core.corePid();
    expect(core.isMine(pid)).toBe(true);
    process.kill(pid, "SIGKILL");
    await until(() => connected(), (n) => n >= 2, "the second connection, after the watch started the core");
    expect(starts).toBe(1);
    expect(notices).toContainEqual({ kind: "core_started" });
    expect(notices).toContainEqual({ kind: "screen_inexact", address: seat.address });
    expect(watch!.view().terminals.get(seat.address)).toMatchObject({ state: "live", pid: seat.pid, screen: "inexact" });
  });

  it.skipIf(!linux)("reads holder loss as a lost seat with hc's reason, and the lifecycle agrees", async () => {
    const seat = await run(hcTerminalName("w@rig"), ["sleep", "300"]);
    await startWatch();
    await expect(new HcLifecycle(core.client).isPaneDead("w@rig")).resolves.toBe(false);
    const holder = await core.holderPid();
    expect(core.isMine(holder)).toBe(true);
    process.kill(holder, "SIGKILL");
    const lost = await until(() => watch!.view().terminals.get(seat.address), (t) => t?.state === "finished", "holder loss in the view", 20000);
    expect(lost).toMatchObject({ reason: "holder_lost" });
    expect(lossReason(lost!)).toBe("holder_lost");
    expect(notices).toContainEqual({ kind: "finished", address: seat.address, reason: "holder_lost", seat: "w@rig" });
    expect(starts).toBe(0);  // the core itself never went down
    await expect(new HcLifecycle(core.client).isPaneDead("w@rig")).resolves.toBe(true);
    expect((await core.client.call<HcTerminal>("terminal.get", { terminal: seat.address })).reason).toBe("holder_lost");
  });

  it.skipIf(!linux)("reads a stopped core's silence as a dead stream, never starts a second core beside it, and recovers when it runs again", async () => {
    await run("s-w", ["sleep", "300"]);
    await startWatch({ heartbeatTimeoutMs: 18_000, helloTimeoutMs: 1000 });
    const pid = await core.corePid();
    expect(core.isMine(pid)).toBe(true);
    process.kill(pid, "SIGSTOP");
    stopped.push(pid);
    await until(() => notices.some((n) => n.kind === "stream_dead"), (dead) => dead, "heartbeat loss", 30_000);
    expect((await probeCore(core.socketPath, { helloTimeoutMs: 300 })).state).toBe("unresponsive");
    process.kill(pid, "SIGCONT");
    await until(() => connected(), (n) => n >= 2, "the stream after the core runs again", 15_000);
    expect(starts).toBe(0);
  }, 90_000);

  it("recovers from `missed`: a subscriber that falls behind gets a replacement snapshot, and later events still apply", async () => {
    const seat = await run("s-w", ["sleep", "300"]);
    await startWatch();
    await run("s-gone", ["sleep", "300"], { x: "1" });
    await until(() => watch!.view().terminals.size, (n) => n === 2, "the second terminal");
    watch!.pause();
    const big = "v".repeat(4000);
    for (let batch = 0; batch < 40; batch++) {
      await Promise.all(Array.from({ length: 50 }, (_, i) => core.client.call("terminal.label", { terminal: "s-w", labels: { churn: `${batch * 50 + i}${big}` } })));
    }
    await core.client.call("terminal.kill", { terminal: "s-gone" });
    await core.client.call("terminal.rm", { terminal: "s-gone" });
    await core.client.call("terminal.label", { terminal: "s-w", labels: { churn: "last" } });
    watch!.resume();
    await until(() => notices.some((n) => n.kind === "missed"), (m) => m, "the core's `missed`", 20_000);
    await until(() => watch!.view().terminals.get(seat.address)?.labels.churn, (c) => c === "last", "the last label value", 20_000);
    expect([...watch!.view().terminals.keys()]).toEqual([seat.address]);  // the terminal removed while behind is gone: replacement, not merge
    expect(watch!.view().seq).toBeGreaterThan(2000);
    await core.client.call("terminal.label", { terminal: "s-w", labels: { after: "1" } });
    await until(() => watch!.view().terminals.get(seat.address)?.labels.after, (a) => a === "1", "an event after the missed recovery");
  }, 90_000);
});
