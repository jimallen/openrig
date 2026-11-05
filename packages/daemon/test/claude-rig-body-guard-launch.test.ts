// OF-250: the rig-body guard rides in the ONE --settings of every managed Claude launch.
// Measured on Claude Code 2.1.318: two --settings flags do not merge (the last wins, the other is dropped), so the guard is merged INTO the
// launch's own --settings JSON. This file pins: the merge function; the composition order with the native-inbox key; "exactly one --settings
// per command string" across every launch kind and every launch-settings variant, classic and managed, fresh/resume/fork/restore; and the
// refusal when the hook script is missing (nothing is typed into the pane).
import { describe, expect, it, vi } from "vitest";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code-adapter.js";
import { ClaudeResumeAdapter } from "../src/adapters/claude-resume.js";
import { claudeRigBodyGuardRefusal, claudeRigBodyGuardScriptPath, withRigBodyGuard } from "../src/adapters/claude-rig-body-guard.js";
import { operationalLaunchArgs, withNativeInboxSettings } from "../src/adapters/kernel-authority.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import { mockShellCommand } from "./helpers/shell-command-mock.js";
import { GUARD_GROUP, GUARD_JSON, GUARD_SCRIPT } from "./helpers/claude-guard.js";
import { existingRigRoot } from "./helpers/existing-rig-root.js";

const TEAM = JSON.stringify({ permissions: { allow: ["Bash(rig:*)"], deny: ["Bash(chmod:*)"] }, hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "team-hook", timeout: 5 }] }] } });

describe("withRigBodyGuard", () => {
  it("no --settings in: adds one holding only the guard group", () => {
    expect(withRigBodyGuard(["--x"])).toEqual(["--x", "--settings", GUARD_JSON]);
  });
  it("the guard group is a blocking Bash PreToolUse hook on the shipped rig-body-guard.cjs", () => {
    expect(GUARD_GROUP.matcher).toBe("Bash");
    expect(GUARD_GROUP.hooks[0]!.command).toBe(`'${process.execPath}' '${GUARD_SCRIPT}'`);
    // F-1: the interpreter is the daemon's own node by absolute path, never a bare `node` that a seat PATH may not resolve.
    expect(GUARD_GROUP.hooks[0]!.command.startsWith("'/")).toBe(true);
    expect(GUARD_GROUP.hooks[0]!.command).not.toMatch(/^node /);
    expect(GUARD_SCRIPT.endsWith("/assets/plugins/openrig-core/hooks/scripts/rig-body-guard.cjs")).toBe(true);
  });
  it("one --settings in: the guard is appended as a SECOND PreToolUse group; permissions and the first hook are untouched", () => {
    const out = withRigBodyGuard(["--settings", TEAM]);
    expect(out.filter((a) => a === "--settings")).toHaveLength(1);
    const merged = JSON.parse(out[1]!);
    expect(merged.permissions).toEqual(JSON.parse(TEAM).permissions);
    expect(merged.hooks.PreToolUse).toEqual([JSON.parse(TEAM).hooks.PreToolUse[0], GUARD_GROUP]);
  });
  it("a --settings with hooks for another event keeps them and adds PreToolUse", () => {
    const out = withRigBodyGuard(["--settings", JSON.stringify({ hooks: { Stop: [{ hooks: [] }] }, crossSessionInbound: "accept" })]);
    expect(JSON.parse(out[1]!)).toEqual({ hooks: { Stop: [{ hooks: [] }], PreToolUse: [GUARD_GROUP] }, crossSessionInbound: "accept" });
  });
  it("is idempotent (the guard is not added twice)", () => {
    const once = withRigBodyGuard(["--settings", TEAM]);
    expect(withRigBodyGuard(once)).toEqual(once);
  });
  it("more than one --settings going in is refused (they do not merge: the double-flag case measured on 2.1.318)", () => {
    expect(() => withRigBodyGuard(["--settings", TEAM, "--settings", GUARD_JSON])).toThrow(/more than one --settings/);
  });
  it("a custom script path is used", () => {
    expect(JSON.parse(withRigBodyGuard([], "/x/y z.cjs")[1]!).hooks.PreToolUse[0].hooks[0].command).toBe(`'${process.execPath}' '/x/y z.cjs'`);
  });
  it("the refusal names a missing script and is null when it is there", () => {
    expect(claudeRigBodyGuardRefusal(GUARD_SCRIPT)).toBeNull();
    expect(claudeRigBodyGuardRefusal("/nonexistent/rig-body-guard.cjs")).toContain("not launching Claude without it");
    expect(claudeRigBodyGuardRefusal(GUARD_SCRIPT, () => false)).not.toBeNull();
    expect(claudeRigBodyGuardScriptPath("/pkg/dist/adapters")).toBe("/pkg/assets/plugins/openrig-core/hooks/scripts/rig-body-guard.cjs");
  });
});

