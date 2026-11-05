// OF-229. Real Codex 0.166.0 takes a hook's output only from a hook that exited, so a relay killed after it wrote its gate record leaves a record
// and an agent without the text (measured; delivery-review.real.test.ts has the end-to-end row). These rows pin the pieces: the record names its
// text, the Codex rollout is read for it, and the gate and the restart reconcile believe the record only when the text is there.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path, { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { codexRolloutBodies, codexSeatGate, reconcileCodexSeatGate } from "../src/adapters/codex-seat-gate.js";
import { hookSeatGate } from "../src/adapters/hook-seat-gate.js";
import { HookSeenStore, reconcileSeen, seatGateFolder, seatGateRoot } from "../src/adapters/hook-seen-store.js";
import { spooledNote } from "../src/adapters/seat-gate-marker.js";
import { messageId } from "../src/domain/seat-messaging/ports.js";

const here = dirname(fileURLToPath(import.meta.url));
const RELAY = resolve(here, "../assets/plugins/openrig-core/hooks/scripts/activity-relay.cjs");
const SEAT = "dev.a@rig";
const NONCE = "a".repeat(32);
const BODY = "the long text, with é and 😀";
/** Restated here on purpose: a pin must not import the recipe it pins. */
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const developerLine = (text: string, role = "developer") => JSON.stringify({ type: "response_item", payload: { type: "message", role, content: [{ type: "input_text", text }] } });
const userLine = (text: string) => developerLine(text, "user");
const NOTE_PROMPT = `${spooledNote(null, { id: "m", nonce: NONCE })}\n[openrig-msg m:${NONCE}]`;
/** 1999: far from wall clock, so a gate that read the real clock instead of the injected one would see every record as ancient. */
const RECORDED = "1999-01-01T00:00:00.000Z";
const T0 = Date.parse(RECORDED);

describe("OF-229: a long message's gate record names its text", () => {
  let home: string;
  beforeEach(() => { home = fs.mkdtempSync(path.join(process.env.OPENRIG_TEST_SCRATCH_ROOT ?? os.tmpdir(), "body-")); });
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

  it("the relay's record carries the sha256 of the exact text it wrote to stdout, by UTF-8 bytes", () => {
    new HookSeenStore(seatGateRoot(home)).spool(SEAT, { id: "m", nonce: NONCE }, BODY);
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: home, OPENRIG_HOME: home, OPENRIG_SESSION_NAME: SEAT, OPENRIG_RUNTIME: "codex" };
    const ran = spawnSync(process.execPath, [RELAY], { input: JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: NOTE_PROMPT, transcript_path: path.join(home, "t") }), env, encoding: "utf8" });
    expect(ran.status).toBe(0);
    const record = new HookSeenStore(seatGateRoot(home)).list(SEAT);
    expect(record).toHaveLength(1);
    expect(JSON.parse(ran.stdout).hookSpecificOutput.additionalContext).toBe(BODY);
    expect(record[0]!.bodySha256).toBe(sha(BODY));
    expect(record[0]!.bodySha256).not.toBe(createHash("sha256").update(BODY, "latin1").digest("hex"));  // not another encoding
  });
});

describe("OF-229: what Codex was given as context", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(process.env.OPENRIG_TEST_SCRATCH_ROOT ?? os.tmpdir(), "rollout-")); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it("the hash of each developer message's text, and nothing else: a user prompt or another role with the same text is not the hook's context", () => {
    const file = path.join(dir, "r.jsonl");
    fs.writeFileSync(file, [developerLine(BODY), userLine("only a user said this"), developerLine("an assistant said this", "assistant"), JSON.stringify({ type: "event_msg", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "wrong record type" }] } })].join("\n") + "\n");
    expect([...codexRolloutBodies(file)!]).toEqual([sha(BODY)]);
  });
  it("only an input_text part is context: the same text in any other part type is not", () => {
    const file = path.join(dir, "r.jsonl");
    const part = (type: string) => JSON.stringify({ type: "response_item", payload: { type: "message", role: "developer", content: [{ type, text: BODY }] } });
    fs.writeFileSync(file, `${part("output_text")}\n${part("refusal")}\n`);
    expect(codexRolloutBodies(file)!.size).toBe(0);
    fs.appendFileSync(file, `${part("input_text")}\n`);
    expect([...codexRolloutBodies(file)!]).toEqual([sha(BODY)]);
  });
  it("a user record that happens to carry the word developer in another field is still a user record", () => {
    const file = path.join(dir, "r.jsonl");
    fs.writeFileSync(file, `${JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", phase: "developer", content: [{ type: "input_text", text: "user text" }] } })}\n`);
    expect(codexRolloutBodies(file)!.size).toBe(0);
  });
  it("a torn last line is not context yet, a file that is not there is empty, one that cannot be read is unknown", () => {
    const file = path.join(dir, "r.jsonl");
    fs.writeFileSync(file, `${developerLine("whole")}\n${developerLine("torn").slice(0, 40)}`);
    expect([...codexRolloutBodies(file)!]).toEqual([sha("whole")]);
    expect(codexRolloutBodies(path.join(dir, "missing.jsonl"))?.size).toBe(0);
    expect(codexRolloutBodies(dir)).toBeNull();  // a directory: EISDIR, not ENOENT
  });
});

