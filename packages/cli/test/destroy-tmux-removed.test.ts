// hc cutover (QA N2): `rig destroy` no longer runs tmux. The only live `execFileSync("tmux", ["kill-session", ...])` in src was
// here. A seat still bound to tmux (a binding from before the cutover) cannot be ended by this build, so it is named and the
// run stops with state untouched, as it does for an hc seat whose fate is unconfirmed. It is never counted as "missing".
import { describe, expect, it, vi } from "vitest";
import { buildDestroyPlan, executeDestroy, type DestroyDeps } from "../src/destroy-helpers.js";

function deps(overrides: Partial<DestroyDeps> = {}): DestroyDeps {
  return {
    stopDaemon: vi.fn(async () => {}),
    inspectListener: vi.fn(async () => ({ kind: "unreachable" as const })),
    findListeningPid: vi.fn(() => null),
    killProcess: vi.fn(),
    exists: vi.fn(() => true),
    renamePath: vi.fn(),
    removePath: vi.fn(),
    mkdirp: vi.fn(),
    listManagedTmuxSessions: vi.fn(() => ["lead@demo", "impl@demo"]),
    listManagedHcSeats: vi.fn(() => ["hc-seat@demo"]),
    killHcSeat: vi.fn(async () => "killed" as const),
    sleep: vi.fn(async () => {}),
    now: vi.fn(() => new Date("2031-03-04T05:06:07Z")),
    ...overrides,
  };
}

const config = { stateRoot: "/x/.openrig", dbPath: "/x/.openrig/openrig.sqlite", transcriptsPath: "/x/.openrig/transcripts", daemonHost: "127.0.0.1", daemonPort: 7433 };

describe("rig destroy with seats still bound to tmux", () => {
  it("names them, ends none of them, leaves state untouched, and still ends the hc seats", async () => {
    const d = deps();
    const plan = buildDestroyPlan("all", false, config, d);
    expect(plan.managedTmuxSessions).toEqual(["lead@demo", "impl@demo"]);
    const result = await executeDestroy(plan, d);
    expect(result.tmuxUnended).toEqual(["lead@demo", "impl@demo"]);
    expect(result.tmuxKilled).toBe(0);
    expect(result.tmuxMissing).toBe(0);  // never "gone": nothing asked tmux anything
    expect(result.hcKilled).toBe(1);     // the reachable seats are still ended
    expect(result.stateRecreated).toBe(false);
    expect(d.removePath).not.toHaveBeenCalled();
    expect(d.renamePath).not.toHaveBeenCalled();
    expect(d.mkdirp).not.toHaveBeenCalled();
    expect(result.warnings.join("\n")).toMatch(/2 seats are still bound to tmux \(lead@demo, impl@demo\) and this build runs no tmux/);
    expect(result.warnings.join("\n")).toMatch(/State was left untouched/);
  });

  it("one seat reads in the singular", async () => {
    const d = deps({ listManagedTmuxSessions: vi.fn(() => ["lead@demo"]) });
    const result = await executeDestroy(buildDestroyPlan("all", false, config, d), d);
    expect(result.warnings.join("\n")).toMatch(/1 seat is still bound to tmux \(lead@demo\) and this build runs no tmux, so it was not ended/);
  });

  it("with no tmux-bound seat the run proceeds as before (control)", async () => {
    const d = deps({ listManagedTmuxSessions: vi.fn(() => []) });
    const result = await executeDestroy(buildDestroyPlan("all", false, config, d), d);
    expect(result.tmuxUnended).toEqual([]);
    expect(result.stateRecreated).toBe(true);
    expect(d.removePath).toHaveBeenCalled();
  });

  it("a caller that supplies its own kill (the legacy seam) is still honoured", async () => {
    const kill = vi.fn((name: string) => name === "lead@demo");
    const d = deps({ killTmuxSession: kill });
    const result = await executeDestroy(buildDestroyPlan("all", false, config, d), d);
    expect(kill).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ tmuxKilled: 1, tmuxMissing: 1, tmuxUnended: [], stateRecreated: true });
  });

  it("--state does not look at tmux-bound seats at all", async () => {
    const d = deps();
    const result = await executeDestroy(buildDestroyPlan("state", false, config, d), d);
    expect(result.tmuxUnended).toEqual([]);
    expect(result.stateRecreated).toBe(true);
  });
});
