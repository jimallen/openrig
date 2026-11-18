// workspaces-o9o.33: on a seat where Claude Code also loads the openrig-core plugin, every relay event ran twice: once from the managed copy
// OpenRig writes into the project's .claude/settings.local.json, once from the plugin's hooks/claude.json. Measured on Claude Code 2.1.326
// (bead note): with the plugin loaded (--plugin-dir), each hook runs from both, 7-27 ms apart, with the same tool_use_id; only the plugin
// copy sees CLAUDE_PLUGIN_ROOT. A plugin that is only projected into .claude/plugins/<id> is not loaded, so today's seats run one copy.
//
// What the second copy did, each measured below or in the bead note: a second post of every hook (a question asked once counted as two asks,
// so the seat read "waiting" after its answer); a second question-wait hold, under its own random request id, so one question became two
// identical rows, which o9o.56 holds as ambiguous and never auto-answers; and a second seat gate, which found the first copy's marker and
// BLOCKED a socket-delivered prompt as a repeat.
//
// The rows run the REAL scripts as separate processes, the way Claude Code runs a hook: stdin payload, env, a daemon endpoint (a fake that
// counts what arrives). The env is built from nothing, so this seat's own OpenRig env never leaks in.
import { spawn } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ASSETS = resolve(import.meta.dirname, "../assets/plugins/openrig-core/hooks/scripts");
const SCRIPTS = ["activity-relay.cjs", "question-wait.cjs"] as const;
const SEAT = "dev-impl@relayrig";
const TOKEN = "hook-token-" + "o9o33";

interface Arrival { route: string; body: Record<string, unknown> }

let root: string;
let server: Server;
let arrivals: Arrival[];
let baseUrl: string;
let home: string;
let project: string;
let pluginRoot: string;
const managed = (script: (typeof SCRIPTS)[number]) => join(home, "state", "claude-activity-hooks", script);
const plugin = (script: (typeof SCRIPTS)[number]) => join(pluginRoot, "hooks", "scripts", script);

/** The project's settings.local.json as the adapter writes it: the managed copy, `node '<path>'`, for each listed event. */
function writeManagedSettings(events: string[], extra: Record<string, unknown> = {}): void {
  const hooks: Record<string, unknown[]> = {};
  for (const event of events) {
    const relay = { type: "command", command: `node '${managed("activity-relay.cjs")}'` };
    hooks[event] = event === "PermissionRequest"
      ? [{ matcher: "AskUserQuestion", hooks: [relay] }, { matcher: "AskUserQuestion", hooks: [{ type: "command", command: `node '${managed("question-wait.cjs")}'`, timeout: 1000 }] }]
      : [{ hooks: [relay] }];
  }
  writeFileSync(join(project, ".claude", "settings.local.json"), JSON.stringify({ ...extra, hooks }, null, 2));
}

/** Runs one copy of a hook script as Claude Code would; resolves its stdout. */
function runHook(path: string, payload: Record<string, unknown>, asPlugin: boolean): Promise<string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: join(root, "user-home"),
    OPENRIG_URL: baseUrl, OPENRIG_ACTIVITY_HOOK_TOKEN: TOKEN, OPENRIG_SESSION_NAME: SEAT, OPENRIG_RUNTIME: "claude-code", OPENRIG_HOME: home,
    CLAUDE_PROJECT_DIR: project,
    ...(asPlugin ? { CLAUDE_PLUGIN_ROOT: pluginRoot } : {}),
  };
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [path], { env, cwd: project, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (c) => { out += c; });
    child.on("error", fail);
    child.on("close", () => done(out));
    child.stdin.end(JSON.stringify({ session_id: "claude-session-o9o33", cwd: project, ...payload }));
  });
}

/** Both copies run for one hook, as Claude Code runs every matching hook of an event. */
const both = (script: (typeof SCRIPTS)[number], payload: Record<string, unknown>) =>
  Promise.all([runHook(managed(script), payload, false), runHook(plugin(script), payload, true)]);
