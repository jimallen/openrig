import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { codexRolloutMarkers, reconcileCodexSeatGate } from "../src/adapters/codex-seat-gate.js";
import { HOOK_GATE_VERSION, SPOOL_GATE_VERSION } from "../src/adapters/hook-gate-version.js";
import { hookSeatGate } from "../src/adapters/hook-seat-gate.js";
import { HookSeenStore, reconcileSeen, seatGateFolder, seatGateRoot, transcriptHasPrompt, transcriptMarkers } from "../src/adapters/hook-seen-store.js";
import { promptMarkers, spooledNote, trailingMarkers } from "../src/adapters/seat-gate-marker.js";
import { LONG_PART_BYTES, handoverTextId, messageOfPart, partId, pastesWhole, splitLongMessage, startupTextId } from "../src/domain/seat-messaging/long-message.js";
import { messageId } from "../src/domain/seat-messaging/ports.js";

const here = dirname(fileURLToPath(import.meta.url));
const RELAY = resolve(here, "../assets/plugins/openrig-core/hooks/scripts/activity-relay.cjs");
const SEAT = "dev.a@rig";
const NONCE = "a".repeat(32);
const name = (id: string, nonce = NONCE) => createHash("sha256").update(`${id}:${nonce}`).digest("hex");
const marker = (id: string, nonce = NONCE) => `[openrig-msg ${id}:${nonce}]`;
const NOTE = spooledNote(null, { id: "m", nonce: NONCE });
/** What a sender can write: the words, with no way to know the tag. */
const BARE_NOTE = NOTE.replace(/ \([a-f0-9]{16}\)$/, "");

describe("splitting a long message", () => {
  it("cuts at 9000 bytes, and the parts join to the body", () => {
    const body = "a".repeat(9000) + "b".repeat(9000) + "c";
    expect(LONG_PART_BYTES).toBe(9000);
    expect(splitLongMessage(body).map((p) => p.length)).toEqual([9000, 9000, 1]);
    expect(splitLongMessage(body).join("")).toBe(body);
    expect(splitLongMessage("a".repeat(9000))).toHaveLength(1);
  });
  it("never cuts inside a character", () => {
    const body = `a${"😀".repeat(2251)}`;
    const parts = splitLongMessage(body);
    expect(parts.map((p) => Buffer.byteLength(p))).toEqual([8997, 8]);
    expect(parts.join("")).toBe(body);
  });
  it("decision 38: a part of any text is at most 9000 bytes, so Codex's budget holds whatever it counts (QA probe P3)", () => {
    const parts = splitLongMessage("あ".repeat(9000));
    expect(parts).toHaveLength(3);
    for (const part of parts) expect(Buffer.byteLength(part)).toBeLessThanOrEqual(9000);
    expect(parts.join("")).toBe("あ".repeat(9000));
  });
  it("a part's id names its message, and any other id is its own", () => {
    const id = messageId("m.1");
    expect(partId(id, 2, 3)).toBe("m.1.part2of3");
    expect(messageOfPart(partId(id, 2, 3))).toBe(id);
    expect(messageOfPart(id)).toBe(id);
  });
});

