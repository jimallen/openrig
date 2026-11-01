// S2: what a retry may do on a Claude seat. A staged paste must be recognised without the marker: Claude shows a multi-line paste as a
// placeholder (M3), and a person's draft must never be submitted, cleared or pasted onto.
import { describe, it, expect } from "vitest";
import { decideClaudeRetry, type ClaudeRetryInput } from "../src/domain/seat-messaging/claude-last-hop.js";

const MARKER = "[openrig-msg m-1:0123456789abcdef]";
const seven = `one\ntwo\nthree\nfour\nfive\n\n${MARKER}`;
const paste: ClaudeRetryInput = { text: seven, socketEligible: false, nowMs: 100_000, lastSocketAttemptMs: null, gateSeen: false, atRest: true, composer: "" };

describe("the socket hop", () => {
  it("is the default on an eligible seat, whatever the composer holds", () => {
    expect(decideClaudeRetry({ ...paste, socketEligible: true, composer: "my draft", atRest: false })).toEqual({ kind: "socket" });
  });
  it("waits out Claude's silent drop of an identical line (M1): the last 25 s measured dropped, 40 s delivered", () => {
    const at = (gap: number) => decideClaudeRetry({ ...paste, socketEligible: true, nowMs: 100_000, lastSocketAttemptMs: 100_000 - gap });
    expect(at(25_000)).toEqual({ kind: "wait", notBefore: 115_000 });
    expect(at(39_999).kind).toBe("wait");
    expect(at(40_000)).toEqual({ kind: "socket" });
  });
});

describe("the paste hop, where a seat is ineligible", () => {
  it("an empty composer takes a paste", () => {
    expect(decideClaudeRetry(paste)).toEqual({ kind: "paste" });
  });
  it("Enter only for a staged multi-line paste, known by its line count: no marker is on the screen", () => {
    const composer = "[Pasted text #1 +7 lines]";
    expect(composer).not.toContain("openrig-msg");
    expect(decideClaudeRetry({ ...paste, composer })).toEqual({ kind: "enter_only" });
  });
  it("Enter only for staged text shown in full", () => {
    expect(decideClaudeRetry({ ...paste, text: `hi\n\n${MARKER}`, composer: `hi\n\n${MARKER}` })).toEqual({ kind: "enter_only" });
  });
  it("a placeholder of another length, or with no length, may be a person's: nothing is typed", () => {
    expect(decideClaudeRetry({ ...paste, composer: "[Pasted text #1 +8 lines]" })).toEqual({ kind: "paused", reason: "guard_held" });
    expect(decideClaudeRetry({ ...paste, composer: "[Pasted text #1]" })).toEqual({ kind: "paused", reason: "guard_held" });
  });
  it("a person's draft is never pasted onto, submitted or cleared", () => {
    expect(decideClaudeRetry({ ...paste, composer: "my draft" })).toEqual({ kind: "paused", reason: "guard_held" });
    expect(decideClaudeRetry({ ...paste, composer: "my draft", gateSeen: true })).toEqual({ kind: "paused", reason: "guard_held" });
  });
  it("a blocked copy is cleared with ctrl+c, the only tested key (M3), and only at rest", () => {
    expect(decideClaudeRetry({ ...paste, composer: "[Pasted text #2 +7 lines]", gateSeen: true })).toEqual({ kind: "clear_composer", key: "ctrl+c" });
    expect(decideClaudeRetry({ ...paste, composer: "[Pasted text #2 +7 lines]", gateSeen: true, atRest: false })).toEqual({ kind: "paused", reason: "busy" });
  });
  it("an unreadable composer proves nothing, so nothing is typed", () => {
    expect(decideClaudeRetry({ ...paste, composer: null })).toEqual({ kind: "paused", reason: "guard_held" });
  });
});
