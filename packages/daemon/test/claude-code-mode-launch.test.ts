import { describe, it, expect, vi } from "vitest";
import { tmuxStub } from "./helpers/tmux-stub.js";
import { mockShellCommand } from "./helpers/shell-command-mock.js";
import { createFullTestDb } from "./helpers/test-app.js";
import { ClaudeCodeAdapter, type ClaudeAdapterFsOps } from "../src/adapters/claude-code-adapter.js";
import { ClaudeResumeAdapter } from "../src/adapters/claude-resume.js";
import { claudeProbeCommand } from "../src/domain/resume-metadata-refresher.js";
import { ClaudeManagedLaunch } from "../src/domain/claude-managed-launch.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";
import { GUARD_FLAG } from "./helpers/claude-guard.js";

// workspaces-o9o.123: a member that declares `code_mode: true` runs Claude Code's Code Mode. Measured on Claude Code 2.1.327
// (o9o.122): a Code Mode session resumes or forks ONLY with CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1 in the environment; without it claude
// prints "can't be resumed" and exits 1, leaving the pane at a shell. So EVERY claude launch of the seat (fresh, resume, fork, restore,
// the resumability probe) sets the variable. The first Code Mode launch in a config dir stops at a one-time picker whose answer Claude
// keeps in `<config dir>/.claude.json` as two keys, `codeModeCaveatsAcceptedV1` and `codeModeAutoModeCaveatAcceptedV1`, both true (the
// picker still shows with either alone: measured, launch only); a code_mode seat's launch writes whichever is missing.
// The expected strings restate the recipe literally (variable name, value, placement) and do not import it.
const SEAT = "build-impl@openrig";
const FLOOR = `--permission-mode acceptEdits ${GUARD_FLAG}`;
const RENDERER = "CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1";
const CM = "CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1";
const ACCEPTED = { codeModeCaveatsAcceptedV1: true, codeModeAutoModeCaveatAcceptedV1: true };

function mockTmux() {
  return mockShellCommand(tmuxStub({
    sendText: vi.fn(async (_session: string, _text: string) => ({ ok: true as const })),
    hasSession: vi.fn(async () => true),
    getPaneCommand: vi.fn(async () => "claude"),
    capturePaneContent: vi.fn(async () => ""),
    createSession: vi.fn(async () => ({ ok: true as const })),
    killSession: vi.fn(async () => ({ ok: true as const })),
    listSessions: vi.fn(async () => []),
    listWindows: vi.fn(async () => []),
    listPanes: vi.fn(async () => []),
    getPanePid: vi.fn(async () => null),
    sendKeys: vi.fn(async () => ({ ok: true as const })),
  }));
}
type MockTmux = ReturnType<typeof mockTmux>;

/** A managed launch over a real (empty) test database, with the methods the adapter calls laid over it: no cast. */
class FakeManagedLaunch extends ClaudeManagedLaunch {
  readonly envs: Array<Readonly<Record<string, string>> | undefined> = [];
  constructor(private readonly home: string | null, private readonly statePath: string) { super(createFullTestDb(), {}, {}, () => []); }
  override boundCwd(): string { return "/project"; }
  override seatConfigDir(): string | null { return this.home; }
  override knownSeatHomes(): string[] { return []; }
  override configPaths(): { configDir: string; statePath: string } { return { configDir: this.home ?? "/fixture", statePath: this.statePath }; }
  override async prepare() {
    return { assertCurrent: () => {}, configDir: this.home ?? "/fixture", executable: "/opt/claude.exe",
      command: (args: readonly string[], env?: Readonly<Record<string, string>>) => { this.envs.push(env); return `claude ${args.join(" ")}`; } };
  }
}

