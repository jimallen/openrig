// The last hops the pump drives on real seats. The store is real, so what crosses a restart is measured; the core client and the input are
// fakes that record every call. Screens are as measured on Claude 2.1.316 and Codex 0.166.0 (s0 M1, M3, M4, M8).
import { beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { CLAUDE_SPOOL_ROUTE, PASTE_LIMIT, ClaudeSeatHop, CodexSeatHop, PiSeatHop, foregroundHoldsAgent, isSeatAgent, markedText, readClaudeComposer, type HopGuard, type SeatSpool } from "../src/adapters/seat-hops.js";
import { MessagePump } from "../src/domain/seat-messaging/message-pump.js";
import { promptMarkers, spooledNote, type SeatMarker } from "../src/adapters/seat-gate-marker.js";
import { handoverTextId, startupTextId } from "../src/domain/seat-messaging/long-message.js";
import type { NativeEligibility, NativeEndpointRow } from "../src/domain/claude-native-inbox.js";
import { CLAUDE_SOCKET_REPEAT_WINDOW_MS } from "../src/domain/seat-messaging/claude-last-hop.js";
import { MessageStore } from "../src/domain/seat-messaging/message-store.js";
import { PREVIOUS_OCCUPANT_LABEL } from "../src/domain/seat-messaging/message-label.js";
import { messageId, type SeatMessage } from "../src/domain/seat-messaging/ports.js";
import type { HcTerminal } from "../src/adapters/hc-client.js";
import { parseForegroundGroup } from "../src/adapters/native-inbox-os.js";
import type { PiRunnerState } from "../src/adapters/pi-runner-protocol.js";
import { parseNativeMarkers } from "../src/domain/claude-native-inbox.js";
import { splitMarkedBlock } from "../src/adapters/seat-gate-marker.js";

const SEAT = "dev@r";
const ID = messageId("m-1");
const T0 = 9_000_000;

// Foregrounds as hc reported them on real seats: Sparky's terminals.json at d-proof-p and d-proof-x, and the process names of live agents.
describe("is the terminal's foreground the seat's agent?", () => {
  const SEAT_NAME = "d-a@dp";
  const of = (name: string, argv: string[]) => ({ foreground: { pid: 1, name, argv, cwd: "/w" } });
  const runner = of("node", ["node", "/x/lib/node_modules/@openrig/cli/daemon/dist/adapters/pi-runner.js", "--session-name", SEAT_NAME, "--state-root", "/s", "--cwd", "/w", "--launch-id", "l", "--no-approve"]);
  const launch = of("sh", ["/bin/sh", "/run/tmp/openrig-tmux-send-3129529-70b8a3b4-7f24-4564-bba7-b8303afe5b"]);

  it.each([
    ["a real Pi runner", runner, "pi", true],
    ["another seat's runner", runner, "pi", false, "other@dp"],
    ["a stub runner", of("node", ["node", "/x/dist/adapters/stub-runner.js", "--session-name", SEAT_NAME]), "pi", false],
    ["node at a prompt", of("node", ["node"]), "pi", false],
    ["a real Codex launch script, with codex its child", launch, "codex", true],
    ["codex itself", of("codex", ["/x/vendor/codex", "--yolo"]), "codex", true],
    ["claude by name", of("claude", ["claude"]), "claude-code", true],
    ["claude by its version, as Sparky shows it", of("2.1.303", ["/x/versions/2.1.303", "--resume"]), "claude-code", true],
    ["a launch script, for Claude", launch, "claude-code", true],
    ["a login shell", of("-bash", ["-bash"]), "codex", false],
    ["a login shell by flag", of("zsh", ["/bin/zsh", "-l"]), "claude-code", false],
    ["a login shell, for Pi", of("bash", ["bash", "-l"]), "pi", false],
    ["a shell running something else", of("sh", ["/bin/sh", "/tmp/other.sh"]), "codex", false],
    ["a program given a file of that name", of("vi", ["vi", "codex"]), "codex", false],
    ["a program given Claude's name as an argument", of("less", ["less", "/x/claude"]), "claude-code", false],
    ["our script's name further along argv", of("bash", ["bash", "--rcfile", "/x/openrig-tmux-send-1"]), "codex", false],
    ["vim", of("vim", ["vim", "notes"]), "codex", false],
    ["python", of("python3", ["python3"]), "claude-code", false],
  ] as ReadonlyArray<[string, Pick<HcTerminal, "foreground">, "pi" | "codex" | "claude-code", boolean, string?]>)("%s", (_name, terminal, runtime, expected, seat = SEAT_NAME) => {
    expect(isSeatAgent(terminal, runtime, seat)).toBe(expected);
  });

  it("hc reads a sourced launch as the shell: the agent is found in the terminal's foreground group", () => {
    expect(foregroundHoldsAgent([{ name: "zsh", argv0: "-zsh" }, { name: "claude", argv0: "claude" }], "claude-code")).toBe(true);
    expect(foregroundHoldsAgent([{ name: "2.1.303", argv0: "/x/versions/2.1.303" }], "claude-code")).toBe(true);
    expect(foregroundHoldsAgent([{ name: "sh", argv0: "/bin/sh" }, { name: "codex", argv0: "/x/vendor/codex" }], "codex")).toBe(true);
    expect(foregroundHoldsAgent([{ name: "codex", argv0: "codex" }], "claude-code")).toBe(false);
  });

  it("a bare prompt's group is the shell alone", () => {
    expect(foregroundHoldsAgent([{ name: "bash", argv0: "-bash" }], "codex")).toBe(false);
    expect(foregroundHoldsAgent([], "claude-code")).toBe(false);
  });

  it("reads ps: only the group that is its terminal's foreground, on Linux's and macOS's output", () => {
    const ps = ["   500    500 zsh             -zsh", "   500    500 /Users/j/.local/bin/claude claude --resume", "   700    500 claude          claude", "   800     -1 bash            bash", "   500    700 vi              vi x"].join("\n");
    expect(parseForegroundGroup(ps, 500)).toEqual([{ name: "zsh", argv0: "-zsh" }, { name: "/Users/j/.local/bin/claude", argv0: "claude" }]);
    expect(parseForegroundGroup(ps, 700)).toEqual([]);
  });

  it("no foreground proves nothing, so it is not the agent", () => {
    expect(isSeatAgent({ foreground: null }, "codex", SEAT_NAME)).toBe(false);
    expect(isSeatAgent({}, "pi", SEAT_NAME)).toBe(false);
  });
});

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
  let foreground: { pid: number; name: string; argv: string[]; cwd: string } | null;
  const client = { call: async <T,>(method: string): Promise<T> => (method === "terminal.get" ? { state: terminalState, status: { state: status }, foreground } : { text: screen }) as T };
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
    foreground = { pid: 1, name: "claude", argv: ["claude"], cwd: "/w" };
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
      await expect(claude().attempt(message)).resolves.toEqual({ kind: "paused", reason: "draft" });
      expect(calls).toEqual([]);
    });
    it("a collapsed paste is a draft, whatever its size: no Enter, no clear, no paste on top", async () => {
      eligible = false;
      for (const lines of [2, 3]) {
        screen = `❯ [Pasted text #1 +${lines} lines]\n──────────────\n`;
        await expect(claude().attempt(message)).resolves.toEqual({ kind: "paused", reason: "draft" });
      }
      expect(calls).toEqual([]);
    });
    it("no composer on the screen proves nothing", async () => {
      eligible = false;
      screen = "Welcome\n";
      await expect(claude().attempt(message)).resolves.toEqual({ kind: "paused", reason: "screen_unreadable" });
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
    it("a seat at its login shell gets no paste, and the socket does not depend on it", async () => {
      foreground = { pid: 1, name: "-zsh", argv: ["-zsh"], cwd: "/w" };
      eligible = false;
      await expect(claude().attempt(message)).resolves.toEqual({ kind: "paused", reason: "agent_absent" });
      expect(calls).toEqual([]);
      eligible = true;
      await expect(claude().attempt(message)).resolves.toEqual({ kind: "sent" });
    });
    it("a sourced launch: the leader reads as the shell, the agent is in its group, and the paste goes", async () => {
      foreground = { pid: 900, name: "zsh", argv: ["/bin/zsh", "-l"], cwd: "/w" };
      eligible = false;
      const asked: number[] = [];
      const hop = new ClaudeSeatHop({
        rows: store, guard, client, input, now: () => now, eligibility: async () => ({ ok: false, reason: "no" }), writeToSeat: async () => "none",
        foregroundGroup: async (pgid) => { asked.push(pgid); return [{ name: "zsh", argv0: "/bin/zsh" }, { name: "claude", argv0: "claude" }]; },
      });
      await expect(hop.attempt(message)).resolves.toEqual({ kind: "sent" });
      expect(asked).toEqual([900]);
      expect(calls).toEqual([`paste:${text()}`]);
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
    describe("a long message (decision 35)", () => {
      const LONG = "y".repeat(PASTE_LIMIT);
      const spooled: string[] = [];
      const spool = { declaredVersion: () => 2 as number | null, spool: (_s: string, _m: SeatMarker, t: string) => { spooled.push(t); }, discardSpool: () => {} };
      const hop = (over: { version?: number | null; spoolRoute?: boolean } = {}) => new ClaudeSeatHop({
        rows: store, guard, client, input, now: () => now, spool: { ...spool, declaredVersion: () => (over.version === undefined ? 2 : over.version) }, ...(over.spoolRoute === undefined ? {} : { spoolRoute: over.spoolRoute }),
        eligibility: async (): Promise<NativeEligibility> => (eligible ? { ok: true, nodeId: "n", endpoint } : { ok: false, reason: "no" }),
        writeToSeat: async (_e, sender, text) => { writes.push({ sender, text }); return written; },
      });
      const group = (first: string, second: string): SeatMessage => ({ ...message, ids: [ID, messageId("m-2")], body: `${first}\n${second}`, bodies: [first, second] });
      beforeEach(() => {
        spooled.length = 0;
        store.accept({ id: messageId("m-2"), seat: SEAT, sender: "lead@r", body: "x" });
        store.claimAttempt(store.headOf(SEAT)!, 0);
        db.prepare("UPDATE outbox_entries SET native_nonce = 'abcdef0123456789abcdef0123456789' WHERE outbox_id = 'm-2'").run();
      });

      it("the spool route is off for Claude, by one named switch", () => {
        expect(CLAUDE_SPOOL_ROUTE).toBe(false);
      });
      it("goes whole by socket", async () => {
        await expect(hop().attempt({ ...message, body: LONG })).resolves.toEqual({ kind: "sent" });
        expect(writes[0]!.text).toContain(LONG);
        expect(calls).toEqual([]);
        expect(spooled).toEqual([]);
      });
      for (const version of [2, 1, null]) {
        it(`with no socket it is never pasted, at gate version ${version}: paused under its own reason`, async () => {
          eligible = false;
          await expect(hop({ version }).attempt({ ...message, body: LONG })).resolves.toEqual({ kind: "paused", reason: "long_no_socket" });
          expect(calls).toEqual([]);
          expect(spooled).toEqual([]);
          expect(store.partsOf(ID)).toBeNull();
        });
      }
      it("a socket that wrote nothing is no socket", async () => {
        written = "none";
        await expect(hop().attempt({ ...message, body: LONG })).resolves.toEqual({ kind: "paused", reason: "long_no_socket" });
        expect(calls).toEqual([]);
      });
      it("the limit is on what the paste would carry, marker included: one byte under still pastes", async () => {
        eligible = false;
        const fits = "z".repeat(PASTE_LIMIT - Buffer.byteLength(`\n[openrig-msg m-1:${store.nonceOf(ID)}]`));
        await expect(hop().attempt({ ...message, body: fits })).resolves.toEqual({ kind: "sent" });
        expect(calls[0]).toContain(fits);
        calls.length = 0;
        await expect(hop().attempt({ ...message, body: `${fits}z` })).resolves.toEqual({ kind: "paused", reason: "long_no_socket" });
        expect(calls).toEqual([]);
      });
      it("a short message keeps the paste path", async () => {
        eligible = false;
        await expect(hop().attempt(message)).resolves.toEqual({ kind: "sent" });
        expect(calls).toEqual([`paste:${text()}`]);
      });
      it("a group over the limit goes whole by socket", async () => {
        const body = "a".repeat(PASTE_LIMIT);
        await expect(hop().attempt(group(body, "b"))).resolves.toEqual({ kind: "sent" });
        expect(writes[0]!.text).toContain(`${body}\nb`);
        expect(writes[0]!.text).toContain("[openrig-msg m-2:");
        expect(calls).toEqual([]);
      });
      it("a group over the limit with no socket: its short first row pastes alone, body in the prompt", async () => {
        eligible = false;
        const rest = "b".repeat(PASTE_LIMIT);
        await expect(hop().attempt(group("first", rest))).resolves.toEqual({ kind: "sent", carried: [ID] });
        expect(calls).toEqual([`paste:first\n[openrig-msg m-1:${store.nonceOf(ID)}]`]);
      });
      it("a group whose first row is itself long, with no socket: paused, nothing typed", async () => {
        eligible = false;
        await expect(hop().attempt(group("a".repeat(PASTE_LIMIT), "b"))).resolves.toEqual({ kind: "paused", reason: "long_no_socket" });
        expect(calls).toEqual([]);
      });
      it("a blocked repeat of a group's first row is cleared by what was pasted", async () => {
        eligible = false;
        const sent = group("first", "b".repeat(PASTE_LIMIT));
        screen = `❯ first\n  [openrig-msg m-1:${store.nonceOf(ID)}]\n──────────────\n`;
        await hop({ version: 1 }).afterReceived(sent);  // whatever the relay declared
        expect(calls).toEqual(["keys:C-c"]);
      });
      for (const [name, known] of [["startup", startupTextId("gen", "attempt", 1)], ["handover", handoverTextId("succ", "restore")]] as const) it(`${name} text is the named exception (decision 39): with no socket it pastes whole, body in the prompt, and never as a note`, async () => {
        eligible = false;
        const startup = messageId(known);
        store.accept({ id: startup, seat: SEAT, sender: "startup@system", body: "s" });
        db.prepare("UPDATE outbox_entries SET native_nonce = 'abcdef0123456789abcdef0123456789' WHERE outbox_id = ?").run(startup);
        for (const spoolRoute of [false, true]) {
          calls.length = 0;
          await expect(hop({ spoolRoute }).attempt({ ...message, ids: [startup], body: LONG, messageClass: "lifecycle" })).resolves.toEqual({ kind: "sent" });
          expect(calls[0]).toContain(LONG);
          expect(spooled).toEqual([]);
        }
      });

      it("the pause ends by itself: the pump finds the socket back, with nobody asking", async () => {
        eligible = false;
        const gate = { version: 2, lookup: async (_s: string, id: ReturnType<typeof messageId>) => (writes.length > 0 ? { kind: "seen" as const, record: { id, recordedAt: "2026-11-02T00:00:00.000Z", nonce: null } } : { kind: "not_seen" as const }) };
        db.prepare("UPDATE outbox_entries SET body = ?, message_state = 'accepted', attempts = 0, next_attempt_at = NULL WHERE outbox_id = 'm-1'").run(LONG);
        const seatHop = hop();
        const pump = new MessagePump({
          store, ports: { gateFor: () => gate, hopFor: () => seatHop }, directory: { fate: () => ({ kind: "live", occupantGeneration: null }) } as never, held: { status: () => "held" },
          senders: { returnToSender: async () => ({ kind: "no_return_path", reason: "none" }) }, timing: { tickMs: 2, pauseRecheckMs: 2, backoffMs: [100_000] }, log: () => undefined,
        });
        pump.start();
        try {
          await vi.waitFor(() => expect(store.headOf(SEAT)?.pauseReason).toBe("long_no_socket"));
          expect(calls).toEqual([]);
          eligible = true;
          await vi.waitFor(() => expect(store.outcomeOf(ID)).toBe("received"));
          expect(writes[0]!.text).toContain(LONG);
          expect(calls).toEqual([]);
        } finally { pump.stop(); }
      });

      describe("the on state: one line turns it on", () => {
        const on = () => hop({ spoolRoute: true });
        it("the paste path goes short, with its text in the spool; the socket still takes it whole", async () => {
          eligible = false;
          await expect(on().attempt({ ...message, body: LONG })).resolves.toEqual({ kind: "sent" });
          expect(spooled).toEqual([LONG]);
          expect(calls[0]).not.toContain("yyy");
          calls.length = 0;
          const staged = spooledNote(null, { id: "m-1", nonce: store.nonceOf(ID)! });
          screen = `❯ ${staged}\n  [openrig-msg m-1:${store.nonceOf(ID)}]\n──────────────\n`;
          await on().afterReceived({ ...message, body: LONG });  // a blocked repeat is cleared by what it was, not by the body
          expect(calls).toEqual(["keys:C-c"]);
        });
        it("a seat whose relay is older gets it whole, as Codex does", async () => {
          eligible = false;
          await expect(hop({ spoolRoute: true, version: 1 }).attempt({ ...message, body: LONG })).resolves.toEqual({ kind: "sent" });
          expect(calls[0]).toContain(LONG);
        });
        it("a long group goes a row at a time, and says so", async () => {
          eligible = false;
          await expect(on().attempt(group("a".repeat(PASTE_LIMIT), "b"))).resolves.toEqual({ kind: "sent", carried: [ID] });
          expect(spooled).toEqual(["a".repeat(PASTE_LIMIT)]);
        });
        it("QA F5: a blocked repeat of a numbered part is cleared by that part's own note", async () => {
          store.markParts(ID, 3);
          const nonce = store.nonceOf(ID)!;
          const id = "m-1.part1of3";
          screen = `❯ ${spooledNote({ index: 1, total: 3 }, { id, nonce })}\n  [openrig-msg ${id}:${nonce}]\n──────────────\n`;
          await on().afterReceived({ ...message, body: LONG, part: 1 });
          expect(calls).toEqual(["keys:C-c"]);
        });
      });
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
    beforeEach(() => { foreground = { pid: 1, name: "sh", argv: ["/bin/sh", "/run/tmp/openrig-tmux-send-1-2"], cwd: "/w" }; });
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
    it("a collapsed paste of exactly this length is a draft: a size cannot tell ours from a person's, so nothing touches it", async () => {
      screen = `› [Pasted Content ${text().length} chars]\n${FOOTER}`;
      await expect(codex().attempt(message)).resolves.toEqual({ kind: "paused", reason: "draft" });
      expect(calls).toEqual([]);
    });
    it("the message goes the moment the composer clears", async () => {
      screen = `› half a thought\n${FOOTER}`;
      await expect(codex().attempt(message)).resolves.toEqual({ kind: "paused", reason: "draft" });
      screen = `› Ask Codex to do anything\n${FOOTER}`;
      await expect(codex().attempt(message)).resolves.toEqual({ kind: "sent" });
      expect(calls).toEqual([`paste:${text()}`]);
    });
    it("a seat at its login shell gets nothing, however empty the composer looks", async () => {
      foreground = { pid: 1, name: "-bash", argv: ["-bash"], cwd: "/w" };
      screen = `› Ask Codex to do anything\n${FOOTER}`;
      await expect(codex().attempt(message)).resolves.toEqual({ kind: "paused", reason: "agent_absent" });
      expect(calls).toEqual([]);
    });
    describe("a long message", () => {
      const spooled: Array<{ id: string; text: string; after: number }> = [];
      const spool = { declaredVersion: () => 2 as number | null, spool: (_s: string, m: SeatMarker, text: string) => { spooled.push({ id: m.id, text, after: calls.length }); }, discardSpool: () => {} };
      const hop = (s: SeatSpool = spool) => new CodexSeatHop({ rows: store, guard, client, input, spool: s });
      beforeEach(() => { spooled.length = 0; screen = `› Ask Codex to do anything\n${FOOTER}`; });

      it("goes as a short paste with the message's own marker, and its text is in the spool before a byte", async () => {
        const body = "y".repeat(PASTE_LIMIT);
        await expect(hop().attempt({ ...message, body })).resolves.toEqual({ kind: "sent" });
        const sent = calls[0]!.replace("paste:", "");
        expect(Buffer.byteLength(sent)).toBeLessThanOrEqual(PASTE_LIMIT);
        expect(sent).not.toContain("yyy");
        expect(promptMarkers(sent)).toEqual([{ id: "m-1", nonce: store.nonceOf(ID), spooled: true }]);
        expect(spooled).toEqual([{ id: "m-1", text: body, after: 0 }]);
        expect(store.partsOf(ID)).toBe(1);
      });
      it("the limit is the 1000 measured on real Codex", async () => {
        expect(PASTE_LIMIT).toBe(1000);
        await hop().attempt({ ...message, body: "y".repeat(1100) });
        expect(calls[0]).not.toContain("yyy");
      });
      it("a repeat is the same paste: the gate drops it", async () => {
        const long = { ...message, body: "y".repeat(PASTE_LIMIT) };
        await hop().attempt(long);
        await hop().attempt(long);
        expect(calls[0]).toBe(calls[1]);
      });
      it("OF-243: a part whose record the gate cleared goes again with its note saying so, and the tag and marker are the first copy's", async () => {
        const body = "y".repeat(PASTE_LIMIT);
        let resent = 0;
        await hop({ ...spool, resentOf: () => resent }).attempt({ ...message, body });
        resent = 1;
        await hop({ ...spool, resentOf: () => resent }).attempt({ ...message, body });
        const [first, again] = calls.map((c) => c.replace("paste:", ""));
        expect(first).not.toContain("resent");
        expect(again).toContain("OpenRig: long message, resent: not confirmed on file. Its text comes");
        expect(again!.replace(", resent: not confirmed on file", "")).toBe(first);
        expect(promptMarkers(again!)).toEqual([{ id: "m-1", nonce: store.nonceOf(ID), spooled: true }]);
      });
      it("a short message is none of this", async () => {
        await hop().attempt(message);
        expect(store.partsOf(ID)).toBeNull();
        expect(spooled).toEqual([]);
        expect(calls).toEqual([`paste:${text()}`]);
      });
      it("at the limit it goes whole; a multi-byte body is judged by its bytes", async () => {
        const fits = "z".repeat(PASTE_LIMIT - Buffer.byteLength(`\n[openrig-msg m-1:${store.nonceOf(ID)}]`));
        await hop().attempt({ ...message, body: fits });
        expect(calls[0]).toContain(fits);
        calls.length = 0;
        await hop().attempt({ ...message, body: "é".repeat(PASTE_LIMIT / 2) });
        expect(calls[0]).toContain("long message");
      });
      it("past 9000 characters each part has its own marker, and the pump says which is due", async () => {
        const body = "a".repeat(9000) + "b".repeat(9000) + "c";
        await hop().attempt({ ...message, body, part: 2 });
        expect(spooled).toEqual([{ id: "m-1.part2of3", text: "b".repeat(9000), after: 0 }]);
        expect(calls[0]).toContain("part 2 of 3");
        expect(store.partsOf(ID)).toBe(3);
      });
      it("a part staged with its Enter lost gets Enter alone, and its text is still there", async () => {
        screen = `› OpenRig: long message.\n  [openrig-msg m-1:${store.nonceOf(ID)}]\n${FOOTER}`;
        await expect(hop().attempt({ ...message, body: "y".repeat(PASTE_LIMIT) })).resolves.toEqual({ kind: "sent" });
        expect(calls).toEqual(["keys:Enter"]);
        expect(spooled).toHaveLength(1);
      });
      it("keeps the label of a message sent to the previous occupant", async () => {
        await hop().attempt({ ...message, body: `${PREVIOUS_OCCUPANT_LABEL} ${"y".repeat(PASTE_LIMIT)}` });
        expect(calls[0]).toContain(`paste:${PREVIOUS_OCCUPANT_LABEL}\nOpenRig: long message`);
      });
      for (const version of [1, null]) {
        it(`goes whole to a seat whose relay declared ${version}: a short paste there would lose the text`, async () => {
          const body = "y".repeat(PASTE_LIMIT);
          await hop({ ...spool, declaredVersion: () => version }).attempt({ ...message, body });
          expect(calls[0]).toContain(body);
          expect(spooled).toEqual([]);
        });
      }
      describe("a wake group", () => {
        const second = messageId("m-2");
        beforeEach(() => {
          store.accept({ id: second, seat: SEAT, sender: "lead@r", body: "second" });
          store.claimAttempt({ ...store.headOf(SEAT)!, id: second, attempts: 0 }, T0 + 1);
        });
        const group = (first: string): SeatMessage => ({ ...message, ids: [ID, second], body: `${first}\nsecond`, bodies: [first, "second"] });

        it("past the limit goes a row at a time: the first row's short paste, marker and spool, and nothing of the second", async () => {
          const body = "y".repeat(PASTE_LIMIT);
          await expect(hop().attempt(group(body))).resolves.toEqual({ kind: "sent", carried: [ID] });
          const sent = calls[0]!.replace("paste:", "");
          expect(promptMarkers(sent)).toEqual([{ id: "m-1", nonce: store.nonceOf(ID), spooled: true }]);
          expect(sent).not.toContain("second");
          expect(spooled).toEqual([{ id: "m-1", text: body, after: 0 }]);
        });
        it("whose first row is short goes as that row alone, so the second is the next attempt's head", async () => {
          await hop().attempt({ ...group("first"), body: `first\n${"y".repeat(PASTE_LIMIT)}`, bodies: ["first", "y".repeat(PASTE_LIMIT)] });
          expect(calls).toEqual([`paste:first\n[openrig-msg m-1:${store.nonceOf(ID)}]`]);
          expect(spooled).toEqual([]);
        });
        it("within the limit goes whole, one marker per row, and nothing is spooled", async () => {
          await hop().attempt(group("first"));
          expect(promptMarkers(calls[0]!.replace("paste:", "")).map((m) => m.id)).toEqual(["m-1", "m-2"]);
          expect(calls[0]).toContain("second");
          expect(spooled).toEqual([]);
        });
        it("goes whole to a seat whose relay declared 1: a short paste there would lose the text", async () => {
          const body = "y".repeat(PASTE_LIMIT);
          await hop({ ...spool, declaredVersion: () => 1 }).attempt(group(body));
          expect(promptMarkers(calls[0]!.replace("paste:", "")).map((m) => m.id)).toEqual(["m-1", "m-2"]);
          expect(spooled).toEqual([]);
        });
      });
      it("forgets its text when told", () => {
        const seats: string[] = [];
        hop({ ...spool, discardSpool: (seat) => { seats.push(seat); } }).forget(SEAT);
        expect(seats).toEqual([SEAT]);
      });
    });
    it("a sourced Codex seat: the agent is found in the foreground group", async () => {
      foreground = { pid: 900, name: "bash", argv: ["/bin/bash", "-l"], cwd: "/w" };
      screen = `› Ask Codex to do anything\n${FOOTER}`;
      const hop = new CodexSeatHop({ rows: store, guard, client, input, foregroundGroup: async () => [{ name: "bash", argv0: "bash" }, { name: "codex", argv0: "codex" }] });
      await expect(hop.attempt(message)).resolves.toEqual({ kind: "sent" });
      expect(new CodexSeatHop({ rows: store, guard, client, input, foregroundGroup: async () => [{ name: "bash", argv0: "bash" }] }).attempt(message)).resolves.toEqual({ kind: "paused", reason: "agent_absent" });
    });
    it("a held seat pauses", async () => {
      held = true;
      await expect(codex().attempt(message)).resolves.toEqual({ kind: "paused", reason: "guard_held" });
    });
  });

  describe("Pi and OMP", () => {
    let state: Partial<PiRunnerState> | null;
    // The ids (with the nonce the row holds) whose gate log says in flight: the runner has them.
    let held: Set<string>;
    const asked: Array<{ seat: string; marker: SeatMarker }> = [];
    const pi = () => new PiSeatHop({ rows: store, guard, client, input, runnerState: () => state as PiRunnerState | null, inFlight: (seat, marker) => { asked.push({ seat, marker }); return held.has(`${marker.id}:${marker.nonce}`); } });
    beforeEach(() => {
      held = new Set(); asked.length = 0;
      state = { seatGate: 1 }; screen = "[pi-runner] READY\n";
      foreground = { pid: 1, name: "node", argv: ["node", "/lib/daemon/dist/adapters/pi-runner.js", "--session-name", SEAT, "--no-approve"], cwd: "/w" };
    });

    it("every paste carries the marker", async () => {
      await expect(pi().attempt(message)).resolves.toEqual({ kind: "sent" });
      expect(calls).toEqual([`paste:${text()}`]);
    });
    it("a dead runner gets nothing, with its sidecar still saying ready: a paste into the shell runs each line", async () => {
      foreground = { pid: 1, name: "-bash", argv: ["-bash"], cwd: "/w" };
      await expect(pi().attempt(message)).resolves.toEqual({ kind: "paused", reason: "agent_absent" });
      expect(calls).toEqual([]);
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
    // OF-214: verify-sec@eztrack took a message mid-turn (the runner steered it), Pi showed it 31 minutes later when the turn's one tool call
    // ended, and the pump pasted the same text again at 2, 7 and 22 minutes: each copy printed in the pane before the gate dropped it.
    describe("a message the runner already holds (OF-214)", () => {
      it("is not typed again: the pump waits under its own reason, and asks about this row's id and nonce", async () => {
        held.add(`m-1:${store.nonceOf(ID)}`);
        await expect(pi().attempt(message)).resolves.toEqual({ kind: "paused", reason: "runner_held" });
        expect(calls).toEqual([]);
        expect(asked).toEqual([{ seat: SEAT, marker: { id: "m-1", nonce: store.nonceOf(ID)! } }]);
      });
      it("goes the moment the runner no longer holds it (Pi refused it, or a restart found no trace): that resend is the answer", async () => {
        held.add(`m-1:${store.nonceOf(ID)}`);
        const hop = pi();
        await hop.attempt(message);
        held.clear();
        await expect(hop.attempt(message)).resolves.toEqual({ kind: "sent" });
        expect(calls).toEqual([`paste:${text()}`]);
      });
      it("is held only under its own nonce: a forged marker of the same id in flight does not hold the real one", async () => {
        held.add("m-1:ffffffffffffffff");
        await expect(pi().attempt(message)).resolves.toEqual({ kind: "sent" });
      });
      it("a stopped seat is still reported as stopped, not as held", async () => {
        held.add(`m-1:${store.nonceOf(ID)}`);
        state = null;
        await expect(pi().attempt(message)).resolves.toEqual({ kind: "paused", reason: "seat_stopped" });
      });
      it("a wake group goes while any of its ids is new to the runner, and waits only when every one is held", async () => {
        store.accept({ id: messageId("m-2"), seat: SEAT, sender: "lead@r", body: "x" });
        store.claimAttempt(store.headOf(SEAT)!, 0);
        db.prepare("UPDATE outbox_entries SET native_nonce = 'abcdef0123456789abcdef0123456789' WHERE outbox_id = 'm-2'").run();
        const group: SeatMessage = { ...message, ids: [ID, messageId("m-2")], body: "a\nb", bodies: ["a", "b"] };
        held.add(`m-1:${store.nonceOf(ID)}`);
        await expect(pi().attempt(group)).resolves.toEqual({ kind: "sent" });
        held.add("m-2:abcdef0123456789abcdef0123456789");
        await expect(pi().attempt(group)).resolves.toEqual({ kind: "paused", reason: "runner_held" });
        expect(calls).toHaveLength(1);
      });
    });
    it("a leftover line with this marker gets Enter alone (M8); any other leftover holds", async () => {
      state = { seatGate: 1, pasteLeftover: true };
      screen = `> ${text()}\n`;
      await expect(pi().attempt(message)).resolves.toEqual({ kind: "sent" });
      expect(calls).toEqual(["keys:Enter"]);
      screen = "> someone's words\n";
      await expect(pi().attempt(message)).resolves.toEqual({ kind: "paused", reason: "draft" });
      expect(calls).toEqual(["keys:Enter"]);
    });
  });
  // Deliver, labelled: the pump gives a message for the previous occupant a body that starts with the label, on every attempt. Each runtime's hop
  // must carry it to the seat (the pump is runtime-neutral; the typing is not).
  describe("a message for the previous occupant carries its label to the seat, on every runtime", () => {
    const labelled: SeatMessage = { ...message, body: `${PREVIOUS_OCCUPANT_LABEL} Do the thing` };
    const labelledText = () => `${PREVIOUS_OCCUPANT_LABEL} Do the thing\n[openrig-msg m-1:${store.nonceOf(ID)}]`;
    it("Claude, by socket", async () => {
      await new ClaudeSeatHop({
        rows: store, guard, client, input, now: () => now,
        eligibility: async (): Promise<NativeEligibility> => ({ ok: true, nodeId: "n", endpoint }),
        writeToSeat: async (_e, sender, text) => { writes.push({ sender, text }); return "all"; },
      }).attempt(labelled);
      expect(writes.map((w) => w.text)).toEqual([labelledText()]);
    });
    it("Claude, by paste", async () => {
      eligible = false;
      foreground = { pid: 1, name: "claude", argv: ["claude"], cwd: "/w" };
      await new ClaudeSeatHop({
        rows: store, guard, client, input, now: () => now,
        eligibility: async (): Promise<NativeEligibility> => ({ ok: false, reason: "no" }),
        writeToSeat: async () => "none",
      }).attempt(labelled);
      expect(calls).toEqual([`paste:${labelledText()}`]);
    });
    it("Codex", async () => {
      foreground = { pid: 1, name: "sh", argv: ["/bin/sh", "/run/tmp/openrig-tmux-send-1-2"], cwd: "/w" };
      screen = "› Ask Codex to do anything\n  GPT-6-Luna low · /work\n";
      await new CodexSeatHop({ rows: store, guard, client, input }).attempt(labelled);
      expect(calls).toEqual([`paste:${labelledText()}`]);
    });
    it("Pi", async () => {
      foreground = { pid: 1, name: "node", argv: ["node", "/lib/daemon/dist/adapters/pi-runner.js", "--session-name", SEAT, "--no-approve"], cwd: "/w" };
      screen = "[pi-runner] READY\n";
      const state: Partial<PiRunnerState> = { seatGate: 1 };
      await new PiSeatHop({ rows: store, guard, client, input, runnerState: () => state as PiRunnerState | null, inFlight: () => false }).attempt(labelled);
      expect(calls).toEqual([`paste:${labelledText()}`]);
    });
    it("a long message whose first part went to the old occupant is cut where it was, not where the label would move it", async () => {
      foreground = { pid: 1, name: "sh", argv: ["/bin/sh", "/run/tmp/openrig-tmux-send-1-2"], cwd: "/w" };
      screen = "› Ask Codex to do anything\n  GPT-6-Luna low · /work\n";
      const spooled: Array<{ id: string; text: string }> = [];
      const spool: SeatSpool = { declaredVersion: () => 2, spool: (_s, marker, text) => { spooled.push({ id: marker.id, text }); }, discardSpool: () => {} };
      const body = "a".repeat(9000) + "b".repeat(9000) + "c";
      const hop = new CodexSeatHop({ rows: store, guard, client, input, spool });
      await hop.attempt({ ...message, body, part: 1 });
      await hop.attempt({ ...message, body: `${PREVIOUS_OCCUPANT_LABEL} ${body}`, part: 2 });
      expect(spooled.map((p) => [p.id, p.text.length, p.text[0]])).toEqual([["m-1.part1of3", 9000, "a"], ["m-1.part2of3", 9000, "b"]]);
      expect(store.partsOf(ID)).toBe(3);
      expect(calls[1]).toContain(`paste:${PREVIOUS_OCCUPANT_LABEL}\nOpenRig: long message`);
    });
  });
});
