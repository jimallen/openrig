// Native comms step 2 (design-native-comms-20261030 §7 F1): after a permission prompt is answered YES, Claude Code
// fires PostToolUse (then Stop), measured on 2.1.314 in scratch sessions. Delivering PostToolUse (and
// PostToolUseFailure) to the daemon lets the send guard and the wake ladder see the seat move on instead of holding it
// at the prompt until the turn's Stop (8 laptop refusals sat on one permission_prompt whose next hook was a Stop 80
// minutes later). A DENIED prompt fires no hook at all on 2.1.314; that gap is not closed here.
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deriveRelayEvents } from "../src/domain/claude-activity-hooks.js";
import { ASYNC_PROMPT_CLEAR_SLACK_MS, hookEventState, latestHookMovedOn, pickLatestByOrdering } from "../src/domain/agent-activity-store.js";
import type { AgentActivity } from "../src/domain/types.js";

const MANIFEST = resolve(fileURLToPath(new URL(".", import.meta.url)), "../assets/plugins/openrig-core/hooks/claude.json");
const realFs = { exists: (p: string) => existsSync(p), readFile: (p: string) => readFileSync(p, "utf-8") };

describe("the shipped Claude hooks manifest relays the events that follow an answered prompt", () => {
  it("derives PostToolUse and PostToolUseFailure as relay events, beside the existing ones", () => {
    const events = deriveRelayEvents(realFs, MANIFEST).map((e) => e.event);
    // OF-278 adds PermissionRequest (scoped to AskUserQuestion): the relay's entry and the question-wait hook's, in the one group.
    // workspaces-o9o.4 adds PreToolUse, so a tool call's start is recorded too.
    expect(events).toEqual(["SessionStart", "UserPromptSubmit", "Stop", "PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionRequest", "PermissionRequest", "Notification"]);
  });

  it("only the tool-call events run in the background (async), so a tool call never waits on the relay", () => {
    const events = deriveRelayEvents(realFs, MANIFEST);
    expect(events.filter((e) => e.async).map((e) => e.event)).toEqual(["PreToolUse", "PostToolUse", "PostToolUseFailure"]);
  });

  // workspaces-o9o.4. Measured on Claude Code 2.1.325 (bead note): an async PreToolUse hook does not hold the tool (a 4 s hook, the tool
  // ran 0.69 s after the hook began), and the real relay costs a median 26 ms vs 21 ms with no hook (73 ms when synchronous).
  it("PreToolUse: one unscoped relay group, async, with the relay's 5 s timeout, beside the rig-body guard's Bash group", () => {
    const hooks = (JSON.parse(readFileSync(MANIFEST, "utf-8")) as { hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string; timeout?: number; async?: boolean }> }>> }).hooks;
    const relayGroups = hooks["PreToolUse"]!.filter((g) => g.hooks.some((h) => h.command.includes("activity-relay.cjs")));
    expect(relayGroups).toEqual([{ hooks: [{ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/activity-relay.cjs"', timeout: 5, async: true }] }]);
    expect(hooks["PreToolUse"]!.find((g) => g.matcher === "Bash")!.hooks.map((h) => h.command)).toEqual(['node "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/rig-body-guard.cjs"']);
    expect(deriveRelayEvents(realFs, MANIFEST).filter((e) => e.event === "PreToolUse")).toEqual([{ event: "PreToolUse", timeout: 5, async: true }]);
  });

  it("each new event runs only the activity relay, async, with the relay's 5 s timeout", () => {
    const hooks = (JSON.parse(readFileSync(MANIFEST, "utf-8")) as { hooks: Record<string, Array<{ hooks: Array<{ command: string; timeout?: number; async?: boolean }> }>> }).hooks;
    for (const event of ["PostToolUse", "PostToolUseFailure"]) {
      const commands = hooks[event]!.flatMap((g) => g.hooks);
      expect(commands).toEqual([{ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/activity-relay.cjs"', timeout: 5, async: true }]);
    }
  });
});

describe("PostToolUse and PostToolUseFailure mean the agent is running", () => {
  it.each(["PostToolUse", "PostToolUseFailure"])("%s → running", (event) => {
    expect(hookEventState(event, "Bash", "claude-code")).toBe("running");
  });

  it("control: an event the daemon does not map stays unknown", () => {
    expect(hookEventState("PermissionDenied", "Bash", "claude-code")).toBe("unknown");
  });

  it("a PostToolUse after the prompt counts as moving on for the wake ladder", () => {
    const promptAt = "2026-10-26T23:38:52.795Z";
    const post: AgentActivity = {
      state: "running", reason: "bash", evidenceSource: "runtime_hook", sampledAt: "2026-10-26T23:39:05.000Z",
      evidence: "Bash", eventAt: "2026-10-26T23:39:05.000Z", rawEvent: "PostToolUse", rawSubtype: "Bash",
    } as AgentActivity;
    expect(latestHookMovedOn(post, promptAt, "claude-code")).toBe(true);
    // the same event dated before the prompt says nothing about the prompt
    expect(latestHookMovedOn({ ...post, eventAt: "2026-10-26T23:38:00.000Z" }, promptAt, "claude-code")).toBe(false);
  });
});

// workspaces-o9o.4, verify-qa F3: against a prompt that waits on a person, an async tool event must also be allowed to clear it.
describe("pickLatestByOrdering: what may clear a waiting prompt (workspaces-o9o.4 F3)", () => {
  const at = (s: number) => new Date(Date.UTC(2026, 9, 26, 0, 0, 0) + s).toISOString();
  const prompt = { activity: { rawEvent: "Notification", rawSubtype: "permission_prompt", state: "needs_input" as const, eventAt: at(30_000) } };
  const question = { activity: { rawEvent: "PermissionRequest", rawSubtype: "AskUserQuestion", state: "needs_input" as const, dialog: "question" as const, eventAt: at(30_000) } };
  const tool = (rawEvent: string, rawSubtype: string, ms: number, toolCallId?: string) =>
    ({ activity: { rawEvent, rawSubtype, state: "running" as const, eventAt: at(ms), ...(toolCallId ? { toolCallId } : {}) } });
  const turnStart = (ms: number) => ({ activity: { rawEvent: "UserPromptSubmit", state: "running" as const, eventAt: at(ms) } });
  const pick = (...rows: Array<{ activity: Record<string, unknown> }>) => pickLatestByOrdering(rows as never) as { activity: { rawEvent: string; rawSubtype: string } } | null;

  it.each([
    ["a tool start stamped after a permission prompt never clears it", [tool("PreToolUse", "Bash", 90_000), prompt], "Notification"],
    ["a tool start stamped after a question never clears it", [tool("PreToolUse", "Bash", 90_000), question], "PermissionRequest"],
    ["another call's end, however late, never clears a question", [tool("PostToolUse", "Read", 600_000), question], "PermissionRequest"],
    ["the question's own end clears it", [tool("PostToolUse", "AskUserQuestion", 60_000), question], "PostToolUse"],
    ["a failed end of the question's own tool clears it", [tool("PostToolUseFailure", "AskUserQuestion", 60_000), question], "PostToolUseFailure"],
    ["a tool end stamped exactly 2 s after a permission prompt does not clear it", [tool("PostToolUse", "Read", 32_000), prompt], "Notification"],
    ["a tool end stamped 2 s + 1 ms after it does", [tool("PostToolUse", "Read", 32_001), prompt], "PostToolUse"],
    ["once the question is answered, a later start is the latest", [tool("PreToolUse", "Bash", 70_000), tool("PostToolUse", "AskUserQuestion", 60_000), question], "PreToolUse"],
    // With call ids (the relay since workspaces-o9o.4): the end must name an AskUserQuestion call this turn started, and none may stay open.
    ["with ids: the end of the turn's own question clears it",
      [tool("PostToolUse", "AskUserQuestion", 60_000, "toolu_q"), question, tool("PreToolUse", "AskUserQuestion", 29_990, "toolu_q"), turnStart(0)], "PostToolUse"],
    ["with ids: a late end of an earlier turn's question does not clear the new one",
      [tool("PostToolUse", "AskUserQuestion", 60_000, "toolu_old"), question, tool("PreToolUse", "AskUserQuestion", 29_990, "toolu_new"), turnStart(0),
        tool("PreToolUse", "AskUserQuestion", -60_000, "toolu_old")], "PermissionRequest"],
    ["with ids: an end whose call this turn never started does not clear it", [tool("PostToolUse", "AskUserQuestion", 60_000, "toolu_q"), question, turnStart(0)], "PermissionRequest"],
  ])("%s", (_label, rows, expected) => {
    expect(pick(...(rows as Array<{ activity: Record<string, unknown> }>))?.activity.rawEvent).toBe(expected);
  });

  it("the window is the measured-bound constant", () => {
    expect(ASYNC_PROMPT_CLEAR_SLACK_MS).toBe(2_000);
  });
});

// Step-2 review F1: async events are ordered by their own eventAt against the newest synchronous hook, not by arrival.
describe("pickLatestByOrdering: the latest hook when async events can arrive late", () => {
  const row = (rawEvent: string, eventAt: string) => ({ activity: { rawEvent, eventAt } });
  it.each([
    ["an async PostToolUse that happened BEFORE the newer prompt loses", [row("PostToolUse", "T00:00:26Z"), row("Notification", "T00:00:30Z")], "Notification"],
    ["an async PostToolUse that happened AFTER the prompt wins", [row("PostToolUse", "T00:00:40Z"), row("Notification", "T00:00:30Z")], "PostToolUse"],
    ["a tie keeps the synchronous hook", [row("PostToolUse", "T00:00:30Z"), row("Notification", "T00:00:30Z")], "Notification"],
    ["a synchronous newest row stays newest whatever its time", [row("Stop", "T00:00:20Z"), row("PostToolUse", "T00:00:50Z")], "Stop"],
    ["the newest of several late async rows that beat the base wins", [row("PostToolUse", "T00:00:35Z"), row("PostToolUseFailure", "T00:00:45Z"), row("Notification", "T00:00:30Z")], "PostToolUseFailure"],
    ["only async rows: the newest eventAt", [row("PostToolUse", "T00:00:35Z"), row("PostToolUse", "T00:00:45Z")], "PostToolUse@45"],
    // workspaces-o9o.4: PreToolUse is relayed async too.
    ["an async PreToolUse that happened BEFORE the newer prompt loses", [row("PreToolUse", "T00:00:26Z"), row("Notification", "T00:00:30Z")], "Notification"],
    ["an async PreToolUse that happened AFTER the prompt wins", [row("PreToolUse", "T00:00:40Z"), row("Notification", "T00:00:30Z")], "PreToolUse"],
    ["a tool's start then its end: the end is newest", [row("PostToolUse", "T00:00:41Z"), row("PreToolUse", "T00:00:40Z"), row("UserPromptSubmit", "T00:00:30Z")], "PostToolUse"],
    ["the next call's start, dated after the previous end that arrived later: the start is newest by its time", [row("PostToolUse", "T00:00:41Z"), row("PreToolUse", "T00:00:42Z"), row("UserPromptSubmit", "T00:00:30Z")], "PreToolUse"],
  ])("%s", (_label, rows, expected) => {
    const iso = (r: { activity: { rawEvent: string; eventAt: string } }) => ({ activity: { ...r.activity, eventAt: `2026-10-26${r.activity.eventAt}` } });
    const got = pickLatestByOrdering(rows.map(iso));
    const label = expected.includes("@") ? `${got?.activity?.rawEvent}@${got?.activity?.eventAt?.slice(17, 19)}` : got?.activity?.rawEvent;
    expect(label).toBe(expected);
  });
});
