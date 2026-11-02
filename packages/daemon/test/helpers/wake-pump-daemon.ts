// A real daemon process for the wake ladder's S4d test: the real createDaemon on a database file and a private core, with a stub gate and a
// stub hop injected as in message-pump-daemon.ts. WPD_HANDOFF makes one real queue hand-off after boot; WPD_LADDER runs the real ladder tick
// on a short loop, its clock moved past the cap, as the scheduler in index.ts would. index.ts is not booted, so no route is exercised.
import { appendFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { HcClient } from "../../src/adapters/hc-client.js";
import { hcTerminalName } from "../../src/adapters/hc-seat.js";
import { runWakeLadderTick } from "../../src/domain/queue-wake-ladder.js";
import { messageId, type GateLookup, type LastHop, type SeatGate } from "../../src/domain/seat-messaging/ports.js";
import { createDaemon } from "../../src/startup.js";

const { WPD_DB: db, WPD_DIR: dir, WPD_SEAT: seat, WPD_HANDOFF: handoff, WPD_LADDER: ladder } = process.env;
if (!db || !dir || !seat) throw new Error("WPD_DB, WPD_DIR and WPD_SEAT are required");
const note = (line: string) => appendFileSync(join(dir, "hop.log"), `${line}\n`);
const client = new HcClient();

const gate: SeatGate = {
  version: 1,
  async lookup(_seat, id): Promise<GateLookup> {
    const path = join(dir, "seen", id);
    return existsSync(path)
      ? { kind: "seen", record: { id: messageId(id), recordedAt: statSync(path).mtime.toISOString(), nonce: null } }
      : { kind: "not_seen" };
  },
};

const hop: LastHop = {
  async attempt(message) {
    const id = message.ids[0];
    try {
      await client.call("terminal.send", { terminal: hcTerminalName(message.seat), text: `[openrig-msg id=${id}] ${message.body}` }, { timeoutMs: 8_000 });
    } catch {
      note(`stopped ${id}`);
      return { kind: "paused", reason: "seat_stopped" };
    }
    note(`sent ${id}`);
    return { kind: "sent" };
  },
};

const daemon = await createDaemon({
  dbPath: db,
  seatMessagingPorts: { gateFor: (s) => (s === seat ? gate : null), hopFor: (s) => (s === seat ? hop : null) },
  messagePumpTiming: { tickMs: 40, pauseRecheckMs: 100, backoffMs: [300, 300, 300] },
});
const queueRepo = daemon.deps.queueRepo;
if (!queueRepo) throw new Error("the daemon wired no queue");
note("booted");
if (handoff) {
  const { source, relay } = JSON.parse(handoff) as { source: string; relay: string };
  const item = await queueRepo.create({ sourceSession: source, destinationSession: relay, body: "the work", nudge: false });
  const { created } = await queueRepo.handoff({ qitemId: item.qitemId, fromSession: relay, toSession: seat });
  note(`handed ${created.qitemId}`);
}
if (ladder) {
  const pass = async () => {
    const result = await runWakeLadderTick({
      db: daemon.db, queueRepo, now: new Date(Date.now() + 2 * 60 * 60_000), retryIntervalSeconds: 60, retryCap: 3, swapGraceSeconds: 0,
      resolveOrchestrator: () => null, log: (line) => note(`ladder ${line}`),
    });
    note(`tick ${result.outcome} ${result.actions.map((a) => a.action).join(",")}`);
  };
  setInterval(() => { void pass(); }, 150);
}
setInterval(() => undefined, 60_000);
