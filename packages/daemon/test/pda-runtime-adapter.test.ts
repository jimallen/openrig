// pda runtime L2a: the pda RuntimeAdapter and its resume adapter, against a fake tmux and a real sidecar on disk.
// No pda, no tmux, no runner process: the sidecar the runner would write is written by the test, in L0's shape.
// The end-to-end rows (the REAL PdaRunner against L1a's fake pda) are in pda-l2a-runner-seat.test.ts.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PdaRuntimeAdapter, PDA_SIDECAR_ALIVE_WINDOW_MS, resolvePdaTokenFile, type PdaRuntimeAdapterDeps } from "../src/adapters/pda-runtime-adapter.js";
import { PdaResumeAdapter } from "../src/adapters/pda-resume.js";
import { pdaSeatPaths, type PdaRunnerState } from "../src/adapters/pda-runner-protocol.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";
import { adapterFreshStart, adapterStartupContent, isAttentionRequiredReadinessCode } from "../src/domain/runtime-adapter.js";

const SESSION = "research@rig";
const BASE = "http://127.0.0.1:8150";
const NOW = new Date("2026-10-24T09:00:00.000Z");

let dir: string;
let stateRoot: string;
let tokenFile: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pda-adapter-"));
  stateRoot = path.join(dir, "state", "pda");
  tokenFile = path.join(dir, "token");
  fs.writeFileSync(tokenFile, "x".repeat(43), { mode: 0o600 });
  fs.mkdirSync(pdaSeatPaths(stateRoot, SESSION).seatRoot, { recursive: true });
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function state(over: Partial<PdaRunnerState> = {}): PdaRunnerState {
  return {
    ready: true, launchId: "launch-1", updatedAt: NOW.toISOString(), aliveAt: NOW.toISOString(), agent: "research", baseUrl: BASE,
    connected: true, busy: false, outboxPending: 0, ...over,
  };
}
function writeSidecar(value: PdaRunnerState | string): void {
  fs.writeFileSync(pdaSeatPaths(stateRoot, SESSION).runnerStatePath, typeof value === "string" ? value : JSON.stringify(value));
}

interface FakeTmux {
  commands: string[];
  paneCommand: string | null;
  pane: string;
  alive: boolean;
  /** Runs when the runner command is "typed": the test plays the runner by writing its sidecar. */
  onCommand: (command: string) => void;
}

function adapter(over: Partial<PdaRuntimeAdapterDeps> = {}, tmuxOver: Partial<FakeTmux> = {}) {
  const tmux: FakeTmux = { commands: [], paneCommand: "node", pane: "", alive: true, onCommand: () => {}, ...tmuxOver };
  const deps: PdaRuntimeAdapterDeps = {
    tmux: {
      sendShellCommand: async (_target: string, command: string) => { tmux.commands.push(command); tmux.onCommand(command); return { ok: true as const }; },
      hasSession: async () => tmux.alive,
      getPaneCommand: async () => tmux.paneCommand,
      capturePaneContent: async () => tmux.pane,
    } as unknown as PdaRuntimeAdapterDeps["tmux"],
    fsOps: {
      readFile: (p) => fs.readFileSync(p, "utf8"),
      exists: (p) => fs.existsSync(p),
      lstat: (p) => { try { return { isFile: fs.lstatSync(p).isFile() }; } catch { return null; } },
    },
    stateRoot, runnerEntryPath: "/opt/openrig/dist/adapters/pda-runner.js",
    tokenFile: () => tokenFile,
    newLaunchId: () => "launch-1",
    now: () => NOW,
    sleep: async () => {},
    pollMs: 1, launchWaitMs: 20,
    ...over,
  };
  return { adapter: new PdaRuntimeAdapter(deps), tmux };
}

const binding = (over: Partial<NodeBinding> = {}): NodeBinding => ({
  id: "b1", nodeId: "node-1", tmuxSession: SESSION, tmuxWindow: null, tmuxPane: null, cmuxWorkspace: null, cmuxSurface: null,
  updatedAt: "", cwd: "/work", pda: { agent: "research", baseUrl: BASE }, ...over,
});

