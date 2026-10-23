// pda L0 (pda-runtime-design-9l Rev 2 + review delta D1-D6): the pure shared contract. Every rule here is
// one more than one lane must apply identically: the loopback predicate, the agent-name rule with J-1, the
// spec block, the resume token, the D4 restore warning, the sidecar parser, the argv, the token format
// (A6), the pane sanitiser (A5, T30 unit) and Jim's J-5 cost rule with its receiving-side pairing check.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { unicodeInvisiblesIn } from "./helpers/unicode-invisibles.js";
import {
  PDA_DEFAULT_BASE_URL, buildPdaRunnerArgv, derivePdaCost, formatPdaResumeToken, isPdaLoopbackBaseUrl,
  isPdaTokenFormat, parsePdaResumeToken, parsePdaRunnerState, parsePdaSpecBlock, parsePdaUsageFact,
  pdaAgentNameProblem, pdaRequestId, pdaRestoreBindingWarning, pdaSeatPaths, sanitizeForPane,
  type PdaRunnerState, type PdaUsageFact,
} from "../src/adapters/pda-runner-protocol.js";

describe("loopback base URL (one rule; schema, runner and token validator all call it)", () => {
  it.each(["http://127.0.0.1:8150", "http://127.0.0.1:1", "http://127.0.0.1:65535"])("accepts %s", (url) => {
    expect(isPdaLoopbackBaseUrl(url)).toBe(true);
  });
  it.each([
    "http://localhost:8150", "http://[::1]:8150", "https://127.0.0.1:8150", "http://127.0.0.1:8150/",
    "http://127.0.0.1:8150/agents", "http://u:p@127.0.0.1:8150", "http://127.0.0.1", "http://127.0.0.1:0",
    "http://127.0.0.1:65536", "http://127.0.0.1:08150", "http://127.0.0.2:8150", " http://127.0.0.1:8150",
    "http://127.0.0.1:8150\n", "http://100.64.0.1:8150",
  ])("refuses %j", (url) => {
    expect(isPdaLoopbackBaseUrl(url)).toBe(false);
  });
  it("refuses a non-string", () => { expect(isPdaLoopbackBaseUrl(8150)).toBe(false); });
});

describe("agent name (pda NAME_PATTERN by value, J-1)", () => {
  it("accepts a pda name and refuses main, patterns and non-strings with a reason", () => {
    expect(pdaAgentNameProblem("research")).toBeNull();
    expect(pdaAgentNameProblem("a")).toBeNull();
    expect(pdaAgentNameProblem("a".repeat(40))).toBeNull();
    expect(pdaAgentNameProblem("main")).toBe("root_agent");
    expect(pdaAgentNameProblem("Main")).toBe("pattern");
    expect(pdaAgentNameProblem("a".repeat(41))).toBe("pattern");
    expect(pdaAgentNameProblem("-x")).toBe("pattern");
    expect(pdaAgentNameProblem("x/y")).toBe("pattern");
    expect(pdaAgentNameProblem(7)).toBe("not_a_string");
  });
});

