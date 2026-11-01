// S2, the Codex last hop. An attempt that pastes over a staged copy types the message twice, and one that presses Enter on a person's
// draft sends their words. The screens here are as measured on Codex 0.166.0 (s0 M4, M8).
import { describe, it, expect } from "vitest";
import { CodexPasteHop, composerHoldsMessage, decideStagedAttempt, readCodexComposer } from "../src/adapters/codex-paste-hop.js";
import { messageId, type SeatMessage } from "../src/domain/seat-messaging/ports.js";
import { HcError, HcUnavailableError } from "../src/adapters/hc-client.js";

const MARKER = "[openrig-msg m-1:0123456789abcdef0123]";
const SHORT = `Reply with TWO\n${MARKER}`;
const LONG = `${"x".repeat(1571)}\n${MARKER}`;
const FOOTER = "  GPT-6-Luna low · /work/cx1 · Reply with ONE\n  ? for shortcuts";
const screen = (composer: string) => `› Reply with ONE\n  [openrig-msg old:0123456789abcdef0123]\n• ONE\n\n${composer}\n\n${FOOTER}\n`;
const EMPTY = screen("› Ask Codex to do anything");

describe("reading the composer", () => {
  it("the placeholder is empty, whatever the history above it", () => {
    expect(readCodexComposer(EMPTY)).toEqual({ kind: "empty" });
  });
  it("a staged message, its lines down to the footer, not the history's", () => {
    expect(readCodexComposer(screen(`› Reply with TWO\n  ${MARKER}`))).toMatchObject({ kind: "text", lines: ["Reply with TWO", MARKER] });
  });
  it("a footer directly under the composer is not the message", () => {
    expect(readCodexComposer(`› half a thought\n${FOOTER}\n`)).toMatchObject({ kind: "text", lines: ["half a thought"] });
  });
  it("no prompt line is unreadable, never empty", () => {
    expect(readCodexComposer("Welcome to Codex\n")).toEqual({ kind: "unreadable" });
  });
  it("a bare prompt is empty", () => {
    expect(readCodexComposer(`›\n\n${FOOTER}\n`)).toEqual({ kind: "empty" });
  });
});

describe("what is staged", () => {
  it("a long paste shows only a length, which a person's paste could match: it is not proof", () => {
    expect(LONG.length).toBe(1610);
    expect(composerHoldsMessage(["[Pasted Content 1610 chars]"], LONG)).toBe(false);
  });
  it("another paste of another length is not this message", () => {
    expect(composerHoldsMessage(["[Pasted Content 1611 chars]"], LONG)).toBe(false);
  });
  it("two collapsed pastes are not one message", () => {
    expect(composerHoldsMessage(["[Pasted Content 1610 chars]", "[Pasted Content 1610 chars]"], LONG)).toBe(false);
  });
  it("a draft holding the marker text mid-line is not a staged copy", () => {
    expect(composerHoldsMessage([`look at ${MARKER} here`], SHORT)).toBe(false);
    expect(composerHoldsMessage(["look at", MARKER.slice(0, 20), MARKER.slice(20), "here"], SHORT)).toBe(true);  // wrapped across whole lines
    expect(composerHoldsMessage([`look at ${MARKER.slice(0, 20)}`, MARKER.slice(20)], SHORT)).toBe(false);
  });
  it("another message's marker is not this one", () => {
    expect(composerHoldsMessage(["hello", "[openrig-msg m-2:0123456789abcdef0123]"], SHORT)).toBe(false);
  });
  it("a body with no marker is matched by nothing visible", () => {
    expect(composerHoldsMessage(["hello"], "hello")).toBe(false);
  });
  it("decides paste on empty, Enter only on this message, hold on a draft or an unreadable screen", () => {
    expect(decideStagedAttempt({ kind: "empty" }, SHORT)).toBe("paste");
    expect(decideStagedAttempt({ kind: "text", lines: ["Reply with TWO", MARKER], below: ["Reply with TWO", MARKER] }, SHORT)).toBe("enter_only");
    expect(decideStagedAttempt({ kind: "text", lines: ["my draft"], below: ["my draft"] }, SHORT)).toBe("draft");
    expect(decideStagedAttempt({ kind: "unreadable" }, SHORT)).toBe("unreadable");
  });
});