describe("PdaRuntimeAdapter: the contract fields", () => {
  it("declares no fresh start and withholds startup content; the L0 readers see exactly that", () => {
    const { adapter: a } = adapter();
    expect(a.runtime).toBe("pda");
    expect(adapterFreshStart(a)).toBe("unsupported");
    expect(adapterStartupContent(a)).toBe("withhold");
  });

  it("D4: project and deliverStartup deliver nothing, required files included, and say what was withheld", async () => {
    const { adapter: a, tmux } = adapter();
    const files = [
      { path: "role.md", absolutePath: "/x/role.md", ownerRoot: "/x", deliveryHint: "send_text" as const, required: true, appliesOn: ["fresh_start" as const] },
    ];
    const delivered = await a.deliverStartup(files, binding());
    expect(delivered).toEqual({ delivered: 0, failed: [], warnings: [expect.stringContaining("1 startup file was withheld")] });
    const projected = await a.project({ runtime: "pda", cwd: "/w", entries: [{ effectiveId: "skill-a" } as never], startup: { files: [], actions: [] }, conflicts: [], noOps: [], diagnostics: [] }, binding());
    expect(projected.projected).toEqual([]);
    expect(projected.skipped).toEqual(["skill-a"]);
    expect(projected.warnings?.[0]).toContain("not applied");
    // Nothing reached the pane.
    expect(tmux.commands).toEqual([]);
    // An empty plan says nothing.
    expect((await a.deliverStartup([], binding())).warnings).toBeUndefined();
  });
});