describe("the pda: spec block", () => {
  it("agent is required and has no default", () => {
    const r = parsePdaSpecBlock({ base_url: PDA_DEFAULT_BASE_URL });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.errors).toEqual(["pda.agent: required; it names the pda agent this seat drives (there is no default)"]);
    expect(parsePdaSpecBlock({}).ok).toBe(false);
  });
  it("J-1: agent: main is refused", () => {
    const r = parsePdaSpecBlock({ agent: "main" }, "pods[0].members[1].pda");
    expect(r).toEqual({ ok: false, errors: ["pods[0].members[1].pda.agent: 'main' is pda's root agent and cannot be bound to a seat"] });
  });
  it("base_url defaults to the pda default and must be loopback", () => {
    expect(parsePdaSpecBlock({ agent: "research" })).toEqual({ ok: true, binding: { agent: "research", baseUrl: "http://127.0.0.1:8150" } });
    expect(parsePdaSpecBlock({ agent: "research", base_url: "http://127.0.0.1:9000" }))
      .toEqual({ ok: true, binding: { agent: "research", baseUrl: "http://127.0.0.1:9000" } });
    const bad = parsePdaSpecBlock({ agent: "research", base_url: "http://localhost:8150" });
    expect(bad.ok === false && bad.errors).toHaveLength(1);
    expect(bad.ok === false && bad.errors[0]).toMatch(/^pda\.base_url: must be http:\/\/127\.0\.0\.1:<port>/);
  });
  it("an explicit null base_url is refused, not defaulted", () => {
    expect(parsePdaSpecBlock({ agent: "research", base_url: null }).ok).toBe(false);
  });
  it("unknown keys and non-mappings are refused", () => {
    expect(parsePdaSpecBlock({ agent: "research", model: "x" })).toEqual({ ok: false, errors: [
      "pda.model: unknown key; a pda block takes only agent, base_url"] });
    expect(parsePdaSpecBlock("research").ok).toBe(false);
    expect(parsePdaSpecBlock(["research"]).ok).toBe(false);
    expect(parsePdaSpecBlock(null).ok).toBe(false);
  });
});

describe("resume token", () => {
  const binding = { agent: "research", baseUrl: "http://127.0.0.1:8150" };
  it("round-trips", () => {
    expect(formatPdaResumeToken(binding)).toBe("http://127.0.0.1:8150/agents/research");
    expect(parsePdaResumeToken(formatPdaResumeToken(binding))).toEqual(binding);
  });
  it.each([
    "http://127.0.0.1:8150/agents/main", "http://localhost:8150/agents/research", "http://127.0.0.1:8150/agents/",
    "http://127.0.0.1:8150/agents/research/", "http://127.0.0.1:8150/agents/Research", "http://127.0.0.1:99999/agents/research",
    "http://127.0.0.1:8150/agents/a/b", "/agents/research", "",
  ])("refuses %j", (token) => {
    expect(parsePdaResumeToken(token)).toBeNull();
  });
});

describe("D4: restore warns when the spec binding and the token disagree", () => {
  const token = { agent: "research", baseUrl: "http://127.0.0.1:8150" };
  it("is silent when they agree or the spec binding is unknown", () => {
    expect(pdaRestoreBindingWarning({ ...token }, token)).toBeNull();
    expect(pdaRestoreBindingWarning(null, token)).toBeNull();
  });
  it("names both bindings, says the token wins, and names the only rebind", () => {
    const w = pdaRestoreBindingWarning({ agent: "writer", baseUrl: "http://127.0.0.1:8150" }, token);
    expect(w).toContain("'writer' at http://127.0.0.1:8150");
    expect(w).toContain("Restore resumes 'research' (the token)");
    expect(w).toContain("re-instantiate the seat");
    expect(pdaRestoreBindingWarning({ agent: "research", baseUrl: "http://127.0.0.1:9000" }, token)).not.toBeNull();
  });
});

describe("seat paths, argv and request ids", () => {
  it("lays out the seat's state under <stateRoot>/<sessionName>", () => {
    expect(pdaSeatPaths("/h/.openrig/state/pda", "research@r")).toEqual({
      seatRoot: "/h/.openrig/state/pda/research@r",
      runnerStatePath: "/h/.openrig/state/pda/research@r/runner-state.json",
      outboxPath: "/h/.openrig/state/pda/research@r/outbox.log",
      rejectedPath: "/h/.openrig/state/pda/research@r/rejected.log",
      ownSubmissionsPath: "/h/.openrig/state/pda/research@r/own-submissions.json",
      releaseRequestPath: "/h/.openrig/state/pda/research@r/release.request",
    });
  });
  it("builds the runner argv from a token PATH; --usage-facts only when on", () => {
    const base = { sessionName: "research@r", stateRoot: "/s", launchId: "L1", binding: { agent: "research", baseUrl: "http://127.0.0.1:8150" }, tokenFile: "/h/.pi-durable/token" };
    expect(buildPdaRunnerArgv(base)).toEqual([
      "--session-name", "research@r", "--state-root", "/s", "--launch-id", "L1", "--agent", "research",
      "--base-url", "http://127.0.0.1:8150", "--token-file", "/h/.pi-durable/token",
    ]);
    expect(buildPdaRunnerArgv({ ...base, usageFacts: true }).slice(-1)).toEqual(["--usage-facts"]);
  });
  it("request ids live under openrig/<nodeId>/", () => {
    expect(pdaRequestId("n1", "L1", 3)).toBe("openrig/n1/L1/3");
  });
});

