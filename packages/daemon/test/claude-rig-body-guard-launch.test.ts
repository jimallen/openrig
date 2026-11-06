// OF-250: the rig-body guard rides in the ONE --settings of every managed Claude launch.
// Measured on Claude Code 2.1.318: two --settings flags do not merge (the last wins, the other is dropped), so the guard is merged INTO the
// launch's own --settings JSON. This file pins: the merge function; the composition order with the native-inbox key; "exactly one --settings
// per command string" across every launch kind and every launch-settings variant, classic and managed, fresh/resume/fork/restore; and the
// refusal when the hook script is missing (nothing is typed into the pane).
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code-adapter.js";
import { ClaudeResumeAdapter } from "../src/adapters/claude-resume.js";
import { claudeRigBodyGuardGroup, claudeRigBodyGuardRefusal, claudeRigBodyGuardScriptPath, withRigBodyGuard } from "../src/adapters/claude-rig-body-guard.js";
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
    // OF-253: an inline sh wrapper; the interpreter is the daemon's own node by absolute path (OF-250 F-1), never a bare `node`; the watchdog is 3 s, under the 5 s hook timeout.
    expect(GUARD_GROUP.hooks[0]!.command.startsWith("/bin/sh -c '")).toBe(true);
    expect(GUARD_GROUP.hooks[0]!.command.endsWith(` sh '${process.execPath}' '${GUARD_SCRIPT}' 3`)).toBe(true);
    expect(GUARD_GROUP.hooks[0]!.timeout).toBe(5);
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
  // OF-252: off-shape input fails closed (a thrown Error, so the launch does not happen) instead of being replaced or mis-detected.
  it("a PreToolUse that is not an array is refused, not silently replaced (a caller's hook would be dropped)", () => {
    for (const pre of [{ matcher: "Bash", hooks: [{ type: "command", command: "team-hook" }] }, "team-hook", 5, null]) {
      expect(() => withRigBodyGuard(["--settings", JSON.stringify({ hooks: { PreToolUse: pre } })])).toThrow(/PreToolUse of a Claude launch is not an array/);
    }
  });
  it("a hooks value that is not an object is refused, not silently replaced", () => {
    for (const hooks of [[{ matcher: "Bash" }], "x", 5, null]) {
      expect(() => withRigBodyGuard(["--settings", JSON.stringify({ hooks })])).toThrow(/hooks of a Claude launch is not an object/);
    }
  });
  it("the --settings=<json> form is a settings flag: it is merged in place, in its own form, and stays the only one", () => {
    const out = withRigBodyGuard(["--x", `--settings=${TEAM}`, "--y"]);
    expect(out.slice(0, 1)).toEqual(["--x"]);
    expect(out[2]).toBe("--y");
    expect(out).toHaveLength(3);
    expect(out[1]!.startsWith("--settings=")).toBe(true);
    expect(JSON.parse(out[1]!.slice("--settings=".length)).hooks.PreToolUse).toEqual([JSON.parse(TEAM).hooks.PreToolUse[0], GUARD_GROUP]);
    expect(withRigBodyGuard(out)).toEqual(out);
  });
  it("the equals form counts toward exactly one, in every pairing", () => {
    expect(() => withRigBodyGuard([`--settings=${TEAM}`, "--settings", GUARD_JSON])).toThrow(/more than one --settings/);
    expect(() => withRigBodyGuard(["--settings", TEAM, `--settings=${GUARD_JSON}`])).toThrow(/more than one --settings/);
    expect(() => withRigBodyGuard([`--settings=${TEAM}`, `--settings=${GUARD_JSON}`])).toThrow(/more than one --settings/);
  });
  it("a flag with no value, a value that is not JSON (a file path), or JSON that is not an object fails closed with a clear error", () => {
    expect(() => withRigBodyGuard(["--x", "--settings"])).toThrow(/has no value/);
    expect(() => withRigBodyGuard(["--settings", "/some/file.json"])).toThrow(/not valid JSON.*file path is not supported/);
    expect(() => withRigBodyGuard(["--settings", "{"])).toThrow(/not valid JSON/);
    expect(() => withRigBodyGuard(["--settings=nope"])).toThrow(/not valid JSON/);
    for (const v of ["null", "[]", "5", "\"x\""]) expect(() => withRigBodyGuard(["--settings", v])).toThrow(/not a JSON object/);
  });
  it("malformed group entries are kept, not crashed on or dropped", () => {
    const out = withRigBodyGuard(["--settings", JSON.stringify({ hooks: { PreToolUse: [null, { matcher: "X", hooks: "s" }] } })]);
    expect(JSON.parse(out[1]!).hooks.PreToolUse).toEqual([null, { matcher: "X", hooks: "s" }, GUARD_GROUP]);
  });
  it("a custom script path is used", () => {
    expect(JSON.parse(withRigBodyGuard([], "/x/y z.cjs")[1]!).hooks.PreToolUse[0].hooks[0].command.endsWith(` sh '${process.execPath}' '/x/y z.cjs' 3`)).toBe(true);
  });
  it("the refusal names a missing script and is null when it is there", () => {
    expect(claudeRigBodyGuardRefusal(GUARD_SCRIPT)).toBeNull();
    expect(claudeRigBodyGuardRefusal("/nonexistent/rig-body-guard.cjs")).toContain("not launching Claude without it");
    expect(claudeRigBodyGuardRefusal(GUARD_SCRIPT, () => false)).not.toBeNull();
    expect(claudeRigBodyGuardScriptPath("/pkg/dist/adapters")).toBe("/pkg/assets/plugins/openrig-core/hooks/scripts/rig-body-guard.cjs");
  });
});

