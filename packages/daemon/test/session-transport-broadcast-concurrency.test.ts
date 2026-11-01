// hc-w46 (QA F2): a broadcast delivers to its recipients concurrently, eight seats at a time, so its wait stops scaling with the rig
// (3 seats that start no run took 15.6 s serially; hc holds each ~5 s). What must not change: one result per recipient, in the
// recipient order; sends to ONE seat stay in order; a send that throws stops the scheduling and is the broadcast's error.
// Real-core proof (timing, outcome rows, outbox rows): session-transport-broadcast.real.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SessionTransport, type SendResult } from "../src/domain/session-transport.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { EventBus } from "../src/domain/event-bus.js";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { tmuxStub } from "./helpers/tmux-stub.js";

const seat = (i: number) => `s${String(i).padStart(2, "0")}@bc-rig`;

describe("SessionTransport.broadcast", () => {
  let db: Database.Database;
  let transport: SessionTransport;

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    const rigRepo = new RigRepository(db);
    const sessionRegistry = new SessionRegistry(db);
    const eventBus = new EventBus(db);
    const rig = rigRepo.createRig("bc-rig");
    for (let i = 1; i <= 20; i++) {
      const node = rigRepo.addNode(rig.id, `s${String(i).padStart(2, "0")}`, { role: "worker", runtime: "claude-code" });
      const session = sessionRegistry.registerSession(node.id, seat(i));
      sessionRegistry.updateStatus(session.id, "running");
      sessionRegistry.updateBinding(node.id, { attachmentType: "hc", tmuxSession: seat(i) });
    }
    transport = new SessionTransport({
      db, rigRepo, sessionRegistry, agentActivityStore: new AgentActivityStore({ db, eventBus }), eventBus, sleep: async () => undefined,
      tmuxAdapter: tmuxStub({
        hasSession: async () => true, probeSession: async () => ({ state: "present" as const }),
        capturePaneContent: async () => "idle\n❯ ", listSessions: async () => [], listWindows: async () => [], listPanes: async () => [],
        getPanePid: async () => null, getPaneCommand: async () => null,
      }),
    });
  });
  afterEach(() => { db.close(); vi.restoreAllMocks(); });

  const ok = (sessionName: string): SendResult => ({ ok: true, sessionName } as SendResult);
  const sessions = (n: number) => Array.from({ length: n }, (_, i) => seat(i + 1));

  it("runs at most eight sends at once, and really overlaps them (20 seats: a ceiling of exactly 8)", async () => {
    let inFlight = 0; let peak = 0;
    vi.spyOn(transport, "send").mockImplementation(async (name) => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 15));
      inFlight--;
      return ok(name);
    });
    const result = await transport.broadcast({ sessions: sessions(20) }, "hello");
    expect(peak).toBe(8);
    expect(result).toMatchObject({ total: 20, sent: 20, failed: 0 });
  });

  it("returns one result per recipient in the RECIPIENT order, whichever finishes first", async () => {
    vi.spyOn(transport, "send").mockImplementation(async (name) => {
      const index = Number(name.slice(1, 3));
      await new Promise((r) => setTimeout(r, (21 - index) * 4));   // the last seats finish first
      return ok(name);
    });
    const result = await transport.broadcast({ sessions: sessions(12) }, "hello");
    expect(result.results.map((r) => r.sessionName)).toEqual(sessions(12));
  });

  it("each recipient is sent the same enveloped text with the broadcast's scale line, under its own delivery id, as before", async () => {
    const seen: Array<{ name: string; text: string; deliveryId?: string }> = [];
    vi.spyOn(transport, "send").mockImplementation(async (name, text, opts) => { seen.push({ name, text, deliveryId: opts?.deliveryId }); return ok(name); });
    await transport.broadcast({ sessions: sessions(3) }, "body", { envelopeSender: "boss@bc-rig", deliveryId: "D1" });
    expect(seen).toHaveLength(3);
    expect(new Set(seen.map((c) => c.text)).size, "one envelope for the fan-out (the scale line names every recipient)").toBe(1);
    expect(seen[0]!.text).toContain("From: boss@bc-rig");
    for (const name of sessions(3)) expect(seen[0]!.text).toContain(name);
    for (const call of seen) expect(call.deliveryId).toBe(`D1:${call.name}`);
  });

  it("sends to ONE seat stay in order: a seat named twice is delivered to one after the other, in the recipient order", async () => {
    const log: string[] = [];
    vi.spyOn(transport, "send").mockImplementation(async (name, text) => {
      log.push(`start ${name} ${text.includes("two") ? "two" : "one"}`);
      await new Promise((r) => setTimeout(r, name === seat(1) ? 20 : 2));
      log.push(`end ${name}`);
      return ok(name);
    });
    // the resolver collapses a repeated name, so a repeated seat is given to broadcast the way a future target kind could
    vi.spyOn(transport, "resolveSessions").mockResolvedValue({
      ok: true, sessions: [seat(1), seat(2), seat(1)].map((sessionName) => ({ sessionName, rigName: "bc-rig", nodeLogicalId: sessionName })),
    });
    const result = await transport.broadcast({ sessions: [seat(1), seat(2), seat(1)] }, "one");
    expect(log.filter((l) => l === `start ${seat(1)} one`), "positive control: the resolver kept the seat twice").toHaveLength(2);
    expect(result.results.map((r) => r.sessionName)).toEqual([seat(1), seat(2), seat(1)]);
    const first = log.indexOf(`start ${seat(1)} one`);
    const firstEnd = log.indexOf(`end ${seat(1)}`);
    const second = log.lastIndexOf(`start ${seat(1)} one`);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(second).toBeGreaterThan(firstEnd);
  });

  it("a send that throws is the broadcast's error; nothing new is started after it, and what was in flight is awaited", async () => {
    const started: string[] = []; const finished: string[] = [];
    vi.spyOn(transport, "send").mockImplementation(async (name) => {
      started.push(name);
      await new Promise((r) => setTimeout(r, 10));
      if (name === seat(2)) throw new Error("boom");
      finished.push(name);
      return ok(name);
    });
    await expect(transport.broadcast({ sessions: sessions(20) }, "hello")).rejects.toThrow("boom");
    expect(started.length).toBeLessThanOrEqual(8 + 7);   // the first wave plus at most the workers that had already picked up the next
    expect(started.length).toBeLessThan(20);
    // everything that started has settled by the time the broadcast reported: no send is left running behind the caller
    expect(finished.length).toBe(started.length - 1);
  });

  it("a failed recipient does not stop the others: it is one failed result", async () => {
    vi.spyOn(transport, "send").mockImplementation(async (name) => (name === seat(3) ? ({ ok: false, sessionName: name, reason: "mid_work" } as SendResult) : ok(name)));
    const result = await transport.broadcast({ sessions: sessions(10) }, "hello");
    expect(result).toMatchObject({ total: 10, sent: 9, failed: 1 });
    expect(result.results[2]).toMatchObject({ ok: false, sessionName: seat(3) });
  });
});