describe("A6: the token format is checked before any use", () => {
  it("accepts pda's own 43-char base64url and the bounds", () => {
    expect(isPdaTokenFormat("Q2hhbmdlTWVQbGVhc2VUaGlzSXNOb3RBUmVhbFRva2Vu".slice(0, 43))).toBe(true);
    expect(isPdaTokenFormat("a".repeat(16))).toBe(true);
    expect(isPdaTokenFormat("a".repeat(512))).toBe(true);
  });
  it.each([
    ["interior LF", "abcdefghijklmnopqrst\ntail"], ["trailing LF", "abcdefghijklmnopqrst\n"], ["too short", "a".repeat(15)],
    ["too long", "a".repeat(513)], ["base64 padding", "abcdefghijklmnopqrst="], ["plus", "abcdefghijklmnop+rst"], ["space", "abcdefghij klmnopqrst"],
  ])("refuses %s", (_label, value) => {
    expect(isPdaTokenFormat(value)).toBe(false);
  });
});

describe("sidecar parser", () => {
  const ok: PdaRunnerState = {
    ready: true, launchId: "L1", updatedAt: "2026-10-23T12:00:00Z", aliveAt: "2026-10-23T12:00:00Z",
    agent: "research", baseUrl: "http://127.0.0.1:8150", connected: true, busy: false, outboxPending: 0,
  };
  it("parses a complete record and its optional fields", () => {
    expect(parsePdaRunnerState(JSON.stringify(ok))).toEqual(ok);
    const held = { ...ok, held: { requestId: "openrig/n/L/1", code: "pda_message_held", at: "t" }, setAside: 1,
      error: { code: "pda_outbox_binding_mismatch", at: "t" }, exited: { code: null, at: "t" } };
    expect(parsePdaRunnerState(JSON.stringify(held))).toEqual(held);
  });
  it.each([
    ["not JSON", "{"], ["an array", "[]"], ["no aliveAt", JSON.stringify({ ...ok, aliveAt: undefined })],
    ["busy not boolean", JSON.stringify({ ...ok, busy: "no" })], ["negative pending", JSON.stringify({ ...ok, outboxPending: -1 })],
    ["unknown held code", JSON.stringify({ ...ok, held: { requestId: "r", code: "pda_whatever", at: "t" } })],
    ["unknown error code", JSON.stringify({ ...ok, error: { code: "boom", at: "t" } })],
    ["bad exited", JSON.stringify({ ...ok, exited: { code: "1", at: "t" } })],
  ])("refuses %s (no runner answer, never a guess)", (_label, raw) => {
    expect(parsePdaRunnerState(raw)).toBeNull();
  });
});