describe("PdaRuntimeAdapter.launchHarness", () => {
  const ready = (tmux: FakeTmux) => { tmux.onCommand = () => writeSidecar(state()); };

  it("types node <entry> with L0's argv: the token file as a PATH, never its content; --usage-facts only when on", async () => {
    fs.writeFileSync(tokenFile, "SECRETTOKENVALUEabcdefghijklmnopqrstuvwxyz0", { mode: 0o600 });
    for (const usage of [false, true]) {
      const { adapter: a, tmux } = adapter({ usageFactsEnabled: () => usage });
      ready(tmux);
      const result = await a.launchHarness(binding(), { name: SESSION });
      expect(result).toEqual({ ok: true, resumeToken: `${BASE}/agents/research`, resumeType: "pda_agent" });
      expect(tmux.commands).toHaveLength(1);
      const command = tmux.commands[0]!;
      expect(command).toBe([
        "node", "'/opt/openrig/dist/adapters/pda-runner.js'",
        "--session-name", `'${SESSION}'`, "--state-root", `'${stateRoot}'`, "--launch-id", "'launch-1'",
        "--agent", "'research'", "--base-url", `'${BASE}'`, "--token-file", `'${tokenFile}'`,
        ...(usage ? ["--usage-facts"] : []),
      ].join(" "));
      expect(command).not.toContain("SECRETTOKENVALUE");
    }
  });

  it("restore: the resume token's binding wins over the spec's (D2), and a malformed token is refused without echo", async () => {
    const { adapter: a, tmux } = adapter();
    tmux.onCommand = () => writeSidecar(state({ agent: "other-agent", baseUrl: "http://127.0.0.1:9001" }));
    const result = await a.launchHarness(binding(), { name: SESSION, resumeToken: "http://127.0.0.1:9001/agents/other-agent" });
    expect(result).toEqual({ ok: true, resumeToken: "http://127.0.0.1:9001/agents/other-agent", resumeType: "pda_agent" });
    expect(tmux.commands[0]).toContain("--agent 'other-agent' --base-url 'http://127.0.0.1:9001'");

    const bad = adapter();
    const refused = await bad.adapter.launchHarness(binding(), { name: SESSION, resumeToken: "http://localhost:8150/agents/SNEAKY" });
    expect(refused.ok).toBe(false);
    expect(JSON.stringify(refused)).not.toContain("SNEAKY");
    expect(bad.tmux.commands).toEqual([]);
  });

  it("no binding (no spec block, a damaged column, a self-attached node) and a fork are refused before any keystroke", async () => {
    const { adapter: a, tmux } = adapter();
    const none = await a.launchHarness(binding({ pda: undefined }), { name: SESSION });
    expect(none).toMatchObject({ ok: false, error: expect.stringContaining("no readable pda binding") });
    expect(none).not.toHaveProperty("recovery");
    const fork = await a.launchHarness(binding(), { name: SESSION, forkSource: { kind: "native_id", value: "x" } });
    expect(fork).toMatchObject({ ok: false, error: expect.stringContaining("cannot fork") });
    expect(tmux.commands).toEqual([]);
  });

  it("one agent, one seat (review L2b action 3): a launch is refused with 0 keystrokes while another seat holds the binding", async () => {
    const asked: Array<{ agent: string; nodeId: string }> = [];
    const { adapter: a, tmux } = adapter({
      reserveBinding: (b, nodeId) => { asked.push({ agent: b.agent, nodeId }); return { ok: false, conflicts: ['pda agent "research" at http://127.0.0.1:8150 is already driven by seat "dev.r" in rig "rig-b"; one pda agent is driven by one seat'] }; },
    });
    ready(tmux);
    const result = await a.launchHarness(binding(), { name: SESSION });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('already driven by seat "dev.r"') });
    expect(result).not.toHaveProperty("recovery"); // nothing started: a plain failure, never retry_fresh
    expect(tmux.commands).toEqual([]);
    // The binding checked is the one being launched (the token's on a restore), for this seat.
    await a.launchHarness(binding(), { name: SESSION, resumeToken: "http://127.0.0.1:9001/agents/zeta" });
    expect(asked).toEqual([{ agent: "research", nodeId: "node-1" }, { agent: "zeta", nodeId: "node-1" }]);
  });

  it("R15: a token path that is not a regular file (a directory) is refused the same way, nothing typed", async () => {
    fs.rmSync(tokenFile);
    fs.mkdirSync(tokenFile);
    const { adapter: a, tmux } = adapter();
    const result = await a.launchHarness(binding(), { name: SESSION });
    expect(result).toMatchObject({ ok: false, recovery: "attention_required", error: expect.stringContaining("is not a regular file") });
    expect(tmux.commands).toEqual([]);
  });

  it("N4: the exit-3 refusal says how to retry once the agent exists (the runner has exited; nothing retries by itself)", async () => {
    const { adapter: a, tmux } = adapter();
    tmux.onCommand = () => writeSidecar(state({ ready: false, connected: false, exited: { code: 3, at: NOW.toISOString() }, error: { code: "pda_agent_missing", at: NOW.toISOString() } }));
    const result = await a.launchHarness(binding(), { name: SESSION });
    expect(result).toMatchObject({ ok: false, recovery: "attention_required" });
    expect((result as { error: string }).error).toContain("then run: rig up <rig> --existing");
  });

  it("a missing token file needs a person: attention_required, nothing typed; the daemon only lstats it", async () => {
    fs.rmSync(tokenFile);
    const { adapter: a, tmux } = adapter();
    const result = await a.launchHarness(binding(), { name: SESSION });
    expect(result).toMatchObject({ ok: false, recovery: "attention_required", error: expect.stringContaining("does not exist") });
    expect(tmux.commands).toEqual([]);
  });

  it("the outcome rule: the runner stopping itself (agent missing, token, outbox) is attention_required with pane evidence; never retry_fresh", async () => {
    for (const [code, error, words] of [
      [3, "pda_agent_missing", "pda has no such agent"],
      [4, "pda_token_format", "token file is not usable"],
      [5, undefined, "message log could not be opened"],
    ] as const) {
      const { adapter: a, tmux } = adapter({}, { pane: "line\n[pda-runner] ERROR pda_agent_missing: ...\n[pda-runner] EXITED code=3" });
      tmux.onCommand = () => writeSidecar(state({ ready: false, connected: false, exited: { code, at: NOW.toISOString() }, ...(error ? { error: { code: error, at: NOW.toISOString() } } : {}) }));
      const result = await a.launchHarness(binding(), { name: SESSION });
      expect(result).toMatchObject({ ok: false, recovery: "attention_required", error: expect.stringContaining(words), evidence: expect.stringContaining("EXITED") });
      expect(JSON.stringify(result)).not.toContain("retry_fresh");
    }
  });

  it("pda refusing the token while the runner keeps retrying is attention_required; pda unreachable past the wait is a plain failure", async () => {
    const unauthorized = adapter();
    unauthorized.tmux.onCommand = () => writeSidecar(state({ ready: false, connected: false, error: { code: "pda_unauthorized", at: NOW.toISOString() } }));
    expect(await unauthorized.adapter.launchHarness(binding(), { name: SESSION })).toMatchObject({ ok: false, recovery: "attention_required", error: expect.stringContaining("refused the token") });

    const unreachable = adapter();
    unreachable.tmux.onCommand = () => writeSidecar(state({ ready: false, connected: false, error: { code: "pda_unreachable", at: NOW.toISOString() } }));
    const result = await unreachable.adapter.launchHarness(binding(), { name: SESSION });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("pda is unreachable") });
    expect(result).not.toHaveProperty("recovery");
  });

  it("only THIS launch's sidecar counts: a ready sidecar of an earlier launch is not readiness; one for another binding is refused", async () => {
    const stale = adapter();
    stale.tmux.onCommand = () => writeSidecar(state({ launchId: "earlier" }));
    expect(await stale.adapter.launchHarness(binding(), { name: SESSION })).toMatchObject({ ok: false, error: expect.stringContaining("never reported") });

    const other = adapter();
    other.tmux.onCommand = () => writeSidecar(state({ agent: "someone-else" }));
    expect(await other.adapter.launchHarness(binding(), { name: SESSION })).toMatchObject({ ok: false, error: expect.stringContaining("another binding") });
  });

  it("a held message does not stop the launch: the token is recorded, and checkReady then reports the hold as attention", async () => {
    const { adapter: a, tmux } = adapter();
    const held = state({ held: { requestId: "openrig/n/l/1", code: "pda_message_held", at: NOW.toISOString() } });
    tmux.onCommand = () => writeSidecar(held);
    expect(await a.launchHarness(binding(), { name: SESSION })).toMatchObject({ ok: true, resumeType: "pda_agent" });
    const readiness = await a.checkReady(binding());
    expect(readiness).toMatchObject({ ready: false, code: "pda_message_held" });
    expect(isAttentionRequiredReadinessCode(readiness.code)).toBe(true);
  });
});

