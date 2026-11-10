// OF-287 — a rig whose seats' terminals are all gone must not block `rig up` as RUNNING.
//
// The specimen (stu, 2026-11-10 14:22Z, rig cel-identity): the CoS was /exit-ed and the other seven hc terminals were
// killed. `rig ps --nodes` showed every seat `detached` ("session missing") because the SeatIdentityReconciler had
// recorded a confirmed `session_missing` verdict for each, but every sessions row still read status='running'. The
// running-name guard counted those rows, so `rig up` (rig-here) failed with rig_name_running and could not resume the
// rig; only `rig down` (0 sessions killed) cleared it.
//
// The guard now counts a running row only when the daemon has not confirmed its terminal gone. These tests pin both
// halves of that rule: confirmed absence stops blocking, and anything short of confirmed absence (no verdict, a
// "could not look" verdict, a verdict about another pane or an earlier occupant, one live seat among dead ones)
// keeps blocking, so a second rig is never minted over a seat that may be alive.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { checkRunningNameGuard, makeRunningSessionCounter, lifecycleHeldOf } from "../src/domain/running-name-guard.js";
import { bundleInstallContext } from "../src/domain/bundle-install-context.js";
import { PsProjectionService } from "../src/domain/ps-projection.js";
import { SeatIdentityStore } from "../src/domain/seat-identity-store.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SeatDeliveryGuard, resolveGuardTarget } from "../src/domain/seat-delivery-guard.js";
import type { SeatIdentityVerdict } from "../src/domain/types.js";

const SEATS = ["exec.cos", "build.arch", "build.impl", "build.ux", "verify.ops", "verify.qa", "verify.screen", "verify.sec"];
const RIG = "cel-identity";
const POD_YAML = [
  'version: "0.2"', `name: ${RIG}`, "pods:", "  - id: crew", "    label: Crew", "    members:", "      - id: a",
  '        agent_ref: "builtin:terminal"', '        profile: "none"', "        runtime: terminal", "        cwd: /",
  "    edges: []", "edges: []",
].join("\n");

type Kind = "missing" | "verified" | "unavailable" | "none" | "other_pane" | "before_session";

/** The daemon's real delivery guard over the test db, with the lease reader replaced (the one member the create paths read). */
const leaseGuard = (db: Database.Database, held: (nodeId: string) => boolean) => {
  const guard = new SeatDeliveryGuard(db, (name) => resolveGuardTarget(db, name));
  vi.spyOn(guard, "lifecycleHeld").mockImplementation(held);
  return guard;
};

