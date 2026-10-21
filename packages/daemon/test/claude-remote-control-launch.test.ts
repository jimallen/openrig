import { describe, it, expect, vi } from "vitest";
import { mockShellCommand } from "./helpers/shell-command-mock.js";
import { ClaudeCodeAdapter, type ClaudeAdapterFsOps } from "../src/adapters/claude-code-adapter.js";
import { ClaudeResumeAdapter } from "../src/adapters/claude-resume.js";
import { buildNativeResumeCommand } from "../src/domain/native-resume-probe.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

// Claude Code Remote Control: a member that declares `remote_control: true` has EVERY claude launch of
// its seat carry `--remote-control=<session name>` (claude 2.1.296: `--remote-control [name]` takes an
// optional value, so the name is always passed explicitly, in the `=` form: a separate-argument name that
// starts with `-` (legal: pod ids only reject dots) is not read as the value, and commander then reports
// the name as an unknown option). The expected strings below restate the recipe literally -- flag spelling, single
// quoting, placement after --model/--effort and before --resume/--session-id -- and do not import it.
//
// The posture / renderer segments are the fixed defaults of a clean environment (acceptEdits floor,
// classic renderer), exactly as the neighbouring launch pins assume.
const SEAT = "exec-cos@eztrack";
const FLOOR = "--permission-mode acceptEdits";
const RENDERER = "CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1";

function mockTmux(): TmuxAdapter {
  return mockShellCommand({
    sendText: vi.fn(async () => ({ ok: true as const })),
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
  } as unknown as TmuxAdapter);
}

const fsOps = {
  readFile: () => { throw new Error("not found"); }, writeFile: () => {}, exists: () => false,
  mkdirp: () => {}, copyFile: () => {}, listFiles: () => [],
} as unknown as ClaudeAdapterFsOps;

const binding = (extra: Partial<NodeBinding> = {}): NodeBinding => ({
  id: "b1", nodeId: "n1", tmuxSession: SEAT, tmuxWindow: null, tmuxPane: null,
  cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", cwd: "/project", ...extra,
});
const adapterWith = (tmux: TmuxAdapter) => new ClaudeCodeAdapter({ tmux, fsOps, sleep: async () => {}, sessionIdFactory: () => "sess-1" });
const sent = (tmux: TmuxAdapter): string => {
  const calls = (tmux.sendText as unknown as { mock: { calls: unknown[][] } }).mock.calls;
  return (calls[calls.length - 1]?.[1] as string) ?? "";
};
const rc = (extra: Partial<NodeBinding> = {}) => binding({ remoteControl: true, ...extra } as Partial<NodeBinding>);

describe("launchHarness: remote_control reaches every claude launch of the seat", () => {
  it("FRESH launch emits --remote-control <session name>, before --session-id", async () => {
    const tmux = mockTmux();
    await adapterWith(tmux).launchHarness(rc(), { name: SEAT });
    expect(sent(tmux)).toBe(`${RENDERER} claude ${FLOOR} '--remote-control=${SEAT}' --session-id sess-1 --name ${SEAT}`);
  });

  it("RESUME launch emits --remote-control <session name>, before --resume", async () => {
    const tmux = mockTmux();
    await adapterWith(tmux).launchHarness(rc(), { name: SEAT, resumeToken: "tok-1" });
    expect(sent(tmux)).toBe(`OPENRIG_RESUME_LAUNCH='tok-1' ${RENDERER} claude ${FLOOR} '--remote-control=${SEAT}' --resume 'tok-1' --name ${SEAT}`);
  });

  it("FORK launch emits --remote-control <session name>, before --resume ... --fork-session", async () => {
    const tmux = mockTmux();
    const adapter = adapterWith(tmux);
    await adapter.launchHarness(rc(), { name: SEAT, forkSource: { kind: "native_id", value: "parent-1" } });
    expect(sent(tmux)).toBe(`${RENDERER} claude ${FLOOR} '--remote-control=${SEAT}' --resume 'parent-1' --fork-session --session-id sess-1 --name ${SEAT}`);
  });

  it("sits after --model and --effort, so the optional value never precedes or swallows another flag", async () => {
    const tmux = mockTmux();
    await adapterWith(tmux).launchHarness(rc({ model: "opus", effort: "high" }), { name: SEAT, resumeToken: "tok-1" });
    expect(sent(tmux)).toBe(`OPENRIG_RESUME_LAUNCH='tok-1' ${RENDERER} claude ${FLOOR} --model 'opus' --effort 'high' '--remote-control=${SEAT}' --resume 'tok-1' --name ${SEAT}`);
  });

  it("the name is the seat's session name (the same one --name carries), quoted so it is one argument", async () => {
    const tmux = mockTmux();
    await adapterWith(tmux).launchHarness(rc(), { name: "a b'c" });
    expect(sent(tmux)).toContain(` '--remote-control=a b'"'"'c' `);
  });

  it("a session name that starts with `-` stays inside the one `--remote-control=<name>` token (shell form)", async () => {
    const tmux = mockTmux();
    await adapterWith(tmux).launchHarness(rc(), { name: "-seat" });
    expect(sent(tmux)).toContain(" '--remote-control=-seat' ");
    // the separate-argument spelling is the one that breaks the optional-value parse
    expect(sent(tmux)).not.toMatch(/--remote-control\s/);
  });

  it("an empty session name refuses the launch rather than silently dropping the declared flag", async () => {
    const tmux = mockTmux();
    const result = await adapterWith(tmux).launchHarness(rc(), { name: "  " });
    expect(result.ok).toBe(false);
    expect(tmux.sendText).not.toHaveBeenCalled();
  });

  it.each([
    ["absent", {}],
    ["false", { remoteControl: false }],
  ])("%s -> every launch is byte-identical to today (no --remote-control)", async (_label, extra) => {
    for (const opts of [
      { name: SEAT },
      { name: SEAT, resumeToken: "tok-1" },
    ]) {
      const tmuxPlain = mockTmux(); await adapterWith(tmuxPlain).launchHarness(binding(), opts);
      const tmuxFlag = mockTmux(); await adapterWith(tmuxFlag).launchHarness(binding(extra as Partial<NodeBinding>), opts);
      expect(sent(tmuxFlag)).toBe(sent(tmuxPlain));
      expect(sent(tmuxFlag)).not.toContain("remote-control");
    }
    const resumeBytes = mockTmux(); await adapterWith(resumeBytes).launchHarness(binding(extra as Partial<NodeBinding>), { name: SEAT, resumeToken: "tok-1" });
    expect(sent(resumeBytes)).toBe(`OPENRIG_RESUME_LAUNCH='tok-1' ${RENDERER} claude ${FLOOR} --resume 'tok-1' --name ${SEAT}`);
  });

  it("the ONLY delta from declaring it is the additive ` '--remote-control=<name>'`", async () => {
    const without = mockTmux(); await adapterWith(without).launchHarness(binding({ model: "opus", effort: "high" }), { name: SEAT, resumeToken: "T" });
    const withRc = mockTmux(); await adapterWith(withRc).launchHarness(rc({ model: "opus", effort: "high" }), { name: SEAT, resumeToken: "T" });
    expect(sent(withRc).replace(` '--remote-control=${SEAT}'`, "")).toBe(sent(without));
  });
});

