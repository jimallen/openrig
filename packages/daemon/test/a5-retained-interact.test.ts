// a5 / y4 review N2: a `--dangerously-interact` message that carries a paste-end sequence, sent to a seat whose typing guard
// is on. Pins today's behaviour; nothing here changes it.
//   * send() exempts dangerouslyInteract from the entry refusal (it may turn out to be unbracketed prompt input), so the
//     guard RETAINS the message with its body, ok:true / outcome "retained", and writes nothing to the pane.
//   * Nothing ever replays a retained body: the only transitions out of "retained" are retire (a person acknowledges
//     it) and idempotent readback of the same delivery id (which answers "retained" again). So the late refusal y4's
//     reviewer worried about (a replay without the flag meeting the delivery-time refusal) has no caller to happen
//     through; the only late outcomes are the ones asserted below.
//   * A second send of the same text WITHOUT the flag is refused at once and records nothing.
// (The delivery-time refusal itself, guard off, is pinned by y4-paste-input.test.ts.)
// Deployed chain: routes/transport.ts -> SessionTransport.send (startup.ts wires the real SeatDeliveryGuard).
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { SeatDeliveryGuard, type GuardTarget } from "../src/domain/seat-delivery-guard.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { SessionTransport } from "../src/domain/session-transport.js";
import { outboxEntriesSchema } from "../src/db/migrations/027_outbox_entries.js";
import { seatDeliveryGuardSchema } from "../src/db/migrations/087_seat_delivery_guard.js";

const END = "\u001b[201~"; // literal: nothing imported from the module under test
const TEXT = `before${END}after`;

function fixture() {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE nodes(id TEXT PRIMARY KEY); INSERT INTO nodes VALUES ('a');");
  db.exec(outboxEntriesSchema.sql); db.exec(seatDeliveryGuardSchema.sql);
  const target: GuardTarget = { nodeId: "a", session: "a", occupant: "g1", pane: "%1" };
  const guard = new SeatDeliveryGuard(db, name => (name === "a" || name === "%1" ? target : null));
  const commands: string[] = [];
  const files: string[] = [];
  const tmux = new TmuxAdapter(async command => { commands.push(command); return ""; }, {
    writeFile: async (_path, text) => { files.push(text); }, unlink: async () => {},
    tmpName: () => "/inert/launch", bufferName: () => "inert-buffer",
  });
  tmux.deliveryGuard = guard;
  vi.spyOn(tmux, "listPanes").mockImplementation(async () => [{ id: "%1" } as never]);
  const transport = new SessionTransport({ db, tmuxAdapter: tmux, rigRepo: {} as never, sessionRegistry: {} as never, sleep: async () => {} });
  return { db, guard, outbox: new OutboxHandler(db), transport, commands, files };
}

describe("y4 N2: a retained --dangerously-interact message that carries a paste-end sequence", () => {
  it("is retained with its body, nothing is written, and retiring or disabling the guard never sends it", async () => {
    const f = fixture();
    await f.guard.set("a", true, "person", "draft");
    const first = await f.transport.send("a", TEXT, { dangerouslyInteract: true, reason: "drive it", deliveryId: "held-1", actorSession: "orch@r" });
    expect(first).toMatchObject({ ok: true, outcome: "retained", sent: false, outboxIds: ["held-1"] });
    expect(f.outbox.getById("held-1")).toMatchObject({ deliveryState: "retained", body: TEXT, deliveredAt: null });
    await f.guard.set("a", false, "person", "new sends only");
    f.outbox.retire("held-1", "person", "read");
    expect(f.outbox.getById("held-1")).toMatchObject({ deliveryState: "retired", deliveredAt: null });
    expect(f.commands).toEqual([]);
    expect(f.files).toEqual([]);
    f.db.close();
  });

  it("the same id and body sent again without the flag is refused at the entry, and nothing is recorded or written", async () => {
    const f = fixture();
    await f.guard.set("a", true, "person", "draft");
    await f.transport.send("a", TEXT, { dangerouslyInteract: true, reason: "drive it", deliveryId: "held-2", actorSession: "orch@r" });
    const late = await f.transport.send("a", TEXT, { deliveryId: "held-2", actorSession: "orch@r" });
    expect(late).toMatchObject({ ok: false, reason: "paste_terminator_in_text", sent: false });
    expect(f.outbox.heldForNode("a").total).toBe(1);
    expect(f.commands).toEqual([]);
    f.db.close();
  });
});
