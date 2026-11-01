// S2: every Codex resume settles the seat's seen store first. A seat restarted without it keeps a record of a prompt the conversation
// lost (s0 M5), and that message is refused for good. A resume typed before it would let the new process's hooks race the clear.
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { CodexResumeAdapter } from "../src/adapters/codex-resume.js";
import { CodexRuntimeAdapter } from "../src/adapters/codex-runtime-adapter.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";

const THREAD = "019d45bc-117d-78a3-a4ad-6fb186e5a86d";
const fsOps = { readFile: () => "", writeFile: () => {}, exists: () => false, mkdirp: () => {}, listFiles: () => [] };
const binding: NodeBinding = { id: "b1", nodeId: "n1", tmuxSession: "seat-1", tmuxWindow: null, tmuxPane: null, updatedAt: "", cwd: "/project" };

function world(reconcileThrows = false) {
  const order: string[] = [];
  const reconcileSeatGate = (seat: string, thread: string | null) => {
    order.push(`reconcile:${seat}:${thread}`);
    if (reconcileThrows) throw new Error("store unreadable");
  };
  const tmux = {
    sendShellCommand: async () => { order.push("typed"); return { ok: true as const }; },
    sendText: async () => { order.push("typed"); return { ok: true as const }; },
    sendKeys: async () => ({ ok: true as const }),
    getPaneCommand: async () => "codex",
    capturePaneContent: async () => "OpenAI Codex (v0.0.0)\n› Ask Codex to do anything",
    capturePaneScreen: async () => "› Ask Codex to do anything",
    getPanePid: async () => null,
    hasSession: async () => true,
  };
  return { order, reconcileSeatGate, tmux };
}

describe("every resume settles the seen store before it types", () => {
  it("launchHarness with a resume token", async () => {
    const w = world();
    const adapter = new CodexRuntimeAdapter({ tmux: w.tmux as never, fsOps: fsOps as never, sleep: async () => {}, reconcileSeatGate: w.reconcileSeatGate });
    await adapter.launchHarness(binding, { name: "dev@rig", resumeToken: THREAD });
    expect(w.order.slice(0, 2)).toEqual([`reconcile:seat-1:${THREAD}`, "typed"]);
  });

  it("a fresh launch settles too: the process before it may have died holding a recorded prompt, and a record names its own rollout", async () => {
    const w = world();
    const adapter = new CodexRuntimeAdapter({ tmux: w.tmux as never, fsOps: fsOps as never, sleep: async () => {}, listProcesses: () => [], reconcileSeatGate: w.reconcileSeatGate });
    await adapter.launchHarness(binding, { name: "dev@rig" });
    expect(w.order.slice(0, 2)).toEqual(["reconcile:seat-1:null", "typed"]);
  });

  it("sendResumeCommand, the restart in place", async () => {
    const w = world();
    const adapter = new CodexRuntimeAdapter({ tmux: w.tmux as never, fsOps: fsOps as never, sleep: async () => {}, reconcileSeatGate: w.reconcileSeatGate });
    await adapter.sendResumeCommand("seat-1", "codex resume x", THREAD);
    expect(w.order.slice(0, 2)).toEqual([`reconcile:seat-1:${THREAD}`, "typed"]);
  });

  it("CodexResumeAdapter.resume, the restore path", async () => {
    const w = world();
    const adapter = new CodexResumeAdapter(w.tmux as never, { settleMs: 0, sleep: async () => {}, reconcileSeatGate: w.reconcileSeatGate });
    await adapter.resume("seat-1", "codex_id", THREAD, "/project");
    expect(w.order.slice(0, 2)).toEqual([`reconcile:seat-1:${THREAD}`, "typed"]);
  });

  it("a store that cannot be settled does not stop the resume, on any path", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const a = world(true);
    await new CodexRuntimeAdapter({ tmux: a.tmux as never, fsOps: fsOps as never, sleep: async () => {}, reconcileSeatGate: a.reconcileSeatGate }).sendResumeCommand("seat-1", "codex resume x", THREAD);
    expect(a.order).toContain("typed");
    const b = world(true);
    await new CodexResumeAdapter(b.tmux as never, { settleMs: 0, sleep: async () => {}, reconcileSeatGate: b.reconcileSeatGate }).resume("seat-1", "codex_id", THREAD, "/project");
    expect(b.order).toContain("typed");
    quiet.mockRestore();
  });

  it("the daemon hands the reconcile to both adapters", () => {
    const startup = readFileSync(new URL("../src/startup.ts", import.meta.url), "utf8");
    expect(startup.match(/new Codex(Resume|Runtime)Adapter\([^\n]*reconcileSeatGate: reconcileCodexSeat/g)).toHaveLength(2);
  });
});
