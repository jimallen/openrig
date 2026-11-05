// OF-243. A part whose record the gate cleared (its text was not on the agent's file, OF-229) is sent again labelled as a resend; and a file that
// never shows the text cannot make the gate resend for ever: after three it stops, the record stands, and `rig health` says so.
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { codexSeatGate } from "../src/adapters/codex-seat-gate.js";
import { HookSeenStore, seatGateFolder, seatGateRoot } from "../src/adapters/hook-seen-store.js";
import { MAX_UNCONFIRMED_RESENDS } from "../src/adapters/hook-seat-gate.js";
import { promptMarkers, spooledNote } from "../src/adapters/seat-gate-marker.js";
import { GateUnconfirmedHealthSource } from "../src/domain/seat-messaging/gate-unconfirmed-health.js";
import { messageId } from "../src/domain/seat-messaging/ports.js";

const here = dirname(fileURLToPath(import.meta.url));
const RELAY = resolve(here, "../assets/plugins/openrig-core/hooks/scripts/activity-relay.cjs");
const SEAT = "dev.a@rig";
const NONCE = "a".repeat(32);
const BODY = "the text";
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const RECORDED = "1999-01-01T00:00:00.000Z";
const T0 = Date.parse(RECORDED);
const LABEL = ", resent: not confirmed on file";

describe("OF-243: the note of a resent part", () => {
  const marker = { id: "m", nonce: NONCE };
  it("says so after the part, and nothing else in the note changes, the tag included", () => {
    expect(spooledNote(null, marker, true)).toContain(`OpenRig: long message${LABEL}. Its text comes`);
    expect(spooledNote({ index: 2, total: 3 }, marker, true)).toContain(`OpenRig: long message, part 2 of 3${LABEL}. Its text comes`);
    expect(spooledNote(null, marker, true).replace(LABEL, "")).toBe(spooledNote(null, marker));
    expect(spooledNote(null, marker)).not.toContain("resent");
  });
  it("the daemon and the relay both read it as the note of a long message's short paste", () => {
    const prompt = `${spooledNote({ index: 2, total: 3 }, marker, true)}\n[openrig-msg m:${NONCE}]`;
    expect(prompt).toContain(`part 2 of 3${LABEL}.`);
    expect(promptMarkers(prompt)).toEqual([{ id: "m", nonce: NONCE, spooled: true }]);
    const relay = /const SPOOLED_NOTE = (\/.*\/);/.exec(fs.readFileSync(RELAY, "utf8"))![1]!;
    const note = new RegExp(relay.slice(1, -1));
    expect(note.test(spooledNote(null, marker, true))).toBe(true);
    expect(note.test(spooledNote({ index: 1, total: 2 }, marker, true))).toBe(true);
    expect(note.test(spooledNote(null, marker).replace(".", `${LABEL} again.`))).toBe(false);  // only the one label
  });
});

