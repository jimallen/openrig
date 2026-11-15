// The ask-in-modal guard: the Stop hook script's detector and decision (ask-in-modal-guard.cjs), the hook run as Claude Code
// runs it (a node process, JSON on stdin), the merge into the launch's one --settings, and every Claude launch builder (fresh,
// resume, fork, restore; classic and managed) carrying it for a declaring seat and never for an undeclared or kernel one.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { afterAll, describe, expect, it, vi } from "vitest";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code-adapter.js";
import { ClaudeResumeAdapter } from "../src/adapters/claude-resume.js";
import { ASK_IN_MODAL_GUARD_TIMEOUT_SECONDS, askInModalGuardGroup, askInModalGuardScriptPath, withAskInModalGuard } from "../src/adapters/claude-ask-in-modal-guard.js";
import { operationalLaunchArgs } from "../src/adapters/kernel-authority.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import { mockShellCommand } from "./helpers/shell-command-mock.js";
import { existingRigRoot } from "./helpers/existing-rig-root.js";

const SCRIPT = askInModalGuardScriptPath();
const guard = createRequire(import.meta.url)(SCRIPT) as {
  decide: (input: unknown, readTranscript?: (file: string) => string) => { decision: string; reason: string } | null;
  findQuestions: (text: string) => string[];
  lastTurnFromTranscript: (jsonl: string) => { text: string; askedAfter: boolean };
};

// ---- the detector --------------------------------------------------------------------------------------------------------------------
describe("findQuestions: what counts as a question for the human", () => {
  it("the observed case: a long report that ends with a prose question (cel-identity CoS, 2026-11-15)", () => {
    const text = [
      "**Caveats:**",
      "- Grafana groups the slow-end figures into coarse bands (0.13, 0.27, 0.54 and 1.07 s), so the 99th-percentile numbers are approximate.",
      "",
      "The baseline is recorded on cid-8te. Should the target be \"beat Odoscope\", meaning a typical call under 50 ms and the slowest 1% under 100 ms, or simply \"no worse than Odoscope\"?",
    ].join("\n");
    expect(guard.findQuestions(text)).toEqual([
      "Should the target be \"beat Odoscope\", meaning a typical call under 50 ms and the slowest 1% under 100 ms, or simply \"no worse than Odoscope\"?",
    ]);
  });

  it.each([
    ["a plain question", "Done. Shall we ship it?", ["Shall we ship it?"]],
    ["a question in bold", "**Merge it now?**", ["Merge it now?"]],
    ["a question in a parenthesis", "I left it open (is that right?) for now.", ["I left it open (is that right?"]],
    ["a question in a list item", "Open items:\n- Which branch should it target?", ["Which branch should it target?"]],
    ["a question mid-paragraph", "Is the 900 for the whole pack? I assumed it was.", ["Is the 900 for the whole pack?"]],
    ["\"??\"", "Really??", ["Really??"]],
    ["Want me to (no question mark)", "Want me to start it.", ["Want me to start it."]],
    ["Shall I", "Shall I assign it to impl.", ["Shall I assign it to impl."]],
    ["Should I", "Should I file it as a bead now.", ["Should I file it as a bead now."]],
    ["Let me know", "All three are merged. Let me know if you want a push.", ["Let me know if you want a push."]],
    ["Tell me if", "Tell me if you want it stopped.", ["Tell me if you want it stopped."]],
    ["Tell me whether", "Tell me whether to keep it.", ["Tell me whether to keep it."]],
    ["Tell me which", "Tell me which one you mean.", ["Tell me which one you mean."]],
    ["Say when", "Say when you are ready.", ["Say when you are ready."]],
    ["Say if", "Say if you'd rather keep that for yourself.", ["Say if you'd rather keep that for yourself."]],
    ["Would you like", "Would you like the long version.", ["Would you like the long version."]],
    ["Do you want", "Do you want both started.", ["Do you want both started."]],
    ["If you want, I'll", "If you want, I'll ask the kernel to fix the wording.", ["If you want, I'll ask the kernel to fix the wording."]],
    ["If you'd like ..., say so", "If you'd like me to push it myself, say so.", ["If you'd like me to push it myself, say so."]],
    ["a stock phrase after a list marker", "- Let me know which.", ["Let me know which."]],
    ["a stock phrase in bold", "**Want me to go ahead.**", ["Want me to go ahead.**"]],
  ])("asks: %s", (_label, text, expected) => {
    expect(guard.findQuestions(text)).toEqual(expected);
  });

  it.each([
    ["a statement", "Merged to local main. Pushing still needs your go."],
    ["a fenced code block", "Ran it:\n```sh\nread -p 'continue? ' x\n```\nAll green."],
    ["a tilde fence", "~~~\nwhy?\n~~~\nDone."],
    ["a block quote", "impl wrote:\n> Is the test flaky?\nI checked: it is not."],
    ["inline code", "The flag is `--dry-run?` in that tool."],
    ["a heading", "## What changed?\nThe guard is in."],
    ["a table row", "| Question | Answer |\n|---|---|\n| Is it safe? | yes |"],
    ["quoted speech", "impl asked \"is it flaky?\" and I answered it."],
    ["curly-quoted speech", "verify asked “does it hold?” and it did."],
    ["a URL with a query string", "Open https://example.com/authorize?response_type=code&x=1 to sign in."],
    ["a ? inside a word", "The field shows a?b after the encoding bug."],
    ["\"let me know\" mid-sentence", "impl will let me know when it lands."],
    ["\"should I\" mid-sentence", "I wondered whether I should rebase; I did."],
    ["\"wants me to\"", "Jim wants me to hold the push."],
    ["a conditional that is a statement", "If you want it to stick, the rule text needs changing."],
    ["an instruction", "Then tell me it's done."],
    ["empty", ""],
  ])("does not ask: %s", (_label, text) => {
    expect(guard.findQuestions(text)).toEqual([]);
  });

  it("several questions are all reported, in order, without repeats", () => {
    expect(guard.findQuestions("Is X right? Is Y right?\nIs X right?\nWant me to do both.")).toEqual(["Is X right?", "Is Y right?", "Want me to do both."]);
  });

  it("a question after a closed fence still counts; a question inside an unclosed fence does not", () => {
    expect(guard.findQuestions("```\na?\n```\nShip it?")).toEqual(["Ship it?"]);
    expect(guard.findQuestions("Done.\n```\nShip it?")).toEqual([]);
  });
});