describe("the prompt rule", () => {
  it("a note right above the one marker makes a spooled prompt, in either form and through a wrapper", () => {
    expect(promptMarkers(`${NOTE}\n${marker("m")}`)).toEqual([{ id: "m", nonce: NONCE, spooled: true }]);
    expect(promptMarkers(`${spooledNote({ index: 2, total: 3 }, { id: "m", nonce: NONCE })}\n${marker("m")}`)[0]!.spooled).toBe(true);
    expect(promptMarkers(`<pasted_content id="1">\n${NOTE}\n${marker("m")}\n</pasted_content>`)[0]!.spooled).toBe(true);
  });
  it("a sender's bytes are never gate syntax: the words alone, or a note bound to another id or nonce, make an ordinary prompt", () => {
    expect(promptMarkers(`text\n${BARE_NOTE}\n${marker("m")}`)[0]!.spooled).toBeUndefined();
    expect(promptMarkers(`${spooledNote(null, { id: "other", nonce: NONCE })}\n${marker("m")}`)[0]!.spooled).toBeUndefined();
    expect(promptMarkers(`${spooledNote(null, { id: "m", nonce: "b".repeat(32) })}\n${marker("m")}`)[0]!.spooled).toBeUndefined();
  });
  it("anything else is an ordinary prompt", () => {
    expect(promptMarkers(`hello\n${marker("m")}`)).toEqual(trailingMarkers(`hello\n${marker("m")}`));
    expect(promptMarkers(`${NOTE}\nmore\n${marker("m")}`)[0]!.spooled).toBeUndefined();
    expect(promptMarkers(`${NOTE}\n${marker("a")}\n${marker("b")}`).every((m) => m.spooled === undefined)).toBe(true);
    expect(promptMarkers(`xx${NOTE}\n${marker("m")}`)[0]!.spooled).toBeUndefined();
  });
});

