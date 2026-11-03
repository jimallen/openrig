// OF-214: a Pi seat in one long turn. verify-sec@eztrack (2026-11-03): exec-cos's message went in at 13:58:58Z, the runner steered it into Pi, and
// Pi showed it at 14:29:51Z, when the turn's one tool call (a bash run) ended. The gate log held the intent from 13:58:59 to then. Meanwhile the pump,
// which saw no record, pasted the same text again at attempts 2, 3 and 4 (backoff 2, 5, 15 min): each copy printed in the pane and the runner
// answered "repeat dropped". This runs that sequence through the pump, the real wiring (RuntimeSeatPorts) and the runner's own gate store.
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { HookSeenStore, seatGateRoot } from "../src/adapters/hook-seen-store.js";
import { piSeatPaths } from "../src/adapters/pi-runner-protocol.js";
import { splitMarkedBlock } from "../src/adapters/seat-gate-marker.js";
import { SeatGateStore, seatGateLogPath, type GateIntent } from "../src/adapters/seat-gate-store.js";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { MessagePump } from "../src/domain/seat-messaging/message-pump.js";
import { MessageStore } from "../src/domain/seat-messaging/message-store.js";
import { messageId } from "../src/domain/seat-messaging/ports.js";
import { RuntimeSeatPorts } from "../src/domain/seat-messaging/runtime-ports.js";

const MIN = 60_000;
const T0 = Date.parse("2026-11-03T13:58:58.000Z");
const SEAT = "verify-sec@eztrack";