describe("ClaudeResumeAdapter.resume (the restore path): remote_control is applied on restore too", () => {
  // resume(sessionName, resumeType, token, cwd, posture, model, permissionMode, nodeId, effort,
  //        nonInterruptive, kernelAuthority, teamPermissionDefault, remoteControl)
  it("restore emits --remote-control <tmux session name> before --resume", async () => {
    const tmux = mockTmux();
    await new ClaudeResumeAdapter(tmux).resume(SEAT, "claude_id", "tok-1", "/repo", undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, true);
    expect((tmux.sendText as ReturnType<typeof vi.fn>).mock.calls[0]![1]).toBe(
      `OPENRIG_RESUME_LAUNCH='tok-1' ${RENDERER} claude ${FLOOR} '--remote-control=${SEAT}' --resume 'tok-1'`,
    );
  });

  it("restore: a session name that starts with `-` stays inside the one `--remote-control=<name>` token", async () => {
    const tmux = mockTmux();
    await new ClaudeResumeAdapter(tmux).resume("-seat", "claude_id", "tok-1", "/repo", undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, true);
    const cmd = (tmux.sendText as ReturnType<typeof vi.fn>).mock.calls[0]![1] as string;
    expect(cmd).toContain(" '--remote-control=-seat' ");
    expect(cmd).not.toMatch(/--remote-control\s/);
  });

  it("restore keeps model and effort ahead of it", async () => {
    const tmux = mockTmux();
    await new ClaudeResumeAdapter(tmux).resume(SEAT, "claude_id", "tok-1", "/repo", undefined, "opus", undefined, undefined, "high", undefined, undefined, undefined, true);
    expect((tmux.sendText as ReturnType<typeof vi.fn>).mock.calls[0]![1]).toBe(
      `OPENRIG_RESUME_LAUNCH='tok-1' ${RENDERER} claude ${FLOOR} --model 'opus' --effort 'high' '--remote-control=${SEAT}' --resume 'tok-1'`,
    );
  });

  it.each([[undefined], [false]])("remoteControl=%s -> restore command byte-identical to today", async (flag) => {
    const tmux = mockTmux();
    await new ClaudeResumeAdapter(tmux).resume(SEAT, "claude_id", "tok-1", "/repo", undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, flag);
    expect((tmux.sendText as ReturnType<typeof vi.fn>).mock.calls[0]![1]).toBe(
      `OPENRIG_RESUME_LAUNCH='tok-1' ${RENDERER} claude ${FLOOR} --resume 'tok-1'`,
    );
  });

  it("an empty tmux session name refuses the restore launch rather than dropping the flag", async () => {
    const tmux = mockTmux();
    const result = await new ClaudeResumeAdapter(tmux).resume(" ", "claude_id", "tok-1", "/repo", undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, true);
    expect(result.ok).toBe(false);
    expect(tmux.sendText).not.toHaveBeenCalled();
  });
});

describe("operator-facing native resume command is NOT a daemon launch and never carries the flag", () => {
  // buildNativeResumeCommand feeds recovery guidance AND the resume-metadata probe, which starts a
  // throwaway `claude --resume` in a probe tmux session. A probe that carried --remote-control would
  // register a second remote session for the same seat.
  it("claude command text is unchanged", () => {
    expect(buildNativeResumeCommand("claude-code", "tok-1", SEAT)).toBe(`claude --resume 'tok-1' --name '${SEAT}'`);
  });
});