// ---- the decision --------------------------------------------------------------------------------------------------------------------
describe("decide: the Stop hook's decision", () => {
  it("blocks a turn whose final reply asks in prose, with a reason that quotes the question and names the modal rule", () => {
    const out = guard.decide({ hook_event_name: "Stop", stop_hook_active: false, last_assistant_message: "Report done. Should I merge it?" });
    expect(out?.decision).toBe("block");
    expect(out?.reason).toContain("\"Should I merge it?\"");
    expect(out?.reason).toContain("AskUserQuestion");
    expect(out?.reason).toContain("(Recommended)");
    expect(out?.reason).toMatch(/one question per decision/);
    expect(out?.reason).toMatch(/Do not repeat the question in prose/);
    expect(out?.reason).toMatch(/rephrase it as a statement/);
  });

  it("the reason quotes at most three questions and counts the rest", () => {
    const out = guard.decide({ last_assistant_message: "A? B? C? D? E?" });
    expect(out?.reason).toContain("\"A?\"; \"B?\"; \"C?\" (and 2 more)");
  });

  it("lets a turn end when its final reply asks nothing", () => {
    expect(guard.decide({ stop_hook_active: false, last_assistant_message: "Merged. Nothing needs your decision." })).toBeNull();
  });

  it("never blocks when stop_hook_active is true (no loops), even for a question", () => {
    expect(guard.decide({ stop_hook_active: true, last_assistant_message: "Should I merge it?" })).toBeNull();
  });

  it.each([[null], [[]], ["text"], [5], [{}], [{ last_assistant_message: 7 }], [{ transcript_path: "" }]])("fails open on unusable input %j", (input) => {
    expect(guard.decide(input)).toBeNull();
  });

  it("fails open when the transcript cannot be read", () => {
    expect(guard.decide({ transcript_path: "/nonexistent/x.jsonl" }, () => { throw new Error("ENOENT"); })).toBeNull();
  });

  it("last_assistant_message wins over the transcript (the transcript may lag at Stop time)", () => {
    const read = vi.fn(() => { throw new Error("must not be read"); });
    expect(guard.decide({ last_assistant_message: "All done.", transcript_path: "/t.jsonl" }, read)).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });
});

