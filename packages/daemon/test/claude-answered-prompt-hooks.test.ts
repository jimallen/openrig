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
import { hookEventState, latestHookMovedOn, pickLatestByOrdering } from "../src/domain/agent-activity-store.js";
import type { AgentActivity } from "../src/domain/types.js";

const MANIFEST = resolve(fileURLToPath(new URL(".", import.meta.url)), "../assets/plugins/openrig-core/hooks/claude.json");
const realFs = { exists: (p: string) => existsSync(p), readFile: (p: string) => readFileSync(p, "utf-8") };

describe("the shipped Claude hooks manifest relays the events that follow an answered prompt", () => {
  it("derives PostToolUse and PostToolUseFailure as relay events, beside the existing ones", () => {
    const events = deriveRelayEvents(realFs, MANIFEST).map((e) => e.event);
    expect(events).toEqual(["SessionStart", "UserPromptSubmit", "Stop", "PostToolUse", "PostToolUseFailure", "Notification"]);
  });

  it("only the two new events run in the background (async), so a tool call never waits on the relay", () => {
    const events = deriveRelayEvents(realFs, MANIFEST);
    expect(events.filter((e) => e.async).map((e) => e.event)).toEqual(["PostToolUse", "PostToolUseFailure"]);
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
  ])("%s", (_label, rows, expected) => {
    const iso = (r: { activity: { rawEvent: string; eventAt: string } }) => ({ activity: { ...r.activity, eventAt: `2026-10-26${r.activity.eventAt}` } });
    const got = pickLatestByOrdering(rows.map(iso));
    const label = expected.includes("@") ? `${got?.activity?.rawEvent}@${got?.activity?.eventAt?.slice(17, 19)}` : got?.activity?.rawEvent;
    expect(label).toBe(expected);
  });
});
