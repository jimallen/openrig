// OF-33 N-3: classifySessionLiveness itself, over a probe double (hc cutover N4: it asks the classified probe, not hasSession).
import { describe, it, expect, vi } from "vitest";
import { classifySessionLiveness, seatProgramEvidence, isEmptyAgentShell } from "../src/domain/session-liveness.js";
import type { SessionProbe, TmuxAdapter } from "../src/adapters/tmux.js";
import { probeSessionFromHasSession } from "./helpers/probe-from-has-session.js";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";

const tmuxOf = (hasSession: (name: string) => unknown) => ({ hasSession, probeSession: probeSessionFromHasSession } as unknown as Pick<TmuxAdapter, "probeSession" | "hostKind">);
/** A seat host of the given kind answering one probe. */
const hostOf = (hostKind: "tmux" | "hc", probe: () => SessionProbe | Promise<SessionProbe>) => ({ hostKind, probeSession: async () => probe() }) as Pick<TmuxAdapter, "probeSession" | "hostKind">;

describe("classifySessionLiveness", () => {
  it.each([
    ["true", async () => true, "live"],
    ["false", async () => false, "dead"],
    ["a rejected promise", async () => { throw new Error("tmux failed (injected)"); }, "unreadable"],
    // hasSession can throw BEFORE it returns a promise (a double, a bad adapter): that is still a probe
    // that failed to answer, never a rejection handed to the caller.
    ["a synchronous throw", () => { throw new Error("sync tmux failure (injected)"); }, "unreadable"],
  ] as const)("hasSession answering %s is %s", async (_label, hasSession, expected) => {
    await expect(classifySessionLiveness(tmuxOf(hasSession), "dev-a@r")).resolves.toBe(expected);
  });

  describe("a host that does not answer (hc cutover N4, OF-177)", () => {
    const unavailable: SessionProbe = { state: "transport_unavailable", cause: "core unreachable" };

    it("an unreachable hc core is unreadable, never dead: its seats may be running", async () => {
      await expect(classifySessionLiveness(hostOf("hc", () => unavailable), "dev-a@r")).resolves.toBe("unreadable");
    });
    it("tmux's own no-server answer stays dead, as restore has always read it", async () => {
      await expect(classifySessionLiveness(hostOf("tmux", () => unavailable), "dev-a@r")).resolves.toBe("dead");
    });
    it.each([["tmux"], ["hc"]] as const)("on %s: present is live and absent is dead", async (kind) => {
      await expect(classifySessionLiveness(hostOf(kind, () => ({ state: "present" })), "dev-a@r")).resolves.toBe("live");
      await expect(classifySessionLiveness(hostOf(kind, () => ({ state: "absent" })), "dev-a@r")).resolves.toBe("dead");
    });
    it("a probe that throws is unreadable on either host", async () => {
      await expect(classifySessionLiveness(hostOf("hc", () => { throw new Error("boom"); }), "dev-a@r")).resolves.toBe("unreadable");
    });
  });

  it("a synchronous throw leaves no deadline timer behind", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await classifySessionLiveness(tmuxOf(() => { throw new Error("sync tmux failure (injected)"); }), "dev-a@r");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

// OF-259. The process shapes are the ones measured on a private hc 0.1.18 core (Sparky): an idle seat shell has foreground == the terminal's own pid;
// Claude run from the pane shell shows foreground `bash` (a subshell) with `claude` below it; Codex shows foreground `sh` AT the terminal's pid with
// `codex` as its child; a program that replaced the shell (Pi, the stub) is itself the foreground.
describe("seatProgramEvidence and the empty agent shell (OF-259)", () => {
  const PID = 2394228;
  const row = (pid: number, ppid: number, command: string) => ({ pid, ppid, command });
  const paneOf = (command: string | null, pid: number | null = PID) => ({ getPaneCommand: async () => command, getPanePid: async () => pid });
  const idle = [row(PID, 1, "/bin/bash -l")];

  it.each([
    ["an idle seat shell", "bash", idle, "empty_shell"],
    ["an idle login shell named -zsh", "-zsh", [row(PID, 1, "-zsh")], "empty_shell"],
    ["Claude from the pane shell: foreground bash, claude two levels down", "bash", [...idle, row(PID + 1, PID, "/bin/bash -l"), row(PID + 2, PID + 1, "claude --permission-mode default")], "program"],
    ["Codex: foreground sh at the terminal's own pid, codex its child", "sh", [row(PID, 1, "/bin/sh x.sh"), row(PID + 3, PID, "codex")], "program"],
    ["a program that replaced the shell", "node", [row(PID, 1, "node -e x")], "program"],
    ["a shell with a plain child (sleep)", "bash", [...idle, row(PID + 4, PID, "sleep 600")], "program"],
    ["a process of another terminal is not this one's", "bash", [...idle, row(PID + 5, 4242, "claude")], "empty_shell"],
  ] as const)("%s reads %s", async (_label, command, rows, expected) => {
    await expect(seatProgramEvidence(paneOf(command), "s@r", async () => [...rows])).resolves.toBe(expected);
  });

  it.each([
    ["no foreground name", paneOf(null), idle],
    ["no pid for the terminal", paneOf("bash", null), idle],
    ["a listing without the terminal's pid", paneOf("bash"), [row(1, 0, "init")]],
    ["an empty listing", paneOf("bash"), []],
  ])("%s is unobservable, never empty", async (_label, pane, rows) => {
    await expect(seatProgramEvidence(pane, "s@r", async () => rows)).resolves.toBe("unobservable");
  });

  it("a listing that throws is unobservable", async () => {
    await expect(seatProgramEvidence(paneOf("bash"), "s@r", async () => { throw new Error("ps failed"); })).resolves.toBe("unobservable");
  });

  it.each([["claude-code", true], ["codex", true], ["pi", true], ["omp", true], ["pda", true], ["terminal", false], ["something-new", false], [null, false], [undefined, false]] as const)(
    "a bare shell is an empty agent shell for runtime %s: %s", async (runtime, expected) => {
      await expect(isEmptyAgentShell(paneOf("bash"), "s@r", runtime, async () => idle)).resolves.toBe(expected);
    });

  describe("classifySessionLiveness with a seat context", () => {
    type Host = Pick<TmuxAdapter, "probeSession" | "hostKind"> & Partial<Pick<TmuxAdapter, "getPaneCommand" | "getPanePid">>;
    const hcPresent = (pane: ReturnType<typeof paneOf>): Host => ({ hostKind: "hc", probeSession: async (): Promise<SessionProbe> => ({ state: "present" }), ...pane });
    const ctx = (runtime: string | null) => ({ runtimeOfSession: () => runtime, listProcesses: async () => idle });

    it("a present terminal that is an empty shell of an agent seat is dead", async () => {
      await expect(classifySessionLiveness(hcPresent(paneOf("bash")), "s@r", 2000, ctx("claude-code"))).resolves.toBe("dead");
    });
    it("the same terminal of a terminal-runtime seat is live", async () => {
      await expect(classifySessionLiveness(hcPresent(paneOf("bash")), "s@r", 2000, ctx("terminal"))).resolves.toBe("live");
    });
    it("without a context the answer is the host's (live), as before", async () => {
      await expect(classifySessionLiveness(hcPresent(paneOf("bash")), "s@r")).resolves.toBe("live");
    });
    it("a host that does not answer stays unreadable, whatever the context", async () => {
      const down: Host = { hostKind: "hc", probeSession: async (): Promise<SessionProbe> => ({ state: "transport_unavailable", cause: "x" }), ...paneOf("bash") };
      await expect(classifySessionLiveness(down, "s@r", 2000, ctx("claude-code"))).resolves.toBe("unreadable");
    });
  });
});

describe("SessionRegistry.runtimeOfSessionName (OF-259)", () => {
  it("reads the runtime of the RUNNING row of a reused session name, not of a newer finished one", () => {
    const db = createFullTestDb();
    const rigRepo = new RigRepository(db);
    const registry = new SessionRegistry(db);
    const rig = rigRepo.createRig("reuse");
    const agent = rigRepo.addNode(rig.id, "a", { role: "worker", runtime: "claude-code" });
    const shell = rigRepo.addNode(rig.id, "b", { role: "worker", runtime: "terminal" });
    const running = registry.registerSession(agent.id, "same@reuse");
    registry.updateStatus(running.id, "running");
    const finished = registry.registerSession(shell.id, "same@reuse");
    registry.updateStatus(finished.id, "exited");
    db.prepare("UPDATE sessions SET created_at = '2030-01-01 00:00:00' WHERE id = ?").run(finished.id);
    db.prepare("UPDATE sessions SET created_at = '2020-01-01 00:00:00' WHERE id = ?").run(running.id);
    expect(registry.runtimeOfSessionName("same@reuse")).toBe("claude-code");
    expect(registry.runtimeOfSessionName("nobody@reuse")).toBeNull();
  });
});