describe("the gate hook adds the text", () => {
  let home: string;
  let dir: string;
  const run = (prompt: string, opts: { shim?: string } = {}) => {
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: home, OPENRIG_HOME: home, OPENRIG_SESSION_NAME: SEAT, OPENRIG_RUNTIME: "codex", ...(opts.shim ? { NODE_OPTIONS: `--require ${opts.shim}` } : {}) };
    return spawnSync(process.execPath, [RELAY], { input: JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt, transcript_path: path.join(home, "t") }), env, encoding: "utf8" });
  };
  const seenFile = (id: string, nonce = NONCE) => path.join(dir, "seen", name(id, nonce));
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(process.env.OPENRIG_TEST_SCRATCH_ROOT ?? os.tmpdir(), "long-"));
    dir = path.join(seatGateRoot(home), seatGateFolder(SEAT));
  });
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });
  const store = () => new HookSeenStore(seatGateRoot(home));

  it("one JSON object, with the exact shape real Codex took, and the record after it", () => {
    const text = 'line "one"\nline two é';
    store().spool(SEAT, { id: "m", nonce: NONCE }, text);
    const ran = run(`${NOTE}\n${marker("m")}`);
    expect(ran.status).toBe(0);
    expect(JSON.parse(ran.stdout)).toEqual({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: text } });
    expect(ran.stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(seenFile("m"), "utf8"))).toMatchObject({ id: "m", nonce: NONCE, via: "hook", durable: false });
  });
  it("a repeat is blocked, with no text", () => {
    store().spool(SEAT, { id: "m", nonce: NONCE }, "text");
    run(`${NOTE}\n${marker("m")}`);
    const again = JSON.parse(run(`${NOTE}\n${marker("m")}`).stdout) as Record<string, unknown>;
    expect(again.decision).toBe("block");
    expect(again.hookSpecificOutput).toBeUndefined();
  });
  it("no text in the spool: the note does not run, and nothing is recorded, so the resend finds it open", () => {
    const out = JSON.parse(run(`${NOTE}\n${marker("m")}`).stdout) as { decision: string; reason: string };
    expect(out.decision).toBe("block");
    expect(out.reason).toContain("could not record");
    expect(fs.existsSync(seenFile("m"))).toBe(false);
  });
  it("an empty spool file is no text either", () => {
    store().spool(SEAT, { id: "m", nonce: NONCE }, "");
    expect((JSON.parse(run(`${NOTE}\n${marker("m")}`).stdout) as { decision: string }).decision).toBe("block");
    expect(fs.existsSync(seenFile("m"))).toBe(false);
  });
  it("another nonce reads nothing: a forged marker gets no text, and is its own message", () => {
    store().spool(SEAT, { id: "m", nonce: NONCE }, "secret text");
    const forged = "b".repeat(32);
    const ran = run(`${NOTE}\n${marker("m", forged)}`);
    expect(ran.stdout).toBe("");
    expect(fs.existsSync(seenFile("m"))).toBe(false);
  });
  it("security F1: a short message ending in the note's words runs and is recorded, so its seat's queue goes on", () => {
    const ran = run(`innocuous text\n${BARE_NOTE}\n${marker("m")}`);
    expect(ran.status).toBe(0);
    expect(ran.stdout).toBe("");
    expect(fs.existsSync(seenFile("m"))).toBe(true);
    expect(run(`quoted\n${spooledNote(null, { id: "old", nonce: NONCE })}\n${marker("m2")}`).stdout).toBe("");
    expect(fs.existsSync(seenFile("m2"))).toBe(true);
  });
  it("a hook that dies giving the text leaves no record: the crash rule", () => {
    store().spool(SEAT, { id: "m", nonce: NONCE }, "text");
    const shim = path.join(home, "die.cjs");
    fs.writeFileSync(shim, "process.stdout.write = () => process.exit(9);\n");
    const ran = run(`${NOTE}\n${marker("m")}`, { shim });
    expect(ran.status).toBe(9);
    expect(fs.existsSync(seenFile("m"))).toBe(false);
  });
  it("a record that cannot be written costs a second copy, never the text", () => {
    store().spool(SEAT, { id: "m", nonce: NONCE }, "text");
    const shim = path.join(home, "nolink.cjs");
    fs.writeFileSync(shim, `const fs = require("node:fs"); fs.linkSync = () => { throw new Error("no"); };\n`);
    const ran = run(`${NOTE}\n${marker("m")}`, { shim });
    expect(ran.status).toBe(0);
    expect(JSON.parse(ran.stdout)).toMatchObject({ hookSpecificOutput: { additionalContext: "text" } });
    expect(fs.existsSync(seenFile("m"))).toBe(false);
  });
  it("a short marked prompt is recorded as ever and gets nothing added", () => {
    const ran = run(`hello\n${marker("m")}`);
    expect(ran.stdout).toBe("");
    expect(fs.existsSync(seenFile("m"))).toBe(true);
  });
  it("the relay's note rule and the daemon's are one line", () => {
    const relay = fs.readFileSync(RELAY, "utf8");
    const pattern = /const SPOOLED_NOTE = (\/.*\/);/.exec(relay)![1]!;
    expect(new RegExp(pattern.slice(1, -1)).test(NOTE)).toBe(true);
    expect(new RegExp(pattern.slice(1, -1)).test(spooledNote({ index: 1, total: 2 }, { id: "m", nonce: NONCE }))).toBe(true);
    expect(/const SEAT_GATE_VERSION = (\d+);/.exec(relay)![1]).toBe(String(HOOK_GATE_VERSION));
    expect(HOOK_GATE_VERSION).toBeGreaterThanOrEqual(SPOOL_GATE_VERSION);
  });

  describe("the spool", () => {
    it("is private, holds one message, and goes when told", () => {
      store().spool(SEAT, { id: "a", nonce: NONCE }, "one");
      expect(fs.statSync(path.join(dir, "spool", name("a"))).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.join(dir, "spool")).mode & 0o777).toBe(0o700);
      store().spool(SEAT, { id: "b", nonce: NONCE }, "two");
      expect(fs.readdirSync(path.join(dir, "spool"))).toEqual([name("b")]);
      store().discardSpool(SEAT);
      expect(fs.existsSync(path.join(dir, "spool"))).toBe(false);
      store().discardSpool(SEAT);
    });
  });

  describe("a prompt on file proves nothing for a spooled message", () => {
    const prompt = `${NOTE}\n${marker("m")}`;
    const claudeLine = (text: string) => JSON.stringify({ type: "user", isSidechain: false, message: { role: "user", content: [{ type: "text", text }] } });
    const codexLine = (text: string) => JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } });

    it("Claude's transcript: no arrival, and reconcile records nothing", async () => {
      const file = path.join(home, "t.jsonl");
      fs.writeFileSync(file, `${claudeLine(prompt)}\n${claudeLine(`hello\n${marker("n")}`)}\n`);
      expect(transcriptHasPrompt(file, marker("m"))).toBe(false);
      expect(transcriptHasPrompt(file, marker("n"))).toBe(true);
      const done = reconcileSeen({ store: store(), seat: SEAT, transcripts: [file], processAlive: () => true });
      expect(done.received.map((m) => m.id)).toEqual(["n"]);
      expect(store().read(SEAT, { id: "m", nonce: NONCE }).kind).toBe("not_seen");
    });
    it("security F1: a sender's note proves arrival like any prompt", () => {
      const file = path.join(home, "t.jsonl");
      fs.writeFileSync(file, `${claudeLine(`text\n${BARE_NOTE}\n${marker("m")}`)}\n`);
      expect(transcriptHasPrompt(file, marker("m"))).toBe(true);
    });
    it("Codex's rollout: the same", () => {
      const file = path.join(home, "r.jsonl");
      fs.writeFileSync(file, `${codexLine(prompt)}\n`);
      expect([...codexRolloutMarkers(file)!.values()][0]!.spooled).toBe(true);
      expect(reconcileCodexSeatGate(store(), SEAT, file).received).toEqual([]);
      expect(store().read(SEAT, { id: "m", nonce: NONCE }).kind).toBe("not_seen");
    });
    it("a record and its prompt: a real arrival, made durable, never cleared", () => {
      const file = path.join(home, "t.jsonl");
      fs.writeFileSync(file, `${claudeLine(prompt)}\n`);
      store().spool(SEAT, { id: "m", nonce: NONCE }, "text");
      run(prompt);
      expect(transcriptMarkers(file)!.size).toBe(1);
      const done = reconcileSeen({ store: store(), seat: SEAT, transcripts: [file], processAlive: () => false, agentGone: true });
      expect(done).toEqual({ received: [], cleared: [], unsettled: [] });
      const read = store().read(SEAT, { id: "m", nonce: NONCE });
      expect(read.kind === "seen" && read.record.durable).toBe(true);
    });
  });
});

