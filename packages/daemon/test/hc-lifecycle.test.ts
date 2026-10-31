import { describe, expect, it } from "vitest";
import { HcClient, HcError, HcOutcomeUnknownError, HcUnavailableError, type HcTerminal } from "../src/adapters/hc-client.js";
import { SEAT_LABEL, hcTerminalName } from "../src/adapters/hc-host.js";
import { HcLifecycle, PROBE_LABEL } from "../src/adapters/hc-lifecycle.js";

type Call = [method: string, params: Record<string, unknown> | undefined];

class FakeClient extends HcClient {
  calls: Call[] = [];
  constructor(private readonly answer: (method: string, params: Record<string, unknown> | undefined) => unknown) { super("/nonexistent"); }
  override async call<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    this.calls.push([method, params]);
    const reply = this.answer(method, params);
    if (reply instanceof Error) throw reply;
    return reply as T;
  }
}

const term = (over: Partial<HcTerminal> = {}): HcTerminal => ({
  address: "t7", labels: { [SEAT_LABEL]: "qa@rig" }, argv: [], cwd: "/work/qa", state: "live", created_ms: 0, screen: "exact", cols: 200, rows: 120, pid: 4242, ...over,
});
const notFound = () => new HcError("no terminal", "not_found", -32000);
const methods = (client: FakeClient) => client.calls.map(([m]) => m);

describe("HcLifecycle.killSession", () => {
  it("kills the terminal at the address the mapped name resolves to", async () => {
    const client = new FakeClient((m) => (m === "terminal.get" ? term() : term({ state: "finished" })));
    await expect(new HcLifecycle(client).killSession("qa@rig")).resolves.toEqual({ ok: true });
    expect(client.calls).toEqual([["terminal.get", { terminal: hcTerminalName("qa@rig") }], ["terminal.kill", { terminal: "t7" }]]);
  });
  it("reads a missing terminal as session_not_found without killing anything", async () => {
    const client = new FakeClient(() => notFound());
    await expect(new HcLifecycle(client).killSession("qa@rig")).resolves.toMatchObject({ ok: false, code: "session_not_found" });
    expect(methods(client)).toEqual(["terminal.get"]);
  });
  it("reads an already finished terminal as session_not_found without a second kill", async () => {
    const client = new FakeClient(() => term({ state: "finished" }));
    await expect(new HcLifecycle(client).killSession("qa@rig")).resolves.toMatchObject({ ok: false, code: "session_not_found" });
    expect(methods(client)).toEqual(["terminal.get"]);
  });
  it("does not report success when hc still reads the terminal as live", async () => {
    const client = new FakeClient(() => term());
    await expect(new HcLifecycle(client).killSession("qa@rig")).resolves.toMatchObject({ ok: false, code: "kill_incomplete" });
  });
  it("never reads an unreachable core as a gone session", async () => {
    await expect(new HcLifecycle(new FakeClient(() => new HcUnavailableError("down"))).killSession("qa@rig")).resolves.toMatchObject({ ok: false, code: "transport_unavailable" });
  });
  it("never reads a lost kill reply as success or as gone", async () => {
    const answer = (m: string) => (m === "terminal.get" ? term() : new HcOutcomeUnknownError("lost", "terminal.kill"));
    await expect(new HcLifecycle(new FakeClient(answer)).killSession("qa@rig")).resolves.toMatchObject({ ok: false, code: "outcome_unknown" });
  });
});

