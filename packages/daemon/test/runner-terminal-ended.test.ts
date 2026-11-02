// OF-200: an hc seat's agent is its terminal's own program, so the end of a runner IS the end of its terminal and readiness can no longer see
// "the pane is back at a shell". These rows pin the one answer the three runner adapters (Pi / OMP, stub, PDA) give for that: `runner_exited`, read
// only from an hc host that positively says the terminal is absent, and the old answer everywhere else.
import { describe, expect, it, vi } from "vitest";
import type { SessionProbe } from "../src/adapters/tmux.js";
import { runnerTerminalEnded, type TerminalEndedHost } from "../src/adapters/runner-terminal-ended.js";
import { PiRuntimeAdapter } from "../src/adapters/pi-runtime-adapter.js";
import { OmpRuntimeAdapter } from "../src/adapters/omp-runtime-adapter.js";
import { StubRuntimeAdapter } from "../src/adapters/stub-runtime-adapter.js";
import { PdaRuntimeAdapter } from "../src/adapters/pda-runtime-adapter.js";

const host = (kind: "tmux" | "hc" | undefined, probe: SessionProbe | Error | undefined): TerminalEndedHost => ({
  ...(kind ? { hostKind: kind } : {}),
  ...(probe === undefined ? {} : { probeSession: vi.fn(async () => { if (probe instanceof Error) throw probe; return probe; }) }),
});

describe("runnerTerminalEnded", () => {
  it("is true only for an hc host whose probe says absent", async () => {
    expect(await runnerTerminalEnded(host("hc", { state: "absent" }), "s")).toBe(true);
  });
  it.each([
    ["a live terminal", host("hc", { state: "present" })],
    ["a core that cannot be asked (not proof of an end)", host("hc", { state: "transport_unavailable", cause: "down" })],
    ["a probe that throws", host("hc", new Error("boom"))],
    ["a tmux host, whatever its probe says (the shell stays above the runner there)", host("tmux", { state: "absent" })],
    ["a host that declares no kind (a unit test's minimal tmux)", host(undefined, { state: "absent" })],
    ["a host that cannot be asked at all", host("hc", undefined)],
  ])("is false for %s", async (_name, h) => {
    expect(await runnerTerminalEnded(h, "s")).toBe(false);
  });
  it("asks about the session it was given", async () => {
    const h = host("hc", { state: "absent" });
    await runnerTerminalEnded(h, "dev@rig");
    expect(h.probeSession).toHaveBeenCalledWith("dev@rig");
  });
});

/** The tmux a runner adapter reads readiness through: no session (the terminal finished), and what the probe says. */
function endedTmux(kind: "tmux" | "hc", probe: SessionProbe) {
  return {
    hostKind: kind, hasSession: vi.fn(async () => false), probeSession: vi.fn(async () => probe),
    getPaneCommand: vi.fn(async () => null), capturePaneContent: vi.fn(async () => ""),
  };
}
const noFiles = { readFile: () => { throw new Error("ENOENT"); }, writeFile: () => {}, exists: () => false, mkdirp: () => {}, listFiles: () => [] };

describe.each([
  ["Pi", (tmux: unknown) => new PiRuntimeAdapter({ tmux: tmux as never, fsOps: noFiles as never, stateRoot: "/state", runnerEntryPath: "/r.js", sleep: async () => {} }), "pi-runner exited: its terminal has ended"],
  ["OMP", (tmux: unknown) => new OmpRuntimeAdapter({ tmux: tmux as never, fsOps: noFiles as never, stateRoot: "/state", runnerEntryPath: "/r.js", sleep: async () => {} }), "omp-runner exited: its terminal has ended"],
  ["stub", (tmux: unknown) => new StubRuntimeAdapter({ tmux: tmux as never, fsOps: { ...noFiles, exists: () => true, readFile: () => JSON.stringify({ ready: true }) } as never }), "stub-runner exited: its terminal has ended"],
  ["PDA", (tmux: unknown) => new PdaRuntimeAdapter({ tmux: tmux as never, fsOps: { readFile: () => "", exists: () => false, lstat: () => null }, stateRoot: "/state", runnerEntryPath: "/r.js", tokenFile: () => "/t", newLaunchId: () => "l", now: () => new Date(), sleep: async () => {}, pollMs: 1, launchWaitMs: 1 } as never), "pda-runner exited: its terminal has ended"],
] as const)("%s checkReady when the runner's terminal has finished", (_name, make, reason) => {
  const binding = { tmuxSession: "dev@rig", cwd: "/work" } as never;

  it("on hc is runner_exited, with the terminal's end as the reason", async () => {
    expect(await make(endedTmux("hc", { state: "absent" })).checkReady(binding)).toEqual({ ready: false, reason, code: "runner_exited" });
  });
  it("on hc with a core that cannot be asked is not runner_exited: the old answer stands", async () => {
    expect(await make(endedTmux("hc", { state: "transport_unavailable", cause: "x" })).checkReady(binding)).toEqual({ ready: false, reason: "tmux session not responsive" });
  });
  it("on tmux is the old answer, whatever a probe says", async () => {
    expect(await make(endedTmux("tmux", { state: "absent" })).checkReady(binding)).toEqual({ ready: false, reason: "tmux session not responsive" });
  });
});
