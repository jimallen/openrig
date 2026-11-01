// The last hops the pump drives on real seats. The store is real, so what crosses a restart is measured; the core client and the input are
// fakes that record every call. Screens are as measured on Claude 2.1.316 and Codex 0.166.0 (s0 M1, M3, M4, M8).
import { beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { ClaudeSeatHop, CodexSeatHop, PiSeatHop, markedText, readClaudeComposer, type HopGuard } from "../src/adapters/seat-hops.js";
import type { NativeEligibility, NativeEndpointRow } from "../src/domain/claude-native-inbox.js";
import { CLAUDE_SOCKET_REPEAT_WINDOW_MS } from "../src/domain/seat-messaging/claude-last-hop.js";
import { MessageStore } from "../src/domain/seat-messaging/message-store.js";
import { messageId, type SeatMessage } from "../src/domain/seat-messaging/ports.js";
import type { PiRunnerState } from "../src/adapters/pi-runner-protocol.js";
import { parseNativeMarkers } from "../src/domain/claude-native-inbox.js";
import { splitMarkedBlock } from "../src/adapters/seat-gate-marker.js";

const SEAT = "dev@r";
const ID = messageId("m-1");
const T0 = 9_000_000;

describe("the hops", () => {
  let db: Database.Database;
  let store: MessageStore;
  let calls: string[];
  let writes: Array<{ sender: string; text: string }>;
  let status: string | null;
  let screen: string;
  let terminalState: string;
  let eligible: boolean;
  let written: "none" | "all" | "partial";
  let now: number;
  let held: boolean;
  const endpoint = { socket_path: "/s" } as NativeEndpointRow;
  const guard: HopGuard = { operation: (_n, fn, onHeld) => (held ? onHeld!({ nodeId: "n", session: SEAT, occupant: null, pane: null }) : fn()) };
  const client = { call: async <T,>(method: string): Promise<T> => (method === "terminal.get" ? { state: terminalState, status: { state: status } } : { text: screen }) as T };
  const input = {
    submitText: async (_s: string, text: string) => { calls.push(`paste:${text}`); return { ok: true as const }; },
    sendKeys: async (_s: string, keys: string[]) => { calls.push(`keys:${keys.join("+")}`); return { ok: true as const }; },
  };
  const claude = () => new ClaudeSeatHop({
    rows: store, guard, client, input, now: () => now,
    eligibility: async (): Promise<NativeEligibility> => (eligible ? { ok: true, nodeId: "n", endpoint } : { ok: false, reason: "no" }),
    writeToSeat: async (_e, sender, text) => { writes.push({ sender, text }); return written; },
  });
  const message: SeatMessage = { ids: [ID], seat: SEAT, body: "Do the thing", messageClass: "content", lane: 2 };
  const text = () => `Do the thing\n[openrig-msg m-1:${store.nonceOf(ID)}]`;

  beforeEach(() => {
    db = createDb(); migrate(db, ALL_MIGRATIONS); store = new MessageStore(db);
    calls = []; writes = []; status = "idle"; screen = "❯ \n──────────────\n"; terminalState = "live"; eligible = true; written = "all"; now = T0; held = false;
    store.accept({ id: ID, seat: SEAT, sender: "lead@r", body: "Do the thing" });
    store.claimAttempt(store.headOf(SEAT)!, 0);
  });

  describe("the marker", () => {
    it("is the gates' own shape, on its own last line, with the row's nonce, so the runner's gate and the relay's both read it", () => {
      const marked = markedText(message, store)!;
      expect(parseNativeMarkers(marked)).toEqual([{ id: "m-1", nonce: store.nonceOf(ID) }]);
      expect(splitMarkedBlock(marked)).toEqual({ text: "Do the thing", markers: [{ id: "m-1", nonce: store.nonceOf(ID) }] });
    });
    it("is the same on every attempt, because (id, nonce) is the gate's identity", () => {
      const first = store.nonceOf(ID);
      store.claimAttempt(store.headOf(SEAT)!, 0);
      expect(store.nonceOf(ID)).toBe(first);
      expect(first).toMatch(/^[a-f0-9]{32}$/);
    });
    it("a row with no nonce sends nothing: an unmarked copy would pass every gate", async () => {
      const bare = { ...message, ids: [messageId("none")] as [ReturnType<typeof messageId>] };
      expect(markedText(bare, store)).toBeNull();
      await expect(claude().attempt(bare)).resolves.toEqual({ kind: "refused", reason: "no_nonce" });
      expect([...calls, ...writes]).toEqual([]);
    });
    it("one marker per id of a group", () => {
      store.accept({ id: messageId("m-2"), seat: "qa@r", sender: "l@r", body: "x" });
      store.claimAttempt(store.headOf("qa@r")!, 0);
      expect(parseNativeMarkers(markedText({ ...message, ids: [ID, messageId("m-2")] }, store)!).map((m) => m.id)).toEqual(["m-1", "m-2"]);
    });
  });

  describe("Claude", () => {
    it("takes the socket when eligible, marked, under the sender's name, with no paste", async () => {
      await expect(claude().attempt(message)).resolves.toEqual({ kind: "sent" });
      expect(writes).toEqual([{ sender: "lead@r", text: text() }]);
      expect(calls).toEqual([]);
    });
    it("M1: a repeat inside the window waits, spends no write, and the wait survives a restart", async () => {
      await claude().attempt(message);
      now += CLAUDE_SOCKET_REPEAT_WINDOW_MS - 1;
      await expect(claude().attempt(message)).resolves.toEqual({ kind: "paused", reason: "busy" });  // a new hop, as after a daemon crash
      expect(writes).toHaveLength(1);
      now += 1;
      await expect(claude().attempt(message)).resolves.toEqual({ kind: "sent" });
      expect(writes).toHaveLength(2);
    });
    it("records the write before making it, so a crash in the write still waits", async () => {
      let during: number | null = null;
      const hop = new ClaudeSeatHop({
        rows: store, guard, client, input, now: () => now, eligibility: async () => ({ ok: true, nodeId: "n", endpoint }),
        writeToSeat: async () => { during = store.lastSocketWriteMs(ID); return "all"; },
      });
      await hop.attempt(message);
      expect(during).toBe(T0);
    });
    it("a partial write counts as sent: only the gate says what landed", async () => {
      written = "partial";
      await expect(claude().attempt(message)).resolves.toEqual({ kind: "sent" });
      expect(calls).toEqual([]);
    });
    it("a socket that took nothing falls to the paste in the same attempt", async () => {
      written = "none";
      await expect(claude().attempt(message)).resolves.toEqual({ kind: "sent" });
      expect(calls).toEqual([`paste:${text()}`]);
    });
    it("an ineligible seat at rest with an empty composer gets a marked paste", async () => {
      eligible = false;
      await claude().attempt(message);
      expect(calls).toEqual([`paste:${text()}`]);
      expect(writes).toEqual([]);
    });
    it("this exact text staged gets Enter alone", async () => {
      eligible = false;
      screen = `history\n❯ ${text().replace("\n", "\n  ")}\n──────────────\n`;
      expect(readClaudeComposer(screen)).toBe(text());
      await expect(claude().attempt(message)).resolves.toEqual({ kind: "sent" });
      expect(calls).toEqual(["keys:Enter"]);
    });
    it("a person's draft holds: nothing is added or submitted", async () => {
      eligible = false;
      screen = "❯ one line draft\n──────────────\n";
      await expect(claude().attempt(message)).resolves.toEqual({ kind: "paused", reason: "guard_held" });
      expect(calls).toEqual([]);
    });
    it("a collapsed paste with no paste of ours behind it holds: no Enter, no clear, no paste on top", async () => {
      eligible = false;
      screen = "❯ [Pasted text #1 +2 lines]\n──────────────\n";
      await expect(claude().attempt(message)).resolves.toEqual({ kind: "paused", reason: "guard_held" });
      expect(calls).toEqual([]);
    });
    it("our collapsed copy, its Enter lost: cleared with ctrl+c, checked empty, pasted again under the same id", async () => {
      eligible = false;
      store.markPasted(ID, "1970-01-01T00:00:00.000Z");
      screen = "❯ [Pasted text #1 +2 lines]\n──────────────\n";
      const inputCleared = { ...input, sendKeys: async (_s: string, keys: string[]) => { calls.push(`keys:${keys.join("+")}`); screen = "❯ \n──────────────\n"; return { ok: true as const }; } };
      const hop = new ClaudeSeatHop({ rows: store, guard, client, input: inputCleared, now: () => now, eligibility: async () => ({ ok: false, reason: "no" }), writeToSeat: async () => "none" });
      await expect(hop.attempt(message)).resolves.toEqual({ kind: "sent" });
      expect(calls).toEqual(["keys:C-c", `paste:${text()}`]);
    });
    it("a clear that did not empty the composer pastes nothing", async () => {
      eligible = false;
      store.markPasted(ID, "1970-01-01T00:00:00.000Z");
      screen = "❯ [Pasted text #1 +2 lines]\n──────────────\n";
      await expect(claude().attempt(message)).resolves.toEqual({ kind: "paused", reason: "guard_held" });
      expect(calls).toEqual(["keys:C-c"]);
    });
    it("a copy of another size is not ours, whatever the row says", async () => {
      eligible = false;
      store.markPasted(ID, "1970-01-01T00:00:00.000Z");
      screen = "❯ [Pasted text #1 +3 lines]\n──────────────\n";
      await expect(claude().attempt(message)).resolves.toEqual({ kind: "paused", reason: "guard_held" });
      expect(calls).toEqual([]);
    });
    it("marks the paste before it writes, so a crash in the write still knows", async () => {
      eligible = false;
      let during = false;
      const marking = { ...input, submitText: async () => { during = store.hasPasted(ID); return { ok: true as const }; } };
      await new ClaudeSeatHop({ rows: store, guard, client, input: marking, now: () => now, eligibility: async () => ({ ok: false, reason: "no" }), writeToSeat: async () => "none" }).attempt(message);
      expect(during).toBe(true);
    });
    it("no composer on the screen proves nothing", async () => {
      eligible = false;
      screen = "Welcome\n";
      await expect(claude().attempt(message)).resolves.toEqual({ kind: "paused", reason: "guard_held" });
    });
    it("a busy seat pauses, and a dialog pauses as blocked", async () => {
      eligible = false;
      status = "working";
      await expect(claude().attempt(message)).resolves.toEqual({ kind: "paused", reason: "busy" });
      status = "blocked";
      await expect(claude().attempt(message)).resolves.toEqual({ kind: "paused", reason: "blocked" });
      expect(calls).toEqual([]);
    });
    it("a held seat pauses the paste; the socket types nothing, so it goes", async () => {
      held = true;
      eligible = false;
      await expect(claude().attempt(message)).resolves.toEqual({ kind: "paused", reason: "guard_held" });
      eligible = true;
      await expect(claude().attempt(message)).resolves.toEqual({ kind: "sent" });
    });
    it("a stopped seat pauses", async () => {
      eligible = false;
      terminalState = "exited";
      await expect(claude().attempt(message)).resolves.toEqual({ kind: "paused", reason: "seat_stopped" });
    });
    it("clears a blocked repeat after it arrived, only when the composer holds exactly this text", async () => {
      screen = `❯ ${text()} and more\n──────────────\n`;
      await claude().afterReceived(message);
      expect(calls).toEqual([]);  // not this text: it may be a person's
      screen = `❯ ${text().replace("\n", "\n  ")}\n──────────────\n`;
      await claude().afterReceived(message);
      expect(calls).toEqual(["keys:C-c"]);
    });
    it("clears nothing on a person's draft, or while the seat works", async () => {
      screen = "❯ my own words\n──────────────\n";
      await claude().afterReceived(message);
      screen = `❯ ${text().replace("\n", "\n  ")}\n──────────────\n`;
      status = "working";
      await claude().afterReceived(message);
      expect(calls).toEqual([]);
    });
  });

  describe("Codex", () => {
    const codex = () => new CodexSeatHop({ rows: store, guard, client, input });
    const FOOTER = "  GPT-6-Luna low · /work\n";
    it("every paste carries the marker", async () => {
      screen = `› Ask Codex to do anything\n${FOOTER}`;
      await expect(codex().attempt(message)).resolves.toEqual({ kind: "sent" });
      expect(calls).toEqual([`paste:${text()}`]);
    });
    it("a staged copy showing its marker gets Enter alone", async () => {
      screen = `› Do the thing\n  ${text().split("\n")[1]}\n${FOOTER}`;
      await expect(codex().attempt(message)).resolves.toEqual({ kind: "sent" });
      expect(calls).toEqual(["keys:Enter"]);
    });
    const collapsed = () => `› [Pasted Content ${text().length} chars]\n${FOOTER}`;
    const clearing = () => ({ ...input, sendKeys: async (_s: string, keys: string[]) => { calls.push(`keys:${keys.join("+")}`); screen = `› Ask Codex to do anything\n${FOOTER}`; return { ok: true as const }; } });
    it("a collapsed paste of exactly this length with no paste of ours behind it holds: it could be a person's", async () => {
      screen = collapsed();
      await expect(codex().attempt(message)).resolves.toEqual({ kind: "paused", reason: "guard_held" });
      expect(calls).toEqual([]);
    });
    it("our collapsed copy, its Enter lost: cleared with ctrl+u, checked empty, pasted again under the same id", async () => {
      store.markPasted(ID, "1970-01-01T00:00:00.000Z");
      screen = collapsed();
      await expect(new CodexSeatHop({ rows: store, guard, client, input: clearing() }).attempt(message)).resolves.toEqual({ kind: "sent" });
      expect(calls).toEqual(["keys:C-u", `paste:${text()}`]);
    });
    it("a clear that did not empty the composer pastes nothing", async () => {
      store.markPasted(ID, "1970-01-01T00:00:00.000Z");
      screen = collapsed();
      await expect(codex().attempt(message)).resolves.toEqual({ kind: "paused", reason: "guard_held" });
      expect(calls).toEqual(["keys:C-u"]);
    });
    it("a copy of another size, or two pastes, is not ours, whatever the row says", async () => {
      store.markPasted(ID, "1970-01-01T00:00:00.000Z");
      screen = `› [Pasted Content ${text().length + 1} chars]\n${FOOTER}`;
      await expect(codex().attempt(message)).resolves.toEqual({ kind: "paused", reason: "guard_held" });
      screen = `› [Pasted Content ${text().length} chars]\n  [Pasted Content ${text().length} chars]\n${FOOTER}`;
      await expect(codex().attempt(message)).resolves.toEqual({ kind: "paused", reason: "guard_held" });
      expect(calls).toEqual([]);
    });
    it("a seat at work is never cleared", async () => {
      store.markPasted(ID, "1970-01-01T00:00:00.000Z");
      screen = collapsed();
      status = "working";
      await expect(codex().attempt(message)).resolves.toEqual({ kind: "paused", reason: "busy" });
      expect(calls).toEqual([]);
    });
    it("marks the paste before it writes", async () => {
      screen = `› Ask Codex to do anything\n${FOOTER}`;
      let during = false;
      await new CodexSeatHop({ rows: store, guard, client, input: { ...input, submitText: async () => { during = store.hasPasted(ID); return { ok: true as const }; } } }).attempt(message);
      expect(during).toBe(true);
    });
    it("a held seat pauses", async () => {
      held = true;
      await expect(codex().attempt(message)).resolves.toEqual({ kind: "paused", reason: "guard_held" });
    });
  });

  describe("Pi and OMP", () => {
    let state: Partial<PiRunnerState> | null;
    const pi = () => new PiSeatHop({ rows: store, guard, client, input, runnerState: () => state as PiRunnerState | null });
    beforeEach(() => { state = { seatGate: 1 }; screen = "[pi-runner] READY\n"; });

    it("every paste carries the marker", async () => {
      await expect(pi().attempt(message)).resolves.toEqual({ kind: "sent" });
      expect(calls).toEqual([`paste:${text()}`]);
    });
    it("a busy agent still gets it: the runner steers, and the gate drops a repeat", async () => {
      status = "working";
      await expect(pi().attempt(message)).resolves.toEqual({ kind: "sent" });
    });
    it("a paste still open pauses; a dialog pauses; a sidecar it cannot read pauses", async () => {
      state = { seatGate: 1, pasteOpen: true };
      await expect(pi().attempt(message)).resolves.toEqual({ kind: "paused", reason: "busy" });
      state = { seatGate: 1 }; status = "blocked";
      await expect(pi().attempt(message)).resolves.toEqual({ kind: "paused", reason: "blocked" });
      status = "idle"; state = null;
      await expect(pi().attempt(message)).resolves.toEqual({ kind: "paused", reason: "seat_stopped" });
      expect(calls).toEqual([]);
    });
    it("a leftover line with this marker gets Enter alone (M8); any other leftover holds", async () => {
      state = { seatGate: 1, pasteLeftover: true };
      screen = `> ${text()}\n`;
      await expect(pi().attempt(message)).resolves.toEqual({ kind: "sent" });
      expect(calls).toEqual(["keys:Enter"]);
      screen = "> someone's words\n";
      await expect(pi().attempt(message)).resolves.toEqual({ kind: "paused", reason: "guard_held" });
      expect(calls).toEqual(["keys:Enter"]);
    });
  });
});