// ---- the transcript fallback (shape measured on a real seat transcript, Claude Code 2.1.322) -----------------------------------------
const line = (o: unknown) => JSON.stringify(o);
const prompt = (text: string) => line({ type: "user", message: { role: "user", content: text } });
const toolResult = () => line({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }] } });
const assistant = (...content: unknown[]) => line({ type: "assistant", message: { role: "assistant", content, stop_reason: "end_turn" } });
const text = (t: string) => ({ type: "text", text: t });
const toolUse = (name: string) => ({ type: "tool_use", id: "t", name, input: {} });
const system = (subtype: string) => line({ type: "system", subtype });

describe("lastTurnFromTranscript: the final text of the last turn", () => {
  it("reads the final text after the turn's tool calls, skipping system and unknown entries", () => {
    const jsonl = [prompt("old"), assistant(text("Old turn?")), prompt("go"), assistant(toolUse("Bash")), toolResult(), assistant(text("Done. Ship it?")),
      system("stop_hook_summary"), line({ type: "queue-operation" }), "not json"].join("\n");
    expect(guard.lastTurnFromTranscript(jsonl)).toEqual({ text: "Done. Ship it?", askedAfter: false });
  });

  it("joins the consecutive text blocks that end the turn", () => {
    expect(guard.lastTurnFromTranscript([prompt("go"), assistant(text("Part one.")), assistant(text("Part two?"))].join("\n")).text).toBe("Part one.\nPart two?");
  });

  it("flags an AskUserQuestion tool_use that comes after the final text", () => {
    const jsonl = [prompt("go"), assistant(text("Which one?"), toolUse("AskUserQuestion"))].join("\n");
    expect(guard.lastTurnFromTranscript(jsonl)).toEqual({ text: "Which one?", askedAfter: true });
    expect(guard.decide({ transcript_path: "/t" }, () => jsonl)).toBeNull();
  });

  it("an AskUserQuestion BEFORE the final text does not excuse a new prose question", () => {
    const jsonl = [prompt("go"), assistant(toolUse("AskUserQuestion")), toolResult(), assistant(text("Noted. Want me to push too?"))].join("\n");
    expect(guard.lastTurnFromTranscript(jsonl).askedAfter).toBe(false);
    expect(guard.decide({ transcript_path: "/t" }, () => jsonl)?.decision).toBe("block");
  });

  it("a turn with no text lets the turn end", () => {
    expect(guard.decide({ transcript_path: "/t" }, () => [prompt("go"), assistant(toolUse("Bash"))].join("\n"))).toBeNull();
  });

  it("a meta user entry does not start a new turn", () => {
    const jsonl = [prompt("go"), assistant(text("Ship it?")), line({ type: "user", isMeta: true, message: { role: "user", content: "caveat" } })].join("\n");
    expect(guard.lastTurnFromTranscript(jsonl).text).toBe("Ship it?");
  });
});