describe("composition order with the native-inbox key", () => {
  const team = ["--settings", TEAM];
  it("both orders give ONE --settings with the same content (key order aside)", () => {
    const a = withRigBodyGuard(withNativeInboxSettings(team));
    const b = withNativeInboxSettings(withRigBodyGuard(team));
    expect(a.filter((x) => x === "--settings")).toHaveLength(1);
    expect(b.filter((x) => x === "--settings")).toHaveLength(1);
    expect(JSON.parse(a[1]!)).toEqual(JSON.parse(b[1]!));
    expect(JSON.parse(a[1]!)).toMatchObject({ crossSessionInbound: "accept", permissions: expect.any(Object) });
    expect(JSON.parse(a[1]!).hooks.PreToolUse).toHaveLength(2);
  });
  it("with no other settings, both orders agree too", () => {
    expect(JSON.parse(withRigBodyGuard(withNativeInboxSettings([]))[1]!)).toEqual(JSON.parse(withNativeInboxSettings(withRigBodyGuard([]))[1]!));
  });
  it("production order is fixed (native inbox, then the guard), so the bytes are deterministic", () => {
    const args = operationalLaunchArgs("claude-code", { nativeInbox: true });
    expect(args).toEqual(["--settings", JSON.stringify({ crossSessionInbound: "accept", hooks: { PreToolUse: [GUARD_GROUP] } })]);
    expect(operationalLaunchArgs("claude-code", { nativeInbox: true })).toEqual(args);
  });
  it("codex gets no guard", () => {
    expect(JSON.stringify(operationalLaunchArgs("codex", {}))).not.toContain("rig-body-guard");
  });
});

// ---- the launch matrix ------------------------------------------------------------------------------------------------------------------
type Variant = { name: string; binding: Partial<NodeBinding>; nativeInbox: boolean; expectsKey?: string };
const VARIANTS: Variant[] = [
  { name: "plain", binding: {}, nativeInbox: false },
  { name: "team default", binding: { teamPermissionDefault: true }, nativeInbox: false, expectsKey: "permissions" },
  { name: "kernel authority", binding: { kernelAuthority: true }, nativeInbox: false, expectsKey: "permissions" },
  { name: "non-interruptive bypass", binding: { launchPosture: "full_bypass", nonInterruptive: true }, nativeInbox: false, expectsKey: "skipDangerousModePermissionPrompt" },
  { name: "native inbox", binding: {}, nativeInbox: true, expectsKey: "crossSessionInbound" },
  { name: "team default + native inbox", binding: { teamPermissionDefault: true }, nativeInbox: true, expectsKey: "crossSessionInbound" },
  { name: "remote control", binding: { remoteControl: true }, nativeInbox: false },
];
const KINDS = ["fresh", "resume", "fork"] as const;

function tmuxMock(): TmuxAdapter {
  const partial: Partial<TmuxAdapter> = {
    sendText: vi.fn(async () => ({ ok: true as const })), sendKeys: vi.fn(async () => ({ ok: true as const })), sendShellCommand: vi.fn(async () => ({ ok: true as const })),
    hasSession: vi.fn(async () => true), getPaneCommand: vi.fn(async () => "claude"), capturePaneContent: vi.fn(async () => ""), listPanes: vi.fn(async () => []),
  };
  return mockShellCommand(partial as TmuxAdapter);
}
const fsOps = { readFile: () => { throw new Error("nf"); }, writeFile: vi.fn(), exists: () => false, mkdirp: vi.fn(), copyFile: vi.fn(), listFiles: () => [] };
const binding = (extra: Partial<NodeBinding>): NodeBinding => ({ id: "b", nodeId: "n", tmuxSession: "dev@test", tmuxWindow: null, tmuxPane: null, updatedAt: "", cwd: existingRigRoot("of250-work"), ...extra }) as NodeBinding;
const opts = (kind: (typeof KINDS)[number]) => ({ name: "dev@test", ...(kind === "resume" ? { resumeToken: "old-id" } : {}), ...(kind === "fork" ? { forkSource: { kind: "native_id" as const, value: "old-id" } } : {}) });

/** The settings JSON values of every `--settings` token in a classic command string. */
function classicSettings(cmd: string): string[] {
  return [...cmd.matchAll(/(?:^| )'--settings' '((?:[^']|'"'"')*)'/g)].map((m) => m[1]!.replace(/'"'"'/g, "'"));
}
function expectGuardMerged(settingsJsons: string[], variant?: Variant) {
  expect(settingsJsons, "exactly one --settings per command string").toHaveLength(1);
  const s = JSON.parse(settingsJsons[0]!);
  const groups = s.hooks.PreToolUse as Array<{ hooks: Array<{ command: string }> }>;
  expect(groups.filter((g) => g.hooks.some((h) => h.command.includes("rig-body-guard.cjs"))), "the guard group is present once").toHaveLength(1);
  expect(groups[groups.length - 1]).toEqual(GUARD_GROUP);
  if (variant?.expectsKey) expect(s[variant.expectsKey], `${variant.name}: the launch's own setting survives`).toBeDefined();
  if (variant?.name === "team default" || variant?.name === "kernel authority") {
    expect(groups, "the team/kernel permission hook is still first").toHaveLength(2);
    expect(groups[0]!.hooks[0]!.command).toContain("claude-team-permissions.cjs");
  }
}