describe("PdaRuntimeAdapter.checkReady", () => {
  it("ready = the sidecar (or the READY marker) while the pane is not back at a shell", async () => {
    writeSidecar(state());
    expect(await adapter().adapter.checkReady(binding())).toEqual({ ready: true });
    expect(await adapter({}, { paneCommand: "-zsh" }).adapter.checkReady(binding())).toMatchObject({ ready: false, code: "runner_exited" });
    fs.rmSync(pdaSeatPaths(stateRoot, SESSION).runnerStatePath);
    expect(await adapter({}, { pane: "[pda-runner] READY agent=research" }).adapter.checkReady(binding())).toEqual({ ready: true });
    expect(await adapter({}, { pane: "[pda-runner] READY agent=research", paneCommand: "bash" }).adapter.checkReady(binding())).toMatchObject({ ready: false, code: "runner_exited" });
    expect(await adapter({}, { pane: "[pda-runner] READY agent=research\n[pda-runner] EXITED code=0" }).adapter.checkReady(binding())).toMatchObject({ ready: false, code: "runner_exited" });
    expect(await adapter({}, { pane: "" }).adapter.checkReady(binding())).toMatchObject({ ready: false, code: "awaiting_runtime" });
  });

  it("N3: checkReady applies sendReadiness's 180 s alive window: a ready sidecar with no tick for longer is not ready", async () => {
    const stale = new Date(NOW.getTime() - PDA_SIDECAR_ALIVE_WINDOW_MS - 1).toISOString();
    writeSidecar(state({ aliveAt: stale }));
    const result = await adapter({}, { pane: "[pda-runner] READY agent=research" }).adapter.checkReady(binding());
    expect(result).toMatchObject({ ready: false, code: "runner_stale" });
    expect(isAttentionRequiredReadinessCode(result.code)).toBe(false);
    writeSidecar(state({ aliveAt: new Date(NOW.getTime() + PDA_SIDECAR_ALIVE_WINDOW_MS + 1).toISOString() }));
    expect(await adapter().adapter.checkReady(binding())).toMatchObject({ ready: false, code: "runner_stale" });
    // control: inside the window it is ready
    writeSidecar(state({ aliveAt: new Date(NOW.getTime() - PDA_SIDECAR_ALIVE_WINDOW_MS).toISOString() }));
    expect(await adapter().adapter.checkReady(binding())).toEqual({ ready: true });
  });

  it("a sidecar that cannot be read is no sidecar: checkReady falls back to the READY marker and never throws", async () => {
    writeSidecar(state({ ready: false, exited: { code: 3, at: NOW.toISOString() } }));
    const unreadable = adapter({ fsOps: { readFile: () => { throw Object.assign(new Error("EIO"), { code: "EIO" }); }, exists: () => true, lstat: () => null } },
      { pane: "[pda-runner] READY agent=research" });
    await expect(unreadable.adapter.checkReady(binding())).resolves.toEqual({ ready: true });
  });

  it("maps every person-only sidecar code to its attention code; a plain exit is not attention", async () => {
    const cases: Array<[Partial<PdaRunnerState>, string]> = [
      [{ ready: false, exited: { code: 3, at: NOW.toISOString() }, error: { code: "pda_agent_missing", at: NOW.toISOString() } }, "pda_agent_missing"],
      [{ ready: false, exited: { code: 4, at: NOW.toISOString() }, error: { code: "pda_token_format", at: NOW.toISOString() } }, "pda_token_format"],
      [{ ready: false, error: { code: "pda_unauthorized", at: NOW.toISOString() } }, "pda_unauthorized"],
      [{ held: { requestId: "r", code: "pda_agent_missing", at: NOW.toISOString() } }, "pda_agent_missing"],
    ];
    for (const [over, code] of cases) {
      writeSidecar(state(over));
      const result = await adapter().adapter.checkReady(binding());
      expect(result).toMatchObject({ ready: false, code });
      expect(isAttentionRequiredReadinessCode(result.code)).toBe(true);
    }
    writeSidecar(state({ ready: false, exited: { code: 0, at: NOW.toISOString() } }));
    const plain = await adapter().adapter.checkReady(binding());
    expect(plain).toMatchObject({ ready: false, code: "runner_exited" });
    expect(isAttentionRequiredReadinessCode(plain.code)).toBe(false);
  });
});

