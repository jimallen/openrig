// OF-241: one lifecycle operation, end to end, on a real daemon and a private hc core, observed for the identity reconciler (OF-235).
// The real createDaemon, its real routes, the real services and the real delivery guard; stubbed through DaemonOptions and the runtime registry and nothing else
// (the seat's runtime adapter, which types a stub program into the shell the real launcher made; the gate and hop of the handover). The child records, at the
// adapter boundary, whether the guard's lifecycle lease holds the seat when a terminal is ended (killSession), replaced (respawnPane) or made (createSession) and
// again when the call has returned, i.e. when the new terminal is labelled; and polls the daemon's own SeatIdentityReconciler (four times, from a context outside
// every lease, as the 5 s timer runs) inside each of those gaps. It writes one JSON report; lifecycle-ops.real.test.ts asserts on it.
// Env: LOD_OP (handover | fresh), LOD_DB, LOD_DIR, plus the private core's env (HC_SESSION, HOME, XDG_*) from the parent.
import { AsyncLocalStorage } from "node:async_hooks";
import { appendFileSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HcClient } from "../../src/adapters/hc-client.js";
import { hcTerminalName } from "../../src/adapters/hc-seat.js";
import { HcAdapter } from "../../src/adapters/hc-adapter.js";
import { StubRuntimeAdapter } from "../../src/adapters/stub-runtime-adapter.js";
import type { TmuxAdapter } from "../../src/adapters/tmux.js";
import type { NodeBinding } from "../../src/domain/runtime-adapter.js";
import { DEFAULT_SYSTEM_WORLD_MANIFEST } from "../../src/domain/system-world.js";
import { RigSpecCodec } from "../../src/domain/rigspec-codec.js";
import { RigRepository } from "../../src/domain/rig-repository.js";
import { SessionRegistry } from "../../src/domain/session-registry.js";
import { SeatIdentityStore } from "../../src/domain/seat-identity-store.js";
import { messageId, type GateLookup, type LastHop, type LastHopResult, type SeatGate } from "../../src/domain/seat-messaging/ports.js";
import { createDaemon } from "../../src/startup.js";

const { LOD_OP: op, LOD_DB: dbPath, LOD_DIR: dir } = process.env;
if (!op || !dbPath || !dir) throw new Error("LOD_OP, LOD_DB and LOD_DIR are required");
const POLLS = Number(process.env.LOD_POLLS ?? 4);
const SEATS = Number(process.env.LOD_SEATS ?? 2);   // restore op: how many seats the rig has
const SEAT_COMMAND = "exec sleep 3000";
const client = new HcClient();
const outside = AsyncLocalStorage.snapshot();   // taken before any lease: the polls run here, as the reconciler's timer does

type Event = Record<string, unknown>;
const events: Event[] = [];
const note = (event: Event) => { events.push(event); appendFileSync(join(dir, "events.log"), `${JSON.stringify(event)}\n`); };

const gate: SeatGate = {
  version: 1,
  async lookup(_seat, id): Promise<GateLookup> {
    const path = join(dir, "seen", id);
    return existsSync(path) ? { kind: "seen", record: { id: messageId(id), recordedAt: statSync(path).mtime.toISOString(), nonce: null } } : { kind: "not_seen" };
  },
};
let tmux!: TmuxAdapter;
const hop: LastHop = {
  attempt(message) {
    return tmux.deliveryGuard!.operation<LastHopResult>(message.seat, async () => {
      const id = message.ids[0];
      await client.call("terminal.send", { terminal: hcTerminalName(message.seat), text: `[openrig-msg id=${id}] ${message.body.replace(/\s+/g, " ")}\r` }, { timeoutMs: 8_000 });
      // The seat is a stub that does not run an agent: it records the id the way a gate would.
      appendFileSync(join(dir, "gate.log"), `${id}\n`);
      writeFileSync(join(dir, "seen", String(id)), "");
      return { kind: "sent" };
    }).catch((): LastHopResult => ({ kind: "paused", reason: "busy" }));
  },
};

