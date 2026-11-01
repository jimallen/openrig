// The last hops the pump drives on real seats. The store is real, so what crosses a restart is measured; the core client and the input are
// fakes that record every call. Screens are as measured on Claude 2.1.316 and Codex 0.166.0 (s0 M1, M3, M4, M8).
import { beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { CODEX_PASTE_LIMIT, ClaudeSeatHop, CodexSeatHop, PiSeatHop, foregroundHoldsAgent, isSeatAgent, markedText, readClaudeComposer, type HopGuard } from "../src/adapters/seat-hops.js";
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
    it("a message past the paste limit goes as a short pointer with its own marker, so it can never collapse", async () => {
      screen = `› Ask Codex to do anything\n${FOOTER}`;
      const long = { ...message, body: "y".repeat(CODEX_PASTE_LIMIT) };
      await expect(codex().attempt(long)).resolves.toEqual({ kind: "sent" });
      const sent = calls[0]!.replace("paste:", "");
      expect(Buffer.byteLength(sent)).toBeLessThanOrEqual(CODEX_PASTE_LIMIT);
      expect(sent).not.toContain("yyy");
      expect(sent).toContain(`rig seat read-message ${SEAT} m-1`);
      expect(splitMarkedBlock(sent).markers).toEqual([{ id: "m-1", nonce: store.nonceOf(ID) }]);
    });
    it("a long wake group's pointer names every row, in order, so no text is left unread", async () => {
      screen = `› Ask Codex to do anything\n${FOOTER}`;
      const second = messageId("m-2");
      store.accept({ id: second, seat: SEAT, sender: "lead@r", body: "second" });
      store.claimAttempt({ ...store.headOf(SEAT)!, id: second, attempts: 0 }, T0 + 1);
      const group: SeatMessage = { ...message, ids: [ID, second], body: "y".repeat(CODEX_PASTE_LIMIT) };
      await expect(codex().attempt(group)).resolves.toEqual({ kind: "sent" });
      const sent = calls[0]!.replace("paste:", "");
      expect(sent.indexOf(`rig seat read-message ${SEAT} m-1`)).toBeGreaterThan(-1);
      expect(sent.indexOf(`rig seat read-message ${SEAT} m-2`)).toBeGreaterThan(sent.indexOf(`rig seat read-message ${SEAT} m-1`));
      expect(splitMarkedBlock(sent).markers.map((m) => m.id)).toEqual(["m-1", "m-2"]);
    });
    it("at the limit it goes whole; a multi-byte body is judged by its bytes", async () => {
      screen = `› Ask Codex to do anything\n${FOOTER}`;
      const marker = `\n[openrig-msg m-1:${store.nonceOf(ID)}]`;
      const fits = "z".repeat(CODEX_PASTE_LIMIT - Buffer.byteLength(marker));
      await codex().attempt({ ...message, body: fits });
      expect(calls[0]).toContain(fits);
      calls.length = 0;
      await codex().attempt({ ...message, body: "é".repeat(CODEX_PASTE_LIMIT / 2) });
      expect(calls[0]).toContain("read-message");
    });
    it("a pointer keeps the label of a message sent to the previous occupant", async () => {
      screen = `› Ask Codex to do anything\n${FOOTER}`;
      await codex().attempt({ ...message, body: `${PREVIOUS_OCCUPANT_LABEL} ${"y".repeat(CODEX_PASTE_LIMIT)}` });
      expect(calls[0]).toContain(`paste:${PREVIOUS_OCCUPANT_LABEL} A message too long`);
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
    const pi = () => new PiSeatHop({ rows: store, guard, client, input, runnerState: () => state as PiRunnerState | null });
    beforeEach(() => {
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
});
