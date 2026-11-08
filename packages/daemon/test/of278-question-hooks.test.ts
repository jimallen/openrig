import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ClaudeCodeAdapter, type ClaudeAdapterFsOps } from "../src/adapters/claude-code-adapter.js";
import { shellQuote } from "../src/adapters/shell-quote.js";
import { deriveRelayEvents } from "../src/domain/claude-activity-hooks.js";
import { QUESTION_HOOK_TIMEOUT_SECONDS } from "../src/domain/seat-question-policy.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";
import type { ProjectionPlan, ProjectionEntry } from "../src/domain/projection-planner.js";

// OF-278: the seat-side half. Claude Code runs a PermissionRequest hook for the AskUserQuestion dialog while the dialog is open
// (measured on 2.1.319); the daemon decides, this script enacts, and anything but an answer leaves the dialog to the human.
const ASSETS = resolve(import.meta.dirname, "../assets/plugins/openrig-core/hooks");
const require_ = createRequire(import.meta.url);
type Deps = { fetch?: typeof fetch; sleep?: (ms: number) => Promise<void>; now?: () => number; requestId?: string };
const hook = require_(resolve(ASSETS, "scripts/question-wait.cjs")) as {
  run: (payload: unknown, env: Record<string, string>, deps: Deps) => Promise<unknown>; HOOK_TIMEOUT_SECONDS: number;
};

const QUESTION = { questions: [{ question: "Which target?", header: "T", multiSelect: false, options: [{ label: "Staging (Recommended)" }, { label: "Production" }] }] };
const PAYLOAD = { hook_event_name: "PermissionRequest", tool_name: "AskUserQuestion", tool_input: QUESTION };
const ENV = { OPENRIG_SESSION_NAME: "dev-impl@qrig", OPENRIG_NODE_ID: "node-1", OPENRIG_RUNTIME: "claude-code", OPENRIG_URL: "http://127.0.0.1:1", OPENRIG_ACTIVITY_HOOK_TOKEN: "tok", OPENRIG_OCCUPANT_GENERATION: "gen-1" };

type Seen = Array<{ url: string; body: Record<string, unknown>; auth: string }>;
function fakeFetch(replies: Array<unknown | Error>, seen: Seen = []) {
  let i = 0;
  const fetchImpl = async (url: string, init: { body: string; headers: Record<string, string> }) => {
    seen.push({ url, body: JSON.parse(init.body), auth: init.headers["authorization"]! });
    const next = replies[Math.min(i++, replies.length - 1)];
    if (next instanceof Error) throw next;
    return { ok: true, json: async () => next };
  };
  return { fetchImpl: fetchImpl as unknown as typeof fetch, seen };
}
const instant = { sleep: async () => {} };