function hop(opts: { status?: string | null; state?: string; composer?: string; sent?: { ok: true } | { ok: false; code: string; message: string }; get?: Error }) {
  const calls: string[] = [];
  const client = { call: async <T,>(method: string): Promise<T> => {
    if (opts.get) throw opts.get;
    const reply = method === "terminal.get"
      ? { state: opts.state ?? "live", status: opts.status === null ? null : { state: opts.status ?? "idle" } }
      : { text: opts.composer === undefined ? EMPTY : screen(opts.composer) };
    return reply as T;
  } };
  const sent = opts.sent ?? { ok: true as const };
  return { calls, hop: new CodexPasteHop(client, {
    submitText: async (_seat, text) => { calls.push(`paste:${text.length}`); return sent; },
    sendKeys: async (_seat, keys) => { calls.push(`keys:${keys.join("+")}`); return sent; },
  }) };
}
const message = (body: string): SeatMessage => ({ ids: [messageId("m-1")], seat: "dev@rig", body, messageClass: "content", lane: 2 });

describe("one attempt", () => {
  it("an empty composer gets the paste and the Enter, one call", async () => {
    const h = hop({});
    await expect(h.hop.attempt(message(SHORT))).resolves.toEqual({ kind: "sent" });
    expect(h.calls).toEqual([`paste:${SHORT.length}`]);
  });
  it("a staged copy showing its marker gets Enter only, and a collapsed one holds", async () => {
    const shown = hop({ composer: `› Reply with TWO\n  ${MARKER}` });
    await expect(shown.hop.attempt(message(SHORT))).resolves.toEqual({ kind: "sent" });
    expect(shown.calls).toEqual(["keys:Enter"]);
    const collapsed = hop({ composer: "› [Pasted Content 1610 chars]", status: "done" });
    await expect(collapsed.hop.attempt(message(LONG))).resolves.toEqual({ kind: "paused", reason: "draft" });
    expect(collapsed.calls).toEqual([]);
  });
  it("a draft holds: nothing typed, nothing pressed", async () => {
    const h = hop({ composer: "› half a thought" });
    await expect(h.hop.attempt(message(SHORT))).resolves.toEqual({ kind: "paused", reason: "draft" });
    expect(h.calls).toEqual([]);
  });
  it.each([["blocked", "blocked"], ["working", "busy"], [null, "busy"]])("status %s pauses as %s, before any input", async (status, reason) => {
    const h = hop({ status, composer: `› x\n  ${MARKER}` });
    await expect(h.hop.attempt(message(SHORT))).resolves.toEqual({ kind: "paused", reason });
    expect(h.calls).toEqual([]);
  });
  it("a finished terminal, a missing one and an unreachable core all pause as stopped", async () => {
    await expect(hop({ state: "finished" }).hop.attempt(message(SHORT))).resolves.toEqual({ kind: "paused", reason: "seat_stopped" });
    await expect(hop({ get: new HcError("gone", "not_found", 404) }).hop.attempt(message(SHORT))).resolves.toEqual({ kind: "paused", reason: "seat_stopped" });
    await expect(hop({ get: new HcUnavailableError("down") }).hop.attempt(message(SHORT))).resolves.toEqual({ kind: "paused", reason: "seat_stopped" });
  });
  it("hc's own refusal on a dialog pauses, any other is refused", async () => {
    await expect(hop({ sent: { ok: false, code: "seat_blocked", message: "m" } }).hop.attempt(message(SHORT))).resolves.toEqual({ kind: "paused", reason: "blocked" });
    await expect(hop({ sent: { ok: false, code: "other", message: "m" } }).hop.attempt(message(SHORT))).resolves.toEqual({ kind: "refused", reason: "other" });
  });
});
