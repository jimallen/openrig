// OF-35 — observed live 2026-10-20 just after bc23cdf5 was deployed: the Chief of Staff seat exec.cos
// (Claude launched with --remote-control) read agentActivity {state: "unknown"} in `rig ps` while exec.em
// read idle, so a seat with a live background shell never read running.
//
// Root cause (measured, see the bead): the footer's update notice ("✔ Update installed · Restart to
// apply") fills the terminal width, so Claude wraps its right-aligned remote-control indicator `/rc` onto
// a line of its OWN below the mode footer. classifyPaneActivity anchors the composer on the LAST non-blank
// line being the mode footer, so `/rc` was read as the footer: no composer, no signal -> unknown. The
// store's idle hook had meanwhile aged out (the last hook was 14 minutes old, window 5 minutes), so no
// other rung covered for the pane read. exec.em had a fresh hook and no `/rc`, hence idle.
//
// The pane tails below are the verbatim last lines of the coordinator's read-only tmux capture-pane of
// exec.cos and exec.em at 2026-10-20T07:52Z (test/fixtures/of35-*-pane-tail.txt).

import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { attachAgentActivity, attachTerminalActivityAndWork } from "../src/domain/node-inventory.js";
import { CLAUDE_ACTIVITY_RUNG_INVENTORY } from "../src/domain/activity-taxonomy.js";
import { SeatActivityService } from "../src/domain/seat-activity-service.js";
import { SeatStructuralActivityService } from "../src/domain/seat-structural-activity-service.js";
import { classifyPaneActivity, detectBackgroundJobs } from "../src/domain/session-transport.js";
import type { AgentActivity } from "../src/domain/types.js";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const COS_TAIL = fixture("of35-exec-cos-pane-tail.txt");
const EM_TAIL = fixture("of35-exec-em-pane-tail.txt");

const lines = (pane: string) => pane.split("\n");
const without = (pane: string, pred: (line: string) => boolean) => lines(pane).filter((l) => !pred(l)).join("\n");
const isRc = (l: string) => l.trim() === "/rc";
// exec.cos with the shell finished: the chip leaves the footer, the wrapped `/rc` stays.
const COS_NO_JOB = COS_TAIL.replace("on · 1 shell", "on");

describe("OF-35 the captures themselves (fixture sanity: positive controls for the rows below)", () => {
  it("exec.cos tail really has the wrapped `/rc` as its LAST line, below a chip footer, over a typed draft", () => {
    const nonBlank = lines(COS_TAIL).filter((l) => l.trim().length > 0);
    expect(nonBlank.at(-1)!.trim()).toBe("/rc");
    expect(nonBlank.at(-2)).toContain("⏵⏵ bypass permissions on · 1 shell");
    expect(nonBlank.at(-2)).toContain("✔ Update installed · Restart to apply");
    expect(nonBlank.at(-3)).toMatch(/^─+$/);
    expect(nonBlank.at(-4)).toContain("what's the status?");
    expect(lines(EM_TAIL).filter(isRc)).toHaveLength(0);
  });
});