describe("question-wait.cjs", () => {
  it("prints the allow decision with the daemon's answers when the daemon sends an answer", async () => {
    const updatedInput = { ...QUESTION, answers: { "Which target?": "Staging (Recommended)" } };
    const { fetchImpl, seen } = fakeFetch([{ ok: true, action: "answer", updatedInput }]);
    const decision = await hook.run(PAYLOAD, ENV, { fetch: fetchImpl, ...instant, requestId: "req-00000001" });
    expect(decision).toEqual({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow", updatedInput } } });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("http://127.0.0.1:1/api/activity/question-wait");
    expect(seen[0]!.auth).toBe("Bearer tok");
    expect(seen[0]!.body).toMatchObject({ requestId: "req-00000001", sessionName: "dev-impl@qrig", nodeId: "node-1", generation: "gen-1", toolInput: QUESTION });
  });

  it.each([
    ["the daemon says none", { ok: true, action: "none", why: "x" }],
    ["the human answered (none)", { ok: true, action: "none", why: "the question is answered_human" }],
  ])("prints nothing and stops when %s", async (_n, reply) => {
    const { fetchImpl, seen } = fakeFetch([reply]);
    expect(await hook.run(PAYLOAD, ENV, { fetch: fetchImpl, ...instant })).toBeNull();
    expect(seen).toHaveLength(1);
  });

  it("asks again at once after a wait, and again after a failure, always under the one request id and the one start time", async () => {
    const seen: Seen = [];
    const updatedInput = { ...QUESTION, answers: { "Which target?": "Staging (Recommended)" } };
    const { fetchImpl } = fakeFetch([{ ok: true, action: "wait" }, new Error("ECONNREFUSED"), new Error("ECONNREFUSED"), { ok: false }, { ok: true, action: "wait" }, { ok: true, action: "answer", updatedInput }], seen);
    let slept = 0; let t = 5_000_000;
    const decision = await hook.run(PAYLOAD, ENV, { fetch: fetchImpl, sleep: async (ms: number) => { slept += ms; t += ms; }, now: () => t });
    expect(decision).not.toBeNull();
    expect(seen).toHaveLength(6);
    expect(new Set(seen.map((s) => s.body["requestId"])).size).toBe(1);
    expect(new Set(seen.map((s) => s.body["askedAtMs"]))).toEqual(new Set([5_000_000]));
    expect(slept).toBe(3 * 5000);   // a failure waits 5 s; a "wait" reply does not
  });

  it("gives up, printing nothing, when the daemon never comes back within the hook's own timeout", async () => {
    const { fetchImpl } = fakeFetch([new Error("ECONNREFUSED")]);
    let t = 0; let reads = 0;
    // a hook that stopped pausing between failures would spin without the clock moving: the guard turns that into a failure, not a hang
    const now = () => { if (++reads > 5000) throw new Error("runaway: the clock is not moving"); return t; };
    const decision = await hook.run(PAYLOAD, ENV, { fetch: fetchImpl, sleep: async (ms: number) => { t += ms; }, now });
    expect(decision).toBeNull();
    expect(t).toBeGreaterThanOrEqual(hook.HOOK_TIMEOUT_SECONDS * 1000);
  });

  it("does nothing for another tool's permission request, or a seat with no identity", async () => {
    const { fetchImpl, seen } = fakeFetch([{ ok: true, action: "answer", updatedInput: {} }]);
    expect(await hook.run({ ...PAYLOAD, tool_name: "Bash" }, ENV, { fetch: fetchImpl, ...instant })).toBeNull();
    expect(await hook.run(PAYLOAD, { OPENRIG_URL: "http://127.0.0.1:1", OPENRIG_ACTIVITY_HOOK_TOKEN: "tok" }, { fetch: fetchImpl, ...instant })).toBeNull();
    expect(seen).toHaveLength(0);
  });

  it("ignores an answer that is not an object (a broken daemon answers nothing)", async () => {
    const { fetchImpl } = fakeFetch([{ ok: true, action: "answer", updatedInput: "yes" }, { ok: true, action: "none" }]);
    expect(await hook.run(PAYLOAD, ENV, { fetch: fetchImpl, ...instant })).toBeNull();
  });
});

describe("the shipped manifest", () => {
  const manifestPath = resolve(ASSETS, "claude.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const fsRead = { exists: () => true, readFile: () => readFileSync(manifestPath, "utf8") };

  it("relays PermissionRequest for AskUserQuestion only, with the question-wait hook beside it, and not PreToolUse", () => {
    const groups = manifest.hooks.PermissionRequest as Array<{ matcher?: string; hooks: Array<{ command: string; timeout: number }> }>;
    expect(groups).toHaveLength(1);
    expect(groups[0]!.matcher).toBe("AskUserQuestion");
    expect(groups[0]!.hooks.map((h) => h.command.match(/scripts\/([a-z-]+\.cjs)/)![1])).toEqual(["activity-relay.cjs", "question-wait.cjs"]);
    expect(JSON.stringify(manifest.hooks.PreToolUse)).not.toContain("activity-relay");
  });

  it("gives the question-wait hook a timeout that outlives the longest wait, the same number the script and the policy hold", () => {
    const wait = manifest.hooks.PermissionRequest[0].hooks[1];
    expect(wait.timeout).toBe(QUESTION_HOOK_TIMEOUT_SECONDS);
    expect(hook.HOOK_TIMEOUT_SECONDS).toBe(QUESTION_HOOK_TIMEOUT_SECONDS);
    expect(QUESTION_HOOK_TIMEOUT_SECONDS).toBeGreaterThan(60 * 60);
  });

  it("derives a scoped relay entry and a question-wait entry for PermissionRequest, and no new unscoped event", () => {
    const events = deriveRelayEvents(fsRead, manifestPath);
    expect(events.filter((e) => e.event === "PermissionRequest")).toEqual([
      { event: "PermissionRequest", matcher: "AskUserQuestion", timeout: 5 },
      { event: "PermissionRequest", script: "question-wait.cjs", matcher: "AskUserQuestion", timeout: QUESTION_HOOK_TIMEOUT_SECONDS },
    ]);
    expect(events.filter((e) => e.matcher === undefined).map((e) => e.event)).toEqual(["SessionStart", "UserPromptSubmit", "Stop", "PostToolUse", "PostToolUseFailure", "Notification"]);
  });
});

describe("delivery into a seat's settings.local.json", () => {
  const manifestPath = resolve(ASSETS, "claude.json");
  const MANIFEST = readFileSync(manifestPath, "utf8");
  const STATE = "/state/inst";
  const SRC_DIR = "/assets/hooks/scripts";
  const SETTINGS = "/project/.claude/settings.local.json";
  const relayDest = `${STATE}/state/claude-activity-hooks/activity-relay.cjs`;
  const waitDest = `${STATE}/state/claude-activity-hooks/question-wait.cjs`;

  function setup(withCompanion: boolean, seeded?: string) {
    const store: Record<string, string> = { [`${SRC_DIR}/activity-relay.cjs`]: "// relay", "/assets/claude.json": MANIFEST, ...(withCompanion ? { [`${SRC_DIR}/question-wait.cjs`]: "// wait" } : {}), ...(seeded ? { [SETTINGS]: seeded } : {}) };
    const fs = {
      readFile: (p: string) => { if (p in store) return store[p]!; throw new Error(`Not found: ${p}`); }, writeFile: (p: string, c: string) => { store[p] = c; },
      exists: (p: string) => p in store, mkdirp: () => {}, copyFile: (s: string, d: string) => { store[d] = store[s] ?? ""; },
      listFiles: () => [], statMode: () => 0o755, chmod: () => {}, homedir: "/home/test",
    } as unknown as ClaudeAdapterFsOps;
    const tmux = { sessionExists: async () => true, sendKeys: async () => {}, capturePaneContent: async () => "", getPaneCommand: async () => "", listSessions: async () => [], runCommandInSession: async () => ({ stdout: "", stderr: "", exitCode: 0 }), setEnvVar: async () => {} };
    const adapter = new ClaudeCodeAdapter({ tmux, fsOps: fs, stateDir: STATE, activityRelayPath: `${SRC_DIR}/activity-relay.cjs`, claudeHooksManifestPath: "/assets/claude.json" } as unknown as ConstructorParameters<typeof ClaudeCodeAdapter>[0]);
    return { store, adapter };
  }
  const binding = { id: "b1", nodeId: "n1", tmuxSession: "t", tmuxWindow: null, tmuxPane: null, updatedAt: "", cwd: "/project" } as NodeBinding;
  const entry: ProjectionEntry = { category: "runtime_resource", effectiveId: "claude-activity-hooks", sourceSpec: "shared", sourcePath: "shared/activity", resourcePath: "activity", absolutePath: `${SRC_DIR}/activity-relay.cjs`, resourceType: "claude_activity_hooks", classification: "safe_projection" };
  const plan = (entries: ProjectionEntry[]) => ({ runtime: "claude-code", cwd: "/project", entries, startup: {} as ProjectionPlan["startup"], conflicts: [], noOps: [], diagnostics: [] }) as ProjectionPlan;

  it("writes PermissionRequest as two groups scoped to AskUserQuestion, and delivers both scripts side by side", async () => {
    const { store, adapter } = setup(true);
    await adapter.project(plan([entry]), binding);
    const settings = JSON.parse(store[SETTINGS]!);
    expect(settings.hooks.PermissionRequest).toEqual([
      { matcher: "AskUserQuestion", hooks: [{ type: "command", command: `node ${shellQuote(relayDest)}`, timeout: 5 }] },
      { matcher: "AskUserQuestion", hooks: [{ type: "command", command: `node ${shellQuote(waitDest)}`, timeout: QUESTION_HOOK_TIMEOUT_SECONDS }] },
    ]);
    expect(store[relayDest]).toBe("// relay");
    expect(store[waitDest]).toBe("// wait");
    // the unscoped events keep their single unscoped group, as before
    expect(settings.hooks.Stop).toEqual([{ hooks: [{ type: "command", command: `node ${shellQuote(relayDest)}`, timeout: 5 }] }]);
  });

  it("leaves the question-wait entry out when its script is not beside the relay: no dangling command", async () => {
    const { store, adapter } = setup(false);
    await adapter.project(plan([entry]), binding);
    const settings = JSON.parse(store[SETTINGS]!);
    expect(settings.hooks.PermissionRequest).toEqual([{ matcher: "AskUserQuestion", hooks: [{ type: "command", command: `node ${shellQuote(relayDest)}`, timeout: 5 }] }]);
    expect(waitDest in store).toBe(false);
  });

  it("delivering twice does not duplicate, and removing the resource strips both owned scripts and nothing else", async () => {
    const user = { type: "command", command: "echo mine" };
    const { store, adapter } = setup(true, JSON.stringify({ hooks: { PermissionRequest: [{ matcher: "Bash", hooks: [user] }] } }));
    await adapter.project(plan([entry]), binding);
    await adapter.project(plan([entry]), binding);
    const twice = JSON.parse(store[SETTINGS]!);
    expect(twice.hooks.PermissionRequest).toHaveLength(3);          // the user's, the relay's, the question-wait's
    await adapter.project(plan([]), binding);
    expect(JSON.parse(store[SETTINGS]!).hooks).toEqual({ PermissionRequest: [{ matcher: "Bash", hooks: [user] }] });
  });
});
