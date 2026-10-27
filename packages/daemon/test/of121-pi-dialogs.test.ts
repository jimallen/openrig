// OF-121: the Pi runner answers and surfaces extension dialogs the way the OMP runner does, hides nested tool calls
// the way the pda runner does, and does not read a retrying agent_end as the end of the run. Fakes only: the event
// shapes come from pi-coding-agent's rpc-types.d.ts (extension_ui_request, extension_ui_response) and
// agent-session.d.ts (agent_end.willRetry); nothing here is a recording of a real Pi session.

import { describe, it, expect } from "vitest";
import { RunnerCore, type RunnerIo } from "../src/adapters/pi-runner.js";
import type { PiRunnerState } from "../src/adapters/pi-runner-protocol.js";

const SESSION = "devpi-a@some-rig";

function pi(runtime: "pi" | "omp" = "pi") {
  const rpc: Record<string, unknown>[] = [];
  const lines: string[] = [];
  const activity: Record<string, unknown>[] = [];
  const sidecars: PiRunnerState[] = [];
  const io: RunnerIo = {
    sendRpc: (cmd) => { rpc.push(cmd); }, mirrorLine: (l) => { lines.push(l); }, mirrorAppend: () => undefined,
    postActivity: (p) => { activity.push(p); }, writeSidecar: (s) => { sidecars.push(s); },
    sessionFileExists: () => true, now: () => "2026-10-27T10:00:00Z",
  };
  const core = new RunnerCore(io, { sessionName: SESSION, nodeId: "node-1", generation: "g1", launchId: "l1" }, { runtime });
  core.start();
  core.handlePiLine(JSON.stringify({ type: "response", id: "pi-runner-get-state", data: { sessionFile: "/state/s.jsonl", sessionId: "s1" } }));
  rpc.length = 0; lines.length = 0; activity.length = 0; sidecars.length = 0;
  const feed = (...events: Record<string, unknown>[]) => { for (const e of events) core.handlePiLine(JSON.stringify(e)); };
  return { core, rpc, lines, activity, sidecars, feed };
}
const hooks = (a: Record<string, unknown>[]) => a.map(x => [x.hookEvent, x.subtype]);

describe("OF-121 Pi extension dialogs", () => {
  it.each(["select", "confirm", "input", "editor"])("a %s dialog is cancelled at once, shown to the operator, and keeps the seat in needs_input through the end of the turn", (method) => {
    const r = pi();
    r.feed({ type: "agent_start" }, { type: "extension_ui_request", id: `dlg-${method}`, method, title: "Allow?" });
    // Pi's dialog promise waits on pendingExtensionRequests until a response arrives (rpc-mode.js createDialogPromise).
    expect(r.rpc).toEqual([{ type: "extension_ui_response", id: `dlg-${method}`, cancelled: true }]);
    expect(r.lines.join("\n")).toMatch(/\[pi-runner\] Approval\/input requested; cancelled .* Operator action required/);
    expect(hooks(r.activity)).toEqual([["active", "agent_start"], ["Notification", "permission_prompt"]]);
    expect(r.activity.at(-1)).toMatchObject({ runtime: "pi", generation: "g1" });
    r.feed({ type: "agent_end", messages: [], willRetry: false });
    expect(hooks(r.activity).at(-1)).toEqual(["Notification", "permission_prompt"]);
    expect(r.activity.filter(a => a.hookEvent === "Stop")).toHaveLength(0);
    // The next turn starts clean: its end is a normal idle.
    r.feed({ type: "agent_start" }, { type: "agent_end", messages: [], willRetry: false });
    expect(hooks(r.activity).at(-1)).toEqual(["Stop", "agent_end"]);
  });

  it.each(["notify", "setStatus", "setWidget", "setTitle", "set_editor_text"])("fire-and-forget %s traffic is neither answered nor flagged", (method) => {
    const r = pi();
    r.feed({ type: "extension_ui_request", id: "u-1", method }, { type: "agent_end", messages: [], willRetry: false });
    expect(r.rpc.filter(c => c.type === "extension_ui_response")).toEqual([]);
    expect(r.lines.join("\n")).not.toContain("Operator action required");
    expect(hooks(r.activity)).toEqual([["Stop", "agent_end"]]);
  });

  it("a dialog without a string id cannot be answered but is still surfaced", () => {
    const r = pi();
    r.feed({ type: "extension_ui_request", method: "confirm" });
    expect(r.rpc).toEqual([]);
    expect(hooks(r.activity)).toEqual([["Notification", "permission_prompt"]]);
  });

  it("OMP's own reply is unchanged: it still cancels non-dialog traffic with an id and names omp-runner", () => {
    const r = pi("omp");
    r.feed({ type: "extension_ui_request", id: "w1", method: "setWidget" }, { type: "extension_ui_request", id: "c1", method: "confirm" });
    expect(r.rpc).toEqual([{ type: "extension_ui_response", id: "w1", cancelled: true }, { type: "extension_ui_response", id: "c1", cancelled: true }]);
    expect(r.lines.join("\n")).toContain("[omp-runner] Approval/input requested");
  });
});

