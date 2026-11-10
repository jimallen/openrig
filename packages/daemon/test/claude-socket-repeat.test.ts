// OF-285: a Claude seat that holds a socket line. On eztrack (2026-11-09/10) 13 of 324 messages went 2-3 times: Claude queues a socket line while a
// dialog is open (5 messages) or a tool call runs (7 messages, Bash calls of 3-14 min; 92046c2b: 08:08:35-08:22:15), and takes it at the next input
// point. Each pump repeat (backoff 2, then 5 min) queued one more copy, and the gate recorded the first and blocked the rest ("duplicate suppressed").
// This runs that through the real pump, the real wiring (RuntimeSeatPorts), the real store and the real hook ingest (AgentActivityStore). Only the
// Claude socket (a recorder) and the core (a terminal that answers for the seat's own name) are fakes.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { hcTerminalName } from "../src/adapters/hc-host.js";
import { HookSeenStore, seatGateFolder, seatGateRoot } from "../src/adapters/hook-seen-store.js";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import type { NativeEndpointRow } from "../src/domain/claude-native-inbox.js";
import { EventBus } from "../src/domain/event-bus.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { MessagePump } from "../src/domain/seat-messaging/message-pump.js";
import { SeatMessagingHealthSource } from "../src/domain/seat-messaging/message-health.js";
import { MessageStore } from "../src/domain/seat-messaging/message-store.js";
import { messageId } from "../src/domain/seat-messaging/ports.js";
import { RuntimeSeatPorts } from "../src/domain/seat-messaging/runtime-ports.js";
import { mkdirSync, writeFileSync } from "node:fs";

const MIN = 60_000;
const T0 = Date.parse("2026-11-10T08:07:12.000Z");
const SEAT = "exec-cos@eztrack";
const ID = messageId("92046c2b");