describe("PdaRuntimeAdapter.sendReadiness", () => {
  const ask = (over: Partial<PdaRuntimeAdapterDeps> = {}) => adapter(over).adapter.sendReadiness({ sessionName: SESSION, nodeId: "node-1" });

  it("maps the sidecar: held -> needs_input(code), disconnected -> unknown, busy -> running, otherwise idle", async () => {
    writeSidecar(state({ held: { requestId: "r", code: "pda_message_held", at: NOW.toISOString() }, busy: true }));
    expect(await ask()).toMatchObject({ state: "needs_input", reason: "pda_message_held", evidenceSource: "runner_sidecar", runtime: "pda" });
    writeSidecar(state({ connected: false, busy: true }));
    expect(await ask()).toMatchObject({ state: "unknown", reason: "pda_disconnected" });
    writeSidecar(state({ busy: true }));
    expect(await ask()).toMatchObject({ state: "running", reason: "run_active" });
    writeSidecar(state());
    expect(await ask()).toMatchObject({ state: "idle", reason: "runner_idle", sampledAt: NOW.toISOString() });
  });

  // OF-185: the injected-clock form of e2e row 9 (stale). The wall clock never enters: only `now` against `aliveAt`.
  it("a forged held head is believed only inside the alive window: the same file is an answer at the edge and none one millisecond past it", async () => {
    const held = { requestId: "openrig/forged/launch/1", code: "pda_message_held" as const, at: "2026-01-01T00:00:00.000Z" };
    writeSidecar(state({ aliveAt: NOW.toISOString(), held }));
    for (const [label, nowMs, expected] of [
      ["fresh", NOW.getTime(), "answer"],
      // the 180 s window is restated, not imported: this row must fail if the window itself moves
      ["last instant of the window", NOW.getTime() + 180_000, "answer"],
      ["one ms past the window", NOW.getTime() + 180_001, "none"],
      ["ten minutes on", NOW.getTime() + 10 * 60_000, "none"],
    ] as const) {
      const got = await ask({ now: () => new Date(nowMs) });
      if (expected === "answer") expect(got, label).toMatchObject({ state: "needs_input", reason: "pda_message_held", evidenceSource: "runner_sidecar" });
      else expect(got, label).toBeNull();
    }
  });

  it("null, never a throw, for an absent, unparseable, not-ready, exited or stale sidecar, and for a read that throws", async () => {
    expect(await ask()).toBeNull(); // absent
    writeSidecar("{ not json");
    expect(await ask()).toBeNull();
    writeSidecar(state({ ready: false }));
    expect(await ask()).toBeNull();
    writeSidecar(state({ exited: { code: 0, at: NOW.toISOString() } }));
    expect(await ask()).toBeNull();
    const old = new Date(NOW.getTime() - PDA_SIDECAR_ALIVE_WINDOW_MS - 1).toISOString();
    writeSidecar(state({ aliveAt: old }));
    expect(await ask()).toBeNull();
    const edge = new Date(NOW.getTime() - PDA_SIDECAR_ALIVE_WINDOW_MS).toISOString();
    writeSidecar(state({ aliveAt: edge }));
    expect(await ask()).toMatchObject({ state: "idle" }); // the window is inclusive
    // N2: the window is two-sided: an aliveAt in the future (a clock jump, a forged file) is no answer either.
    writeSidecar(state({ aliveAt: new Date(NOW.getTime() + 60 * 60_000).toISOString() }));
    expect(await ask()).toBeNull();
    writeSidecar(state({ aliveAt: new Date(NOW.getTime() + PDA_SIDECAR_ALIVE_WINDOW_MS + 1).toISOString() }));
    expect(await ask()).toBeNull();
    writeSidecar(state({ aliveAt: new Date(NOW.getTime() + PDA_SIDECAR_ALIVE_WINDOW_MS).toISOString() }));
    expect(await ask()).toMatchObject({ state: "idle" });
    writeSidecar(state({ aliveAt: "not a date" }));
    expect(await ask()).toBeNull();
    writeSidecar(state());
    await expect(ask({ fsOps: { readFile: () => { throw new Error("EIO"); }, exists: () => true, lstat: () => null } })).resolves.toBeNull();
  });
});