describe("A5: sanitizeForPane (T30 unit; the review's 12 forms plus DEL)", () => {
  // Each form sits between "a" and "b"; the exact result pins both that the sequence is gone, payload
  // included, and that the text around it is kept.
  it.each([
    ["CSI bracketed-paste off", "\u001b[?2004l"],
    ["OSC 52 clipboard, BEL", "\u001b]52;c;c2VjcmV0\u0007"],
    ["OSC title, ST", "\u001b]0;title\u001b\\"],
    ["C1 CSI", "\u009b?2004l"],
    ["2-byte ESC", "\u001bc"],
    ["ESC with intermediate (charset)", "\u001b(B"],
    ["C1 OSC with payload", "\u009d52;c;c2VjcmV0\u009c"],
    ["DCS to ST", "\u001bPq#0;1;2\u001b\\"],
    ["BEL", "\u0007"],
    ["CR", "\r"],
    ["ETX", "\u0003"],
    ["DEL", "\u007f"],
    ["bidi RLO", "\u202e"],
    ["bidi isolate", "\u2067"],
    // Review N4: the bidi marks and the line and paragraph separators.
    ["LRM", "\u200e"],
    ["RLM", "\u200f"],
    ["ALM", "\u061c"],
    ["line separator", "\u2028"],
    ["paragraph separator", "\u2029"],
  ])("removes %s", (_label, seq) => {
    expect(sanitizeForPane("a" + seq + "b")).toBe("ab");
  });
  it("removes a lone ESC (at the end, or before a byte that cannot end a sequence)", () => {
    expect(sanitizeForPane("a\u001b")).toBe("a");
    expect(sanitizeForPane("a\u001b\nb")).toBe("a\nb");
    // ESC plus a printable final byte IS a 2-byte sequence to a terminal, so the final byte goes with it.
    expect(sanitizeForPane("a\u001bcb")).toBe("ab");
  });
  // Battery M15 survived without this row: every C1 form above is an introducer the escape pass already
  // removes, so nothing exercised step 2's C1 range. NEL and a stray ST are C1 controls that start nothing.
  it("removes a lone C1 control (NEL, a stray ST) that introduces no sequence", () => {
    expect(sanitizeForPane("a\u0085b\u009cc")).toBe("abc");
  });
  // Review N5: the guard is written as escapes. A raw invisible character in the source can be dropped by
  // an editor or formatter without any visible diff, silently shrinking the class.
  it("the sanitiser's source holds no raw invisible character", () => {
    const src = readFileSync(fileURLToPath(new URL("../src/adapters/pda-runner-protocol.ts", import.meta.url)), "utf8");
    expect(src.length).toBeGreaterThan(1000); // positive control: the file was read
    expect(unicodeInvisiblesIn(src)).toEqual([]);
  });
  it("keeps LF, TAB and ordinary Unicode", () => {
    expect(sanitizeForPane("line one\n\tcafé 日本語 ── idle ──\n")).toBe("line one\n\tcafé 日本語 ── idle ──\n");
  });
  it("leaves no control byte and no ESC in a mixed adversarial string", () => {
    const out = sanitizeForPane("x\u001b]52;c;Zm9v\u0007y\u001bPdcs\u001b\\z\r\n\u009b31mw\u001b[1;31mv\u202eu\u001b");
    expect(out).toBe("xyz\nwvu");
    expect(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(out)).toBe(false);
  });
});

