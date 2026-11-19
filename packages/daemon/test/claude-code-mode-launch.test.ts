import { describe, it, expect, vi } from "vitest";
import { tmuxStub } from "./helpers/tmux-stub.js";
import { mockShellCommand } from "./helpers/shell-command-mock.js";
import { createFullTestDb } from "./helpers/test-app.js";
import { ClaudeCodeAdapter, type ClaudeAdapterFsOps } from "../src/adapters/claude-code-adapter.js";
import { ClaudeResumeAdapter } from "../src/adapters/claude-resume.js";
import { claudeProbeCommand, ResumeMetadataRefresher } from "../src/domain/resume-metadata-refresher.js";
import { sessionCodeMode, conversationCodeMode, launchCodeMode } from "../src/domain/claude-code-mode.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { getNodeInventory, getNodeDetail } from "../src/domain/node-inventory.js";
import { readFileSync } from "node:fs";
import { SessionRegistry } from "../src/domain/session-registry.js";
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

/** An in-memory file system: what the launch wrote, by path. `links` maps a symbolic link to its target: reads and a plain
 *  writeFile follow it (as fs.writeFileSync does), lstat reports it, and writeFileNoFollow refuses it (as O_NOFOLLOW does). */
function memFs(initial: Record<string, string> = {}, links: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial));
  const link = new Map(Object.entries(links));
  const follow = (p: string): string => link.get(p) ?? p;
  const ops: ClaudeAdapterFsOps = {
    readFile: (p: string) => { const v = files.get(follow(p)); if (v === undefined) throw new Error(`not found: ${p}`); return v; },
    writeFile: (p: string, c: string) => { files.set(follow(p), c); },
    writeFileNoFollow: (p: string, c: string) => {
      if (link.has(p)) throw Object.assign(new Error(`ELOOP: ${p}`), { code: "ELOOP" });
      files.set(p, c);
    },
    exists: (p: string) => files.has(follow(p)) || link.has(p),
    lstat: (p: string) => link.has(p) ? "symlink" : files.has(p) ? "file" : null,
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

describe("launchHarness: a code_mode seat's launch pre-answers Code Mode's one-time picker, in the seat's own Claude home only", () => {
  // verify-sec2 (o9o.123 review, temp-home probes at 3068d3590) and the CoS's acceptance: the answer is written only into the seat's
  // OWN Claude state (nodes.claude_config_dir), never HOME/.claude.json or the daemon-selected one, never through a link, and only
  // where a key is ABSENT; a present answer that is not true is kept, and the launch says so in a warning naming the file and key.
  const HOME_STATE = "/home/u/.claude.json";
  const SEAT_HOME = "/seat-home";
  const STATE = `${SEAT_HOME}/.claude.json`;
  const DAEMON_STATE = "/daemon-claude/.claude.json";
  const seatHomed = () => new FakeManagedLaunch(SEAT_HOME, STATE);
  const launchWarnings = (r: Awaited<ReturnType<ClaudeCodeAdapter["launchHarness"]>>): string[] => (r.ok ? r.warnings ?? [] : []);

  it("writes both answer keys into the seat's own Claude state, keeping every other field", async () => {
    const { files, ops } = memFs({ [STATE]: JSON.stringify({ hasCompletedOnboarding: true, keep: { a: 1 } }) });
    const result = await adapterWith(mockTmux(), ops, seatHomed()).launchHarness(cm(), { name: SEAT });
    expect(JSON.parse(files.get(STATE)!)).toEqual({ hasCompletedOnboarding: true, keep: { a: 1 }, ...ACCEPTED });
    expect(launchWarnings(result)).toEqual([]);
  });

  it("a seat home with no state file yet gets one holding just the answer", async () => {
    const { files, ops } = memFs();
    await adapterWith(mockTmux(), ops, seatHomed()).launchHarness(cm(), { name: SEAT });
    expect(JSON.parse(files.get(STATE)!)).toEqual(ACCEPTED);
  });

  it.each(Object.keys(ACCEPTED))("a file holding only one of them, true, gets the other (%s present)", async (present) => {
    const { files, ops } = memFs({ [STATE]: JSON.stringify({ [present]: true }) });
    await adapterWith(mockTmux(), ops, seatHomed()).launchHarness(cm(), { name: SEAT });
    expect(JSON.parse(files.get(STATE)!)).toEqual(ACCEPTED);
  });

  it("on resume and fork too (a seat whose first Code Mode launch is a handover successor)", async () => {
    for (const opts of [{ resumeToken: "tok-1" }, { forkSource: { kind: "native_id" as const, value: "p" } }]) {
      const { files, ops } = memFs({ [STATE]: "{}" });
      await adapterWith(mockTmux(), ops, seatHomed()).launchHarness(cm(), { name: SEAT, ...opts });
      expect(JSON.parse(files.get(STATE)!)).toEqual(ACCEPTED);
    }
  });

  it("a managed launch writes into the seat's home too", async () => {
    const { files, ops } = memFs({ [STATE]: "{}" });
    await adapterWith(mockTmux(), ops, seatHomed()).launchHarness(cm({ permissionMode: "bypassPermissions" }), { name: SEAT });
    expect(JSON.parse(files.get(STATE)!)).toEqual(ACCEPTED);
  });

  it("an already-answered file is not rewritten (running Claude processes write it too)", async () => {
    const before = JSON.stringify({ ...ACCEPTED, other: "x" });
    const { files, ops } = memFs({ [STATE]: before });
    const write = vi.spyOn(ops, "writeFile");
    const writeNoFollow = vi.spyOn(ops, "writeFileNoFollow");
    await adapterWith(mockTmux(), ops, seatHomed()).launchHarness(cm(), { name: SEAT });
    expect(files.get(STATE)).toBe(before);
    expect(write).not.toHaveBeenCalled();
    expect(writeNoFollow).not.toHaveBeenCalled();
  });

  it("a seat without code_mode never gets the key (control)", async () => {
    const { files, ops } = memFs({ [STATE]: "{}" });
    await adapterWith(mockTmux(), ops, seatHomed()).launchHarness(binding(), { name: SEAT });
    expect(files.get(STATE)).toBe("{}");
  });

  it("a malformed state file is left as it is, the launch goes ahead, and it says so", async () => {
    const { files, ops } = memFs({ [STATE]: "{not json" });
    const tmux = mockTmux();
    const result = await adapterWith(tmux, ops, seatHomed()).launchHarness(cm(), { name: SEAT });
    expect(files.get(STATE)).toBe("{not json");
    expect(result.ok).toBe(true);
    expect(sent(tmux)).toContain(CM);
    expect(launchWarnings(result).join("\n")).toContain(STATE);
  });

  // (1) A present answer that is not true is the user's: kept, never filled around, and named in a warning.
  it.each([
    ["false", { codeModeCaveatsAcceptedV1: false }, "codeModeCaveatsAcceptedV1"],
    ["false (the other key)", { codeModeAutoModeCaveatAcceptedV1: false }, "codeModeAutoModeCaveatAcceptedV1"],
    ["a non-boolean", { codeModeCaveatsAcceptedV1: "no" }, "codeModeCaveatsAcceptedV1"],
  ])("FINDING 1: a present %s answer is kept, the file is not written, and the launch warns naming the file and key", async (_label, state, key) => {
    const before = JSON.stringify({ ...state, other: 1 });
    const { files, ops } = memFs({ [STATE]: before });
    const result = await adapterWith(mockTmux(), ops, seatHomed()).launchHarness(cm(), { name: SEAT });
    expect(files.get(STATE)).toBe(before);
    expect(result.ok).toBe(true);
    const warning = launchWarnings(result).join("\n");
    expect(warning).toContain(STATE);
    expect(warning).toContain(key);
  });

  // (2) Never through a link: the seat's state file, or its home, being a symbolic link is refused, and the target is untouched.
  it("FINDING 2: a symlinked .claude.json in the seat home is refused; its target is not written; the launch warns", async () => {
    const TARGET = "/elsewhere/shared.json";
    const { files, ops } = memFs({ [TARGET]: JSON.stringify({ shared: true }) }, { [STATE]: TARGET });
    const result = await adapterWith(mockTmux(), ops, seatHomed()).launchHarness(cm(), { name: SEAT });
    expect(JSON.parse(files.get(TARGET)!)).toEqual({ shared: true });
    expect(result.ok).toBe(true);
    expect(launchWarnings(result).join("\n")).toMatch(new RegExp(`${STATE}.*link|link.*${STATE}`));
  });

  it("FINDING 2: a seat home that is itself a symbolic link is refused", async () => {
    const { files, ops } = memFs({}, { [SEAT_HOME]: "/elsewhere" });
    const result = await adapterWith(mockTmux(), ops, seatHomed()).launchHarness(cm(), { name: SEAT });
    expect([...files.keys()]).toEqual([]);
    expect(launchWarnings(result).join("\n")).toMatch(/link/);
  });

  it.each([["neither", ["lstat", "writeFileNoFollow"]], ["no lstat", ["lstat"]], ["no no-follow write", ["writeFileNoFollow"]]])(
    "FINDING 2: a file system with %s is refused (fail closed), and the warning says why", async (_label, missing) => {
      const { files, ops } = memFs({ [STATE]: "{}" });
      const bare: ClaudeAdapterFsOps = { ...ops };
      for (const key of missing) delete bare[key as "lstat" | "writeFileNoFollow"];
      const result = await adapterWith(mockTmux(), bare, seatHomed()).launchHarness(cm(), { name: SEAT });
      expect(files.get(STATE)).toBe("{}");
      expect(launchWarnings(result)).toEqual([`code_mode: ${STATE} was not written: this file system cannot check for or refuse a symbolic link`]);
    });

  it("FINDING 2: the write itself never follows a link (a link swapped in after the check is refused by the write)", async () => {
    const { files, ops } = memFs({ [STATE]: "{}" });
    const write = vi.spyOn(ops, "writeFile");
    await adapterWith(mockTmux(), ops, seatHomed()).launchHarness(cm(), { name: SEAT });
    expect(write).not.toHaveBeenCalled();
    expect(JSON.parse(files.get(STATE)!)).toEqual(ACCEPTED);
  });

  // (3) Never the daemon's default or selected home: no per-seat claude_config_dir means nothing is written anywhere.
  it("FINDING 3: with no per-seat claude_config_dir, neither HOME/.claude.json nor the daemon-selected one is written; the launch warns", async () => {
    const { files, ops } = memFs({ [HOME_STATE]: "{}", [DAEMON_STATE]: "{}" });
    const noSeatHome = new FakeManagedLaunch(null, DAEMON_STATE);
    const result = await adapterWith(mockTmux(), ops, noSeatHome).launchHarness(cm(), { name: SEAT });
    expect(files.get(HOME_STATE)).toBe("{}");
    expect(files.get(DAEMON_STATE)).toBe("{}");
    expect(result.ok).toBe(true);
    expect(launchWarnings(result).join("\n")).toContain("claude_config_dir");
  });

  it("FINDING 3: the same with a managed launch (the daemon-selected home is not the seat's)", async () => {
    const { files, ops } = memFs({ [HOME_STATE]: "{}", [DAEMON_STATE]: "{}" });
    const noSeatHome = new FakeManagedLaunch(null, DAEMON_STATE);
    await adapterWith(mockTmux(), ops, noSeatHome).launchHarness(cm({ permissionMode: "bypassPermissions" }), { name: SEAT });
    expect(files.get(HOME_STATE)).toBe("{}");
    expect(files.get(DAEMON_STATE)).toBe("{}");
  });

  it("FINDING 3: with no managed launch at all, HOME/.claude.json is not written", async () => {
    const { files, ops } = memFs({ [HOME_STATE]: "{}" });
    await adapterWith(mockTmux(), ops).launchHarness(cm(), { name: SEAT });
    expect(files.get(HOME_STATE)).toBe("{}");
  });

  // workspaces-o9o.176: the onboarding/trust bootstrap writes the SAME seat state file through the SAME shared rule, so a symlinked
  // seat home is refused there too (the guardDirs wiring in provisionManagedBootstrap), not only for the Code Mode answer.
  it("the onboarding/trust bootstrap refuses a symlinked seat home (shared rule): the refusal names the home and the target is not written", () => {
    const { files, ops } = memFs({ "/elsewhere/.claude.json": JSON.stringify({ shared: true }) }, { [SEAT_HOME]: "/elsewhere" });
    // workspaces-o9o.176 (verify-sec2 round 2): a guard refusal is RETURNED (not thrown) so deliverStartup can turn it into a launch-
    // aborting delivery failure naming the home; the link target stays untouched.
    const outcome = adapterWith(mockTmux(), ops, seatHomed()).ensureManagedBootstrap(binding({ nodeId: "n1", cwd: "/project", permissionMode: "bypassPermissions" }));
    expect(outcome.refusals).toEqual([{ path: SEAT_HOME, message: expect.stringMatching(/is a symbolic link/) }]);
    expect(JSON.parse(files.get("/elsewhere/.claude.json")!)).toEqual({ shared: true });
  });

  it("the restore seam returns its warnings instead of logging them away", () => {
    const { ops } = memFs({ [STATE]: JSON.stringify({ codeModeCaveatsAcceptedV1: false }) });
    const warnings = adapterWith(mockTmux(), ops, seatHomed()).ensureCodeModeAccepted({ nodeId: "n1", cwd: "/project" });
    expect(warnings.join("\n")).toContain("codeModeCaveatsAcceptedV1");
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

  it("restore: the pre-answer's warnings reach the restore result (a kept answer is visible, not only logged)", async () => {
    const result = await new ClaudeResumeAdapter(mockTmux(), { prepareCodeMode: () => ["code_mode: kept codeModeCaveatsAcceptedV1=false in /seat-home/.claude.json"] })
      .resume(SEAT, "claude_id", "tok-1", "/repo", undefined, undefined, undefined, "node-7", undefined, undefined, undefined, undefined, undefined, undefined, true);
    expect(result.ok).toBe(true);
    expect(result.ok ? result.warnings ?? [] : []).toContain("code_mode: kept codeModeCaveatsAcceptedV1=false in /seat-home/.claude.json");
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

describe("finding 4: a session records the mode its conversation was launched in; resumes read that, not the seat (claude-code-mode.ts)", () => {
  it("registerSession records the seat's declaration at the time (a fresh launch's mode); withdrawing later does not change the row", () => {
    const db = createFullTestDb();
    const rigRepo = new RigRepository(db);
    const sessions = new SessionRegistry(db);
    const rig = rigRepo.createRig("r");
    const onNode = rigRepo.addNode(rig.id, "dev.on", { runtime: "claude-code", codeMode: true });
    const on = sessions.registerSession(onNode.id, "dev-on@r");
    const off = sessions.registerSession(rigRepo.addNode(rig.id, "dev.off", { runtime: "claude-code" }).id, "dev-off@r");
    expect(sessionCodeMode(db, on.id)).toBe(true);
    expect(sessionCodeMode(db, off.id)).toBe(false);
    rigRepo.setNodeCodeMode(onNode.id, false);
    expect(sessionCodeMode(db, on.id)).toBe(true);
    expect(sessionCodeMode(db, "no-such-session")).toBe(false);
    db.exec("ALTER TABLE sessions DROP COLUMN code_mode");
    expect(sessionCodeMode(db, on.id)).toBe(false);
    db.close();
  });

  it("a conversation's mode is found by its native id on the newest other row; a fresh launch takes the declaration", () => {
    const db = createFullTestDb();
    const rigRepo = new RigRepository(db);
    const sessions = new SessionRegistry(db);
    const node = rigRepo.addNode(rigRepo.createRig("r").id, "dev.cm", { runtime: "claude-code", codeMode: true });
    const first = sessions.registerSession(node.id, "dev-cm@r");
    db.prepare("UPDATE sessions SET resume_token = 'conv-1' WHERE id = ?").run(first.id);
    rigRepo.setNodeCodeMode(node.id, false);
    const restoring = sessions.registerSession(node.id, "dev-cm@r");
    db.prepare("UPDATE sessions SET resume_token = 'conv-1' WHERE id = ?").run(restoring.id); // the restore row already carries the id
    expect(sessionCodeMode(db, restoring.id)).toBe(false); // recorded from the withdrawn seat at registration
    expect(conversationCodeMode(db, "conv-1", restoring.id)).toBe(true); // ...but the conversation it continues is Code Mode
    expect(conversationCodeMode(db, "conv-1")).toBe(false); // without excluding itself, the newest row (its own) answers
    expect(conversationCodeMode(db, "unknown-conv")).toBe(false);
    expect(launchCodeMode(db, { declared: true, conversationId: null })).toBe(true);
    expect(launchCodeMode(db, { declared: false, conversationId: "conv-1", launchingSessionId: restoring.id })).toBe(true);
    expect(launchCodeMode(db, { declared: true, conversationId: "unknown-conv" })).toBe(false);
    db.close();
  });
});

describe("finding 4: the resume line OpenRig SHOWS carries the variable for a Code Mode conversation (rig ps, node detail)", () => {
  // The approved design said the shown resume command carries it; the first hand-back did it for the probe only (build-arch's own gap,
  // reported to the CoS). It follows the latest conversation's recorded mode, not the seat's declaration.
  it.each([[true], [false]])("launched in Code Mode=%s, then the seat flipped: the list's resumeCommand and the detail's guidance follow the conversation", (launchedInCodeMode) => {
    const db = createFullTestDb();
    const rigRepo = new RigRepository(db);
    const sessions = new SessionRegistry(db);
    const rig = rigRepo.createRig("r");
    const node = rigRepo.addNode(rig.id, "dev.cm", { runtime: "claude-code", cwd: "/repo", ...(launchedInCodeMode ? { codeMode: true } : {}) });
    const s1 = sessions.registerSession(node.id, "dev-cm@r");
    db.prepare("UPDATE sessions SET resume_type = 'claude_id', resume_token = 'conv-1' WHERE id = ?").run(s1.id);
    rigRepo.setNodeCodeMode(node.id, !launchedInCodeMode);
    const entry = getNodeInventory(db, rig.id).find((e) => e.logicalId === "dev.cm")!;
    const prefix = launchedInCodeMode ? `${CM} ` : "";
    expect(entry.resumeCommand).toBe(`${prefix}claude --resume 'conv-1'`);
    const guidance = getNodeDetail(db, rig.id, "dev.cm")!.recoveryGuidance!;
    expect(guidance.commands[0]).toBe(`${prefix}claude --resume 'conv-1' --name='dev-cm@r'`);
    expect(guidance.commands).toContain(`${prefix}claude --resume`);
    db.close();
  });

  it("the probe's per-session read is wired in startup.ts from the session's own record", () => {
    const startup = readFileSync(new URL("../src/startup.ts", import.meta.url), "utf8");
    expect(startup).toContain("sessionCodeMode: (session) => sessionCodeMode(db, session.sessionId)");
  });
});

describe("the refresher hands the probe the session's code_mode only when its conversation runs in Code Mode", () => {
  const session = { sessionId: "sess-1", sessionName: "dev-impl@r", runtime: "claude-code", resumeType: "claude_id", resumeToken: "abc-123", cwd: "/repo" };
  it.each([[true], [false]])("declared=%s", async (declared) => {
    const db = createFullTestDb();
    const probe = vi.fn(async (_n: string, _t: string, _c?: string | null, _h?: string | null, _m?: boolean) => "resumable" as const);
    const refresher = new ResumeMetadataRefresher({ sessionRegistry: new SessionRegistry(db), tmuxAdapter: tmuxStub({}), probeClaudeResume: probe,
      sleep: async () => {}, sessionCodeMode: () => declared });
    await refresher.refresh([session]);
    // An undeclared seat's call is exactly the four arguments it always was; a declared one adds `true`.
    expect(probe.mock.calls).toEqual([declared ? ["dev-impl@r", "abc-123", "/repo", null, true] : ["dev-impl@r", "abc-123", "/repo", null]]);
    db.close();
  });
});
