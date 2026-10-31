// OF-184 (review of OF-182, finding 1): deleting the post-restart wiring from startup.ts kept every test green. These are
// the boot-level pins: a real createDaemon, a restore.completed on its event bus (or already in its database when it
// boots), and the daemon's own transport seen to be asked to send the prompt. Removing the wirePostRestartPrompt call,
// its re-derivation on boot, or its reading of the setting from startup.ts fails HERE.
// Nothing reaches a seat: the transport's send is replaced on the instance, and the delays are zero.
import { describe, it, expect, afterEach, vi } from "vitest";
import { SessionTransport } from "../src/domain/session-transport.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDaemon } from "../src/startup.js";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import type { RestoreResult } from "../src/domain/types.js";

const SWITCH_ENV = "OPENRIG_RECOVERY_POST_RESTART_PROMPT";
const cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.splice(0)) fn(); });

const resultFor = (nodeId: string): RestoreResult => ({
  snapshotId: "s", preRestoreSnapshotId: null, rigResult: "fully_restored", warnings: [],
  nodes: [{ nodeId, logicalId: "dev.impl", status: "resumed" }],
});

interface Call { sessionName: string; text: string; deliveryId?: string }

/** A rig with one running seat started at a fixed, old time, in any database handle. */
function seed(db: import("better-sqlite3").Database, rigName: string) {
  const rigRepo = new RigRepository(db);
  const registry = new SessionRegistry(db);
  const rig = rigRepo.createRig(rigName);
  const node = rigRepo.addNode(rig.id, "dev.impl");
  const session = registry.registerSession(node.id, `dev-impl@${rigName}`);
  registry.updateStatus(session.id, "running");
  db.prepare("UPDATE sessions SET created_at = '2026-10-30 17:58:12' WHERE id = ?").run(session.id);
  return { rig, node };
}

async function boot(dbPath: string, hold: Promise<void> = Promise.resolve()): Promise<{ calls: Call[]; daemon: Awaited<ReturnType<typeof createDaemon>> }> {
  const calls: Call[] = [];
  // Before createDaemon: the re-derivation on boot can ask for a send as soon as the daemon is wired.
  const spy = vi.spyOn(SessionTransport.prototype, "send").mockImplementation(async (sessionName, text, opts) => {
    calls.push({ sessionName, text, deliveryId: opts?.deliveryId });
    return { ok: true, path: "native", sessionName };
  });
  cleanup.push(() => spy.mockRestore());
  // The notifier's clock only moves when it sleeps, so a seat that never takes the prompt runs the window out at once
  // instead of spinning on a clock that does not advance.
  const clock = { t: Date.now() };
  const daemon = await createDaemon({
    dbPath,
    postRestartTiming: { now: () => new Date(clock.t), sleep: async (ms) => { await hold; clock.t += ms; }, firstDelayMs: 0, retryEveryMs: 60_000 },
  });
  return { calls, daemon };
}

describe("OF-184 wiring pin: startup connects restore.completed to the post-restart prompt", () => {
  it("a restore.completed on the daemon's event bus asks the daemon's transport to send the prompt to the resumed seat", async () => {
    const { calls, daemon } = await boot(":memory:");
    const { rig, node } = seed(daemon.db, "boot-pinned");
    daemon.deps.eventBus.emit({ type: "restore.completed", rigId: rig.id, snapshotId: "s", result: resultFor(node.id) });
    await new Promise((r) => setTimeout(r, 100));

    expect(calls).toHaveLength(1);
    expect(calls[0]!.sessionName).toBe("dev-impl@boot-pinned");
    expect(calls[0]!.text).toContain("rig boot-pinned was restored");
    expect(calls[0]!.text).toContain("restarted at 2026-10-30T17:58:12.000Z");
    expect(calls[0]!.deliveryId).toMatch(/^post-restart-\d+-/);
  });

  it("startup reads the recovery.post_restart_prompt setting: switched off through its environment variable, nothing is sent", async () => {
    const before = process.env[SWITCH_ENV];
    process.env[SWITCH_ENV] = "false";
    cleanup.push(() => { if (before === undefined) delete process.env[SWITCH_ENV]; else process.env[SWITCH_ENV] = before; });
    const { calls, daemon } = await boot(":memory:");
    const { rig, node } = seed(daemon.db, "boot-off");
    daemon.deps.eventBus.emit({ type: "restore.completed", rigId: rig.id, snapshotId: "s", result: resultFor(node.id) });
    await new Promise((r) => setTimeout(r, 100));
    expect(calls).toHaveLength(0);
  });

  it("a daemon restart inside the window: a restore.completed already in the database when the daemon boots is delivered", async () => {
    const dir = mkdtempSync(join(tmpdir(), "post-restart-boot-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const dbPath = join(dir, "daemon.sqlite");
    // The daemon that restored the rig: the event is in the log, the seat is running, and that daemon is gone.
    const first = createDb(dbPath);
    migrate(first, ALL_MIGRATIONS);
    const { rig, node } = seed(first, "boot-restart");
    new EventBus(first).emit({ type: "restore.completed", rigId: rig.id, snapshotId: "s", result: resultFor(node.id) });
    first.close();

    // Boot reconciles sessions against tmux, which this test does not have, and marks the seat detached; the seat's
    // first attempt is held until the test has put it back to running, as a live tmux session would leave it.
    let release!: () => void;
    const { calls, daemon } = await boot(dbPath, new Promise<void>((r) => { release = r; }));
    daemon.db.prepare("UPDATE sessions SET status = 'running' WHERE session_name = 'dev-impl@boot-restart'").run();
    release();
    await new Promise((r) => setTimeout(r, 200));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.sessionName).toBe("dev-impl@boot-restart");
  });
});