const posts = (route: string, event?: string) => arrivals.filter((a) => a.route === route && (!event || a.body.hookEvent === event));

const QUESTIONS = [{ question: "Ship it?", header: "Ship", multiSelect: false, options: [{ label: "Yes (Recommended)", description: "y" }, { label: "No", description: "n" }] }];
const EVENTS: Array<[string, Record<string, unknown>]> = [
  ["SessionStart", { hook_event_name: "SessionStart", source: "startup" }],
  ["UserPromptSubmit", { hook_event_name: "UserPromptSubmit", prompt: "hello" }],
  ["PreToolUse", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "toolu_bash_0001" }],
  ["PostToolUse", { hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "toolu_bash_0001" }],
  ["PostToolUseFailure", { hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_use_id: "toolu_bash_0002" }],
  ["PermissionRequest", { hook_event_name: "PermissionRequest", tool_name: "AskUserQuestion", tool_input: { questions: QUESTIONS } }],
  ["Notification", { hook_event_name: "Notification", notification_type: "permission_prompt" }],
  ["Stop", { hook_event_name: "Stop" }],
];

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "o9o33-"));
  home = join(root, "openrig-home");
  project = join(root, "project");
  pluginRoot = join(root, "plugin", "openrig-core");
  for (const script of SCRIPTS) {
    for (const dest of [managed(script), plugin(script)]) { mkdirSync(dirname(dest), { recursive: true }); copyFileSync(join(ASSETS, script), dest); }
  }
  mkdirSync(join(project, ".claude"), { recursive: true });
  arrivals = [];
  server = createServer((req, res) => {
    let data = "";
    req.on("data", (c) => { data += c; });
    req.on("end", () => {
      let body: Record<string, unknown> = {};
      try { body = JSON.parse(data) as Record<string, unknown>; } catch { /* not JSON */ }
      arrivals.push({ route: req.url ?? "", body });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(req.url === "/api/activity/question-wait" ? { ok: true, action: "none", why: "test" } : { ok: true }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(root, { recursive: true, force: true });
});

describe("workspaces-o9o.33: the activity relay runs once per hook when the openrig-core plugin is also loaded", () => {
  it.each(EVENTS)("RED: %s, run by both copies, reaches the daemon exactly as the managed copy alone does", async (event, payload) => {
    writeManagedSettings(EVENTS.map(([e]) => e));
    await runHook(managed("activity-relay.cjs"), payload, false);
    const alone = arrivals.map((a) => a.route + " " + String(a.body.hookEvent));
    expect(posts("/api/activity/hooks", event).length).toBeGreaterThan(0);
    arrivals.length = 0;
    await both("activity-relay.cjs", payload);
    expect(arrivals.map((a) => a.route + " " + String(a.body.hookEvent))).toEqual(alone);
  });

  it("RED: a socket-delivered prompt run by both copies is not blocked as a repeat", async () => {
    writeManagedSettings(EVENTS.map(([e]) => e));
    const prompt = `hello from a peer\n[openrig-msg msg-o9o33-0001:${"a1b2c3d4".repeat(4)}]`;
    const outputs = await both("activity-relay.cjs", { hook_event_name: "UserPromptSubmit", prompt });
    expect(outputs.join("")).not.toMatch(/"decision":"block"/);
  });

  it("RED: the question-wait hold is asked for once, not twice (two requests made one question two rows)", async () => {
    writeManagedSettings(EVENTS.map(([e]) => e));
    await both("question-wait.cjs", { hook_event_name: "PermissionRequest", tool_name: "AskUserQuestion", tool_input: { questions: QUESTIONS } });
    expect(posts("/api/activity/question-wait")).toHaveLength(1);
  });

  // workspaces-o9o.124: the real relay process, fed the captured Code Mode code output (UserPromptSubmit source poll_event), posts no hook
  // activity; the captured typed prompt from the same session is posted as before.
  it("Code Mode's captured code output posts no hook activity; the typed prompt beside it does", async () => {
    const { readFileSync } = await import("node:fs");
    const captured = JSON.parse(readFileSync(resolve(import.meta.dirname, "fixtures", "code-mode-user-prompt-submit.json"), "utf8")) as Record<string, Record<string, unknown>>;
    writeManagedSettings(EVENTS.map(([e]) => e));
    await runHook(managed("activity-relay.cjs"), captured.codeOutput!, false);
    expect(posts("/api/activity/hooks", "UserPromptSubmit")).toHaveLength(0);
    await runHook(managed("activity-relay.cjs"), captured.typedPrompt!, false);
    expect(posts("/api/activity/hooks", "UserPromptSubmit")).toHaveLength(1);
  });

  it("the plugin copy still relays where the project's settings carry no managed copy (OpenRig's hooks off): one post, not none", async () => {
    writeManagedSettings([]);
    await runHook(plugin("activity-relay.cjs"), { hook_event_name: "Stop" }, true);
    expect(posts("/api/activity/hooks", "Stop")).toHaveLength(1);
  });

  it("an event the managed copy does not carry (settings written before it existed) is relayed by the plugin copy, once", async () => {
    writeManagedSettings(["Stop", "UserPromptSubmit"]);    // no PreToolUse entry: settings from before workspaces-o9o.4
    // Claude Code runs only what is configured: the plugin's PreToolUse, and both copies' Stop.
    await runHook(plugin("activity-relay.cjs"), { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "toolu_bash_0003" }, true);
    await both("activity-relay.cjs", { hook_event_name: "Stop" });
    expect(posts("/api/activity/hooks", "PreToolUse").map((a) => a.body.toolCallId)).toEqual(["toolu_bash_0003"]);
    expect(posts("/api/activity/hooks", "Stop")).toHaveLength(1);
  });

  it("settings the plugin copy cannot read fail open: it relays (never zero copies)", async () => {
    writeFileSync(join(project, ".claude", "settings.local.json"), "{ not json");
    await runHook(plugin("activity-relay.cjs"), { hook_event_name: "Stop" }, true);
    expect(posts("/api/activity/hooks", "Stop")).toHaveLength(1);
  });

  it("a copy outside the plugin's root never steps aside, even with CLAUDE_PLUGIN_ROOT in its environment", async () => {
    writeManagedSettings(EVENTS.map(([e]) => e));
    await runHook(managed("activity-relay.cjs"), { hook_event_name: "Stop" }, true);
    expect(posts("/api/activity/hooks", "Stop")).toHaveLength(1);
  });

  // verify-qa FAIL of 711e9a16e: a settings command that merely MENTIONS the managed path, or names a managed file that is not there, made
  // the plugin copy step aside, and the event was lost. Claude Code runs the configured command; only a real invocation of a real file counts.
  /** Settings whose every event runs `command` (the managed relay's place, for PermissionRequest the question-wait's too). */
  const writeCommands = (relay: string, wait: string = relay) => {
    const hooks: Record<string, unknown[]> = {};
    for (const [event] of EVENTS) hooks[event] = event === "PermissionRequest"
      ? [{ matcher: "AskUserQuestion", hooks: [{ type: "command", command: relay }] }, { matcher: "AskUserQuestion", hooks: [{ type: "command", command: wait }] }]
      : [{ hooks: [{ type: "command", command: relay }] }];
    writeFileSync(join(project, ".claude", "settings.local.json"), JSON.stringify({ hooks }, null, 2));
  };

  it("RED (review): the managed file named in settings is missing: the plugin copy runs (the event is not lost)", async () => {
    writeManagedSettings(EVENTS.map(([e]) => e));
    unlinkSync(managed("activity-relay.cjs"));     // Claude Code runs `node '<managed>'`, which fails: only the plugin copy can relay
    await runHook(plugin("activity-relay.cjs"), { hook_event_name: "Stop" }, true);
    expect(posts("/api/activity/hooks", "Stop")).toHaveLength(1);
  });

  it("RED (review): a settings command that only mentions the managed path (a decoy echo) does not make the plugin copy step aside", async () => {
    writeCommands(`echo 'path mention only: ${managed("activity-relay.cjs")}'`, `echo 'path mention only: ${managed("question-wait.cjs")}'`);
    await runHook(plugin("activity-relay.cjs"), { hook_event_name: "Stop" }, true);
    await runHook(plugin("question-wait.cjs"), { hook_event_name: "PermissionRequest", tool_name: "AskUserQuestion", tool_input: { questions: QUESTIONS } }, true);
    expect(posts("/api/activity/hooks", "Stop")).toHaveLength(1);
    expect(posts("/api/activity/question-wait")).toHaveLength(1);
  });

  it("another program given the managed path (it reads the file, it does not run the relay) does not count", async () => {
    writeCommands(`cat '${managed("activity-relay.cjs")}'`);
    await runHook(plugin("activity-relay.cjs"), { hook_event_name: "Stop" }, true);
    expect(posts("/api/activity/hooks", "Stop")).toHaveLength(1);
  });

  it("node running some other readable script (not the managed relay) does not count", async () => {
    const other = join(project, "my-own-hook.cjs");
    writeFileSync(other, "process.exit(0);\n");
    writeCommands(`node '${other}'`);
    await runHook(plugin("activity-relay.cjs"), { hook_event_name: "Stop" }, true);
    expect(posts("/api/activity/hooks", "Stop")).toHaveLength(1);
  });

  it("the managed script run directly (no node in front) counts: the plugin copy steps aside", async () => {
    writeCommands(`'${managed("activity-relay.cjs")}'`);
    await runHook(plugin("activity-relay.cjs"), { hook_event_name: "Stop" }, true);
    expect(posts("/api/activity/hooks", "Stop")).toHaveLength(0);
  });

  // verify-qa FAIL of 317724c7a: run directly, a script must be executable, not just readable. question-wait.cjs ships 100644 and the adapter
  // keeps the source mode, so a direct `'<managed question-wait>'` command cannot run; the plugin copy must not step aside for it.
  it("RED (review): the managed question-wait named directly but shipped not executable (100644): the plugin copy still asks, once", async () => {
    expect(statSync(join(ASSETS, "question-wait.cjs")).mode & 0o111).toBe(0);   // as shipped
    chmodSync(managed("question-wait.cjs"), 0o644);
    writeCommands(`'${managed("activity-relay.cjs")}'`, `'${managed("question-wait.cjs")}'`);
    await runHook(plugin("question-wait.cjs"), { hook_event_name: "PermissionRequest", tool_name: "AskUserQuestion", tool_input: { questions: QUESTIONS } }, true);
    expect(posts("/api/activity/question-wait")).toHaveLength(1);
  });

  it("node in front of the same not-executable script counts: node only needs to read it", async () => {
    chmodSync(managed("question-wait.cjs"), 0o644);
    writeCommands(`node '${managed("activity-relay.cjs")}'`, `node '${managed("question-wait.cjs")}'`);
    await runHook(plugin("question-wait.cjs"), { hook_event_name: "PermissionRequest", tool_name: "AskUserQuestion", tool_input: { questions: QUESTIONS } }, true);
    expect(posts("/api/activity/question-wait")).toHaveLength(0);
  });

  it("node chained with another command (shell operators) is not a plain invocation: the plugin copy runs", async () => {
    writeCommands(`node '${managed("activity-relay.cjs")}' ; true`);
    await runHook(plugin("activity-relay.cjs"), { hook_event_name: "Stop" }, true);
    expect(posts("/api/activity/hooks", "Stop")).toHaveLength(1);
  });

  it("the managed copy always relays, whatever the plugin is doing", async () => {
    writeManagedSettings(EVENTS.map(([e]) => e));
    await runHook(managed("activity-relay.cjs"), { hook_event_name: "Stop" }, false);
    expect(posts("/api/activity/hooks", "Stop")).toHaveLength(1);
  });
});