describe("OF-35 classifyPaneActivity: a wrapped `/rc` line below the mode footer is not the footer", () => {
  it("exec.cos capture reads agent_idle (was unknown / no_activity_signal, evidence '/rc')", () => {
    expect(classifyPaneActivity(COS_TAIL)).toMatchObject({ state: "agent_idle", reason: "idle_status_bar" });
  });

  it("the same capture with the `/rc` line removed reads the same, so the line alone was the cause", () => {
    const base = classifyPaneActivity(without(COS_TAIL, isRc));
    expect(base).toMatchObject({ state: "agent_idle", reason: "idle_status_bar" });
    expect(classifyPaneActivity(COS_TAIL)).toEqual(base);
  });

  it("exec.em capture (no `/rc`) is unchanged: agent_idle", () => {
    expect(classifyPaneActivity(EM_TAIL)).toMatchObject({ state: "agent_idle", reason: "idle_status_bar" });
  });

  it("the chip is still read from the footer above `/rc` (detectBackgroundJobs was already right)", () => {
    expect(detectBackgroundJobs(COS_TAIL)).toEqual({ count: 1, evidence: "1 shell" });
    expect(detectBackgroundJobs(COS_NO_JOB)).toBeNull();
    expect(classifyPaneActivity(COS_NO_JOB)).toMatchObject({ state: "agent_idle" });
  });

  // The three rows below are MODELLED panes (no native capture of these shapes): they pin that the
  // normalisation is exactly "the LAST non-blank line is `/rc` alone AND a Claude mode footer is right above".
  it("`/rc` is a trailer only BELOW a Claude mode footer: with no footer above it is ordinary last-line text", () => {
    const proseThenRc = ["Some output", "", "/rc"].join("\n");
    // evidence '/rc' proves the line was read as the last line, not stripped and replaced by the prose above
    expect(classifyPaneActivity(proseThenRc)).toMatchObject({ state: "unknown", evidence: "/rc" });
  });

  it("only the LAST line is a trailer: a `/rc` line followed by a warning row is not stripped", () => {
    // Claude's noninteractive warning rows render below the footer. A `/rc` line between the footer and a
    // warning row is not the last line, so the composer is not re-anchored on the footer above it.
    const warning = "tmux focus-events off · add 'set -g focus-events on' to ~/.tmux.conf and re…";
    const em = lines(EM_TAIL).filter((l) => l.trim().length > 0); // empty composer, idle footer
    expect(classifyPaneActivity([...em, `${" ".repeat(60)}/rc`, warning].join("\n"))).toMatchObject({ state: "unknown" });
    // positive control: the same pane without the `/rc` line is a complete frame with a warning row below
    expect(classifyPaneActivity([...em, warning].join("\n"))).toMatchObject({ state: "agent_idle" });
  });

  it("the last line must be `/rc` alone: text that merely mentions it is not a trailer", () => {
    const mentions = [...lines(without(COS_TAIL, isRc)).filter((l) => l.trim().length > 0), "Run /rc to reconnect"].join("\n");
    expect(classifyPaneActivity(mentions)).toMatchObject({ state: "unknown", evidence: "Run /rc to reconnect" });
  });

  it("a question on the pane above a wrapped `/rc` still reads attention (the trailer never hides a dialog)", () => {
    const RULE = "─".repeat(40);
    const pane = [
      "☐ Region",
      "Which region should the build target?",
      "❯ 1. us-east-1",
      "  2. eu-west-1",
      "Enter to select · ↑/↓ to navigate · Esc to cancel",
      RULE,
      "❯ ",
      RULE,
      "  ? for shortcuts · 2 shells",
    ].join("\n");
    const wrapped = `${pane}\n${" ".repeat(60)}/rc`;
    expect(classifyPaneActivity(pane)).toMatchObject({ state: "attention", reason: "selection_prompt" });
    expect(classifyPaneActivity(wrapped)).toEqual(classifyPaneActivity(pane));
  });

  it("`/rc` text in the Claude footer is not a live status: a work row above still reads active", () => {
    const RULE = "─".repeat(40);
    const pane = [
      "✻ Reading files… (12s · ↓ 1.2k tokens · esc to interrupt)",
      "",
      RULE,
      "❯ ",
      RULE,
      "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
      `${" ".repeat(60)}/rc`,
    ].join("\n");
    expect(classifyPaneActivity(pane)).toMatchObject({ state: "agent_active" });
  });
});

// ---- the surfaces: agentActivity (rig ps --json, herdr pump) and activityState (rig ps text, TUI, rig down) ----
const T0 = Date.parse("2031-03-04T05:06:07.000Z"); // far from wall clock
const SESSION = "exec-cos@rig";
const SEAT = "node-cos";
const entry = { rigId: "r", rigName: "rig", logicalId: "exec.cos", canonicalSessionName: SESSION, runtime: "claude-code", attachmentType: "tmux", nodeKind: "agent", sessionStatus: "running", startupStatus: "ready", lifecycleState: "running" };

// What AgentActivityStore.getLatestForNode returns for exec.cos at 07:52Z: its last hook (idle, 07:37Z)
// is older than the 5 minute freshness window (agent-activity-store.ts), delivered as stale unknown.
const STALE_IDLE_HOOK: AgentActivity = {
  state: "unknown", reason: "stale_runtime_hook", evidenceSource: "runtime_hook",
  sampledAt: new Date(T0).toISOString(), eventAt: new Date(T0 - 14 * 60_000).toISOString(),
  evidence: "idle_prompt", rawEvent: "Notification", rawSubtype: "idle_prompt", fallback: false, stale: true,
};

function harness(pane: string) {
  const state = { pane, clock: T0 - 14 * 60_000 };
  const seatActivity = new SeatActivityService({
    // The pane has been quiet for 10 minutes: the window-sampling floor reads idle-at-prompt.
    tmux: { readPaneLastActivity: async () => Math.floor(T0 / 1000) - 600 },
    defaultWindowSeconds: 3,
    now: () => new Date(state.clock),
  } as never);
  // The inventory production auto-declares for a claude-code seat (hooks authoritative, sampling floor).
  seatActivity.declareRungInventory({ seatNodeId: SEAT, sessionName: SESSION }, CLAUDE_ACTIVITY_RUNG_INVENTORY);
  const structural = new SeatStructuralActivityService({ capturePaneContent: async () => state.pane }, () => new Date(state.clock));
  // Both enrichers exactly as the routes compose them.
  const enrich = async (hookRow: AgentActivity | null) => {
    const withA = (await attachAgentActivity([entry] as never, {
      tmuxAdapter: { hasSession: async () => true, getPaneCommand: async () => "claude", capturePaneContent: async () => { throw new Error("capture-free"); } } as never,
      activityStore: { getLatestForNode: () => hookRow } as never,
      structuralActivity: structural,
      now: new Date(state.clock),
    } as never)) as never;
    const db = { prepare: () => ({ all: () => [] }) } as never;
    return attachTerminalActivityAndWork(withA, { db, seatActivity, structuralActivity: structural } as never)[0] as unknown as {
      agentActivity: AgentActivity;
      activityState: { activity: string; display: string; decidedBy: string | null } | null;
    };
  };
  // The 07:37Z idle hook, reported when it happened; the clock then runs to 07:52Z.
  const reportIdleHookThenAge = async () => {
    seatActivity.reportEvidence({
      seatNodeId: SEAT, sessionName: SESSION, rung: "lifecycle-hooks", sourceId: "claude-code:hooks",
      seq: 1, observedAt: new Date(state.clock).toISOString(), activity: "idle-at-prompt",
    } as never);
    state.clock = T0;
    await seatActivity.pollSeat(SESSION);
  };
  return { state, structural, enrich, reportIdleHookThenAge };
}