/** An in-memory file system: what the launch wrote, by path. */
function memFs(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial));
  const ops: ClaudeAdapterFsOps = {
    readFile: (p: string) => { const v = files.get(p); if (v === undefined) throw new Error(`not found: ${p}`); return v; },
    writeFile: (p: string, c: string) => { files.set(p, c); },
    exists: (p: string) => files.has(p),
    mkdirp: () => {}, copyFile: () => {}, listFiles: () => [],
    homedir: "/home/u",
  };
  return { files, ops };
}

const binding = (extra: Partial<NodeBinding> = {}): NodeBinding => ({
  id: "b1", nodeId: "n1", tmuxSession: SEAT, tmuxWindow: null, tmuxPane: null,
  updatedAt: "", cwd: "/project", ...extra,
});
const cm = (extra: Partial<NodeBinding> = {}) => binding({ codeMode: true, ...extra } as Partial<NodeBinding>);
const adapterWith = (tmux: MockTmux, fsOps: ClaudeAdapterFsOps = memFs().ops, managed?: ClaudeManagedLaunch) =>
  new ClaudeCodeAdapter({ tmux, fsOps, sleep: async () => {}, sessionIdFactory: () => "sess-1", ...(managed ? { claudeManagedLaunch: managed } : {}) });
const sent = (tmux: MockTmux): string => {
  const calls = tmux.sendText.mock.calls;
  return calls[calls.length - 1]?.[1] ?? "";
};

describe("launchHarness: code_mode sets CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1 on every claude launch of the seat", () => {
  it("FRESH launch", async () => {
    const tmux = mockTmux();
    await adapterWith(tmux).launchHarness(cm(), { name: SEAT });
    expect(sent(tmux)).toBe(`${RENDERER} ${CM} claude ${FLOOR} --session-id sess-1 --name=${SEAT}`);
  });

  it("RESUME launch (the symptom: without the variable a Code Mode session exits 1 and the pane is left at a shell)", async () => {
    const tmux = mockTmux();
    await adapterWith(tmux).launchHarness(cm(), { name: SEAT, resumeToken: "tok-1" });
    expect(sent(tmux)).toBe(`OPENRIG_RESUME_LAUNCH='tok-1' ${RENDERER} ${CM} claude ${FLOOR} --resume 'tok-1' --name=${SEAT}`);
  });

  it("FORK launch (handover's fork path)", async () => {
    const tmux = mockTmux();
    await adapterWith(tmux).launchHarness(cm(), { name: SEAT, forkSource: { kind: "native_id", value: "parent-1" } });
    expect(sent(tmux)).toBe(`${RENDERER} ${CM} claude ${FLOOR} --resume 'parent-1' --fork-session --session-id sess-1 --name=${SEAT}`);
  });

  it.each([
    ["fresh", {}],
    ["resume", { resumeToken: "tok-1" }],
    ["fork", { forkSource: { kind: "native_id" as const, value: "parent-1" } }],
  ])("MANAGED %s launch passes it in the launch env (env -i keeps nothing it is not given)", async (_label, opts) => {
    const tmux = mockTmux();
    const managed = new FakeManagedLaunch(null, "/fixture/.claude.json");
    const seen = managed.envs;
    await adapterWith(tmux, memFs().ops, managed).launchHarness(cm({ permissionMode: "bypassPermissions" }), { name: SEAT, ...opts });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ CLAUDE_CODE_EXPERIMENTAL_CODE_MODE: "1" });
  });

  it.each([["absent", {}], ["false", { codeMode: false }]])("%s -> every launch is byte-identical to today (no variable)", async (_label, extra) => {
    for (const opts of [{ name: SEAT }, { name: SEAT, resumeToken: "tok-1" }, { name: SEAT, forkSource: { kind: "native_id" as const, value: "p" } }]) {
      const plain = mockTmux(); await adapterWith(plain).launchHarness(binding(), opts);
      const flagged = mockTmux(); await adapterWith(flagged).launchHarness(binding(extra as Partial<NodeBinding>), opts);
      expect(sent(flagged)).toBe(sent(plain));
      expect(sent(flagged)).not.toContain("CODE_MODE");
    }
  });

  it("the ONLY delta from declaring it is the additive ` CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1`", async () => {
    const without = mockTmux(); await adapterWith(without).launchHarness(binding({ model: "opus", effort: "high" }), { name: SEAT, resumeToken: "T" });
    const withCm = mockTmux(); await adapterWith(withCm).launchHarness(cm({ model: "opus", effort: "high" }), { name: SEAT, resumeToken: "T" });
    expect(sent(withCm).replace(` ${CM}`, "")).toBe(sent(without));
  });
});