describe("HcLifecycle.respawnPane", () => {
  const daemonEnv = { PATH: "/bin", SHELL: "/bin/zsh", CLAUDECODE: "1" };
  const fresh = (before: HcTerminal) => new FakeClient((m) => (m === "terminal.get" ? before : m === "terminal.kill" ? { ...before, state: "finished" } : term({ address: "t8" })));

  it("kills the live program, then runs again under the same name, following the label", async () => {
    const client = fresh(term({ labels: { [SEAT_LABEL]: "qa@rig", "herdr.space": "rig:eztrack", "herdr.tab": "rig:eztrack/team" } }));
    await expect(new HcLifecycle(client, { daemonEnv }).respawnPane("qa@rig", "claude --resume abc", { env: { API_KEY: "k-needle" } })).resolves.toEqual({ ok: true });
    expect(methods(client)).toEqual(["terminal.get", "terminal.kill", "terminal.run"]);
    const run = client.calls[2]![1]!;
    expect(run.name).toBe(hcTerminalName("qa@rig"));
    expect(run.labels).toEqual({ [SEAT_LABEL]: "qa@rig", "herdr.space": "rig:eztrack", "herdr.tab": "rig:eztrack/team" });
    expect(run.cwd).toBe("/work/qa");
    expect(run.argv).toEqual(expect.arrayContaining(["/bin/sh", "-c", "claude --resume abc"]));
    expect(run.argv).not.toContain("/bin/zsh");
    expect(JSON.stringify(run.argv)).not.toContain("k-needle");
    expect(run.env).toMatchObject({ API_KEY: "k-needle" });
    expect(run.env).not.toHaveProperty("CLAUDECODE");
  });
  it("starts a blank login shell when given no command, never a creation command", async () => {
    const client = fresh(term());
    await new HcLifecycle(client, { daemonEnv }).respawnPane("qa@rig");
    const argv = client.calls[2]![1]!.argv;
    expect(argv).toEqual(expect.arrayContaining(["/bin/zsh", "-l"]));
    expect(argv).not.toContain("-c");
  });
  it("takes the new cwd when one is given", async () => {
    const client = fresh(term());
    await new HcLifecycle(client, { daemonEnv }).respawnPane("qa@rig", undefined, { cwd: "/elsewhere" });
    expect(client.calls[2]![1]!.cwd).toBe("/elsewhere");
  });
  it("does not kill a terminal that already finished", async () => {
    const client = fresh(term({ state: "finished" }));
    await expect(new HcLifecycle(client, { daemonEnv }).respawnPane("qa@rig")).resolves.toEqual({ ok: true });
    expect(methods(client)).toEqual(["terminal.get", "terminal.run"]);
  });
  it("runs nothing when the kill did not end the program", async () => {
    const client = new FakeClient((m) => (m === "terminal.get" ? term() : term()));
    await expect(new HcLifecycle(client, { daemonEnv }).respawnPane("qa@rig")).resolves.toMatchObject({ ok: false, code: "kill_incomplete" });
    expect(methods(client)).not.toContain("terminal.run");
  });
  it("refuses a seat with no terminal", async () => {
    const client = new FakeClient(() => notFound());
    await expect(new HcLifecycle(client, { daemonEnv }).respawnPane("qa@rig")).resolves.toMatchObject({ ok: false, code: "session_not_found" });
    expect(methods(client)).toEqual(["terminal.get"]);
  });
  it("says the old program had already ended when the new run fails", async () => {
    const client = new FakeClient((m) => (m === "terminal.get" ? term() : m === "terminal.kill" ? term({ state: "finished" }) : new HcError("spawn", "spawn_failed", -32000)));
    const result = await new HcLifecycle(client, { daemonEnv }).respawnPane("qa@rig");
    expect(result).toMatchObject({ ok: false, code: "unknown" });
    expect(result.ok ? "" : result.message).toContain("already ended");
  });
  it("refuses an invalid env name before touching the seat", async () => {
    const client = fresh(term());
    await expect(new HcLifecycle(client, { daemonEnv }).respawnPane("qa@rig", undefined, { env: { "A=B": "x" } })).resolves.toMatchObject({ ok: false, code: "invalid_env" });
    expect(client.calls).toEqual([]);
  });
});

