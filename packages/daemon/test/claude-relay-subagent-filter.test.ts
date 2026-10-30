// Native comms step 2 (review F1): the activity relay drops a SUBAGENT's PostToolUse/PostToolUseFailure. Measured on
// Claude Code 2.1.314 in a scratch session: a subagent's tool hooks carry agent_id/agent_type and the main agent's carry
// neither, and a background subagent ran its tool while the main turn ran its own.
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const relay = require("../assets/plugins/openrig-core/hooks/scripts/activity-relay.cjs") as {
  buildOpenRigPayload: (provider: Record<string, unknown>, env: Record<string, string>, now?: () => Date) => { hookEvent: string } | null;
};
const ENV = { OPENRIG_SESSION_NAME: "dev-impl@my-rig", OPENRIG_RUNTIME: "claude-code" };

describe("the relay ignores a subagent's tool completions", () => {
  it.each(["PostToolUse", "PostToolUseFailure"])("a subagent's %s (agent_id set) is not relayed", (event) => {
    expect(relay.buildOpenRigPayload({ hook_event_name: event, tool_name: "Bash", agent_id: "a96a08682698934f9", agent_type: "general-purpose" }, ENV)).toBeNull();
  });

  it.each(["PostToolUse", "PostToolUseFailure"])("the main agent's %s (no agent_id) is relayed", (event) => {
    expect(relay.buildOpenRigPayload({ hook_event_name: event, tool_name: "Bash" }, ENV)?.hookEvent).toBe(event);
  });

  it("control: other events from a subagent context are relayed as before", () => {
    expect(relay.buildOpenRigPayload({ hook_event_name: "Notification", notification_type: "permission_prompt", agent_id: "a1" }, ENV)?.hookEvent).toBe("Notification");
  });
});
