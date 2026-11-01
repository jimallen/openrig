// A real daemon process for the pump's crash tests: the real createDaemon on a database file and a private core, with a stub gate and
// a stub hop injected through DaemonOptions, the only thing not as shipped. The stub hop sends through the real core; the gate is a
// file the seat's stub program creates. MPD_CRASH makes one attempt hang at a named point, so the parent can SIGKILL it there.
import { appendFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { HcClient } from "../../src/adapters/hc-client.js";
import { hcTerminalName } from "../../src/adapters/hc-seat.js";
import { messageId, type GateLookup, type LastHop, type SeatGate } from "../../src/domain/seat-messaging/ports.js";
import { createDaemon } from "../../src/startup.js";

const { MPD_DB: db, MPD_DIR: dir, MPD_CRASH: crash = "none" } = process.env;
if (!db || !dir) throw new Error("MPD_DB and MPD_DIR are required");

const hang = () => new Promise<never>(() => undefined);
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
    note(`claimed ${id}`);
    if (crash === "before_bytes") return hang();
    await client.call("terminal.send", { terminal: hcTerminalName(message.seat), text: `[openrig-msg id=${id}] ${message.body}` }, { timeoutMs: 8_000 });
    note(`sent ${id}`);
    if (crash === "after_bytes") return hang();
    return { kind: "sent" };
  },
};

const daemon = await createDaemon({
  dbPath: db,
  seatMessagingPorts: { gateFor: () => gate, hopFor: () => hop },
  messagePumpTiming: { tickMs: 40, pauseRecheckMs: 100, backoffMs: [300, 300, 300] },
});
note("booted");
// A send through the daemon's real SessionTransport, as every sender makes one.
if (process.env.MPD_SEND) {
  const { seat, id, body } = JSON.parse(process.env.MPD_SEND) as { seat: string; id: string; body: string };
  const result = await daemon.deps.sessionTransport!.send(seat, body, { deliveryId: id, actorSession: "lead@pump-rig" });
  note(`transport ${id} ${result.reason ?? ""} sent=${String(result.sent)}`);
}
setInterval(() => undefined, 60_000);