describe("HcLifecycle.signalPid", () => {
  const killer = () => { const sent: [number, string][] = []; return { sent, kill: (pid: number, signal: NodeJS.Signals) => { sent.push([pid, signal]); } }; };
  it("sends TERM and KILL as the signals of those names", async () => {
    const { sent, kill } = killer();
    const lifecycle = new HcLifecycle(new FakeClient(() => null), { kill });
    await lifecycle.signalPid(4242, "TERM");
    await lifecycle.signalPid(4242, "KILL");
    expect(sent).toEqual([[4242, "SIGTERM"], [4242, "SIGKILL"]]);
  });
  it.each([0, 1, -5, 1.5, Number.NaN])("refuses pid %s", async (pid) => {
    const { sent, kill } = killer();
    await expect(new HcLifecycle(new FakeClient(() => null), { kill }).signalPid(pid, "KILL")).resolves.toMatchObject({ ok: false, code: "invalid_pid" });
    expect(sent).toEqual([]);
  });
  it("names a process that is not there", async () => {
    const kill = () => { throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" }); };
    await expect(new HcLifecycle(new FakeClient(() => null), { kill }).signalPid(4242, "TERM")).resolves.toMatchObject({ ok: false, code: "process_not_found" });
  });
});

describe("HcLifecycle.signalPaneProcess", () => {
  it("signals the live terminal's pid", async () => {
    const sent: [number, string][] = [];
    const lifecycle = new HcLifecycle(new FakeClient(() => term()), { kill: (pid, signal) => { sent.push([pid, signal]); } });
    await expect(lifecycle.signalPaneProcess("qa@rig", "TERM")).resolves.toEqual({ ok: true });
    expect(sent).toEqual([[4242, "SIGTERM"]]);
  });
  it.each([
    ["a finished terminal, whose pid the OS may have reused", term({ state: "finished" })],
    ["a terminal with no pid", term({ pid: null })],
    ["a terminal on another machine, whose pid is not local", term({ address: "spk/t7" })],
  ])("signals nothing for %s", async (_name, terminal) => {
    const sent: number[] = [];
    const lifecycle = new HcLifecycle(new FakeClient(() => terminal), { kill: (pid) => { sent.push(pid); } });
    await expect(lifecycle.signalPaneProcess("qa@rig", "KILL")).resolves.toMatchObject({ ok: false, code: "pane_pid_unavailable" });
    expect(sent).toEqual([]);
  });
  it("signals nothing for a missing terminal", async () => {
    const sent: number[] = [];
    const lifecycle = new HcLifecycle(new FakeClient(() => notFound()), { kill: (pid) => { sent.push(pid); } });
    await expect(lifecycle.signalPaneProcess("qa@rig", "KILL")).resolves.toMatchObject({ ok: false, code: "pane_pid_unavailable" });
    expect(sent).toEqual([]);
  });
  it("reports an unreachable core as such", async () => {
    await expect(new HcLifecycle(new FakeClient(() => new HcUnavailableError("down"))).signalPaneProcess("qa@rig", "TERM")).resolves.toMatchObject({ ok: false, code: "transport_unavailable" });
  });
});

describe("HcLifecycle.setRemainOnExit", () => {
  it("holds already: on is ok for a seat that has a terminal, live or finished", async () => {
    await expect(new HcLifecycle(new FakeClient(() => term())).setRemainOnExit("qa@rig", true)).resolves.toEqual({ ok: true });
    await expect(new HcLifecycle(new FakeClient(() => term({ state: "finished" }))).setRemainOnExit("qa@rig", true)).resolves.toEqual({ ok: true });
  });
  it("cannot turn it off, and says so", async () => {
    const result = await new HcLifecycle(new FakeClient(() => term())).setRemainOnExit("qa@rig", false);
    expect(result).toMatchObject({ ok: true, warnings: [expect.stringContaining("cannot be turned off")] });
  });
  it("refuses a seat with no terminal", async () => {
    await expect(new HcLifecycle(new FakeClient(() => notFound())).setRemainOnExit("qa@rig", true)).resolves.toMatchObject({ ok: false, code: "session_not_found" });
  });
});

describe("HcLifecycle.isPaneDead", () => {
  it.each([
    ["finished", () => term({ state: "finished" }), true],
    ["missing", () => notFound(), true],
    ["live", () => term(), false],
    ["unreachable", () => new HcUnavailableError("down"), false],
    ["unanswered", () => new HcOutcomeUnknownError("lost", "terminal.get"), false],
  ])("%s", async (_name, answer, dead) => {
    await expect(new HcLifecycle(new FakeClient(answer)).isPaneDead("qa@rig")).resolves.toBe(dead);
  });
});

describe("HcLifecycle.createProbeSession", () => {
  const daemonEnv = { PATH: "/bin", SHELL: "/bin/zsh" };
  it("starts a login shell labelled as a probe, never as a seat", async () => {
    const client = new FakeClient(() => term());
    await expect(new HcLifecycle(client, { daemonEnv }).createProbeSession("rigged-refresh-x", "/work")).resolves.toEqual({ ok: true });
    const run = client.calls[0]![1]!;
    expect(run.labels).toEqual({ [PROBE_LABEL]: "rigged-refresh-x" });
    expect(run.name).toBe(hcTerminalName("rigged-refresh-x"));
    expect(run.cwd).toBe("/work");
    expect(run.argv).toEqual(expect.arrayContaining(["/bin/zsh", "-l"]));
  });
  it("refuses a managed seat's name without calling hc", async () => {
    const client = new FakeClient(() => term());
    await expect(new HcLifecycle(client, { daemonEnv, isManagedSeat: (n) => n === "qa@rig" }).createProbeSession("qa@rig")).resolves.toMatchObject({ ok: false, code: "guard_target_managed" });
    expect(client.calls).toEqual([]);
  });
  it("refuses a live terminal of that name atomically", async () => {
    const client = new FakeClient(() => new HcError("taken", "name_taken", -32000));
    await expect(new HcLifecycle(client, { daemonEnv }).createProbeSession("x")).resolves.toMatchObject({ ok: false, code: "duplicate_session" });
  });
});