const daemon = await createDaemon({ dbPath, seatMessagingPorts: { gateFor: () => gate, hopFor: () => hop }, messagePumpTiming: { tickMs: 40, backoffMs: [120_000] } });
tmux = daemon.deps.tmuxAdapter;
const db = daemon.db;
const guard = tmux.deliveryGuard!;
const reconciler = daemon.deps.seatIdentityReconciler!;
const verdicts = new SeatIdentityStore(db);
const rigs = new RigRepository(db);
const sessions = new SessionRegistry(db);

const nodeOfSeat = (name: string): string | null =>
  (db.prepare("SELECT n.id AS id FROM nodes n JOIN sessions s ON s.node_id = n.id WHERE s.session_name = ? ORDER BY s.created_at DESC LIMIT 1").get(name) as { id: string } | undefined)?.id ?? null;
const missing = () => (db.prepare("SELECT n.id AS id, s.session_name AS seat FROM nodes n JOIN sessions s ON s.node_id = n.id AND s.id = (SELECT s2.id FROM sessions s2 WHERE s2.node_id = n.id ORDER BY s2.id DESC LIMIT 1) WHERE s.status IN ('running','detached')").all() as Array<{ id: string; seat: string }>)
  .filter((row) => verdicts.getForNode(row.id)?.reason === "session_missing").map((row) => row.seat);
async function pollInGap(phase: string, seat: string) {
  for (let i = 0; i < POLLS; i++) { await outside(() => reconciler.reconcileAll()); note({ kind: "poll", phase, seat, missing: missing() }); }
}

type Labels = Record<string, string>;
/** The node a terminal belongs to, from the labels the launch wrote (its OPENRIG_NODE_ID identity label), else from the seat's session row. */
const nodeOfLabels = (labels: Labels): string | null => {
  const entry = Object.entries(labels).find(([key, value]) => key.endsWith("OPENRIG_NODE_ID") && value !== "1");
  return entry?.[1] ?? (labels["openrig.seat"] ? nodeOfSeat(labels["openrig.seat"]) : null);
};
const held = (nodeId: string | null) => nodeId !== null && guard.lifecycleHeld(nodeId);

// Record at the core's own calls, the one place every kill, respawn and creation passes through (HcLifecycle.kill, respawnUnchecked, HcHost.createSession):
//   terminal.kill -> the seat's terminal is gone: note whether the lease holds the seat, then poll four times in the absence (a respawn runs the new program only after this
//                    returns, so these polls are inside the respawn's own gap);
//   terminal.run  -> a terminal is made and labelled: note whether the lease holds the seat when the call has returned.
if (!(tmux instanceof HcAdapter)) throw new Error("the daemon's seat host is not hc");
const hcClient = tmux.client;
const originalCall = hcClient.call.bind(hcClient);
const patchedCall = async (method: string, params?: Record<string, unknown>, options?: { timeoutMs?: number }): Promise<unknown> => {
  if (process.env.LOD_TRACE && /terminal\.(kill|run|get|list|signal|hangup)/.test(method)) note({ kind: "trace", method, terminal: params?.["terminal"] });
  if (method === "terminal.kill") {
    const before = await originalCall<{ labels: Labels }>("terminal.get", { terminal: params?.["terminal"] }).catch(() => null);
    const node = before ? nodeOfLabels(before.labels) : null;
    const seat = before?.labels["openrig.seat"] ?? String(params?.["terminal"]);
    const result = await originalCall(method, params, options);
    note({ kind: "terminal.kill", seat, heldAfterKill: held(node) });
    await pollInGap("terminal.kill", seat);
    return result;
  }
  const labelsOfRun = method === "terminal.run" ? (params?.["labels"] as Labels | undefined) : undefined;
  const runSeat = labelsOfRun?.["openrig.seat"];
  const runNode = runSeat ? ((params!["env"] as Record<string, string> | undefined)?.["OPENRIG_NODE_ID"] ?? nodeOfLabels(labelsOfRun!)) : null;
  // The seat's terminal is about to be made: it is absent now (killed, ended, or never made), and the seat's row may already say running. Poll in that gap.
  if (runSeat) { note({ kind: "terminal.run-begin", seat: runSeat, heldBeforeRun: held(runNode) }); await pollInGap("pre-run", runSeat); }
  const result = await originalCall(method, params, options);
  if (runSeat) note({ kind: "terminal.run", seat: runSeat, heldWhenLabelled: held(runNode) });
  return result;
};
Object.defineProperty(hcClient, "call", { value: patchedCall, configurable: true, writable: true });