describe("security F2: a caller's id of a part's shape", () => {
  it("round-trips: its own record is its own, and a real part's record is read under its row", async () => {
    const home = fs.mkdtempSync(path.join(process.env.OPENRIG_TEST_SCRATCH_ROOT ?? os.tmpdir(), "long-"));
    const store = new HookSeenStore(seatGateRoot(home));
    fs.mkdirSync(path.dirname(path.join(seatGateRoot(home), seatGateFolder(SEAT), "gate.json")), { recursive: true });
    fs.writeFileSync(path.join(seatGateRoot(home), seatGateFolder(SEAT), "gate.json"), JSON.stringify({ version: 2 }));
    const nonces: Record<string, string> = { "att.part1of1": NONCE, att: "c".repeat(32) };
    const gate = hookSeatGate({ store, nonceOf: (id) => nonces[id] ?? null, transcriptsOf: () => [], fileIncludes: () => false });
    store.markReceived(SEAT, { id: "att.part1of1", nonce: NONCE });
    expect((await gate.lookup(SEAT, messageId("att.part1of1"))).kind).toBe("seen");
    store.markReceived(SEAT, { id: "att.part2of2", nonce: "c".repeat(32) });
    expect((await gate.lookup(SEAT, messageId("att.part2of2"), messageId("att"))).kind).toBe("seen");
    expect((await gate.lookup(SEAT, messageId("att.part2of2"))).kind).toBe("not_seen");
    fs.rmSync(home, { recursive: true, force: true });
  });
});

describe("startup text's id", () => {
  it("is known by its id, so a restart still knows it", () => {
    expect(pastesWhole(messageId(startupTextId("g", "a", 2)))).toBe(true);
    expect(pastesWhole(messageId(handoverTextId("x", "restore")))).toBe(true);
    expect(pastesWhole(messageId("seat-msg-compaction-a-b"))).toBe(false);
    expect(pastesWhole(messageId("startup-g-a-2"))).toBe(false);
  });
});