describe("J-5: the cost rule (Jim's decision) and the receiving side's pairing check", () => {
  const tokens = (n: number) => ({ input: n, output: n, cacheRead: 0, cacheWrite: 0 });
  it("a priced entry keeps its cost", () => {
    expect(derivePdaCost({ total: 0.0123 }, tokens(10))).toEqual({ costTotal: 0.0123, costBasis: "model_priced" });
  });
  it("a zero price with tokens is NULL with declared_zero_price", () => {
    expect(derivePdaCost({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, tokens(812))).toEqual({ costTotal: null, costBasis: "declared_zero_price" });
    expect(derivePdaCost({ total: 0 }, { input: 0, output: 0, cacheRead: 5, cacheWrite: 0 })).toEqual({ costTotal: null, costBasis: "declared_zero_price" });
  });
  it("a 0 cost with 0 tokens is a real 0, model_priced", () => {
    expect(derivePdaCost({ total: 0 }, tokens(0))).toEqual({ costTotal: 0, costBasis: "model_priced" });
  });
  it.each([
    ["no cost object", undefined], ["null", null], ["no total", {}], ["string total", { total: "0.1" }],
    ["negative", { total: -0.5 }], ["NaN", { total: Number.NaN }], ["Infinity", { total: Number.POSITIVE_INFINITY }],
  ])("%s is NULL with absent", (_label, cost) => {
    expect(derivePdaCost(cost, tokens(10))).toEqual({ costTotal: null, costBasis: "absent" });
  });

  // Review N6: unusable token counts make the basis unknowable, even with a zero or a positive total.
  it.each([
    ["NaN input", { input: Number.NaN, output: 1, cacheRead: 0, cacheWrite: 0 }, { total: 0 }],
    ["NaN cacheWrite", { input: 0, output: 0, cacheRead: 0, cacheWrite: Number.NaN }, { total: 0 }],
    ["Infinity output", { input: 1, output: Number.POSITIVE_INFINITY, cacheRead: 0, cacheWrite: 0 }, { total: 0.5 }],
    ["negative cacheRead", { input: 0, output: 0, cacheRead: -3, cacheWrite: 0 }, { total: 0 }],
  ])("token counts with %s are NULL with absent", (_label, counts, cost) => {
    expect(derivePdaCost(cost, counts)).toEqual({ costTotal: null, costBasis: "absent" });
  });

  const fact = (over: Partial<PdaUsageFact>): Record<string, unknown> => ({
    conversationId: "c1", entryId: "e1", entryTimestamp: "2026-10-23T12:00:00Z", kind: "assistant",
    provider: "ollama-cloud", model: "glm-5", api: "openai-completions", responseId: null, stopReason: "stop",
    input: 812, output: 144, cacheRead: 0, cacheWrite: 0, costTotal: null, costBasis: "declared_zero_price", origin: "own", ...over,
  });
  it("accepts every pairing the rule produces", () => {
    expect(parsePdaUsageFact(fact({}))).not.toBeNull();
    expect(parsePdaUsageFact(fact({ costTotal: 0.01, costBasis: "model_priced" }))).not.toBeNull();
    expect(parsePdaUsageFact(fact({ costTotal: null, costBasis: "absent" }))).not.toBeNull();
    expect(parsePdaUsageFact(fact({ input: 0, output: 0, costTotal: 0, costBasis: "model_priced" }))).not.toBeNull();
  });
  it("accepts the largest safe-integer token count (the boundary the safe-integer rule keeps)", () => {
    expect(parsePdaUsageFact(fact({ input: Number.MAX_SAFE_INTEGER }))).not.toBeNull();
  });
  it.each([
    ["a stored 0 for real tokens", { costTotal: 0, costBasis: "model_priced" as const }],
    ["a cost on a declared-zero fact", { costTotal: 0.01, costBasis: "declared_zero_price" as const }],
    ["a cost on an absent fact", { costTotal: 0, costBasis: "absent" as const }],
    ["declared-zero with 0 tokens", { input: 0, output: 0, costBasis: "declared_zero_price" as const }],
    ["a NULL model_priced cost", { costTotal: null, costBasis: "model_priced" as const }],
    ["a negative cost", { costTotal: -1, costBasis: "model_priced" as const }],
    ["an unknown basis", { costBasis: "free" as never }],
    ["an unknown origin", { origin: "inherited" as never }],
    ["a non-assistant kind", { kind: "tool_result" as never }],
    ["fractional tokens", { input: 1.5 }],
    ["a token count past the safe-integer range", { output: 1e300 }],
    ["a token count one past the largest safe integer", { cacheRead: Number.MAX_SAFE_INTEGER + 1 }],
    ["no entry id", { entryId: "" }],
  ])("refuses %s", (_label, over) => {
    expect(parsePdaUsageFact(fact(over as Partial<PdaUsageFact>))).toBeNull();
  });
});