describe("OF-229: the record is believed when the text is on file", () => {
  let home: string;
  let rollout: string;
  const store = () => new HookSeenStore(seatGateRoot(home));
  const recordPath = (id = "m") => path.join(seatGateRoot(home), seatGateFolder(SEAT), "seen", createHash("sha256").update(`${id}:${NONCE}`).digest("hex"));
  const writeRecord = (extra: Record<string, unknown> = { bodySha256: sha(BODY) }, id = "m") => {
    fs.mkdirSync(path.dirname(recordPath(id)), { recursive: true });
    fs.writeFileSync(recordPath(id), JSON.stringify({ id, nonce: NONCE, recordedAt: RECORDED, via: "hook", durable: false, agentPid: null, transcriptPath: null, ...extra }));
  };
  let clock = T0;
  const gate = (over: { rollouts?: string[]; grace?: number } = {}) => codexSeatGate({ store: store(), nonceOf: () => NONCE, rolloutPathOf: () => (over.rollouts ?? [rollout])[0] ?? null, bodyGraceMs: over.grace ?? 10_000, now: () => clock });
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(process.env.OPENRIG_TEST_SCRATCH_ROOT ?? os.tmpdir(), "bodygate-"));
    rollout = path.join(home, "rollout.jsonl");
    fs.mkdirSync(path.join(seatGateRoot(home), seatGateFolder(SEAT)), { recursive: true });
    fs.writeFileSync(path.join(seatGateRoot(home), seatGateFolder(SEAT), "gate.json"), JSON.stringify({ version: 2 }));
    fs.writeFileSync(rollout, `${userLine(NOTE_PROMPT)}\n`);
    clock = T0;
  });
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

  it("the note is on file and the text is not, inside the grace: not yet, and the record stays", async () => {
    writeRecord();
    clock = T0 + 9_999;
    expect(await gate().lookup(SEAT, messageId("m"))).toEqual({ kind: "unavailable", cause: "body_unconfirmed" });
    expect(fs.existsSync(recordPath())).toBe(true);
  });
  it("the same, past the grace: the relay was killed after its record. The record is cleared and the message is not seen, so the next attempt passes the relay again", async () => {
    writeRecord();
    clock = T0 + 10_000;
    expect(await gate().lookup(SEAT, messageId("m"))).toEqual({ kind: "not_seen" });
    expect(fs.existsSync(recordPath())).toBe(false);
    expect(store().read(SEAT, { id: "m", nonce: NONCE }).kind).toBe("not_seen");
  });
  it("the text on file: seen, at any age, and the record stays", async () => {
    writeRecord();
    fs.appendFileSync(rollout, `${developerLine(BODY)}\n`);
    for (const age of [0, 9_999, 10_000, 86_400_000]) {
      clock = T0 + age;
      expect((await gate().lookup(SEAT, messageId("m"))).kind).toBe("seen");
    }
    expect(fs.existsSync(recordPath())).toBe(true);
  });
  it("another text on file is not this one", async () => {
    writeRecord();
    fs.appendFileSync(rollout, `${developerLine(`${BODY} `)}\n`);
    clock = T0 + 10_000;
    expect((await gate().lookup(SEAT, messageId("m"))).kind).toBe("not_seen");
  });
  it("a file that cannot be read proves nothing, so nothing is cleared however old the record is", async () => {
    writeRecord();
    clock = T0 + 1;
    expect(await gate({ rollouts: [home] }).lookup(SEAT, messageId("m"))).toEqual({ kind: "unavailable", cause: "transcript_unreadable" });
    clock = T0 + 86_400_000;
    await gate({ rollouts: [home] }).lookup(SEAT, messageId("m"));
    expect(fs.existsSync(recordPath())).toBe(true);
  });
  it("OF-229 round 2: a file that stays unreadable cannot hold the lane for ever. Inside the grace it is unavailable; from the grace on the record stands, as before the fix, and is not cleared", async () => {
    writeRecord();
    clock = T0 + 9_999;
    expect(await gate({ rollouts: [home] }).lookup(SEAT, messageId("m"))).toEqual({ kind: "unavailable", cause: "transcript_unreadable" });
    for (const age of [10_000, 86_400_000]) {
      clock = T0 + age;
      expect((await gate({ rollouts: [home] }).lookup(SEAT, messageId("m"))).kind).toBe("seen");
    }
    expect(fs.existsSync(recordPath())).toBe(true);
  });
  it("a rollout that is not there past the grace is a file with no text in it: cleared, and resent", async () => {
    writeRecord();
    clock = T0 + 10_000;
    expect((await gate({ rollouts: [path.join(home, "nope.jsonl")] }).lookup(SEAT, messageId("m"))).kind).toBe("not_seen");
    expect(fs.existsSync(recordPath())).toBe(false);
  });
  it("the production grace is 30 seconds, written here as a literal: 29 999 ms in, the text may still be coming; at 30 000 it is taken as lost", async () => {
    const production = () => codexSeatGate({ store: store(), nonceOf: () => NONCE, rolloutPathOf: () => rollout, now: () => clock });
    writeRecord();
    clock = T0 + 29_999;
    expect(await production().lookup(SEAT, messageId("m"))).toEqual({ kind: "unavailable", cause: "body_unconfirmed" });
    clock = T0 + 30_000;
    expect((await production().lookup(SEAT, messageId("m"))).kind).toBe("not_seen");
    expect(fs.existsSync(recordPath())).toBe(false);
  });
  it("the record's own transcript path is searched when the daemon knows no rollout: the text there makes it seen, and its absence there past the grace does not", async () => {
    clock = T0 + 86_400_000;
    writeRecord({ bodySha256: sha(BODY), transcriptPath: rollout });
    expect((await gate({ rollouts: [] }).lookup(SEAT, messageId("m"))).kind).toBe("not_seen");
    expect(fs.existsSync(recordPath())).toBe(false);
    writeRecord({ bodySha256: sha(BODY), transcriptPath: rollout });
    fs.appendFileSync(rollout, `${developerLine(BODY)}\n`);
    expect((await gate({ rollouts: [] }).lookup(SEAT, messageId("m"))).kind).toBe("seen");
  });
  it("a record of an older relay names no text, a durable one was settled from the file, and a seat with no file known has nothing to look in: each stands as before", async () => {
    clock = T0 + 86_400_000;
    writeRecord({});
    expect((await gate().lookup(SEAT, messageId("m"))).kind).toBe("seen");
    writeRecord({ bodySha256: sha(BODY), durable: true });
    expect((await gate().lookup(SEAT, messageId("m"))).kind).toBe("seen");
    writeRecord({ bodySha256: sha(BODY) });
    expect((await gate({ rollouts: [] }).lookup(SEAT, messageId("m"))).kind).toBe("seen");
  });
  it("a gate with no way to read the text (Claude's) believes the record as before", async () => {
    writeRecord();
    clock = T0 + 86_400_000;
    const claude = hookSeatGate({ store: store(), nonceOf: () => NONCE, transcriptsOf: () => [rollout], fileIncludes: () => false, now: () => clock });
    expect((await claude.lookup(SEAT, messageId("m"))).kind).toBe("seen");
  });
  it("a numbered part is judged by its own text, under its row's nonce", async () => {
    writeRecord({ bodySha256: sha("part two") }, "m.part2of2");
    fs.appendFileSync(rollout, `${developerLine("part one")}\n`);
    clock = T0 + 10_000;
    expect((await gate().lookup(SEAT, messageId("m.part2of2"), messageId("m"))).kind).toBe("not_seen");
    writeRecord({ bodySha256: sha("part two") }, "m.part2of2");
    fs.appendFileSync(rollout, `${developerLine("part two")}\n`);
    expect((await gate().lookup(SEAT, messageId("m.part2of2"), messageId("m"))).kind).toBe("seen");
  });

  describe("a seat restart settles the same way", () => {
    it("the note and the text on file: the record is made durable", () => {
      writeRecord();
      fs.appendFileSync(rollout, `${developerLine(BODY)}\n`);
      expect(reconcileCodexSeatGate(store(), SEAT, rollout)).toEqual({ received: [], cleared: [], unsettled: [] });
      const read = store().read(SEAT, { id: "m", nonce: NONCE });
      expect(read.kind === "seen" && read.record.durable).toBe(true);
    });
    it("the note on file and the text not: the record is cleared, not made durable, so the pump resends it", () => {
      writeRecord();
      expect(reconcileCodexSeatGate(store(), SEAT, rollout)).toEqual({ received: [], cleared: [{ id: "m", nonce: NONCE }], unsettled: [] });
      expect(fs.existsSync(recordPath())).toBe(false);
    });
    it("a file that cannot be read for the text settles nothing, and clears nothing", () => {
      writeRecord();
      const done = reconcileSeen({ store: store(), seat: SEAT, transcripts: [rollout], processAlive: () => false, agentGone: true, markers: () => new Map([[`m:${NONCE}`, { id: "m", nonce: NONCE, spooled: true }]]), bodies: () => null });
      expect(done).toEqual({ received: [], cleared: [], unsettled: [{ id: "m", nonce: NONCE }] });
      const read = store().read(SEAT, { id: "m", nonce: NONCE });
      expect(read.kind === "seen" && read.record.durable).toBe(false);
    });
    it("a reconcile given no way to read the text settles as before (Claude's)", () => {
      writeRecord();
      const done = reconcileSeen({ store: store(), seat: SEAT, transcripts: [rollout], processAlive: () => false, agentGone: true, markers: () => new Map([[`m:${NONCE}`, { id: "m", nonce: NONCE, spooled: true }]]) });
      expect(done).toEqual({ received: [], cleared: [], unsettled: [] });
      const read = store().read(SEAT, { id: "m", nonce: NONCE });
      expect(read.kind === "seen" && read.record.durable).toBe(true);
    });
  });
});