describe("OF-253: the hook command runs the guard through an inline sh wrapper that fails closed where the risk signal exists", () => {
  // Measured on Claude Code 2.1.319: only exit 2 (or a deny decision) blocks; a missing interpreter, a missing script, exit 1, a SIGKILL and a timeout let the command run.
  const BAD = 'rig send s "x `date` y"';
  const BAD_DOLLAR = 'rig send s "x $(date) y"';
  const HEREDOC = "rig send s --file - <<'EOF'\nuse `x` here\nEOF";
  const event = (command: string) => JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } });
  let dir = "";
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "of253-"));
    writeFileSync(join(dir, "crash.cjs"), 'throw new Error("guard crashed");\n');
    writeFileSync(join(dir, "exit1.cjs"), "process.exit(1);\n");
    writeFileSync(join(dir, "hang.cjs"), "process.stdin.resume(); setTimeout(() => {}, 30000);\n");
    writeFileSync(join(dir, "garbage.cjs"), 'console.log("not json"); \n');
  });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });
  const hook = (command: string, options: { script?: string; node?: string; watchdog?: number; raw?: string; env?: Record<string, string>; shell?: string } = {}) => {
    const g = claudeRigBodyGuardGroup(options.script ?? GUARD_SCRIPT, { ...(options.node ? { nodePath: options.node } : {}), watchdogSeconds: options.watchdog ?? 3 });
    const line = options.shell ? g.hooks[0]!.command.replace(/^\/bin\/sh /, `${options.shell} `) : g.hooks[0]!.command;
    const t0 = Date.now();
    const r = spawnSync("/bin/sh", ["-c", line], { input: options.raw ?? event(command), encoding: "utf8", timeout: 20_000, ...(options.env ? { env: options.env } : {}) });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, ms: Date.now() - t0 };
  };
  const REFUSED = { status: 2 };
  const ALLOWED = { status: 0, stdout: "" };

  it("guard intact: a bad body is denied through the guard's own decision (exit 0 + deny JSON), a safe command and a quoted heredoc pass, and success does not wait for the watchdog", () => {
    const bad = hook(BAD);
    expect(bad.status).toBe(0);
    expect(JSON.parse(bad.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
    expect(hook("ls -la")).toMatchObject(ALLOWED);
    const heredoc = hook(HEREDOC);
    expect(heredoc).toMatchObject(ALLOWED);
    expect(heredoc.ms).toBeLessThan(2500); // watchdog is 3 s: a clean exit must not sit out its timer
  });

  for (const [label, options] of [
    ["the guard script is gone (a package directory replaced under a running seat)", { script: "/nonexistent/rig-body-guard.cjs" }],
    ["the node path is gone (a node upgrade under a running seat)", { node: "/nonexistent/bin/node" }],
  ] as const) {
    it(`${label}: degraded check refuses rig + backtick or $( and lets the rest run`, () => {
      const bad = hook(BAD, options);
      expect(bad).toMatchObject(REFUSED);
      expect(bad.stderr).toContain("rig-body-guard is unavailable");
      expect(bad.stderr).toContain("(node or the guard script is missing)"); // found by the wrapper's own existence check, not by the guard failing
      expect(bad.stderr).toContain("--file /tmp/msg.md");
      expect(hook(BAD_DOLLAR, options)).toMatchObject(REFUSED);
      expect(hook("echo hi\nrig send s `x`", options)).toMatchObject(REFUSED); // rig right after a newline
      expect(hook("ls -la", options)).toMatchObject(ALLOWED);
      expect(hook("echo `date`", options)).toMatchObject(ALLOWED);           // a backtick with no rig
      expect(hook("rig send s 'plain'", options)).toMatchObject(ALLOWED);    // rig with no backtick or $(
      expect(hook("echo a right $(date) b", options)).toMatchObject(ALLOWED); // "rig" inside another word is not rig
    });
    it(`${label}: a SAFE quoted-heredoc rig send holding backticks is refused too (the documented cost of degraded mode)`, () => {
      expect(hook(HEREDOC, options)).toMatchObject(REFUSED);
    });
  }

  for (const [label, script] of [["crashes", "crash.cjs"], ["exits 1", "exit1.cjs"]] as const) {
    it(`the guard ${label}: the same degraded check, not a blanket refusal and not a blanket allow`, () => {
      const bad = hook(BAD, { script: join(dir, script) });
      expect(bad).toMatchObject(REFUSED);
      expect(bad.stderr).toContain("(the guard failed or timed out, exit ");
      expect(hook("ls -la", { script: join(dir, script) })).toMatchObject(ALLOWED);
    });
  }
  it("the guard prints something but exits 0: that output is passed through untouched", () => {
    const r = hook("ls", { script: join(dir, "garbage.cjs") });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("not json\n");
  });
  it("the hook command names /bin/sh by absolute path, so a PATH without sh cannot skip the wrapper", () => {
    expect(claudeRigBodyGuardGroup(GUARD_SCRIPT).hooks[0]!.command.startsWith("/bin/sh -c ")).toBe(true);
  });
  it("degraded check reads through quotes and backslashes in the name, and through JSON escapes (OF-251 re-review F-1, F-5)", () => {
    const options = { script: "/nonexistent/rig-body-guard.cjs" };
    for (const c of ['r""ig send s "x `date`"', "r\\ig send s $(date)", "'r'ig send s `date`", '"r"i\'g\' send s $(x)', "rig\tsend `x`"]) expect(hook(c, options), c).toMatchObject(REFUSED);
    // the hook text as JSON with the characters escaped as the JSON grammar allows
    expect(hook("", { ...options, raw: '{"tool_input":{"command":"\\u0072ig send s \\u0060x\\u0060"}}' })).toMatchObject(REFUSED);
    expect(hook("", { ...options, raw: '{"tool_input":{"command":"r\\u0069g send s \\u0024(x)"}}' })).toMatchObject(REFUSED);
    expect(hook("", { ...options, raw: '{"tool_input":{"command":"echo \\u0060date\\u0060"}}' })).toMatchObject(ALLOWED); // decoded backtick, no rig
    expect(hook("rig send s 'plain'", options)).toMatchObject(ALLOWED);
    expect(hook("echo a string $(date) b", options)).toMatchObject(ALLOWED);          // "string" holds r-i-g in order but is not rig
  });
  it("degraded check needs no grep or sed on PATH (shell builtins only), and cat and sleep are found even when PATH is empty", () => {
    const env = { PATH: "/nonexistent" };
    const options = { script: "/nonexistent/rig-body-guard.cjs", env };
    expect(hook(BAD, options)).toMatchObject(REFUSED);
    expect(hook('r""ig send s $(x)', options)).toMatchObject(REFUSED);
    expect(hook("ls -la", options)).toMatchObject(ALLOWED);
    expect(hook(BAD, { env })).toMatchObject({ status: 0 });                          // intact guard still answers with its deny JSON under that PATH
  });
  it("a hook text over 16 KB is not decoded: with a backtick or $( in it, it counts as mentioning rig", () => {
    const options = { script: "/nonexistent/rig-body-guard.cjs" };
    expect(hook(`echo ${"x".repeat(17_000)} $(date)`, options)).toMatchObject(REFUSED);
    expect(hook(`echo ${"x".repeat(17_000)}`, options)).toMatchObject(ALLOWED);
  });
  const hasBash = spawnSync("bash", ["-c", "true"]).status === 0;
  it.skipIf(!hasBash)("an inherited errexit (SHELLOPTS) cannot end the wrapper on the guard's exit code before the degraded check", () => {
    const env = { PATH: process.env["PATH"] ?? "/usr/bin:/bin", SHELLOPTS: "errexit" };
    expect(hook(BAD, { script: join(dir, "exit1.cjs"), env, shell: "bash" })).toMatchObject(REFUSED);
    expect(hook("ls -la", { script: join(dir, "exit1.cjs"), env, shell: "bash" })).toMatchObject(ALLOWED);
  });
  it("a guard that ignores TERM is KILLed one second after the watchdog's TERM, then the degraded check applies", () => {
    writeFileSync(join(dir, "deaf.cjs"), 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);\n');
    const bad = hook(BAD, { script: join(dir, "deaf.cjs"), watchdog: 1 });
    expect(bad).toMatchObject(REFUSED);
    expect(bad.stderr).toContain("exit 137");
    expect(bad.ms).toBeGreaterThan(1800);
    expect(bad.ms).toBeLessThan(6000);
    expect(hook("ls -la", { script: join(dir, "deaf.cjs"), watchdog: 1 })).toMatchObject(ALLOWED);
  });
  it("the guard outruns the watchdog (1 s): stopped, then the degraded check applies; a safe command still runs", () => {
    const bad = hook(BAD, { script: join(dir, "hang.cjs"), watchdog: 1 });
    expect(bad).toMatchObject(REFUSED);
    expect(bad.stderr).toContain("exit 143"); // stopped by the watchdog's TERM
    expect(bad.ms).toBeGreaterThan(900);
    expect(bad.ms).toBeLessThan(5000);
    expect(hook("ls -la", { script: join(dir, "hang.cjs"), watchdog: 1 })).toMatchObject(ALLOWED);
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
