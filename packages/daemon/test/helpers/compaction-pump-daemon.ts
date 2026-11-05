// A real daemon process for test/compaction-pump.real.test.ts: the real createDaemon on a database file and a private core, the real enforcer and
// the real pump, with a stub gate and hop as in message-pump-daemon.ts. The parent decides when a poll runs: it makes the file `tick`, and one
// drain runs, as ContextMonitor's would. MPD_CRASH hangs one attempt at a named point, so the parent can SIGKILL it there.
import { appendFileSync, existsSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { HcClient } from "../../src/adapters/hc-client.js";
import { hcTerminalName } from "../../src/adapters/hc-seat.js";
import { messageId, type GateLookup, type LastHop, type SeatGate } from "../../src/domain/seat-messaging/ports.js";
import { createDaemon } from "../../src/startup.js";

const { MPD_DB: db, MPD_DIR: dir, MPD_SEAT: seat, MPD_CRASH: crash = "none" } = process.env;
if (!db || !dir || !seat) throw new Error("MPD_DB, MPD_DIR and MPD_SEAT are required");

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
    if (crash === "before_bytes") return new Promise<never>(() => undefined);
    await client.call("terminal.send", { terminal: hcTerminalName(message.seat), text: `[openrig-msg id=${id}] ${message.body}` }, { timeoutMs: 8_000 });
    note(`sent ${id}`);
    return { kind: "sent" };
  },
};

const daemon = await createDaemon({
  dbPath: db,
  seatMessagingPorts: { gateFor: () => gate, hopFor: () => hop },
  messagePumpTiming: { tickMs: 40, pauseRecheckMs: 100, backoffMs: [300, 300, 300] },
});
// OF-241 measurement (opt-in, MPD_LEASE_LOG=<file>): how long each lifecycle lease the enforcer takes is HELD, from the moment it runs `fn` to the moment `fn` returns
// (the wait for the seat's queue is not counted). Nothing else changes.
const leaseLog = process.env.MPD_LEASE_LOG;
const guard = daemon.deps.tmuxAdapter?.deliveryGuard;
if (leaseLog && guard) {
  const lifecycle = guard.lifecycle.bind(guard) as <T>(ids: string[], fn: () => Promise<T>) => Promise<T>;
  (guard as unknown as { lifecycle: typeof lifecycle }).lifecycle = (ids, fn) => lifecycle(ids, async () => {
    const started = performance.now();
    try { return await fn(); } finally { appendFileSync(leaseLog, `lease ${ids.length} seat(s) held ${Math.round(performance.now() - started)} ms\n`); }
  });
}
const enforcer = daemon.deps.compactionEnforcer;
if (!enforcer) throw new Error("the daemon built no enforcer");
note("booted");

const tick = join(dir, "tick");
let polling = false;
setInterval(() => {
  if (polling || !existsSync(tick)) return;
  polling = true;
  rmSync(tick);
  void enforcer.drainPendingPostCompactStage({ sessionName: seat, runtime: "claude-code" })
    .then((outcome) => note(`drained ${outcome.triggered ? "triggered" : outcome.reason}`), (error: Error) => note(`drain threw ${error.message}`))
    .finally(() => { polling = false; });
}, 20);
setInterval(() => undefined, 60_000);