describe("launchHarness: a code_mode seat's launch pre-answers Code Mode's one-time picker", () => {
  const STATE = "/home/u/.claude.json";

  it("writes both answer keys into the seat's Claude state, keeping every other field", async () => {
    const { files, ops } = memFs({ [STATE]: JSON.stringify({ hasCompletedOnboarding: true, keep: { a: 1 } }) });
    await adapterWith(mockTmux(), ops).launchHarness(cm(), { name: SEAT });
    expect(JSON.parse(files.get(STATE)!)).toEqual({ hasCompletedOnboarding: true, keep: { a: 1 }, ...ACCEPTED });
  });

  it.each(Object.keys(ACCEPTED))("a file holding only one of them gets the other (%s present)", async (present) => {
    const { files, ops } = memFs({ [STATE]: JSON.stringify({ [present]: true }) });
    await adapterWith(mockTmux(), ops).launchHarness(cm(), { name: SEAT });
    expect(JSON.parse(files.get(STATE)!)).toEqual(ACCEPTED);
  });

  it("on resume and fork too (a seat whose first Code Mode launch is a handover successor)", async () => {
    for (const opts of [{ resumeToken: "tok-1" }, { forkSource: { kind: "native_id" as const, value: "p" } }]) {
      const { files, ops } = memFs({ [STATE]: "{}" });
      await adapterWith(mockTmux(), ops).launchHarness(cm(), { name: SEAT, ...opts });
      expect(JSON.parse(files.get(STATE)!)).toEqual(ACCEPTED);
    }
  });

  it("an already-answered file is not rewritten (running Claude processes write it too)", async () => {
    const before = JSON.stringify({ ...ACCEPTED, other: "x" });
    const { files, ops } = memFs({ [STATE]: before });
    const write = vi.spyOn(ops, "writeFile");
    await adapterWith(mockTmux(), ops).launchHarness(cm(), { name: SEAT });
    expect(files.get(STATE)).toBe(before);
    expect(write).not.toHaveBeenCalled();
  });

  it("a seat without code_mode never gets the key (control)", async () => {
    const { files, ops } = memFs({ [STATE]: "{}" });
    await adapterWith(mockTmux(), ops).launchHarness(binding(), { name: SEAT });
    expect(files.get(STATE)).toBe("{}");
  });

  it("a malformed state file is left as it is, and the launch still goes ahead (the picker then shows; nothing is lost)", async () => {
    const { files, ops } = memFs({ [STATE]: "{not json" });
    const tmux = mockTmux();
    const result = await adapterWith(tmux, ops).launchHarness(cm(), { name: SEAT });
    expect(files.get(STATE)).toBe("{not json");
    expect(result.ok).toBe(true);
    expect(sent(tmux)).toContain(CM);
  });

  it("a managed launch writes it into the home that launch selects", async () => {
    const managedState = "/seat-home/.claude.json";
    const { files, ops } = memFs({ [managedState]: "{}" });
    const managed = new FakeManagedLaunch("/seat-home", managedState);
    await adapterWith(mockTmux(), ops, managed).launchHarness(cm({ permissionMode: "bypassPermissions" }), { name: SEAT });
    expect(JSON.parse(files.get(managedState)!)).toEqual(ACCEPTED);
  });
});

