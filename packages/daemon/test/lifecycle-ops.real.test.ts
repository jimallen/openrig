// OF-241, closing OF-235's F4: the lifecycle leases of the operations that end or replace a seat's terminal, measured end to end rather than read from source text.
// Each row runs one real operation through its real route on a real daemon (createDaemon) and a private hc core, with the real delivery guard and the
// daemon's own SeatIdentityReconciler (helpers/lifecycle-ops-daemon.ts). Boundary: the seat's runtime is a stub that types `sleep` into the shell the real launcher
// made, and the handover's gate and hop are stubs; no real agent ran. The child records, at the adapter's killSession / respawnPane / createSession:
//   * whether the guard's lifecycle lease held the seat when the call began and again when it returned (the new terminal is labelled by then);
//   * what the reconciler said at four polls (more than the two OF-205 needs), made from outside every lease, inside the gap the call left;
// and, after the operation, the control: a terminal killed outside any lease reports on the second poll and not the first.
// Production entrypoint: routes/seat.ts, routes/snapshots.ts, routes/rigs.ts -> the lifecycle services startup.ts constructs; startup.ts wires the reconciler to the guard.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HC, PrivateCore } from "./hc-private-core.js";

const here = dirname(fileURLToPath(import.meta.url));
const CHILD = resolve(here, "helpers/lifecycle-ops-daemon.ts");

type Event = Record<string, unknown> & { kind: string };
interface Report { op: string; seat: string; result: { status: number; body: Record<string, unknown> } | null; events: Event[] }