describe("OF-287 running-name guard honours confirmed-gone terminals", () => {
  let db: Database.Database;
  let setup: ReturnType<typeof createTestApp>;
  let rigId: string;
  const nodeIds: string[] = [];

  /** An 8-seat hc rig whose sessions rows all read status='running' (as the specimen did), with each seat's verdict as given. */
  function seed(kinds: Kind[], name = RIG): string {
    const repo = new RigRepository(db);
    const rig = repo.createRig(name);
    kinds.forEach((kind, i) => {
      const logical = SEATS[i]!;
      const sessionName = `${logical.replace(".", "-")}@${name}`;
      const nodeId = `n-${name}-${i}`;
      const pane = `t${30 + i}`;
      db.prepare("INSERT INTO nodes (id, rig_id, logical_id, runtime, cwd) VALUES (?, ?, ?, 'claude-code', '/tmp')").run(nodeId, rig.id, logical);
      db.prepare("INSERT INTO sessions (id, node_id, session_name, status, created_at) VALUES (?, ?, ?, 'running', '2026-11-10 12:00:00')")
        .run(`s-${name}-${i}`, nodeId, sessionName);
      db.prepare("INSERT INTO bindings (id, node_id, attachment_type, tmux_session, terminal_address) VALUES (?, ?, 'hc', ?, ?)")
        .run(`b-${name}-${i}`, nodeId, sessionName, pane);
      nodeIds.push(nodeId);
      if (kind === "none") return;
      const base = { nodeId, sessionName, observedAt: "2026-11-10T14:23:00.000Z" };
      const evidence = (registeredPane: string) => ({ registeredPane, observedPid: null, observedCommand: null, matchedLayer: null });
      let verdict: SeatIdentityVerdict;
      if (kind === "missing") verdict = { ...base, verdict: "pane_missing", evidenceSource: "tmux_session", reason: "session_missing", evidence: evidence(pane) };
      else if (kind === "other_pane") verdict = { ...base, verdict: "pane_missing", evidenceSource: "tmux_session", reason: "session_missing", evidence: evidence("t999") };
      else if (kind === "before_session") verdict = { ...base, observedAt: "2026-11-10T11:00:00.000Z", verdict: "pane_missing", evidenceSource: "tmux_session", reason: "session_missing", evidence: evidence(pane) };
      else if (kind === "unavailable") verdict = { ...base, verdict: "tmux_unavailable", evidenceSource: null, reason: "tmux_unavailable", evidence: evidence(pane) };
      else verdict = { ...base, verdict: "verified", evidenceSource: "pane_process", reason: null, evidence: evidence(pane) };
      new SeatIdentityStore(db).upsert(verdict);
    });
    return rig.id;
  }

  const guard = () => checkRunningNameGuard({
    findRigsByName: (n) => new RigRepository(db).findRigsByName(n),
    countRunningSessions: makeRunningSessionCounter(db),
  }, RIG);

  beforeEach(() => { db = createFullTestDb(); setup = createTestApp(db); nodeIds.length = 0; });
  afterEach(() => { db.close(); });

  it("all eight seats confirmed gone: the guard passes, the rig reads stopped in ps and in the bundle install context", () => {
    rigId = seed(Array(8).fill("missing"));
    expect(makeRunningSessionCounter(db)(rigId)).toBe(0);
    expect(guard()).toEqual({ ok: true });
    // ps already honoured the verdict (Slice-05 D5); pinned here so the two readings cannot drift apart again.
    const entry = new PsProjectionService({ db }).getEntries().find((e) => e.rigId === rigId)!;
    expect(entry.status).toBe("stopped");
    expect(entry.runningCount).toBe(0);
    expect(bundleInstallContext(db, RIG, { name: RIG, version: null, source: "x" }).existing[0]!.state).toBe("stopped");
    // The rows themselves are untouched: the guard reads the verdict, it never rewrites sessions.status.
    expect((db.prepare("SELECT COUNT(*) AS c FROM sessions WHERE status = 'running'").get() as { c: number }).c).toBe(8);
  });

  // Jim's decision (2026-11-10): the plain `rig up <spec>` must not archive a rig whose terminals died and start fresh
  // conversations beside it. It refuses, names both ways forward, and changes nothing.
  it("pod YAML instantiate on an all-gone rig REFUSES with the exact message; nothing is created, archived or launched", async () => {
    rigId = seed(Array(8).fill("missing"));
    const result = await setup.podInstantiator.instantiate(POD_YAML, "/tmp");
    expect(result).toEqual({
      ok: false,
      code: "generation_unconfirmed",
      message: `A rig named "${RIG}" already exists (${rigId}), and all of its seats have lost their terminals. `
        + `Nothing was created and it was not archived. Resume it on its own conversations with 'rig up ${RIG} --existing', `
        + `or archive it first with 'rig archive ${rigId}' to start fresh.`,
    });
    expect((db.prepare("SELECT COUNT(*) AS c FROM rigs WHERE name = ?").get(RIG) as { c: number }).c).toBe(1);
    expect((db.prepare("SELECT archived_at FROM rigs WHERE id = ?").get(rigId) as { archived_at: string | null }).archived_at).toBeNull();
    expect(setup.tmuxAdapter.createSession).not.toHaveBeenCalled();
  });

  it("the explicit choice to start fresh (replaceGoneGeneration) archives the all-gone rig and launches the replacement", async () => {
    rigId = seed(Array(8).fill("missing"));
    setup.tmuxAdapter.probeSession = vi.fn(async () => ({ state: "absent" as const }));
    const result = await setup.podInstantiator.instantiate(POD_YAML, "/tmp", { replaceGoneGeneration: true });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect((db.prepare("SELECT archived_at FROM rigs WHERE id = ?").get(rigId) as { archived_at: string | null }).archived_at).not.toBeNull();
  });

  it("the refusal's own advice on the plain-spec path, followed literally: 'rig archive <id>' then rig up again starts fresh", async () => {
    rigId = seed(Array(8).fill("missing"));
    setup.tmuxAdapter.probeSession = vi.fn(async () => ({ state: "absent" as const }));
    const refused = await setup.podInstantiator.instantiate(POD_YAML, "/tmp");
    expect(refused).toMatchObject({ ok: false, code: "generation_unconfirmed" });
    expect(new RigRepository(db).archiveRig(rigId)).toBe(true);
    const again = await setup.podInstantiator.instantiate(POD_YAML, "/tmp");
    expect(again.ok, JSON.stringify(again)).toBe(true);
    expect(new RigRepository(db).findUnarchivedRigsByName(RIG).map((r) => r.id)).not.toContain(rigId);
  });

  it("a rig that was STOPPED (no running row) is still replaced on YAML import, as before (#196)", async () => {
    const stopped = new RigRepository(db).createRig(RIG);
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id, runtime, cwd) VALUES ('n-st', ?, 'crew.a', 'terminal', '/tmp')").run(stopped.id);
    db.prepare("INSERT INTO sessions (id, node_id, session_name, status, created_at) VALUES ('s-st', 'n-st', 'crew-a@x', 'exited', '2026-11-10 12:00:00')").run();
    setup.tmuxAdapter.probeSession = vi.fn(async () => ({ state: "absent" as const }));
    const result = await setup.podInstantiator.instantiate(POD_YAML, "/tmp");
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect((db.prepare("SELECT archived_at FROM rigs WHERE id = ?").get(stopped.id) as { archived_at: string | null }).archived_at).not.toBeNull();
  });

  // F1 (review): a verdict can be written on one observation (send/capture, rebind) while a relaunch, handover or restore
  // holds the seat between its old terminal and its successor. A held node keeps counting.
  it("a node whose lifecycle lease is held keeps counting, however applicable its session_missing verdict", () => {
    rigId = seed(Array(8).fill("missing"));
    const held = new Set([nodeIds[3]!]);
    expect(makeRunningSessionCounter(db, (id) => held.has(id))(rigId)).toBe(1);
    const verdict = checkRunningNameGuard({
      findRigsByName: (n) => new RigRepository(db).findRigsByName(n),
      countRunningSessions: makeRunningSessionCounter(db, (id) => held.has(id)),
    }, RIG);
    expect(verdict.ok).toBe(false);
    held.clear();
    expect(makeRunningSessionCounter(db, (id) => held.has(id))(rigId)).toBe(0);
    // The adapter-side reader: a guard that holds the node counts it; an adapter with no guard excuses nothing extra.
    expect(lifecycleHeldOf(undefined)).toBeUndefined();
    expect(lifecycleHeldOf({ deliveryGuard: { lifecycleHeld: (id) => id === nodeIds[0] } })!(nodeIds[0]!)).toBe(true);
  });

  it("the guard's pod-YAML create path reads the lease: a held seat keeps the rig RUNNING (rig_name_running)", async () => {
    rigId = seed(Array(8).fill("missing"));
    setup.tmuxAdapter.deliveryGuard = leaseGuard(db, (id) => id === nodeIds[2]);
    const result = await setup.podInstantiator.instantiate(POD_YAML, "/tmp");
    expect((result as { code?: string }).code).toBe("rig_name_running");
    expect((result as { runningRig: { runningSessionCount: number } }).runningRig.runningSessionCount).toBe(1);
  });

  it("the materialize-only create path reads the lease too", async () => {
    rigId = seed(Array(8).fill("missing"));
    setup.tmuxAdapter.deliveryGuard = leaseGuard(db, (id) => id === nodeIds[5]);
    const podSpec = { version: "0.2", name: RIG, pods: [{ id: "crew", label: "Crew", members: [{ id: "a", agentRef: "builtin:terminal", profile: "none", runtime: "terminal", cwd: "/" }], edges: [] }], edges: [] };
    const materialized = await setup.podInstantiator.materializeValidatedSpec(podSpec as never, "/tmp", []);
    expect((materialized as { code?: string }).code).toBe("rig_name_running");
  });

  // Review F1/F2: explicit fresh skips the refusal by design, so the lease checks AFTER the guard are what stop it. A lease that
  // begins after the guard has passed (a restore or relaunch starting now) must stop the archive at each of them.
  function leaseFromHere() {
    let held = false;
    setup.tmuxAdapter.deliveryGuard = leaseGuard(db, (id) => held && id === nodeIds[4]);
    return { begin: () => { held = true; } };
  }

  it("a lease that begins while the stopped-generation check waits on the terminal host stops the archive (in-transaction recount)", async () => {
    rigId = seed(Array(8).fill("missing"));
    const lease = leaseFromHere();
    setup.tmuxAdapter.probeSession = vi.fn(async () => { lease.begin(); return { state: "absent" as const }; });
    const result = await setup.podInstantiator.instantiate(POD_YAML, "/tmp", { replaceGoneGeneration: true });
    expect(result).toMatchObject({ ok: false, code: "generation_unconfirmed" });
    expect((db.prepare("SELECT archived_at FROM rigs WHERE id = ?").get(rigId) as { archived_at: string | null }).archived_at).toBeNull();
    expect((db.prepare("SELECT COUNT(*) AS c FROM rigs WHERE name = ?").get(RIG) as { c: number }).c).toBe(1);
  });

  it("a lease that begins after the guard but before the stopped-generation check is caught there, with its own reason", async () => {
    rigId = seed(Array(8).fill("missing"));
    const lease = leaseFromHere();
    const probe = vi.fn(async () => ({ state: "absent" as const }));
    setup.tmuxAdapter.probeSession = probe;
    // The same-name lookup that decides which generations the import may replace runs after the guard and before the
    // stopped-generation check: start the lease there.
    const lookup = setup.rigRepo.findUnarchivedRigsByName.bind(setup.rigRepo);
    vi.spyOn(setup.rigRepo, "findUnarchivedRigsByName").mockImplementation((name: string) => { lease.begin(); return lookup(name); });
    const result = await setup.podInstantiator.instantiate(POD_YAML, "/tmp", { replaceGoneGeneration: true });
    expect((result as { message?: string }).message).toContain("it has a running session");
    expect(probe).not.toHaveBeenCalled();
    expect((db.prepare("SELECT archived_at FROM rigs WHERE id = ?").get(rigId) as { archived_at: string | null }).archived_at).toBeNull();
  });

  // F3/F4 (review): the verdict describes only the node's newest session row.
  it("an older still-running row of a gone node is not excused (only the newest row is)", () => {
    rigId = seed(Array(8).fill("missing"));
    db.prepare("INSERT INTO sessions (id, node_id, session_name, status, created_at) VALUES ('s-old', ?, 'older-name@x', 'running', '2026-11-10 11:00:00')").run(nodeIds[0]!);
    // ids order the rows: 'a-old' sorts before the seeded 's-...' row, so the seeded row is the newest.
    db.prepare("UPDATE sessions SET id = 'a-old' WHERE id = 's-old'").run();
    expect(makeRunningSessionCounter(db)(rigId)).toBe(1);
  });

  it("a newest row that is not running excuses nothing: an older running row counts even with a session_missing verdict on file", () => {
    rigId = seed(Array(8).fill("missing"));
    db.prepare("UPDATE sessions SET status = 'exited' WHERE id = ?").run(`s-${RIG}-0`);
    db.prepare("INSERT INTO sessions (id, node_id, session_name, status, created_at) VALUES ('a-old', ?, 'older-name@x', 'running', '2026-11-10 11:00:00')").run(nodeIds[0]!);
    expect(makeRunningSessionCounter(db)(rigId)).toBe(1);
  });

  it("one seat still verified live among seven gone: still RUNNING, counting exactly the live seat", () => {
    rigId = seed(["missing", "missing", "missing", "verified", "missing", "missing", "missing", "missing"]);
    expect(makeRunningSessionCounter(db)(rigId)).toBe(1);
    const verdict = guard();
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.runningRig).toMatchObject({ id: rigId, runningSessionCount: 1 });
  });

  it.each<[string, Kind]>([
    ["no verdict recorded yet (daemon just restarted)", "none"],
    ["tmux_unavailable (hc or tmux could not be asked)", "unavailable"],
    ["a session_missing verdict about a different terminal than the one bound now", "other_pane"],
    ["a session_missing verdict observed before the current session was registered", "before_session"],
  ])("a seat the daemon cannot observe is NOT dead: %s", (_label, kind) => {
    rigId = seed(Array(8).fill(kind));
    expect(makeRunningSessionCounter(db)(rigId)).toBe(8);
    const verdict = guard();
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe("rig_name_running");
  });

  it("a mixed rig (seven confirmed gone, one unobservable) still blocks: the unobservable seat may be alive", () => {
    rigId = seed(["missing", "missing", "missing", "missing", "unavailable", "missing", "missing", "missing"]);
    expect(makeRunningSessionCounter(db)(rigId)).toBe(1);
    expect(guard().ok).toBe(false);
  });
});
