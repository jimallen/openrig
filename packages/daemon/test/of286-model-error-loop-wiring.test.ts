// OF-286, the deployed chain. startup.ts hands PiRuntimeAdapter / OmpRuntimeAdapter to the three readers of the runner's `modelErrorLoop` flag: the node inventory
// and PsProjectionService (through AgentActivityStore), the `rig health` source, and the notifier that tells the rig's Chief of Staff; index.ts starts the notifier
// after bind and stops it on shutdown. The first draft of this change left the registration and the Pi/OMP dispatch unpinned (a review's mutants survived): each
// runtime keeps its sidecar under its own state root (`state/pi`, `state/omp`), so a swapped dispatch reads no flag for either. This builds a real daemon over a
// database with a Pi seat and an OMP seat, each with a published flag in its own runtime's root, and a Pi seat whose only sidecar is in the OMP root.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createDaemon } from "../src/startup.js";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { OPENRIG_HOME } from "../src/openrig-compat.js";

const RIG = "01RIGOF286000000000000000A";
const seats = [
  { node: "01NODEOF286000000000000PI1", logical: "verify.qa", session: "verify-qa@wired", runtime: "pi", root: "pi" },
  { node: "01NODEOF286000000000000OMP", logical: "build.omp", session: "build-omp@wired", runtime: "omp", root: "omp" },
  { node: "01NODEOF286000000000000PI2", logical: "verify.sec", session: "verify-sec@wired", runtime: "pi", root: "omp" }, // a Pi seat whose flag sits in the wrong root
];

function sidecar(root: string, session: string): void {
  const now = new Date().toISOString();
  const dir = join(OPENRIG_HOME, "state", root, session);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "runner-state.json"), JSON.stringify({
    ready: true, busy: true, updatedAt: now, aliveAt: now,
    modelErrorLoop: { count: 3, total: 7, since: new Date(Date.now() - 20 * 60_000).toISOString(), lastAt: new Date(Date.now() - 60_000).toISOString(), lastError: "terminated" },
  }));
}

describe("OF-286 a daemon built over a database with looping Pi and OMP seats", () => {
  it("lists a finding, marks ATTN, serves the flag on the node, and tells the Chief of Staff, for the Pi seat and the OMP seat, not for the seat whose flag is in the wrong runtime's root", async () => {
    expect(OPENRIG_HOME.includes("fixture"), `OPENRIG_HOME ${OPENRIG_HOME} is not a fixture home: this test writes sidecars under it`).toBe(true);
    const dir = mkdtempSync(join(tmpdir(), "of286-wired-"));
    const file = join(dir, "openrig.sqlite");
    const seeded = createDb(file);
    migrate(seeded, ALL_MIGRATIONS);
    seeded.prepare("INSERT INTO rigs (id, name) VALUES (?, 'wired')").run(RIG);
    seeded.prepare("INSERT INTO nodes (id, rig_id, logical_id, runtime, cwd) VALUES ('01NODEOF286000000000000COS', ?, 'exec.cos', 'claude-code', '/tmp')").run(RIG);
    seeded.prepare("INSERT INTO sessions (id, node_id, session_name, status, created_at) VALUES ('s-cos', '01NODEOF286000000000000COS', 'exec-cos@wired', 'running', '2026-11-10 10:00:00')").run();
    for (const [i, s] of seats.entries()) {
      seeded.prepare("INSERT INTO nodes (id, rig_id, logical_id, runtime, cwd) VALUES (?, ?, ?, ?, '/tmp')").run(s.node, RIG, s.logical, s.runtime);
      seeded.prepare("INSERT INTO sessions (id, node_id, session_name, status, created_at) VALUES (?, ?, ?, 'running', '2026-11-10 10:00:00')").run(`s-${i}`, s.node, s.session);
      seeded.prepare("INSERT INTO edges (id, rig_id, source_id, target_id, kind) VALUES (?, ?, '01NODEOF286000000000000COS', ?, 'delegates_to')").run(`e-${i}`, RIG, s.node);
      sidecar(s.root, s.session);
    }
    seeded.close();
    const daemon = await createDaemon({ dbPath: file });
    try {
      // The boot reconciler found no terminals and detached the sessions; they are recorded running again, as on a live host.
      daemon.db.prepare("UPDATE sessions SET status = 'running'").run();
      // rig health
      const found = daemon.deps.healthProjection!.list().records.filter((r) => r.detector === "seat.model-error-loop");
      expect(found.map((r) => (r.scope as { seatId: string }).seatId).sort()).toEqual([seats[0]!.node, seats[1]!.node].sort());
      expect(found.find((r) => (r.scope as { seatId: string }).seatId === seats[1]!.node)!.summary).toContain("(omp)");
      // rig ps: the rig's ATTN count
      const entry = daemon.deps.psProjectionService!.getEntries().find((e) => e.name === "wired")!;
      expect(entry.attentionCount).toBe(2);
      // rig ps --nodes: the flag on the node
      const res = await daemon.app.request(`/api/rigs/${RIG}/nodes`);
      expect(res.status).toBe(200);
      const nodes = await res.json() as Array<{ logicalId: string; modelErrorLoop?: { total: number; line: string }; agentActivity?: { state: string } }>;
      expect(nodes.find((n) => n.logicalId === "verify.qa")!.modelErrorLoop).toMatchObject({ total: 7 });
      expect(nodes.find((n) => n.logicalId === "verify.qa")!.modelErrorLoop!.line).toContain("looping on model errors: 7 failed requests");
      expect(nodes.find((n) => n.logicalId === "build.omp")!.modelErrorLoop).toMatchObject({ total: 7 });
      expect(nodes.find((n) => n.logicalId === "verify.sec")!.modelErrorLoop).toBeUndefined();
      expect(nodes.find((n) => n.logicalId === "exec.cos")!.modelErrorLoop).toBeUndefined();
      // the Chief of Staff is told, once per looping seat
      const notifier = daemon.deps.seatModelErrorLoopNotifier!;
      expect(notifier).toBeDefined();
      await notifier.tick();
      await notifier.tick();
      const items = daemon.db.prepare("SELECT summary, source_session FROM queue_items WHERE destination_session = 'exec-cos@wired' ORDER BY summary").all() as Array<{ summary: string; source_session: string }>;
      expect(items.map((i) => i.summary)).toEqual(["build.omp@wired is looping on model errors", "verify.qa@wired is looping on model errors"]);
      expect(items.every((i) => i.source_session === "daemon@kernel")).toBe(true);
    } finally {
      daemon.hcCoreWatch?.stop();
      daemon.eventLoopMonitor.stop();
      daemon.db.close();
      rmSync(dir, { recursive: true, force: true });
      for (const s of seats) rmSync(join(OPENRIG_HOME, "state", s.root, s.session), { recursive: true, force: true });
    }
  }, 120_000);

  it("index.ts starts the notifier after bind and stops it on shutdown", () => {
    const index = readFileSync(resolve(import.meta.dirname, "../src/index.ts"), "utf-8");
    expect(index).toContain("deps.seatModelErrorLoopNotifier?.start()");
    expect(index).toMatch(/\["seat-model-error-loop-notice", \(\) => deps\.seatModelErrorLoopNotifier\?\.stop\(\)\]/);
  });
});
