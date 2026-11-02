// A real daemon process for S4b and S4c: the real createDaemon on a database file and a private core, with a stub gate and hop as in
// message-pump-daemon.ts. The parent decides what happens through CPD_ACT: a restore.completed on the daemon's event bus, or scans of a job
// through the daemon's real watchdog engine. The hop pauses while the file `stopped` exists: a seat that is down.
import { appendFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { HcClient } from "../../src/adapters/hc-client.js";
import { hcTerminalName } from "../../src/adapters/hc-seat.js";
import { messageId, type GateLookup, type LastHop, type SeatGate } from "../../src/domain/seat-messaging/ports.js";
import { createDaemon } from "../../src/startup.js";

const { CPD_DB: db, CPD_DIR: dir, CPD_ACT: act, CPD_FIRST_DELAY_MS: firstDelay = "0" } = process.env;
if (!db || !dir) throw new Error("CPD_DB and CPD_DIR are required");

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
    if (existsSync(join(dir, "stopped"))) return { kind: "paused", reason: "seat_stopped" };
    note(`claimed ${id}`);
    note(`body ${id} ${message.body.replace(/\s+/g, " ")}`);
    await client.call("terminal.send", { terminal: hcTerminalName(message.seat), text: `[openrig-msg id=${id}] ${message.body.replace(/\s+/g, " ")}` }, { timeoutMs: 8_000 });
    return { kind: "sent" };
  },
};

const daemon = await createDaemon({
  dbPath: db,
  seatMessagingPorts: { gateFor: () => gate, hopFor: () => hop },
  messagePumpTiming: { tickMs: 40, pauseRecheckMs: 80, backoffMs: [300, 300, 300] },
  postRestartTiming: { firstDelayMs: Number(firstDelay) },
});
note("booted");
const action = act ? JSON.parse(act) as { restore?: { rigId: string; nodeId: string }; scan?: { jobIds: string[]; times: number } } : {};
if (action.restore) {
  const { rigId, nodeId } = action.restore;
  daemon.deps.eventBus.emit({ type: "restore.completed", rigId, snapshotId: "s", result: { snapshotId: "s", preRestoreSnapshotId: null, rigResult: "fully_restored", warnings: [], nodes: [{ nodeId, logicalId: "dev", status: "resumed" }] } });
  note("restored");
}
if (action.scan) {
  for (let i = 0; i < action.scan.times; i++) {
    for (const jobId of action.scan.jobIds) {
      const result = await daemon.deps.watchdogPolicyEngine!.evaluate(daemon.deps.watchdogJobsRepo!.getByIdOrThrow(jobId));
      note(`scan ${result.delivery?.status ?? "none"} ${result.history?.outcome ?? "none"}`);
    }
    await new Promise((r) => setTimeout(r, 1_100));  // the job's last fire is the occurrence, and it is a timestamp
  }
  note("scanned");
}
setInterval(() => undefined, 60_000);