describe("every managed Claude launch carries the guard in exactly one --settings", () => {
  for (const v of VARIANTS) for (const kind of KINDS) {
    it(`classic ${kind} / ${v.name}`, async () => {
      const tmux = tmuxMock();
      const adapter = new ClaudeCodeAdapter({ tmux, fsOps, sleep: async () => {}, sessionIdFactory: () => "sid", nativeInboxEnabled: () => v.nativeInbox, listProcesses: async () => [] });
      await adapter.launchHarness(binding(v.binding), opts(kind));
      const sent = vi.mocked(tmux.sendShellCommand).mock.calls[0]?.[1] ?? vi.mocked(tmux.sendText).mock.calls[0]![1];
      expectGuardMerged(classicSettings(sent as string), v);
    });
    it(`managed ${kind} / ${v.name}`, async () => {
      const tmux = tmuxMock();
      const command = vi.fn((args: readonly string[]) => JSON.stringify(args));
      const managed = { prepare: async () => ({ configDir: "/inert", assertCurrent: () => {}, command }) };
      const adapter = new ClaudeCodeAdapter({ tmux, fsOps, sleep: async () => {}, sessionIdFactory: () => "sid", nativeInboxEnabled: () => v.nativeInbox, listProcesses: async () => [],
        claudeManagedLaunch: managed as never });
      await adapter.launchHarness(binding({ ...v.binding, permissionMode: "auto" }), opts(kind));
      const args = command.mock.calls[0]![0] as string[];
      expectGuardMerged(args.flatMap((a, i) => (a === "--settings" ? [args[i + 1]!] : [])), { ...v, ...(v.binding.teamPermissionDefault || v.binding.nonInterruptive ? { name: "managed explicit native mode", expectsKey: v.nativeInbox ? "crossSessionInbound" : undefined } : {}) }); // an explicit native permission mode replaces the team default and the non-interruptive setting: the guard still rides alone
    });
  }
  for (const v of VARIANTS.filter((x) => !x.binding.launchPosture)) {
    it(`restore (classic) / ${v.name}`, async () => {
      const tmux = tmuxMock();
      await new ClaudeResumeAdapter(tmux, { nativeInboxEnabled: () => v.nativeInbox, sleep: async () => {}, maxWaitMs: 1, listProcesses: async () => [] })
        .resume("dev@test", "claude_id", "tok", existingRigRoot("of250-work"), undefined, null, undefined, undefined, undefined, undefined,
          v.binding.kernelAuthority, v.binding.teamPermissionDefault, v.binding.remoteControl);
      const sent = vi.mocked(tmux.sendShellCommand).mock.calls[0]?.[1] ?? vi.mocked(tmux.sendText).mock.calls[0]![1];
      expectGuardMerged(classicSettings(sent as string), v);
    });
    it(`restore (managed) / ${v.name}`, async () => {
      const tmux = tmuxMock();
      const command = vi.fn((args: readonly string[]) => JSON.stringify(args));
      const managed = { prepare: async () => ({ configDir: "/inert", assertCurrent: () => {}, command }) };
      await new ClaudeResumeAdapter(tmux, { nativeInboxEnabled: () => v.nativeInbox, sleep: async () => {}, maxWaitMs: 1, listProcesses: async () => [], claudeManagedLaunch: managed as never })
        .resume("dev@test", "claude_id", "tok", existingRigRoot("of250-work"), undefined, null, "auto", "n", undefined, undefined,
          v.binding.kernelAuthority, v.binding.teamPermissionDefault, v.binding.remoteControl);
      const args = command.mock.calls[0]![0] as string[];
      expectGuardMerged(args.flatMap((a, i) => (a === "--settings" ? [args[i + 1]!] : [])), { ...v, ...(v.binding.teamPermissionDefault ? { name: "managed explicit native mode" } : {}), expectsKey: v.nativeInbox ? "crossSessionInbound" : undefined });
    });
  }
});

describe("a missing hook script refuses the launch before anything is typed", () => {
  const MISSING = "/nonexistent/rig-body-guard.cjs";
  for (const kind of KINDS) {
    it(`launchHarness ${kind}`, async () => {
      const tmux = tmuxMock();
      const adapter = new ClaudeCodeAdapter({ tmux, fsOps, sleep: async () => {}, rigBodyGuardScript: MISSING });
      const r = await adapter.launchHarness(binding({}), opts(kind));
      expect(r).toMatchObject({ ok: false, error: expect.stringContaining("not launching Claude without it") });
      expect(tmux.sendText).not.toHaveBeenCalled();
      expect(tmux.sendShellCommand).not.toHaveBeenCalled();
    });
  }
  it("restore", async () => {
    const tmux = tmuxMock();
    const r = await new ClaudeResumeAdapter(tmux, { rigBodyGuardScript: MISSING }).resume("dev@test", "claude_id", "tok", "/repo");
    expect(r).toMatchObject({ ok: false, message: expect.stringContaining("not launching Claude without it") });
    expect(tmux.sendText).not.toHaveBeenCalled();
    expect(tmux.sendShellCommand).not.toHaveBeenCalled();
  });
});
