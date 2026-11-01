// The real daemon for the census crash table: createDaemon with its real RuntimeSeatPorts, real hop, real gate reader and real hook-store
// layout. The only additions are a short schedule, and MPD_CRASH, which hangs one attempt at a named point so the parent can SIGKILL there.
import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { HookSeenStore, seatGateRoot } from "../../src/adapters/hook-seen-store.js";
import { reconcileCodexSeatGate } from "../../src/adapters/codex-seat-gate.js";
import { MessageStore } from "../../src/domain/seat-messaging/message-store.js";
import { messageId, type LastHop } from "../../src/domain/seat-messaging/ports.js";
import { createDaemon } from "../../src/startup.js";

const { MPD_DB: db, MPD_DIR: dir, MPD_CRASH: crash = "none", OPENRIG_HOME: home } = process.env;
if (!db || !dir || !home) throw new Error("MPD_DB, MPD_DIR and OPENRIG_HOME are required");
const note = (line: string) => appendFileSync(join(dir, "hop.log"), `${line}\n`);
const hang = () => new Promise<never>(() => undefined);

const noted = (hop: LastHop): LastHop => ({
  attempt: async (message) => {
    const id = message.ids[0];
    note(`claimed ${id}`);
    if (crash === "before_bytes") return hang();
    const result = await hop.attempt(message);
    note(`${result.kind === "paused" ? `paused:${result.reason}` : result.kind} ${id}`);
    if (crash === "after_bytes" && result.kind === "sent") return hang();
    return result;
  },
});

const daemon = await createDaemon({
  dbPath: db,
  wrapSeatMessagingPorts: (ports) => ({ gateFor: (seat) => ports.gateFor(seat), hopFor: (seat) => { const hop = ports.hopFor(seat); return hop ? noted(hop) : null; } }),
  messagePumpTiming: { tickMs: 40, pauseRecheckMs: 80, backoffMs: [300, 300, 300] },
});
note("booted");
if (process.env.MPD_SEND) {
  const { seat, id, body } = JSON.parse(process.env.MPD_SEND) as { seat: string; id: string; body: string };
  const result = await daemon.deps.sessionTransport.send(seat, body, { deliveryId: id, actorSession: "lead@cr" });
  note(`transport ${id} ${result.reason ?? ""} sent=${String(result.sent)}`);
}
// A seat restart's reconcile, as startup's Codex closure runs it; the parent asks by making this file.
const reconcile = join(dir, "reconcile");
const seat = process.env.MPD_SEAT;
setInterval(() => {
  if (!seat || !existsSync(reconcile)) return;
  const { cleared } = reconcileCodexSeatGate(new HookSeenStore(seatGateRoot(home)), seat, join(dir, "rollout.jsonl"));
  for (const marker of cleared) new MessageStore(daemon.db).reopenCleared(messageId(marker.id), marker.nonce);
  note(`reconciled ${cleared.length}`);
  appendFileSync(reconcile + ".done", "x");
}, 50).unref();
setInterval(() => undefined, 60_000);