describe.skipIf(!HC)("OF-241: lifecycle leases, end to end on a real daemon and a private hc core", () => {
  const core = new PrivateCore("lo");
  beforeAll(() => {
    expect(core.socketPath.startsWith(`${core.root}/`)).toBe(true);
    expect(Object.keys(core.env).filter((k) => k.startsWith("HC_") && k !== "HC_SESSION")).toEqual([]);
    core.start();
  });
  afterAll(() => core.stop());

  async function run(op: string, extraEnv?: NodeJS.ProcessEnv): Promise<Report> {
    const dir = mkdtempSync(join(core.root, `${op}-`));
    mkdirSync(join(dir, "seen"));
    const env: NodeJS.ProcessEnv = {
      ...core.env, PATH: `${dirname(HC)}:/usr/bin:/bin`, TMPDIR: join(core.root, "h"), OPENRIG_HOME: join(core.root, "h", "openrig"), OPENRIG_TRANSPORT_MESSAGE_PUMP: "true",
      LOD_OP: op, ...(extraEnv ?? {}), ...(process.env.LOD_TRACE ? { LOD_TRACE: "1" } : {}), LOD_DB: join(dir, "d.sqlite"), LOD_DIR: dir,
    };
    const stderr: string[] = [];
    const child = spawn(process.execPath, ["--import", "tsx", CHILD], { cwd: resolve(here, ".."), env, stdio: ["ignore", "ignore", "pipe"] });
    child.stderr?.on("data", (b: Buffer) => { stderr.push(b.toString()); if (stderr.length > 40) stderr.shift(); });
    const exited = new Promise<number | null>((done) => child.on("exit", (code) => done(code)));
    const code = await Promise.race([exited, new Promise<"timeout">((done) => setTimeout(() => done("timeout"), 100_000))]);
    if (code === "timeout") child.kill("SIGKILL");
    if (!existsSync(join(dir, "report.json"))) throw new Error(`no report (exit ${String(code)}): ${stderr.join("").slice(0, 800)} EVENTS ${existsSync(join(dir, "events.log")) ? readFileSync(join(dir, "events.log"), "utf8").slice(-3000) : "(none)"}`);
    return JSON.parse(readFileSync(join(dir, "report.json"), "utf8")) as Report;
  }

  const of = (r: Report, kind: string) => r.events.filter((e) => e.kind === kind);
  /** The lease held the seat from the kill of its terminal to the new terminal's label, and no poll in the absence read the seat missing. */
  function expectLeaseThroughout(r: Report, shape: { kills: number; runs: number; endedBeforeRespawn?: number }) {
    const kills = of(r, "terminal.kill"), runs = of(r, "terminal.run"), begins = of(r, "respawn-begin");
    expect(kills.length, `terminals the operation killed; events ${JSON.stringify(r.events)}`).toBe(shape.kills);
    expect(begins.filter((b) => b["state"] !== "live").length, "respawns of a terminal whose program had already ended").toBe(shape.endedBeforeRespawn ?? 0);
    for (const b of begins) expect(b["held"], `the lease held ${String(b["seat"])} when its respawn began`).toBe(true);
    expect(runs.length, `terminals the operation made and labelled; events ${JSON.stringify(r.events.filter((e) => e.kind !== "poll"))}`).toBe(shape.runs);
    for (const k of kills) expect(k["heldAfterKill"], `the lease held ${String(k["seat"])} when its terminal was gone`).toBe(true);
    for (const n of runs) expect(n["heldWhenLabelled"], `the lease held ${String(n["seat"])} when its new terminal was labelled`).toBe(true);
    const gap = of(r, "poll");
    expect(gap.length, "polls inside the absences (after each kill, before each new terminal)").toBe((shape.kills + shape.runs) * 4);
    expect(gap.flatMap((e) => e["missing"] as string[]), "seats reading session_missing inside an absence").toEqual([]);
  }
  function expectCrashOutsideLeaseReports(r: Report) {
    expect(of(r, "after-op")[0]).toMatchObject({ heldAfterOp: false });
    const [first, second] = of(r, "control-poll");
    expect(first!["missing"], "first poll after a crash outside any lease").toEqual([]);
    expect(second!["missing"], `second poll; events ${JSON.stringify(r.events.filter((e) => e.kind !== "poll"))}`).toEqual([r.seat]);
  }

  it("seat handover: the successor's respawn is under the lease, the gap is quiet, and a later crash reports", async () => {
    const r = await run("handover");
    expect(of(r, "child-error"), JSON.stringify(of(r, "child-error"))).toEqual([]);
    expect(r.result, JSON.stringify(r.result)).toMatchObject({ status: 200 });
    expectLeaseThroughout(r, { kills: 0, runs: 1, endedBeforeRespawn: 1 });
    expectCrashOutsideLeaseReports(r);
  }, 120_000);

  it("rig seat launch --fresh: the stop of the old occupant is under the lease, the gap is quiet, and a later crash reports", async () => {
    const r = await run("fresh");
    expect(of(r, "child-error"), JSON.stringify(of(r, "child-error"))).toEqual([]);
    expect(r.result, JSON.stringify(r.result)).toMatchObject({ status: 200 });
    expectLeaseThroughout(r, { kills: 1, runs: 1 });
    expectCrashOutsideLeaseReports(r);
  }, 120_000);

  it("rig down then rig up --existing (restore): both terminals are ended and made again under the lease, the gaps are quiet, and a later crash reports", async () => {
    const r = await run("restore");
    expect(of(r, "child-error"), JSON.stringify(of(r, "child-error"))).toEqual([]);
    expect(of(r, "down")[0], JSON.stringify(of(r, "down"))).toMatchObject({ status: 200 });
    expect(of(r, "up")[0], JSON.stringify(of(r, "up"))).toMatchObject({ status: expect.any(Number) });
    expectLeaseThroughout(r, { kills: 2, runs: 2 });
    expectCrashOutsideLeaseReports(r);
  }, 150_000);

  it("rig seat stop then rig node launch (relaunch): the stop and the launch are under the lease, the gaps are quiet, and a later crash reports", async () => {
    const r = await run("relaunch");
    expect(of(r, "child-error"), JSON.stringify(of(r, "child-error"))).toEqual([]);
    expect(of(r, "stop")[0], JSON.stringify(of(r, "stop"))).toMatchObject({ status: 200 });
    expect(r.result, JSON.stringify(r.result)).toMatchObject({ status: 201 });
    expectLeaseThroughout(r, { kills: 1, runs: 1 });
    expectCrashOutsideLeaseReports(r);
  }, 150_000);

  it("rig up of a rig whose every member fails to start (instantiate cleanup): the launched terminal is ended under the lease, the gap is quiet, and another rig's crash outside any lease reports", async () => {
    const r = await run("instantiate");
    expect(of(r, "child-error"), JSON.stringify(of(r, "child-error"))).toEqual([]);
    expect(of(r, "instantiate")[0], JSON.stringify(of(r, "instantiate"))).toMatchObject({ ok: false });
    expectLeaseThroughout(r, { kills: 1, runs: 1 });
    expectCrashOutsideLeaseReports(r);
  }, 150_000);

  it("rig import of a flat spec whose every member fails to launch (RigInstantiator cleanup): the lease holds the rig's nodes when the rig is deleted, no terminal is ended, and a crash outside any lease reports", async () => {
    const r = await run("legacy-instantiate");
    expect(of(r, "child-error"), JSON.stringify(of(r, "child-error"))).toEqual([]);
    expect(of(r, "legacy-instantiate")[0], JSON.stringify(of(r, "legacy-instantiate"))).toMatchObject({ ok: false });
    // The cleanup's kill loop is empty by construction (see the child): no terminal is ended or made, so there is no gap to poll. What the lease covers is the delete.
    expectLeaseThroughout(r, { kills: 0, runs: 0 });
    expect(of(r, "rig-delete"), `the rig is deleted once; events ${JSON.stringify(r.events.filter((e) => e.kind !== "poll"))}; with every one of its nodes held by the lease`).toEqual([{ kind: "rig-delete", nodes: 1, heldNodes: 1 }]);
    expectCrashOutsideLeaseReports(r);
  }, 150_000);

  // A measurement, not a pin (run with LOD_MEASURE_SEATS=27): how long a multi-seat restore of stub seats takes on a private core, and how long the lease is seen held.
  // The stub starts at once, so this is OpenRig's own work per seat without a real agent's start-up (the bound for that, STARTUP_TEXT_WAIT_MS, is per seat).
  it.skipIf(!process.env.LOD_MEASURE_SEATS)("measurement: rig down then restore of N stub seats, timed", async () => {
    const seats = Number(process.env.LOD_MEASURE_SEATS);
    const r = await run("restore", { LOD_SEATS: String(seats), LOD_POLLS: "0" });
    const timing = of(r, "restore-timing")[0]!;
    // eslint-disable-next-line no-console
    console.log(`LOD-MEASURE ${JSON.stringify(timing)}`);
    expect(of(r, "child-error")).toEqual([]);
    expect(timing["seats"]).toBe(seats);
  }, 600_000);
});
