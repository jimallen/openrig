// A real daemon for seat-posture-startup.real.test.ts: createDaemon on a database file and a private core (the env says which), nothing stubbed.
// It asks the daemon two things about one seat and writes the answers to SPS_OUT: what the SessionTransport startup built would put on a
// "not yet received" answer, and what the node list route serves for the seat.
import { writeFileSync } from "node:fs";
import { createDaemon } from "../../src/startup.js";

const { SPS_DB: db, SPS_OUT: out, SPS_SEAT: seat, SPS_RIG: rigId } = process.env;
if (!db || !out || !seat || !rigId) throw new Error("SPS_DB, SPS_OUT, SPS_SEAT and SPS_RIG are required");

const daemon = await createDaemon({ dbPath: db });
const viaTransport = await daemon.deps.sessionTransport?.seatPostureFor(seat);
const list = (await (await daemon.app.request(`/api/rigs/${rigId}/nodes`)).json()) as Array<{ canonicalSessionName?: string; seatPosture?: unknown }>;
const viaRoute = list.find((n) => n.canonicalSessionName === seat)?.seatPosture ?? null;
writeFileSync(out, JSON.stringify({ hasReaderInDeps: typeof daemon.deps.seatTerminalStatus === "function", viaTransport, viaRoute }));
process.exit(0);
