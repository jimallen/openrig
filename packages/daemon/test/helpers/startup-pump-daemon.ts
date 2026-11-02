// A real daemon for startup-pump.real.test.ts: the real createDaemon on a database file and a private core, with a real StartupOrchestrator on the daemon's own
// seat host, so its guard, pump and hand-off are the daemon's. Stubbed through DaemonOptions, and nothing else: the gate (a file the seat's stub program creates)
// and the hop, which types through the real core under the real delivery guard, as the real hops do. The runtime adapter is the stub's, so no real agent runs.
import { appendFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { HcClient } from "../../src/adapters/hc-client.js";
import { hcTerminalName } from "../../src/adapters/hc-seat.js";
import { guarded } from "../../src/adapters/seat-hops.js";
import { StubRuntimeAdapter, type StubAdapterFsOps } from "../../src/adapters/stub-runtime-adapter.js";
import type { TmuxAdapter } from "../../src/adapters/tmux.js";
import type { NodeBinding, ResolvedStartupFile } from "../../src/domain/runtime-adapter.js";
import { messageId, type GateLookup, type LastHop, type SeatGate } from "../../src/domain/seat-messaging/ports.js";
import { StartupOrchestrator } from "../../src/domain/startup-orchestrator.js";
import { createDaemon } from "../../src/startup.js";

const { SPD_DB: db, SPD_DIR: dir, SPD_SEAT: seat, SPD_SEAT_COMMAND: seatCommand, SPD_NODE: nodeId, SPD_RIG: rigId, SPD_SESSION: sessionId } = process.env;
if (!db || !dir || !seat || !seatCommand || !nodeId || !rigId || !sessionId) throw new Error("SPD_DB, SPD_DIR, SPD_SEAT, SPD_SEAT_COMMAND, SPD_NODE, SPD_RIG and SPD_SESSION are required");
const queued = process.env.SPD_QUEUED_DURING_LAUNCH;
const newOccupant = process.env.SPD_NEW_OCCUPANT_DURING_LAUNCH === "1";
const waitMs = Number(process.env.SPD_WAIT_MS ?? 20_000);

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
    return guarded(tmux.deliveryGuard!, message.seat, async () => {
      const id = message.ids[0];
      note(`claimed ${id}`);
      await client.call("terminal.send", { terminal: hcTerminalName(message.seat), text: `[openrig-msg id=${id}] ${message.body.replace(/\s+/g, " ")}\r` }, { timeoutMs: 8_000 });
      return { kind: "sent" };
    });
  },
};

const daemon = await createDaemon({
  dbPath: db,
  seatMessagingPorts: { gateFor: () => gate, hopFor: () => hop },
  messagePumpTiming: { tickMs: 200, pauseRecheckMs: 300 },
});
tmux = daemon.deps.tmuxAdapter as TmuxAdapter;
const sessions = daemon.deps.sessionRegistry;

let minted = false;
const fsOps: StubAdapterFsOps = { readFile: (path) => readFileSync(path, "utf8"), writeFile: () => undefined, exists: existsSync, mkdirp: () => undefined };
const adapter = Object.assign(new StubRuntimeAdapter({ tmux, fsOps }), {
  async launchHarness(binding: NodeBinding) {
    if (queued) {
      const sent = await daemon.deps.sessionTransport!.send(seat, "queued text", { deliveryId: queued, actorSession: "lead@system" });
      note(`queued ${String(sent.reason)}`);
      await new Promise((resolve) => setTimeout(resolve, 600));  // long enough for timer passes to reach the hop if nothing holds it
    }
    const typed = await tmux.sendShellCommand(binding.tmuxSession!, seatCommand);
    return typed.ok ? { ok: true as const } : { ok: false as const, error: typed.message };
  },
  async checkReady() {
    if (!existsSync(join(dir, "ready.seat"))) return { ready: false, reason: "the stub has not started" };
    // After the launch's own typing, which the delivery guard would refuse once its occupant changed.
    if (newOccupant && !minted) { minted = true; sessions.mintOccupantTenure(nodeId, "fresh"); }
    return { ready: true };
  },
});

const file = (name: string): ResolvedStartupFile => ({ path: name, absolutePath: join(dir, name), ownerRoot: dir, deliveryHint: "send_text", required: true, appliesOn: ["fresh_start"] });
const orchestrator = new StartupOrchestrator({ db: daemon.db, sessionRegistry: sessions, eventBus: daemon.deps.eventBus, tmuxAdapter: tmux, startupTextWaitMs: waitMs });

note("booted");
const result = await orchestrator.startNode({
  rigId, nodeId, sessionId, adapter, isRestore: false, startupActions: [],
  binding: { id: "b", nodeId, tmuxSession: seat, tmuxWindow: null, tmuxPane: null, updatedAt: "", cwd: dir },
  plan: { runtime: "stub", cwd: dir, entries: [], startup: { files: [], actions: [] }, conflicts: [], noOps: [], diagnostics: [] },
  resolvedStartupFiles: [file("one.txt"), file("two.txt")],
});
note(`result ${JSON.stringify(result)}`);
setInterval(() => undefined, 60_000);
