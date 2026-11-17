// workspaces-o9o.37: PermissionRequest is relayed for EVERY tool (synchronous, it names the tool), so a plain permission prompt is tied to
// its own tool and cleared by that tool's end with no time window. Before, the relay ran for AskUserQuestion only, and a plain prompt (a
// Notification that names no tool) was cleared by any tool end stamped more than ASYNC_PROMPT_CLEAR_SLACK_MS after it.
//
// SAFETY (CoS, 2026-11-17): the every-tool group must NEVER answer a prompt. question-wait.cjs answers with `allow`, so it stays on its own
// AskUserQuestion group; the every-tool group runs the relay only, and the relay prints no decision for a PermissionRequest.
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deriveRelayEvents } from "../src/domain/claude-activity-hooks.js";
import { AgentActivityStore, ASYNC_PROMPT_CLEAR_SLACK_MS, pickLatestByOrdering } from "../src/domain/agent-activity-store.js";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import type { AgentActivity } from "../src/domain/types.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const MANIFEST = resolve(HERE, "../assets/plugins/openrig-core/hooks/claude.json");
const SCRIPTS = resolve(HERE, "../assets/plugins/openrig-core/hooks/scripts");
const realFs = { exists: (p: string) => existsSync(p), readFile: (p: string) => readFileSync(p, "utf-8") };
type Group = { matcher?: string; hooks: Array<{ type: string; command: string; timeout?: number; async?: boolean }> };
const permissionGroups = () => (JSON.parse(readFileSync(MANIFEST, "utf-8")) as { hooks: Record<string, Group[]> }).hooks["PermissionRequest"]!;
const RELAY = 'node "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/activity-relay.cjs"';
const QUESTION_WAIT = 'node "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/question-wait.cjs"';

describe("the manifest relays PermissionRequest for every tool", () => {
  it("two groups: question-wait alone on AskUserQuestion, and an unscoped group with the relay alone, synchronous", () => {
    expect(permissionGroups()).toEqual([
      { matcher: "AskUserQuestion", hooks: [{ type: "command", command: QUESTION_WAIT, timeout: 1500 }] },
      { hooks: [{ type: "command", command: RELAY, timeout: 5 }] },
    ]);
  });

  it("the derived relay entry is unscoped and synchronous; question-wait keeps the AskUserQuestion matcher", () => {
    expect(deriveRelayEvents(realFs, MANIFEST).filter((e) => e.event === "PermissionRequest")).toEqual([
      { event: "PermissionRequest", timeout: 5 },
      { event: "PermissionRequest", script: "question-wait.cjs", matcher: "AskUserQuestion", timeout: 1500 },
    ]);
  });
});

