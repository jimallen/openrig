// A real daemon for seat-handover-pump.real.test.ts: the real createDaemon and its real `/api/seat/handover` route, on a database file and a private core.
// Stubbed through DaemonOptions, and nothing else: the gate (a file the seat's stub program creates) and the hop, which types through the real core
// under the real delivery guard, as the real hops do. The seat's runtime adapter is a stub too: `launchHarness` types the stub program into the blank
// shell the real successor launcher respawned, and the seat is that program, so no real agent runs.
import { appendFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { HcClient } from "../../src/adapters/hc-client.js";
import { hcTerminalName } from "../../src/adapters/hc-seat.js";
import { StubRuntimeAdapter } from "../../src/adapters/stub-runtime-adapter.js";
import type { TmuxAdapter } from "../../src/adapters/tmux.js";
import type { NodeBinding } from "../../src/domain/runtime-adapter.js";
import { messageId, type GateLookup, type LastHop, type LastHopResult, type SeatGate } from "../../src/domain/seat-messaging/ports.js";
import { createDaemon } from "../../src/startup.js";

const { HPD_DB: db, HPD_DIR: dir, HPD_SEAT: seat, HPD_SEAT_COMMAND: seatCommand } = process.env;
if (!db || !dir || !seat || !seatCommand) throw new Error("HPD_DB, HPD_DIR, HPD_SEAT and HPD_SEAT_COMMAND are required");
const queued = process.env.HPD_QUEUED_DURING_LAUNCH;
const firstBackoffMs = Number(process.env.HPD_BACKOFF_MS ?? 120_000);

const note = (line: string) => appendFileSync(join(dir, "hop.log"), `${line}\n`);
const client = new HcClient();

const gate: SeatGate = {
  version: 1,
  async lookup(_seat, id): Promise<GateLookup> {
    const path = join(dir, "seen", id);
    return existsSync(path) ? { kind: "seen", record: { id: messageId(id), recordedAt: statSync(path).mtime.toISOString(), nonce: null } } : { kind: "not_seen" };
  },
};

let tmux: TmuxAdapter;
const hop: LastHop = {
  attempt(message) {
    return tmux.deliveryGuard!.operation<LastHopResult>(message.seat, async () => {
      const id = message.ids[0];
      note(`claimed ${id}`);
      await client.call("terminal.send", { terminal: hcTerminalName(message.seat), text: `[openrig-msg id=${id}] ${message.body.replace(/\s+/g, " ")}\r` }, { timeoutMs: 8_000 });
      note(`sent ${id}`);
      return { kind: "sent" };
    }).catch((error: unknown) => { note(`guard ${(error as { code?: string }).code ?? String(error)}`); return { kind: "paused", reason: "busy" }; });
  },
};

const daemon = await createDaemon({
  dbPath: db,
  seatMessagingPorts: { gateFor: () => gate, hopFor: () => hop },
  messagePumpTiming: { tickMs: 40, backoffMs: [firstBackoffMs] },
});
tmux = daemon.deps.tmuxAdapter as TmuxAdapter;

const adapter = Object.assign(new StubRuntimeAdapter({ tmux }), {
  async launchHarness(binding: NodeBinding) {
    if (queued) {
      const sent = await daemon.deps.sessionTransport!.send(seat, "queued text", { deliveryId: queued, actorSession: "lead@system" });
      note(`queued ${String(sent.reason)}`);
      await new Promise((resolve) => setTimeout(resolve, 300));  // long enough for a timer pass to reach the hop if nothing holds it
    }
    const typed = await tmux.sendShellCommand(binding.tmuxSession!, seatCommand);
    return typed.ok ? { ok: true as const } : { ok: false as const, error: typed.message };
  },
  async checkReady() {
    return existsSync(join(dir, "ready.successor")) ? { ready: true } : { ready: false, reason: "the stub has not started" };
  },
});
daemon.deps.runtimeAdapters!.stub = adapter;

note("booted");
const response = await daemon.app.request(`/api/seat/handover/${encodeURIComponent(seat)}`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ reason: "s4f real", source: "fresh", operator: "lead@system" }),
});
note(`route ${response.status} ${JSON.stringify(await response.json())}`);
setInterval(() => undefined, 60_000);