describe("OF-121 Pi nested tool calls", () => {
  it("a nested call (parentToolCallId set) prints nothing and posts no activity; a top-level call still does", () => {
    const r = pi();
    r.feed({ type: "tool_execution_start", toolCallId: "n1", toolName: "read", args: {}, parentToolCallId: "p1" },
      { type: "tool_execution_end", toolCallId: "n1", toolName: "read", parentToolCallId: "p1", isError: true });
    expect(r.lines).toEqual([]);
    expect(r.activity).toEqual([]);
    r.feed({ type: "tool_execution_start", toolCallId: "p1", toolName: "task", args: {} },
      { type: "tool_execution_end", toolCallId: "p1", toolName: "task" });
    expect(r.lines).toEqual(["  ⚙ task …", "  ⚙ task done"]);
    expect(hooks(r.activity)).toEqual([["PreToolUse", "task"]]);
  });

  it("a null parentToolCallId is top-level", () => {
    const r = pi();
    r.feed({ type: "tool_execution_start", toolName: "bash", parentToolCallId: null });
    expect(r.lines).toEqual(["  ⚙ bash …"]);
  });
});

describe("OF-121 Pi agent_end willRetry", () => {
  it("a retrying agent_end is not a Stop: the seat stays streaming until the final agent_end", () => {
    const r = pi();
    r.feed({ type: "agent_start" }, { type: "agent_end", messages: [], willRetry: true });
    expect(hooks(r.activity)).toEqual([["active", "agent_start"]]);
    expect(r.sidecars.at(-1)!.busy).toBe(true);
    r.feed({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 2000 }, { type: "agent_start" },
      { type: "agent_end", messages: [], willRetry: false });
    expect(hooks(r.activity).filter(h => h[0] === "Stop")).toEqual([["Stop", "agent_end"]]);
    expect(r.sidecars.at(-1)!.busy).toBe(false);
  });

  it("/abort during the retry backoff ends the run: agent_settled posts the one Stop and clears busy", () => {
    // Pi: agent_end{willRetry:true}, then the backoff is cancelled -> auto_retry_end{success:false}, agent_settled{aborted:true};
    // no further agent_start or agent_end (agent-session.js _finishCancelledRetry, _emitAgentSettled).
    const r = pi();
    r.feed({ type: "agent_start" }, { type: "agent_end", messages: [], willRetry: true },
      { type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 2000 });
    expect(r.sidecars.at(-1)!.busy).toBe(true);
    r.feed({ type: "auto_retry_end", success: false, attempt: 1, finalError: "Retry cancelled" }, { type: "agent_settled", aborted: true });
    expect(r.activity.filter(a => a.hookEvent === "Stop")).toHaveLength(1);
    expect(hooks(r.activity).at(-1)).toEqual(["Stop", "agent_end"]);
    expect(r.sidecars.at(-1)!.busy).toBe(false);
  });

  it("a successful retry still gives exactly one Stop, and the trailing agent_settled adds none", () => {
    const r = pi();
    r.feed({ type: "agent_start" }, { type: "agent_end", messages: [], willRetry: true },
      { type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 2000 }, { type: "agent_start" },
      { type: "auto_retry_end", success: true, attempt: 1 }, { type: "agent_end", messages: [], willRetry: false },
      { type: "agent_settled", aborted: false });
    expect(r.activity.filter(a => a.hookEvent === "Stop")).toHaveLength(1);
    expect(r.sidecars.at(-1)!.busy).toBe(false);
  });

  it("retries exhausted: the final agent_end stops once; auto_retry_end{success:false} and agent_settled add no second Stop", () => {
    const r = pi();
    r.feed({ type: "agent_start" }, { type: "agent_end", messages: [], willRetry: false },
      { type: "auto_retry_end", success: false, attempt: 3, finalError: "overloaded" }, { type: "agent_settled", aborted: false });
    expect(r.activity.filter(a => a.hookEvent === "Stop")).toHaveLength(1);
  });

  it("an agent_settled on an idle seat posts nothing; OMP is untouched", () => {
    const r = pi();
    r.feed({ type: "agent_settled", aborted: false });
    expect(r.activity).toEqual([]);
    const o = pi("omp");
    o.feed({ type: "agent_start" }, { type: "agent_settled", aborted: true });
    expect(o.activity.filter(a => a.hookEvent === "Stop")).toHaveLength(0);
  });

  it("an agent_end without willRetry (older Pi) stops", () => {
    const r = pi();
    r.feed({ type: "agent_start" }, { type: "agent_end", messages: [] });
    expect(hooks(r.activity).at(-1)).toEqual(["Stop", "agent_end"]);
  });

  it("the get_entries cursor refresh still follows a retrying agent_end", () => {
    const r = pi();
    r.feed({ type: "agent_end", messages: [], willRetry: true });
    expect(r.rpc).toEqual([{ type: "get_entries", id: "pi-runner-cursor-refresh" }]);
  });
});