describe("a Pi seat that holds a message through a long turn (OF-214)", () => {
  let db: Database.Database;
  let home: string;
  let now: number;
  let store: MessageStore;
  let pump: MessagePump;
  /** Every text typed into the pane: what the person watching the seat sees, copy by copy. */
  let typed: string[];
  /** The runner, as pi-runner.ts runs it on a marked block: admit, and a repeat is dropped. */
  let gate: SeatGateStore;
  let open: GateIntent[];
  let dropped: number;
  let ports: RuntimeSeatPorts;

  beforeEach(() => {
    db = createDb(); migrate(db, ALL_MIGRATIONS);
    home = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "pi-held-"));
    now = T0; typed = []; open = []; dropped = 0;
    const rigs = new RigRepository(db);
    const node = rigs.addNode(rigs.createRig("eztrack").id, "verify-sec", { role: "worker", runtime: "pi" });
    new SessionRegistry(db).updateBinding(node.id, { attachmentType: "hc", tmuxSession: SEAT });
    const piRoot = join(home, "pi");
    const paths = piSeatPaths(piRoot, SEAT);
    mkdirSync(paths.seatRoot, { recursive: true });
    writeFileSync(paths.runnerStatePath, JSON.stringify({ ready: true, updatedAt: "1970-01-01T00:00:00.000Z", seatGate: 1 }));
    gate = SeatGateStore.open(seatGateLogPath(paths.seatRoot));
    store = new MessageStore(db);
    const foreground = { pid: 1, name: "node", argv: ["node", "/lib/daemon/dist/adapters/pi-runner.js", "--session-name", SEAT, "--no-approve"], cwd: "/w" };
    ports = new RuntimeSeatPorts({
      db, rows: store, hookStore: new HookSeenStore(seatGateRoot(home)), stateRoots: { pi: piRoot, omp: join(home, "omp") },
      client: { call: async <T,>(method: string): Promise<T> => (method === "terminal.get" ? { state: "live", status: { state: "working" }, foreground } : { text: "[pi-runner] READY\n" }) as T },
      guard: { operation: (_n, fn) => fn() },
      input: {
        submitText: async (_s: string, text: string) => {
          typed.push(text);
          const { text: body, markers } = splitMarkedBlock(text);
          const intent = gate.admit(markers, body, null);  // the runner's gate (handleUserBlock)
          if (intent === null) dropped += 1; else open.push(intent);
          return { ok: true as const };
        },
        sendKeys: async () => ({ ok: true as const }),
      },
      inbox: () => ({ eligibility: async () => ({ ok: false, reason: "x" }), writeToSeat: async () => "none", transcriptOf: () => null }), fileIncludes: () => false, rolloutOf: () => null,
    });
    pump = new MessagePump({
      store, ports, directory: { fate: () => ({ kind: "live", occupantGeneration: null }) } as never, held: { status: () => "held" },
      senders: { returnToSender: async () => ({ kind: "no_return_path", reason: "none" }) }, clock: () => now, log: () => undefined,
    });
  });
  afterEach(() => { db.close(); rmSync(home, { recursive: true, force: true }); });

  const accept = (id: string, body: string) => store.accept({ id: messageId(id), seat: SEAT, sender: "exec-cos@eztrack", body });

  it("types the message once, however long Pi keeps it, and records it received the moment Pi shows it", async () => {
    accept("6a82166e", "CoS 14:00Z: stop the guard run");
    await pump.tick();
    expect(typed).toHaveLength(1);
    expect(store.headOf(SEAT)?.attempts).toBe(1);
    // The pump's own clock passes every backoff the live row went through (2, 5, 15 min) and a half hour beyond, a tick at a time.
    for (let elapsed = 0; elapsed <= 31 * MIN; elapsed += 30_000) {
      now = T0 + elapsed;
      await pump.tick();
    }
    expect(typed, "the pane saw the message once").toHaveLength(1);
    expect(dropped, "the runner dropped nothing").toBe(0);
    expect(store.headOf(SEAT)).toMatchObject({ attempts: 1, pauseReason: "runner_held" });
    // 14:29:51Z: Pi's message_start for it. The runner records it; the next pass sees the record.
    gate.seen(open[0]!, "message_start");
    now += 5 * MIN;
    await pump.tick();
    expect(store.outcomeOf(messageId("6a82166e"))).toBe("received");
    expect(typed).toHaveLength(1);
  });

  it("a message Pi refused (the runner cleared its intent) goes again at the first backoff, and nothing was dropped", async () => {
    accept("m-refused", "try me");
    await pump.tick();
    expect(typed).toHaveLength(1);
    gate.clear(open[0]!, "refused_by_runtime");
    now += 1 * MIN;
    await pump.tick();
    expect(typed).toHaveLength(1);  // the first backoff (2 min) has not run out
    now += 1 * MIN + 1;
    await pump.tick();
    expect(typed).toHaveLength(2);
    expect(dropped).toBe(0);
  });

  it("a message to a runner that was killed with it open waits, and goes if the restart finds no trace of it", async () => {
    accept("m-killed", "lost with the runner");
    await pump.tick();
    // The runner restarts: it reopens its log and settles the open intent against the session file, which never got the message.
    const reopened = SeatGateStore.open(seatGateLogPath(piSeatPaths(join(home, "pi"), SEAT).seatRoot));
    gate = reopened;  // the new runner process is the one that reads stdin from here on
    now += 2 * MIN + 1;
    await pump.tick();
    expect(typed, "the log still says in flight: nothing is typed").toHaveLength(1);
    expect(store.headOf(SEAT)?.pauseReason).toBe("runner_held");
    expect(reopened.reconcile(() => [])).toBe(0);
    now += 20_000;
    await pump.tick();
    expect(typed, "the restart cleared it: the pause is 15 s, not another backoff").toHaveLength(2);
    expect(dropped).toBe(0);
  });

  it("a seat whose gate log is not there yet is not held: the first message goes, as it always did", async () => {
    rmSync(seatGateLogPath(piSeatPaths(join(home, "pi"), SEAT).seatRoot));
    accept("m-fresh", "first ever");
    await pump.tick();
    expect(typed).toHaveLength(1);
  });

  // F2 of the review. The pump never reaches the hop for these (the gate lookup answers unavailable and the message waits), so the hop is asked
  // directly: a log that exists and cannot be read proves nothing about the runner, and the hop types as it did before OF-214.
  const heldBy = (id: string) => {
    store.accept({ id: messageId(id), seat: SEAT, sender: "exec-cos@eztrack", body: "x" });
    const head = store.headOf(SEAT)!;
    store.claimAttempt(head, 0);
    return { ids: [messageId(id)] as [ReturnType<typeof messageId>], seat: SEAT, body: "x", messageClass: "content" as const, lane: 2 as const };
  };
  it("a gate log that exists but is a directory is not held: the hop types", async () => {
    const log = seatGateLogPath(piSeatPaths(join(home, "pi"), SEAT).seatRoot);
    rmSync(log);
    mkdirSync(log);
    gate = SeatGateStore.open(join(home, "elsewhere.log"));  // the simulated runner keeps its own log; the daemon's path is the directory
    await expect(ports.hopFor(SEAT)!.attempt(heldBy("m-dir"))).resolves.toEqual({ kind: "sent" });
    expect(typed).toHaveLength(1);
  });
  it("a gate log that exists but cannot be read (mode 000) is not held: the hop types", async () => {
    const log = seatGateLogPath(piSeatPaths(join(home, "pi"), SEAT).seatRoot);
    const message = heldBy("m-000");
    gate.admit([{ id: "m-000", nonce: store.nonceOf(message.ids[0])! }], "x", null);  // the intent is in the file: only the unreadable mode hides it
    chmodSync(log, 0o000);
    try {
      await expect(ports.hopFor(SEAT)!.attempt(message)).resolves.toEqual({ kind: "sent" });
      expect(typed).toHaveLength(1);
    } finally { chmodSync(log, 0o600); }
  });

  it("the second message waits behind the first, as the pump always keeps a seat's order, and goes when the first is received", async () => {
    accept("m-first", "one");
    accept("m-second", "two");
    await pump.tick();
    now += 10 * MIN;
    await pump.tick();
    expect(typed).toHaveLength(1);
    gate.seen(open[0]!, "message_start");
    now += 20_000;
    await pump.tick();
    now += 20_000;
    await pump.tick();
    expect(typed).toHaveLength(2);
    expect(typed[1]).toContain("two");
  });
});