describe("OF-35 the exec.cos scenario through both enrichers: stale idle hook + the live capture", () => {
  it("agentActivity (rig ps --json, herdr pump): running / background_job, not unknown", async () => {
    const h = harness(COS_TAIL);
    await h.reportIdleHookThenAge();
    await h.structural.pollSeat(SESSION);
    const e = await h.enrich(STALE_IDLE_HOOK);
    expect(e.agentActivity).toMatchObject({ state: "running", reason: "background_job", evidenceSource: "pane_heuristic", evidence: "1 shell" });
  });

  it("hook-less exec.cos reads the same", async () => {
    const h = harness(COS_TAIL);
    await h.structural.pollSeat(SESSION);
    expect((await h.enrich(null)).agentActivity).toMatchObject({ state: "running", reason: "background_job", evidence: "1 shell" });
  });

  it("activityState (rig ps text, TUI, rig down) agrees with agentActivity", async () => {
    const h = harness(COS_TAIL);
    await h.reportIdleHookThenAge();
    await h.structural.pollSeat(SESSION);
    const e = await h.enrich(STALE_IDLE_HOOK);
    expect(e.agentActivity.state).toBe("running");
    expect(e.activityState).toMatchObject({ display: "working" });
  });

  it("once the shell is gone the same layout reads idle on both surfaces (the lift expires with the chip)", async () => {
    const h = harness(COS_NO_JOB);
    await h.reportIdleHookThenAge();
    await h.structural.pollSeat(SESSION);
    const e = await h.enrich(STALE_IDLE_HOOK);
    expect(e.agentActivity).toMatchObject({ state: "idle", reason: "idle_status_bar" });
    expect(e.activityState?.display).toBe("idle");
  });

  it("exec.em (fresh idle hook, no `/rc`, no chip) is still idle on both surfaces", async () => {
    const h = harness(EM_TAIL);
    h.state.clock = T0;
    await h.structural.pollSeat(SESSION);
    const fresh: AgentActivity = { ...STALE_IDLE_HOOK, state: "idle", reason: "idle_prompt", stale: false, eventAt: new Date(T0 - 60_000).toISOString() };
    const e = await h.enrich(fresh);
    expect(e.agentActivity).toMatchObject({ state: "idle" });
    expect(e.activityState?.display).not.toBe("working");
  });
});

// ---- the decision: an UNKNOWN verdict does not lift on a job chip (this PR fixes the unknown instead) ----
// `unknown` means the pane could not be read as a turn state. The known OF-34 FP-b/FP-c false positives
// (activity-background-job.test.ts) are exactly such panes: a stale chip footer with a footer-less redraw
// (splash) below it still yields detectBackgroundJobs {1 shell}, and classifies unknown. Lifting unknown on
// the chip would turn every one of them into a false `running`; lifting only idle (unchanged) leaves them
// unknown. The exec.cos defect is fixed where it lives, in the classifier, so its idle verdict lifts.
describe("OF-35 decision: unknown + a job chip stays unknown (the FP-b/FP-c shape is not widened)", () => {
  const RULE = "─".repeat(40);
  const STALE_FOOTER_WITH_SPLASH = [
    "● Started the build.", "", RULE, "❯ ", RULE, "  ⏵⏵ bypass permissions on · 1 shell",
    "", "  Claude Code v2.1.289", "  ~/work/openrig",
  ].join("\n");

  it("positive control: the stale-footer pane classifies unknown yet the chip is still detected", () => {
    expect(classifyPaneActivity(STALE_FOOTER_WITH_SPLASH).state).toBe("unknown");
    expect(detectBackgroundJobs(STALE_FOOTER_WITH_SPLASH)).toEqual({ count: 1, evidence: "1 shell" });
  });

  it("hook-less seat: agentActivity stays unknown, not running", async () => {
    const h = harness(STALE_FOOTER_WITH_SPLASH);
    await h.structural.pollSeat(SESSION);
    expect((await h.enrich(null)).agentActivity.state).toBe("unknown");
  });

  it("seat with a stale hook: agentActivity stays unknown, not running", async () => {
    const h = harness(STALE_FOOTER_WITH_SPLASH);
    await h.structural.pollSeat(SESSION);
    expect((await h.enrich(STALE_IDLE_HOOK)).agentActivity.state).toBe("unknown");
  });
});