describe("a Claude seat that holds a socket line through one long tool call or an open question (OF-285)", () => {
  let db: Database.Database;
  let home: string;
  let now: number;
  /** The wall clock at accept: the store stamps `accepted_at` with it, and health measures a message's age from there. */
  let wall0: number;
  let store: MessageStore;
  let pump: MessagePump;
  let activity: AgentActivityStore;
  let nodeId: string;
  let ports: RuntimeSeatPorts;
  /** Every line written to Claude's socket: what the seat queues, copy by copy. */
  let writes: string[];
  let terminalReads: string[];
  let hcStatus: string;

  beforeEach(() => {
    db = createDb(); migrate(db, ALL_MIGRATIONS);
    home = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "claude-repeat-"));
    now = T0; writes = []; terminalReads = []; hcStatus = "working";
    const rigs = new RigRepository(db);
    const node = rigs.addNode(rigs.createRig("eztrack").id, "exec-cos", { role: "worker", runtime: "claude-code" });
    nodeId = node.id;
    const sessions = new SessionRegistry(db);
    sessions.updateStatus(sessions.registerSession(node.id, SEAT).id, "running");
    sessions.updateBinding(node.id, { attachmentType: "hc", tmuxSession: SEAT });
    const gateDir = join(seatGateRoot(home), seatGateFolder(SEAT));
    mkdirSync(gateDir, { recursive: true });
    writeFileSync(join(gateDir, "gate.json"), JSON.stringify({ version: 1 }));
    activity = new AgentActivityStore({ db, eventBus: new EventBus(db), now: () => new Date(now) });
    store = new MessageStore(db);
    const foreground = { pid: 1, name: "claude", argv: ["claude"], cwd: "/w" };
    ports = new RuntimeSeatPorts({
      db, rows: store, hookStore: new HookSeenStore(seatGateRoot(home)), stateRoots: { pi: join(home, "pi"), omp: join(home, "omp") },
      client: {
        call: async <T,>(method: string, params?: { terminal?: string }): Promise<T> => {
          terminalReads.push(`${method}:${params?.terminal}`);
          if (params?.terminal !== hcTerminalName(SEAT)) throw new Error(`no such terminal: ${params?.terminal}`);
          return (method === "terminal.get" ? { state: "live", status: { state: hcStatus }, foreground } : { text: "❯ \n──────────────\n" }) as T;
        },
      },
      guard: { operation: (_n, fn) => fn() }, input: { submitText: async () => ({ ok: true }), sendKeys: async () => ({ ok: true }) },
      inbox: () => ({
        eligibility: async () => ({ ok: true as const, nodeId, endpoint: { socket_path: "/s" } as NativeEndpointRow }),
        writeToSeat: async (_e, _sender, text) => { writes.push(text); return "all" as const; },
        transcriptOf: () => null,
      }),
      fileIncludes: () => false, rolloutOf: () => null, now: () => now,
    });
    pump = new MessagePump({
      store, ports, directory: { fate: () => ({ kind: "live", occupantGeneration: store.headOf(SEAT)?.occupantGeneration ?? null }) } as never, held: { status: () => "held" },
      senders: { returnToSender: async () => ({ kind: "no_return_path", reason: "none" }) }, clock: () => now, log: () => undefined,
    });
    wall0 = Date.now();
    store.accept({ id: ID, seat: SEAT, sender: "build-ux@eztrack", body: "CoS: stop the guard run" });
  });
  afterEach(() => { db.close(); rmSync(home, { recursive: true, force: true }); });

  const hook = (hookEvent: string, subtype: string | null = null) => {
    const result = activity.recordHookEvent({ runtime: "claude-code", sessionName: SEAT, nodeId, hookEvent, subtype, occurredAt: new Date(now).toISOString() });
    expect(result.ok).toBe(true);
  };
  /** Claude takes the queued line: the relay's hook records it, as the gate does for a line that landed. */
  const gateRecords = () => new HookSeenStore(seatGateRoot(home)).markReceived(SEAT, { id: ID, nonce: store.nonceOf(ID)! });
  /** The pump's own clock, a pass every 15 s (its pause recheck) for `ms`. */
  const run = async (ms: number) => { for (const end = now + ms; now < end;) { now += 15_000; await pump.tick(); } };
  const health = () => new SeatMessagingHealthSource(store, ports, () => new Date(wall0 + (now - T0))).coverage().flatMap((row) => ("reason" in row ? [row.reason] : []));

  it("a 14 min Bash call: one write, the attempt count stays 1, and the line is recorded when the call ends", async () => {
    hook("PreToolUse", "Bash");
    await pump.tick();
    expect(writes).toHaveLength(1);
    await run(13 * MIN);                                          // past the 2 min and the 5 min backoffs
    expect(writes, "the pane/queue saw the line once").toHaveLength(1);
    expect(store.headOf(SEAT)).toMatchObject({ attempts: 1, pauseReason: "busy" });
    expect(store.lastSocketWriteMs(ID), "a held repeat does not move the write time").toBe(T0);
    // Downstream: rig health says nothing until the message is 15 min old, then counts one attempt and names the pause.
    expect(health()).toEqual([]);
    await run(3 * MIN);
    expect(health()).toEqual([expect.stringContaining("1 attempt(s), paused: busy")]);
    // 08:22:15: the Bash call ends; Claude takes the queued line and the relay records it.
    hook("PostToolUse", "Bash"); gateRecords();
    await run(30_000);
    expect(store.outcomeOf(ID)).toBe("received");
    expect(writes).toHaveLength(1);
    // The extra reads: one hc terminal.get per held visit (never for the seat's first write or a seat that is not held), all for the seat's own terminal.
    expect(terminalReads.length).toBeGreaterThan(0);
    expect(new Set(terminalReads)).toEqual(new Set([`terminal.get:${hcTerminalName(SEAT)}`]));
  });

  it("an open question: one write; the repeat goes only if the question closed and the line was still not recorded", async () => {
    hook("PermissionRequest", "AskUserQuestion");
    await pump.tick();
    hcStatus = "blocked";
    await run(20 * MIN);
    expect(writes).toHaveLength(1);
    expect(store.headOf(SEAT)).toMatchObject({ attempts: 1, pauseReason: "busy" });
    // The question is answered (PostToolUse of AskUserQuestion) but the first line was lost: the seat passed an input point, so the repeat goes.
    hook("PostToolUse", "AskUserQuestion"); hcStatus = "working";
    await run(30_000);
    expect(writes).toHaveLength(2);
    expect(store.headOf(SEAT)?.attempts).toBe(2);
  });

  it("a seat that passed an input point and recorded nothing gets the repeat at its next pass", async () => {
    hook("PreToolUse", "Bash");
    await pump.tick();
    await run(3 * MIN);
    expect(writes).toHaveLength(1);
    hook("PostToolUse", "Bash");
    await run(15_000);
    expect(writes).toHaveLength(2);
  });
});
