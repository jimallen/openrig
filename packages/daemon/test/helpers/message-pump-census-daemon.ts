// The real daemon for the census crash table: createDaemon with its real RuntimeSeatPorts, real hop, real gate reader and real hook-store
// layout. The only additions are a short schedule, and MPD_CRASH, which hangs one attempt at a named point so the parent can SIGKILL there.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ClaudeNativeInbox } from "../../src/domain/claude-native-inbox.js";
import type { LastHop } from "../../src/domain/seat-messaging/ports.js";
import { createDaemon } from "../../src/startup.js";

const { MPD_DB: db, MPD_DIR: dir, MPD_CRASH: crash = "none" } = process.env;
if (!db || !dir) throw new Error("MPD_DB and MPD_DIR are required");
const note = (line: string) => appendFileSync(join(dir, "hop.log"), `${line}\n`);
const hang = () => new Promise<never>(() => undefined);

const noted = (hop: LastHop): LastHop => ({
  forget: (seat) => hop.forget?.(seat),
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

let reconcileSeat: ((sessionName: string, threadId: string | null) => void) | undefined;
let inbox: ClaudeNativeInbox | undefined;
const daemon = await createDaemon({
  dbPath: db,
  onClaudeInboxReady: (ready) => { inbox = ready; },
  onCodexReconcileReady: (reconcile) => { reconcileSeat = reconcile; },
  wrapSeatMessagingPorts: (ports) => ({ gateFor: (seat) => ports.gateFor(seat), hopFor: (seat) => { const hop = ports.hopFor(seat); return hop ? noted(hop) : null; } }),
  messagePumpTiming: { tickMs: 40, pauseRecheckMs: 80, backoffMs: [300, 300, 300] },
});
note("booted");
if (process.env.MPD_SEND) {
  const { seat, id, body } = JSON.parse(process.env.MPD_SEND) as { seat: string; id: string; body: string };
  const result = await daemon.deps.sessionTransport!.send(seat, body, { deliveryId: id, actorSession: "lead@cr" });
  note(`transport ${id} ${result.reason ?? ""} sent=${String(result.sent)}`);
}
// A seat restart's reconcile: startup's own closure. The parent asks by making this file.
const reconcile = join(dir, "reconcile");
const seat = process.env.MPD_SEAT;
setInterval(() => {
  if (!seat || !existsSync(reconcile)) return;
  reconcileSeat?.(seat, null);
  note("reconciled");
  appendFileSync(reconcile + ".done", "x");
}, 50).unref();
// A new Claude process on the seat: the daemon's own registration, as the relay's SessionStart makes it.
const register = join(dir, "register-claude");
let registered = false;
setInterval(() => {
  if (registered || !existsSync(register)) return;
  registered = true;
  const input = JSON.parse(readFileSync(register, "utf8")) as { nodeId: string; sessionName: string; transcriptPath: string };
  void inbox?.registerEndpoint({ ...input, generation: null, socketPath: join(dir, "no.sock"), claudePid: process.pid, execPath: null }).then(() => note("registered"));
}, 50).unref();
setInterval(() => undefined, 60_000);
