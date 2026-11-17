// A real daemon for codex-gate-current-session.real.test.ts: createDaemon on a database file and a private core (the env says which), nothing
// stubbed but the capture of the seat-messaging ports startup builds (its own wrapSeatMessagingPorts option). It asks the seat's gate whether
// one message reached the seat and writes the answer to CGS_OUT.
import { writeFileSync } from "node:fs";
import { createDaemon } from "../../src/startup.js";
import { messageId } from "../../src/domain/seat-messaging/ports.js";
import type { SeatMessagingPorts } from "../../src/domain/seat-messaging/pump-ports.js";

const { CGS_DB: db, CGS_OUT: out, CGS_SEAT: seat, CGS_MESSAGE: id } = process.env;
if (!db || !out || !seat || !id) throw new Error("CGS_DB, CGS_OUT, CGS_SEAT and CGS_MESSAGE are required");

let ports: SeatMessagingPorts | undefined;
await createDaemon({ dbPath: db, wrapSeatMessagingPorts: (real) => { ports = real; return real; } });
const gate = ports?.gateFor(seat);
const answer = gate ? await gate.lookup(seat, messageId(id)) : null;
writeFileSync(out, JSON.stringify({ hasGate: Boolean(gate), answer }));
process.exit(0);