// ---- the hook as Claude Code runs it ------------------------------------------------------------------------------------------------
describe("the hook process: JSON on stdin, a decision on stdout, exit 0", () => {
  const dir = mkdtempSync(join(tmpdir(), "aim-guard-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const run = (stdin: string) => spawnSync(process.execPath, [SCRIPT], { input: stdin, encoding: "utf8", timeout: 10_000 });

  it("blocks: prints one {decision, reason} object", () => {
    const r = run(JSON.stringify({ hook_event_name: "Stop", stop_hook_active: false, last_assistant_message: "Should I merge it?" }));
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(Object.keys(out).sort()).toEqual(["decision", "reason"]);
    expect(out.decision).toBe("block");
  });

  it("allows: prints nothing", () => {
    const r = run(JSON.stringify({ stop_hook_active: false, last_assistant_message: "Merged." }));
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });

  it.each([[""], ["not json"], ["[1,2]"], ["{\"stop_hook_active\":true,\"last_assistant_message\":\"Ok?\"}"]])("fails open on %j: prints nothing, exit 0", (stdin) => {
    const r = run(stdin);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("reads a real transcript file by path when last_assistant_message is missing", () => {
    const file = join(dir, "t.jsonl");
    writeFileSync(file, [prompt("go"), assistant(text("Want me to start it?"))].join("\n") + "\n");
    const r = run(JSON.stringify({ stop_hook_active: false, transcript_path: file }));
    expect(JSON.parse(r.stdout).decision).toBe("block");
  });

  it("a missing transcript file fails open", () => {
    const r = run(JSON.stringify({ stop_hook_active: false, transcript_path: join(dir, "missing.jsonl") }));
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });
});

// ---- the launch settings ------------------------------------------------------------------------------------------------------------
const GROUP = { hooks: [{ type: "command", command: `'${process.execPath}' '${SCRIPT}'`, timeout: 5 }] };

describe("withAskInModalGuard / askInModalGuardGroup", () => {
  it("the group runs the shipped script with the daemon's own node by absolute path, within a 5 s timeout", () => {
    expect(askInModalGuardGroup()).toEqual(GROUP);
    expect(ASK_IN_MODAL_GUARD_TIMEOUT_SECONDS).toBe(5);
    expect(SCRIPT.endsWith("/assets/plugins/openrig-core/hooks/scripts/ask-in-modal-guard.cjs")).toBe(true);
    expect(existsSync(SCRIPT)).toBe(true);
  });
  it("no --settings in: adds one holding only the Stop group", () => {
    expect(withAskInModalGuard(["--x"])).toEqual(["--x", "--settings", JSON.stringify({ hooks: { Stop: [GROUP] } })]);
  });
  it("merges into the one --settings, keeping its other keys, hooks and Stop groups", () => {
    const team = JSON.stringify({ permissions: { allow: ["Bash(rig:*)"] }, hooks: { PreToolUse: [{ matcher: "Bash", hooks: [] }], Stop: [{ hooks: [{ type: "command", command: "other" }] }] } });
    const out = withAskInModalGuard(["--settings", team]);
    expect(out.filter((a) => a === "--settings")).toHaveLength(1);
    const s = JSON.parse(out[1]!);
    expect(s.permissions).toEqual({ allow: ["Bash(rig:*)"] });
    expect(s.hooks.PreToolUse).toEqual([{ matcher: "Bash", hooks: [] }]);
    expect(s.hooks.Stop).toEqual([{ hooks: [{ type: "command", command: "other" }] }, GROUP]);
  });
  it("the --settings=<json> form is merged in place", () => {
    const out = withAskInModalGuard(["--settings={\"a\":1}", "--y"]);
    expect(out).toEqual([`--settings=${JSON.stringify({ a: 1, hooks: { Stop: [GROUP] } })}`, "--y"]);
  });
  it("is idempotent", () => {
    const once = withAskInModalGuard(["--settings", "{}"]);
    expect(withAskInModalGuard(once)).toEqual(once);
  });
  it("refuses off-shape settings instead of dropping a caller's settings", () => {
    expect(() => withAskInModalGuard(["--settings", "{}", "--settings", "{}"])).toThrow(/more than one --settings/);
    expect(() => withAskInModalGuard(["--settings"])).toThrow(/no value/);
    expect(() => withAskInModalGuard(["--settings", "/a/file.json"])).toThrow(/not valid JSON/);
    expect(() => withAskInModalGuard(["--settings", "[]"])).toThrow(/not a JSON object/);
    expect(() => withAskInModalGuard(["--settings", "{\"hooks\":[]}"])).toThrow(/hooks of a Claude launch is not an object/);
    expect(() => withAskInModalGuard(["--settings", "{\"hooks\":{\"Stop\":{}}}"])).toThrow(/hooks\.Stop of a Claude launch is not an array/);
  });
});

describe("operationalLaunchArgs: the guard rides in the one --settings for a declaring seat only, never for a kernel-authority launch", () => {
  const stopGroups = (args: string[]) => {
    const at = args.indexOf("--settings");
    return (JSON.parse(args[at + 1]!).hooks?.Stop ?? []) as unknown[];
  };
  it.each([
    ["plain", {}],
    ["team default", { teamPermissionDefault: true }],
    ["native inbox", { nativeInbox: true }],
    ["non-interruptive bypass", { launchPosture: "full_bypass" as const, nonInterruptive: true }],
  ])("%s + askInModal: exactly one --settings, the Stop group last, the rig-body guard still there", (_label, extra) => {
    const args = operationalLaunchArgs("claude-code", { ...extra, askInModal: true });
    expect(args.filter((a) => a === "--settings")).toHaveLength(1);
    expect(stopGroups(args)).toEqual([GROUP]);
    expect(args.join(" ")).toContain("rig-body-guard.cjs");
  });
  it("without the declaration the settings are byte-identical to today", () => {
    for (const extra of [{}, { askInModal: false }, { teamPermissionDefault: true }]) {
      const withField = operationalLaunchArgs("claude-code", extra);
      const without = operationalLaunchArgs("claude-code", { ...extra, askInModal: undefined });
      expect(withField).toEqual(without);
      expect(withField.join(" ")).not.toContain("ask-in-modal-guard");
    }
  });
  it("a kernel-authority launch never carries it", () => {
    expect(operationalLaunchArgs("claude-code", { kernelAuthority: true, askInModal: true }).join(" ")).not.toContain("ask-in-modal-guard");
  });
  it("codex never carries it", () => {
    expect(operationalLaunchArgs("codex", { askInModal: true }).join(" ")).not.toContain("ask-in-modal-guard");
  });
});

// ---- every Claude launch builder ----------------------------------------------------------------------------------------------------
function tmuxMock(): TmuxAdapter {
  const partial: Partial<TmuxAdapter> = {
    sendText: vi.fn(async () => ({ ok: true as const })), sendKeys: vi.fn(async () => ({ ok: true as const })), sendShellCommand: vi.fn(async () => ({ ok: true as const })),
    hasSession: vi.fn(async () => true), getPaneCommand: vi.fn(async () => "claude"), capturePaneContent: vi.fn(async () => ""), listPanes: vi.fn(async () => []),
  };
  return mockShellCommand(partial as TmuxAdapter);
}
const fsOps = { readFile: () => { throw new Error("nf"); }, writeFile: vi.fn(), exists: () => false, mkdirp: vi.fn(), copyFile: vi.fn(), listFiles: () => [] };
const binding = (extra: Partial<NodeBinding>): NodeBinding => ({ id: "b", nodeId: "n", tmuxSession: "exec-cos@test", tmuxWindow: null, tmuxPane: null, updatedAt: "", cwd: existingRigRoot("aim-work"), ...extra }) as NodeBinding;
const KINDS = ["fresh", "resume", "fork"] as const;
const opts = (kind: (typeof KINDS)[number]) => ({ name: "exec-cos@test", ...(kind === "resume" ? { resumeToken: "old-id" } : {}), ...(kind === "fork" ? { forkSource: { kind: "native_id" as const, value: "old-id" } } : {}) });
/** The settings JSON values of every `--settings` token in a classic command string. */
const classicSettings = (cmd: string): string[] => [...cmd.matchAll(/(?:^| )'--settings' '((?:[^']|'"'"')*)'/g)].map((m) => m[1]!.replace(/'"'"'/g, "'"));
const managedSettings = (args: string[]): string[] => args.flatMap((a, i) => (a === "--settings" ? [args[i + 1]!] : []));
const hasGuard = (settings: string[]): boolean => {
  expect(settings, "exactly one --settings").toHaveLength(1);
  const stop = (JSON.parse(settings[0]!).hooks?.Stop ?? []) as unknown[];
  return stop.some((g) => JSON.stringify(g) === JSON.stringify(GROUP));
};

describe("every Claude launch of a declaring seat carries the guard; an undeclared or kernel seat's does not", () => {
  const CASES: Array<[string, Partial<NodeBinding>, boolean]> = [
    ["declared", { askInModal: true }, true],
    ["declared + remote control", { askInModal: true, remoteControl: true }, true],
    ["not declared", {}, false],
    ["declared but kernel authority", { askInModal: true, kernelAuthority: true }, false],
  ];
  for (const [label, extra, expected] of CASES) for (const kind of KINDS) {
    it(`classic ${kind} / ${label}`, async () => {
      const tmux = tmuxMock();
      const adapter = new ClaudeCodeAdapter({ tmux, fsOps, sleep: async () => {}, sessionIdFactory: () => "sid", listProcesses: async () => [] });
      const result = await adapter.launchHarness(binding(extra), opts(kind));
      expect(result.ok, JSON.stringify(result)).toBe(true);
      const sent = vi.mocked(tmux.sendShellCommand).mock.calls[0]?.[1] ?? vi.mocked(tmux.sendText).mock.calls[0]![1];
      expect(hasGuard(classicSettings(sent as string))).toBe(expected);
    });
    it(`managed ${kind} / ${label}`, async () => {
      const tmux = tmuxMock();
      const command = vi.fn((args: readonly string[]) => JSON.stringify(args));
      const managed = { prepare: async () => ({ configDir: "/inert", assertCurrent: () => {}, command }) };
      const adapter = new ClaudeCodeAdapter({ tmux, fsOps, sleep: async () => {}, sessionIdFactory: () => "sid", listProcesses: async () => [], claudeManagedLaunch: managed as never });
      const result = await adapter.launchHarness(binding({ ...extra, permissionMode: "auto" }), opts(kind));
      expect(result.ok, JSON.stringify(result)).toBe(true);
      expect(hasGuard(managedSettings(command.mock.calls[0]![0] as string[]))).toBe(expected);
    });
  }

  // resume(sessionName, resumeType, token, cwd, posture, model, permissionMode, nodeId, effort, nonInterruptive, kernelAuthority,
  //        teamPermissionDefault, remoteControl, askInModal)
  for (const [label, extra, expected] of CASES) {
    it(`restore (classic) / ${label}`, async () => {
      const tmux = tmuxMock();
      await new ClaudeResumeAdapter(tmux, { sleep: async () => {}, maxWaitMs: 1, listProcesses: async () => [] })
        .resume("exec-cos@test", "claude_id", "tok", existingRigRoot("aim-work"), undefined, null, undefined, undefined, undefined, undefined,
          extra.kernelAuthority, undefined, extra.remoteControl, extra.askInModal);
      const sent = vi.mocked(tmux.sendShellCommand).mock.calls[0]?.[1] ?? vi.mocked(tmux.sendText).mock.calls[0]![1];
      expect(hasGuard(classicSettings(sent as string))).toBe(expected);
    });
    it(`restore (managed) / ${label}`, async () => {
      const tmux = tmuxMock();
      const command = vi.fn((args: readonly string[]) => JSON.stringify(args));
      const managed = { prepare: async () => ({ configDir: "/inert", assertCurrent: () => {}, command }) };
      await new ClaudeResumeAdapter(tmux, { sleep: async () => {}, maxWaitMs: 1, listProcesses: async () => [], claudeManagedLaunch: managed as never })
        .resume("exec-cos@test", "claude_id", "tok", existingRigRoot("aim-work"), undefined, null, "auto", "n", undefined, undefined,
          extra.kernelAuthority, undefined, extra.remoteControl, extra.askInModal);
      expect(hasGuard(managedSettings(command.mock.calls[0]![0] as string[]))).toBe(expected);
    });
  }

  it("an undeclared seat's classic fresh launch is byte-identical to a launch with askInModal: false", async () => {
    const a = tmuxMock(); const b = tmuxMock();
    const mk = (tmux: TmuxAdapter) => new ClaudeCodeAdapter({ tmux, fsOps, sleep: async () => {}, sessionIdFactory: () => "sid", listProcesses: async () => [] });
    await mk(a).launchHarness(binding({}), opts("fresh"));
    await mk(b).launchHarness(binding({ askInModal: false }), opts("fresh"));
    const sent = (t: TmuxAdapter) => vi.mocked(t.sendShellCommand).mock.calls[0]?.[1] ?? vi.mocked(t.sendText).mock.calls[0]![1];
    expect(sent(b)).toBe(sent(a));
  });
});
