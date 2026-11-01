// The daemon child for test/delivery-review.real.test.ts, from the QA reviewer's kit: createDaemon's real ports and a real HTTP listener for the
// relay, on a private port. The hop is wrapped only to log and, on `fast_hop`, to return at once as the socket hop does.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import type { ClaudeNativeInbox } from "../../src/domain/claude-native-inbox.js";
import type { LastHop } from "../../src/domain/seat-messaging/ports.js";
import { createDaemon } from "../../src/startup.js";
const { MPD_DB: db, MPD_DIR: dir, MPD_CRASH: crash = "none", DELIVERY_PORT: port, DELIVERY_TIMING: timing } = process.env;
if (!db || !dir) throw new Error("MPD_DB and MPD_DIR are required");
const note = (line: string) => appendFileSync(join(dir, "hop.log"), `${line}\n`);
const hang = () => new Promise<never>(() => undefined);
const noted = (hop: LastHop): LastHop => ({
  attempt: async (message) => {
    const id = message.ids[0];
    note(`claimed ${id}`);
    if (crash === "before_bytes") return hang();
    // The socket hop's shape: the write returns in ms and the prompt lands later. Real paste underneath, the pump just isn't kept waiting.
    if (crash === "fast_hop") { void hop.attempt(message).catch(() => undefined); return { kind: "sent" as const }; }
    const result = await hop.attempt(message);
    note(`${result.kind === "paused" ? `paused:${result.reason}` : result.kind} ${id}`);
    if (crash === "after_bytes" && result.kind === "sent") return hang();
    return result;
  },
});
let inbox: ClaudeNativeInbox | undefined;
const daemon = await createDaemon({
  dbPath: db,
  onClaudeInboxReady: (ready) => { inbox = ready; },
  wrapSeatMessagingPorts: (ports) => ({ gateFor: (seat) => ports.gateFor(seat), hopFor: (seat) => { const hop = ports.hopFor(seat); return hop ? noted(hop) : null; } }),
  messagePumpTiming: timing ? JSON.parse(timing) : { tickMs: 40, pauseRecheckMs: 80, backoffMs: [300, 300, 300] },
});
if (port) await new Promise<void>((ok) => serve({ fetch: daemon.app.fetch, port: Number(port), hostname: "127.0.0.1" }, () => ok()));
note("booted");
const register = join(dir, "register-claude");
let registered = false;
setInterval(() => {
  if (registered || !existsSync(register)) return;
  registered = true;
  const input = JSON.parse(readFileSync(register, "utf8")) as { nodeId: string; sessionName: string; transcriptPath: string };
  void inbox?.registerEndpoint({ ...input, generation: null, socketPath: join(dir, "no.sock"), claudePid: process.pid, execPath: null }).then(() => note("registered"));
}, 50).unref();
setInterval(() => undefined, 60_000);