// A respawn of a terminal whose program already ended (the handover's successor launcher stops the retiree by signal and waits for it, then respawns) calls no
// terminal.kill; the gap is between the program's end and the new terminal, and the pre-run poll above is inside it. Note the lease at the respawn's start.
const respawnOriginal = tmux.respawnPane.bind(tmux);
Object.defineProperty(tmux, "respawnPane", {
  configurable: true, writable: true,
  value: async (...args: Parameters<HcAdapter["respawnPane"]>) => {
    const target = String(args[0]);
    const before = await originalCall<{ labels: Labels; state: string }>("terminal.get", { terminal: target }).catch(() => null);
    const seat = before?.labels["openrig.seat"] ?? target;
    note({ kind: "respawn-begin", seat, state: before?.state ?? null, held: held(before ? nodeOfLabels(before.labels) : null) });
    return respawnOriginal(...args);
  },
});

let failLaunch = false;   // the instantiate op: every member's harness fails to start, so the launch of the whole rig fails and its cleanup runs
const adapter = Object.assign(new StubRuntimeAdapter({ tmux }), {
  async launchHarness(binding: NodeBinding) {
    if (failLaunch) return { ok: false as const, error: "OF-241: the stub harness refuses to start" };
    const typed = await tmux.sendShellCommand(binding.tmuxSession!, SEAT_COMMAND);
    return typed.ok ? { ok: true as const } : { ok: false as const, error: typed.message };
  },
  async checkReady() { return { ready: true }; },
});
daemon.deps.runtimeAdapters!.stub = adapter;

/** A running seat of runtime stub with a live terminal, bound the way an hc launch binds it. */
async function seedSeat(rigName: string, logical: string, seat: string) {
  const rig = rigs.createRig(rigName);
  const node = rigs.addNode(rig.id, logical, { role: "worker", runtime: "stub", cwd: dir });
  const session = sessions.registerSession(node.id, seat);
  sessions.updateStatus(session.id, "running");
  sessions.updateStartupStatus(session.id, "ready", "2026-11-01T12:00:00Z");
  await client.call("terminal.run", { argv: ["/bin/sh", "-c", SEAT_COMMAND], name: hcTerminalName(seat), labels: { "openrig.seat": seat }, no_parent: true, no_notify: true, outlive_parent: true, cwd: dir });
  const [pane] = await tmux.listPanes(seat);
  sessions.updateBinding(node.id, { attachmentType: "hc", tmuxSession: seat, terminalAddress: pane!.id });
  sessions.mintOccupantTenure(node.id, "fresh");
  db.prepare("INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, '[]', '[]', '[]', 'stub')").run(node.id);
  return { rig, node, session };
}

async function seedSibling(rigId: string, logical: string, seat: string) {
  const node = rigs.addNode(rigId, logical, { role: "worker", runtime: "stub", cwd: dir });
  const session = sessions.registerSession(node.id, seat);
  sessions.updateStatus(session.id, "running");
  sessions.updateStartupStatus(session.id, "ready", "2026-11-01T12:00:00Z");
  await client.call("terminal.run", { argv: ["/bin/sh", "-c", SEAT_COMMAND], name: hcTerminalName(seat), labels: { "openrig.seat": seat }, no_parent: true, no_notify: true, outlive_parent: true, cwd: dir });
  const [pane] = await tmux.listPanes(seat);
  sessions.updateBinding(node.id, { attachmentType: "hc", tmuxSession: seat, terminalAddress: pane!.id });
  sessions.mintOccupantTenure(node.id, "fresh");
  db.prepare("INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, '[]', '[]', '[]', 'stub')").run(node.id);
  return { node, session };
}