describe("PdaResumeAdapter", () => {
  it("resumes only a pda_agent token, through the runtime adapter's launch; never retry_fresh", async () => {
    const calls: Array<{ nodeId: string; token: string | undefined }> = [];
    const outcomes = [
      { ok: true as const, resumeToken: "t", resumeType: "pda_agent" },
      { ok: false as const, error: "pda launch: the runner stopped (code 3)", recovery: "attention_required" as const, evidence: "EXITED" },
      { ok: false as const, error: "pda launch: timed out" },
    ];
    const resume = new PdaResumeAdapter({ launchHarness: async (b, o) => { calls.push({ nodeId: b.nodeId, token: o.resumeToken }); return outcomes.shift()!; } });
    const token = `${BASE}/agents/research`;
    expect(resume.canResume("pda_agent", token)).toBe(true);
    expect(resume.canResume("pi_session_file", token)).toBe(false);
    expect(resume.canResume("pda_agent", null)).toBe(false);
    expect(await resume.resume("node-9", SESSION, "pda_agent", token, "/w")).toEqual({ ok: true });
    expect(await resume.resume("node-9", SESSION, "pda_agent", token, "/w")).toEqual({ ok: false, code: "attention_required", message: "pda launch: the runner stopped (code 3)", evidence: "EXITED" });
    expect(await resume.resume("node-9", SESSION, "pda_agent", token, "/w")).toEqual({ ok: false, code: "resume_failed", message: "pda launch: timed out" });
    expect(calls).toEqual([{ nodeId: "node-9", token }, { nodeId: "node-9", token }, { nodeId: "node-9", token }]);
    expect(await resume.resume("node-9", SESSION, "claude_id", "abc", "/w")).toMatchObject({ ok: false, code: "no_resume" });
  });
});

describe("resolvePdaTokenFile", () => {
  it("is $OPENRIG_PDA_TOKEN_FILE when set, else ~/.pi-durable/token (pda main.mjs:17, 26)", () => {
    expect(resolvePdaTokenFile({ OPENRIG_PDA_TOKEN_FILE: " /srv/pda/token " }, "/home/j")).toBe("/srv/pda/token");
    expect(resolvePdaTokenFile({ OPENRIG_PDA_TOKEN_FILE: "  " }, "/home/j")).toBe("/home/j/.pi-durable/token");
    expect(resolvePdaTokenFile({}, "/home/j")).toBe("/home/j/.pi-durable/token");
  });
});