describe("the every-tool group can never approve a prompt", () => {
  it("every PermissionRequest group that is not AskUserQuestion's runs the relay and nothing else, and there is one", () => {
    const others = permissionGroups().filter((g) => g.matcher !== "AskUserQuestion");
    expect(others.length).toBeGreaterThan(0);
    for (const g of others) expect(g.hooks.map((h) => h.command)).toEqual([RELAY]);
    // question-wait (the only script here that prints `allow`) is derived with the AskUserQuestion matcher, never unscoped.
    for (const e of deriveRelayEvents(realFs, MANIFEST).filter((x) => x.script === "question-wait.cjs")) expect(e.matcher).toBe("AskUserQuestion");
  });

  it("the relay prints no decision for a plain tool's PermissionRequest", () => {
    const payload = JSON.stringify({ hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "rm -rf /tmp/x" }, session_id: "s" });
    const run = spawnSync(process.execPath, [resolve(SCRIPTS, "activity-relay.cjs")], {
      input: payload, encoding: "utf8", timeout: 20_000,
      // An endpoint nothing listens on: the relay reaches no daemon, as when one is down.
      env: { PATH: process.env.PATH, OPENRIG_URL: "http://127.0.0.1:9", OPENRIG_SESSION_NAME: "dev@rig", OPENRIG_ACTIVITY_HOOK_TOKEN: "t" },
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toBe("");
  });

  it("question-wait answers nothing for a plain tool, even with a daemon that would answer, and does not ask it", async () => {
    const qw = createRequire(import.meta.url)(resolve(SCRIPTS, "question-wait.cjs")) as {
      run: (p: unknown, env: Record<string, string>, deps: Record<string, unknown>) => Promise<unknown>;
    };
    let asked = 0;
    const fetch = async () => { asked++; return { ok: true, status: 200, json: async () => ({ ok: true, action: "answer", updatedInput: { a: 1 } }) }; };
    const out = await qw.run({ hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: {} },
      { OPENRIG_SESSION_NAME: "dev@rig", OPENRIG_URL: "http://127.0.0.1:1", OPENRIG_ACTIVITY_HOOK_TOKEN: "t" }, { fetch, sleep: async () => {} });
    expect(out).toBeNull();
    expect(asked).toBe(0);
  });
});

describe("a plain permission prompt is tied to its own tool (agent-activity-store)", () => {
  const T0 = Date.parse("2026-11-17T10:00:00.000Z");
  const at = (ms: number) => new Date(T0 + ms).toISOString();
  const row = (a: Partial<AgentActivity>) => ({ activity: a as AgentActivity });
  const prompt = (tool: string) => row({ rawEvent: "PermissionRequest", rawSubtype: tool, state: "needs_input", eventAt: at(0) });
  const end = (tool: string, ms: number) => row({ rawEvent: "PostToolUse", rawSubtype: tool, state: "running", eventAt: at(ms) });
  const latest = (rows: Array<ReturnType<typeof row>>) => pickLatestByOrdering(rows)?.activity;

  it("another tool's end stamped well after the prompt does not clear it", () => {
    expect(latest([end("Read", ASYNC_PROMPT_CLEAR_SLACK_MS + 1_000), prompt("Bash")])?.rawEvent).toBe("PermissionRequest");
  });

  it("the prompted tool's own end clears it at once, with no window", () => {
    expect(latest([end("Bash", 300), prompt("Bash")])?.rawEvent).toBe("PostToolUse");
  });

  it("a Notification/permission_prompt that inherited the tool (promptTool) is cleared only by that tool's end", () => {
    const note = row({ rawEvent: "Notification", rawSubtype: "permission_prompt", state: "needs_input", eventAt: at(0), promptTool: "Bash" });
    expect(latest([end("Read", ASYNC_PROMPT_CLEAR_SLACK_MS + 1_000), note])?.rawEvent).toBe("Notification");
    expect(latest([end("Bash", 300), note])?.rawEvent).toBe("PostToolUse");
  });

  it("fallback: a Notification-only prompt (a seat on the old hooks) keeps the window rule", () => {
    const note = row({ rawEvent: "Notification", rawSubtype: "permission_prompt", state: "needs_input", eventAt: at(0) });
    expect(latest([end("Read", 300), note])?.rawEvent).toBe("Notification");
    expect(latest([end("Read", ASYNC_PROMPT_CLEAR_SLACK_MS + 1_000), note])?.rawEvent).toBe("PostToolUse");
  });
});

describe("the store gives a plain prompt's Notification the tool its PermissionRequest named", () => {
  const NOW = new Date("2026-11-17T10:00:05.000Z");
  const setup = () => {
    const db = createFullTestDb();
    const rig = new RigRepository(db).createRig("r");
    const node = new RigRepository(db).addNode(rig.id, "dev.impl", { runtime: "claude-code" });
    const reg = new SessionRegistry(db);
    reg.updateStatus(reg.registerSession(node.id, "dev-impl@r").id, "running");
    const store = new AgentActivityStore({ db, eventBus: new EventBus(db), now: () => NOW });
    const hook = (hookEvent: string, subtype?: string, at = "2026-11-17T10:00:00.000Z") =>
      store.recordHookEvent({ runtime: "claude-code", sessionName: "dev-impl@r", hookEvent, ...(subtype ? { subtype } : {}), occurredAt: at });
    return { db, hook };
  };

  it("a Notification/permission_prompt after a plain PermissionRequest carries its tool", () => {
    const { db, hook } = setup();
    hook("PermissionRequest", "Bash");
    const note = hook("Notification", "permission_prompt", "2026-11-17T10:00:01.000Z");
    expect(note.ok && note.activity.promptTool).toBe("Bash");
    db.close();
  });

  it("a Notification with no PermissionRequest before it (a seat on the older relay) carries none", () => {
    const { db, hook } = setup();
    hook("UserPromptSubmit");
    const note = hook("Notification", "permission_prompt", "2026-11-17T10:00:01.000Z");
    expect(note.ok && note.activity.promptTool).toBeUndefined();
    db.close();
  });

  it("an AskUserQuestion dialog's Notification stays a question and carries no promptTool", () => {
    const { db, hook } = setup();
    hook("PermissionRequest", "AskUserQuestion");
    const note = hook("Notification", "permission_prompt", "2026-11-17T10:00:01.000Z");
    expect(note.ok && note.activity.dialog).toBe("question");
    expect(note.ok && note.activity.promptTool).toBeUndefined();
    db.close();
  });
});