const post = async (path: string, body: unknown) => {
  const response = await daemon.app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json().catch(() => null) as unknown };
};

let seatName = "";
let controlNode = "";   // the node whose seat the control crashes after the operation
let result: unknown = null;
try {
  if (op === "handover") {
    seatName = "dev@lod-handover";
    controlNode = (await seedSeat("lod-handover", "dev", seatName)).node.id;
    await outside(() => reconciler.reconcileAll());
    result = await post(`/api/seat/handover/${encodeURIComponent(seatName)}`, { reason: "OF-241", source: "fresh", operator: "lead@system" });
  } else if (op === "fresh") {
    seatName = "dev-impl@lod-fresh";
    controlNode = (await seedSeat("lod-fresh", "dev.impl", seatName)).node.id;
    await outside(() => reconciler.reconcileAll());
    result = await post(`/api/seat/launch/${encodeURIComponent(seatName)}`, { fresh: true, stop: true, reason: "OF-241", operator: "lead@system", startupFrom: "stored" });
  } else if (op === "restore") {
    // rig down (snapshot, kill every terminal), then rig up --existing (restore from that snapshot): SEATS seats, all started fresh from their stored startup files
    // (the stub keeps no conversation to resume). The wall time of each step is noted: it is what a multi-seat restore holds its leases for, without a real agent's start-up.
    const nodes: Array<{ id: string; logical: string }> = [];
    const first = await seedSeat("lod-restore", "dev.s0", "dev-s0@lod-restore");
    seatName = "dev-s0@lod-restore"; controlNode = first.node.id; nodes.push({ id: first.node.id, logical: "dev.s0" });
    for (let i = 1; i < SEATS; i++) { const sibling = await seedSibling(first.rig.id, `dev.s${i}`, `dev-s${i}@lod-restore`); nodes.push({ id: sibling.node.id, logical: `dev.s${i}` }); }
    await outside(() => reconciler.reconcileAll());
    const t0 = performance.now();
    const down = await post("/api/down", { rigId: first.rig.id, snapshot: true });
    const t1 = performance.now();
    note({ kind: "down", status: down.status, ms: Math.round(t1 - t0) });
    // The longest a lifecycle lease is seen held while the restore runs, from this process's own view of the lease table.
    let heldSince: number | null = null; let longestHeldMs = 0; let maxHeldSeats = 0;
    const watch = setInterval(() => {
      const count = guard.lifecycleHeldCount();
      maxHeldSeats = Math.max(maxHeldSeats, count);
      if (count > 0 && heldSince === null) heldSince = performance.now();
      if (count === 0 && heldSince !== null) { longestHeldMs = Math.max(longestHeldMs, performance.now() - heldSince); heldSince = null; }
    }, 20);
    const up = await post("/api/up", { sourceRef: "lod-restore", freshLogicalIds: nodes.map((n) => n.logical), startupFrom: "stored" });
    const t2 = performance.now();
    note({ kind: "up", status: up.status, ms: Math.round(t2 - t1), body: JSON.stringify(up.body).slice(0, 300) });
    for (let i = 0; i < 240; i++) {
      const running = nodes.every((n) => (db.prepare("SELECT status FROM sessions WHERE node_id = ? ORDER BY id DESC LIMIT 1").get(n.id) as { status: string } | undefined)?.status === "running");
      if (running) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    clearInterval(watch);
    if (heldSince !== null) longestHeldMs = Math.max(longestHeldMs, performance.now() - heldSince);
    note({ kind: "restore-timing", seats: SEATS, downMs: Math.round(t1 - t0), upMs: Math.round(t2 - t1), allRunningMs: Math.round(performance.now() - t1), longestLeaseHeldMs: Math.round(longestHeldMs), maxLeasesHeld: maxHeldSeats });
    result = { down, up };
  } else if (op === "relaunch") {
    // rig seat stop, then rig node launch: the seat's terminal is ended by the stop and made again by the node launch.
    seatName = "dev-a@lod-relaunch";
    const a = await seedSeat("lod-relaunch", "dev.a", seatName);
    controlNode = a.node.id;
    await outside(() => reconciler.reconcileAll());
    const stop = await post(`/api/seat/stop/${encodeURIComponent(seatName)}`, { reason: "OF-241", operator: "lead@system" });
    note({ kind: "stop", status: stop.status });
    result = await post(`/api/rigs/${a.rig.id}/nodes/${encodeURIComponent("dev.a")}/launch`, {});
  } else if (op === "instantiate") {
    // A rig of one member whose harness fails to start: every member fails, and the instantiator's cleanup ends the terminals it launched and deletes the rig.
    // The control seat is another rig's, untouched by it.
    seatName = "dev-ctl@lod-inst-ctl";
    controlNode = (await seedSeat("lod-inst-ctl", "dev.ctl", seatName)).node.id;
    await outside(() => reconciler.reconcileAll());
    mkdirSync(join(dir, "agents", "impl"), { recursive: true });
    writeFileSync(join(dir, "agents", "impl", "agent.yaml"), 'name: impl\nversion: "1.0.0"\nresources:\n  skills: []\nprofiles:\n  default:\n    uses:\n      skills: []\n');
    const yaml = RigSpecCodec.serialize({ version: "0.2", name: "lod-inst", pods: [{ id: "dev", label: "Dev", members: [{ id: "impl", agentRef: "local:agents/impl", profile: "default", runtime: "stub", cwd: dir }], edges: [] }], edges: [] });
    // A launched member resolves the System World; a fresh OPENRIG_HOME has none.
    mkdirSync(join(process.env.OPENRIG_HOME!, "context", "system"), { recursive: true });
    writeFileSync(join(process.env.OPENRIG_HOME!, "context", "system", "system-world.yaml"), DEFAULT_SYSTEM_WORLD_MANIFEST);
    failLaunch = true;
    const instantiated = await daemon.deps.podInstantiator.instantiate(yaml, dir);
    failLaunch = false;
    result = { status: instantiated.ok ? 200 : 500, body: JSON.parse(JSON.stringify(instantiated)) };
    note({ kind: "instantiate", ok: instantiated.ok, detail: JSON.stringify(instantiated).slice(0, 1500) });
  } else throw new Error(`unknown LOD_OP ${op}`);
  // The control, after the operation (the lease is released): a crash outside any lease reports, on the second poll and not the first. The seat is the node's
  // current one: a restore or a node launch may name the new session differently.
  seatName = (db.prepare("SELECT session_name FROM sessions WHERE node_id = ? ORDER BY id DESC LIMIT 1").get(controlNode) as { session_name: string }).session_name;
  const after = nodeOfSeat(seatName);
  note({ kind: "after-op", heldAfterOp: after !== null && guard.lifecycleHeld(after), missing: missing(), rows: process.env.LOD_TRACE ? db.prepare("SELECT session_name, status, startup_status FROM sessions ORDER BY id").all() : undefined });
  await client.call("terminal.kill", { terminal: hcTerminalName(seatName) }).catch((error) => note({ kind: "control-kill-failed", error: String(error) }));
  await outside(() => reconciler.reconcileAll()); note({ kind: "control-poll", n: 1, missing: missing() });
  await outside(() => reconciler.reconcileAll()); note({ kind: "control-poll", n: 2, missing: missing() });
} catch (error) {
  note({ kind: "child-error", error: String((error as Error)?.stack ?? error) });
}
writeFileSync(join(dir, "report.json"), JSON.stringify({ op, seat: seatName, result, events }));
process.exit(0);