describe("ClaudeResumeAdapter.resume (the restore path): code_mode is applied on restore too", () => {
  // resume(sessionName, resumeType, token, cwd, posture, model, permissionMode, nodeId, effort,
  //        nonInterruptive, kernelAuthority, teamPermissionDefault, remoteControl, askInModal, codeMode)
  it("restore sets the variable", async () => {
    const tmux = mockTmux();
    await new ClaudeResumeAdapter(tmux).resume(SEAT, "claude_id", "tok-1", "/repo", undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, true);
    expect(tmux.sendText.mock.calls[0]![1]).toBe(`OPENRIG_RESUME_LAUNCH='tok-1' ${RENDERER} ${CM} claude ${FLOOR} --resume 'tok-1'`);
  });

  it("restore pre-answers the picker for a code_mode seat (a session started without Code Mode, resumed with it, shows the picker too)", async () => {
    const tmux = mockTmux();
    const prepared: unknown[] = [];
    await new ClaudeResumeAdapter(tmux, { prepareCodeMode: (b) => { prepared.push(b); } }).resume(SEAT, "claude_id", "tok-1", "/repo", undefined, undefined, undefined, "node-7", undefined, undefined, undefined, undefined, undefined, undefined, true);
    expect(prepared).toEqual([{ nodeId: "node-7", cwd: "/repo", permissionMode: undefined }]);
  });

  it("restore: a pre-answer that throws is logged and the restore still goes ahead", async () => {
    const tmux = mockTmux();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await new ClaudeResumeAdapter(tmux, { prepareCodeMode: () => { throw new Error("state unreadable"); } }).resume(SEAT, "claude_id", "tok-1", "/repo", undefined, undefined, undefined, "node-7", undefined, undefined, undefined, undefined, undefined, undefined, true);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("state unreadable"));
    error.mockRestore();
    expect(tmux.sendText.mock.calls[0]![1]).toContain(CM);
    expect(result.ok === true || result.code !== "resume_failed").toBe(true);
  });

  it.each([[undefined], [false]])("codeMode=%s -> restore never pre-answers (control)", async (flag) => {
    const prepared: unknown[] = [];
    await new ClaudeResumeAdapter(mockTmux(), { prepareCodeMode: (b) => { prepared.push(b); } }).resume(SEAT, "claude_id", "tok-1", "/repo", undefined, undefined, undefined, "node-7", undefined, undefined, undefined, undefined, undefined, undefined, flag);
    expect(prepared).toEqual([]);
  });

  it.each([[undefined], [false]])("codeMode=%s -> restore command byte-identical to today", async (flag) => {
    const tmux = mockTmux();
    await new ClaudeResumeAdapter(tmux).resume(SEAT, "claude_id", "tok-1", "/repo", undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, flag);
    expect(tmux.sendText.mock.calls[0]![1]).toBe(`OPENRIG_RESUME_LAUNCH='tok-1' ${RENDERER} claude ${FLOOR} --resume 'tok-1'`);
  });
});

describe("the resumability probe types the variable for a code_mode seat", () => {
  // Without it, the probe's throwaway `claude --resume` of a Code Mode session exits 1 and the seat reads as not resumable.
  it("code_mode seat", () => {
    expect(claudeProbeCommand("tok-1", SEAT, null, true)).toBe(`${CM} claude --resume 'tok-1' --name='${SEAT}'`);
    expect(claudeProbeCommand("tok-1", SEAT, "/seat/home", true)).toBe(`CLAUDE_CONFIG_DIR=/seat/home ${CM} claude --resume 'tok-1' --name='${SEAT}'`);
  });

  it("other seats: unchanged", () => {
    expect(claudeProbeCommand("tok-1", SEAT, null)).toBe(`claude --resume 'tok-1' --name='${SEAT}'`);
    expect(claudeProbeCommand("tok-1", SEAT, null, false)).toBe(`claude --resume 'tok-1' --name='${SEAT}'`);
  });
});