describe("OF-243: the gate stops resending a part whose text never shows", () => {
  let home: string;
  let missing: string;
  const store = () => new HookSeenStore(seatGateRoot(home), () => new Date(clock));
  let clock = T0;
  const recordPath = () => path.join(seatGateRoot(home), seatGateFolder(SEAT), "seen", createHash("sha256").update(`m:${NONCE}`).digest("hex"));
  const writeRecord = () => {
    fs.mkdirSync(path.dirname(recordPath()), { recursive: true });
    fs.writeFileSync(recordPath(), JSON.stringify({ id: "m", nonce: NONCE, recordedAt: new Date(clock).toISOString(), via: "hook", durable: false, agentPid: null, transcriptPath: null, bodySha256: sha(BODY) }));
  };
  const gate = (maxResends?: number) => codexSeatGate({ store: store(), nonceOf: () => NONCE, rolloutPathOf: () => missing, now: () => clock, bodyGraceMs: 1000, ...(maxResends === undefined ? {} : { maxResends }) });
  /** One cycle: the relay writes its record, the grace passes, the pump reads the gate. */
  const cycle = async (g = gate()) => { writeRecord(); clock += 1000; return (await g.lookup(SEAT, messageId("m"))).kind; };
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(process.env.OPENRIG_TEST_SCRATCH_ROOT ?? os.tmpdir(), "resend-"));
    missing = path.join(home, "never-there.jsonl");
    fs.mkdirSync(path.join(seatGateRoot(home), seatGateFolder(SEAT)), { recursive: true });
    fs.writeFileSync(path.join(seatGateRoot(home), seatGateFolder(SEAT), "gate.json"), JSON.stringify({ version: 2 }));
    clock = T0;
  });
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

  it("the limit is three, written here as a literal", () => {
    expect(MAX_UNCONFIRMED_RESENDS).toBe(3);
  });
  it("three clears and three resends, each counted; the fourth read keeps the record and says nothing is lost to resend", async () => {
    for (const resent of [1, 2, 3]) {
      expect(await cycle()).toBe("not_seen");
      expect(store().resentOf(SEAT, { id: "m", nonce: NONCE })).toBe(resent);
      expect(fs.existsSync(recordPath())).toBe(false);
    }
    expect(await cycle()).toBe("seen");
    expect(fs.existsSync(recordPath())).toBe(true);
    expect(store().resentOf(SEAT, { id: "m", nonce: NONCE })).toBe(3);
    expect(store().gaveUp(86_400_000)).toEqual([{ seat: SEAT, id: "m", at: new Date(clock).toISOString() }]);
  });
  it("after it gives up it stays given up, and counts nothing more", async () => {
    for (let i = 0; i < 3; i += 1) await cycle();
    await cycle();
    const at = store().gaveUp(86_400_000)[0]!.at;
    clock += 500_000;
    for (let i = 0; i < 3; i += 1) expect(await cycle()).toBe("seen");
    expect(store().resentOf(SEAT, { id: "m", nonce: NONCE })).toBe(3);
    expect(store().gaveUp(86_400_000)).toHaveLength(1);
    expect(store().gaveUp(86_400_000)[0]!.at).toBe(at);  // not rewritten
  });
  it("the limit is the gate's own to set", async () => {
    expect(await cycle(gate(1))).toBe("not_seen");
    expect(await cycle(gate(1))).toBe("seen");
  });
  it("a text that shows up on file resets nothing it needs to: the record is believed, whatever the count", async () => {
    expect(await cycle()).toBe("not_seen");
    writeRecord();
    fs.writeFileSync(missing, `${JSON.stringify({ type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: BODY }] } })}\n`);
    clock += 1000;
    expect((await gate().lookup(SEAT, messageId("m"))).kind).toBe("seen");
    expect(store().gaveUp(86_400_000)).toEqual([]);
  });
  it("the count goes with the message, and the finding stays for a day", async () => {
    for (let i = 0; i < 4; i += 1) await cycle();
    store().discardSpool(SEAT);
    expect(store().resentOf(SEAT, { id: "m", nonce: NONCE })).toBe(0);
    expect(store().gaveUp(86_400_000)).toHaveLength(1);
    clock += 86_400_001;
    expect(store().gaveUp(86_400_000)).toEqual([]);
    expect(fs.readdirSync(path.join(seatGateRoot(home), seatGateFolder(SEAT), "gave-up"))).toEqual([]);  // deleted, not hidden
  });
  it("rig health names the part, its seat, and what to check; it is empty when nothing was given up", async () => {
    const health = new GateUnconfirmedHealthSource(store(), () => new Date(clock));
    expect(health.coverage()).toEqual([]);
    for (let i = 0; i < 4; i += 1) await cycle();
    const rows = health.coverage();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: "seat-gate-unconfirmed", status: "notice", partial: false });
    expect(rows[0]!.reason).toContain(`m to ${SEAT}`);
    expect(rows[0]!.reason).toContain("rollout path");
    expect(health.read()).toEqual([]);
  });
});
