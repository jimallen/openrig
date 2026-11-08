import { describe, expect, it } from "vitest";
import { HcClient, HcError, HcOutcomeUnknownError, HcUnavailableError, type HcTerminal } from "../src/adapters/hc-client.js";
import { HcHost, hcTerminalName, seatEnvironment } from "../src/adapters/hc-host.js";

class FakeClient extends HcClient {
  calls: [string, Record<string, unknown> | undefined][] = [];
  constructor(private readonly answer: () => unknown) { super("/nonexistent"); }
  override async call<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    this.calls.push([method, params]);
    return this.answer() as T;
  }
}

const terminal = (state: string): HcTerminal => ({ address: "t1", labels: {}, argv: [], cwd: "/", state, created_ms: 0, screen: "exact", cols: 80, rows: 24 });
const hostAnswering = (answer: () => unknown) => new HcHost(new FakeClient(answer));
const hostThrowing = (err: Error) => hostAnswering(() => { throw err; });

describe("hcTerminalName", () => {
  it("fits hc's name rule for any seat", () => {
    expect(hcTerminalName("verify-qa@eztrack")).toMatch(/^[a-z0-9._-]{1,32}$/);
    expect(hcTerminalName("x".repeat(500))).toMatch(/^[a-z0-9._-]{1,32}$/);
  });
  it("is stable and differs by seat", () => {
    expect(hcTerminalName("a@b")).toBe(hcTerminalName("a@b"));
    expect(hcTerminalName("a@b")).not.toBe(hcTerminalName("a@c"));
  });
});

describe("HcHost.probeSession", () => {
  it("asks for the mapped name", async () => {
    const client = new FakeClient(() => terminal("live"));
    await new HcHost(client).probeSession("qa@rig");
    expect(client.calls).toEqual([["terminal.get", { terminal: hcTerminalName("qa@rig") }]]);
  });
  it("reads a live terminal as present", async () => {
    await expect(hostAnswering(() => terminal("live")).probeSession("s")).resolves.toEqual({ state: "present" });
  });
  it("reads a finished terminal as absent", async () => {
    await expect(hostAnswering(() => terminal("finished")).probeSession("s")).resolves.toEqual({ state: "absent" });
  });
  it("reads not_found as absent", async () => {
    await expect(hostThrowing(new HcError("no", "not_found", -32000)).probeSession("s")).resolves.toEqual({ state: "absent" });
  });
  it("never reads an unreachable core as absent", async () => {
    await expect(hostThrowing(new HcUnavailableError("down")).probeSession("s")).resolves.toEqual({ state: "transport_unavailable", cause: "down" });
  });
  it("never reads a lost reply as absent", async () => {
    await expect(hostThrowing(new HcOutcomeUnknownError("lost", "terminal.get")).probeSession("s")).resolves.toEqual({ state: "transport_unavailable", cause: "lost" });
  });
  it("never reads a state it does not know as absent", async () => {
    await expect(hostAnswering(() => terminal("recovering")).probeSession("s")).resolves.toMatchObject({ state: "transport_unavailable" });
  });
  it("never reads a spawn that may still be starting as absent", async () => {
    await expect(hostAnswering(() => ({ ...terminal("finished"), reason: "spawn_pending" })).probeSession("s")).resolves.toMatchObject({ state: "transport_unavailable" });
  });
  it("rethrows any other refusal", async () => {
    await expect(hostThrowing(new HcError("gen", "unsupported_generation", -32000)).probeSession("s")).rejects.toBeInstanceOf(HcError);
  });
});

describe("seatEnvironment", () => {
  it("states the daemon's env with the seat's values on top", () => {
    const { env } = seatEnvironment({ A: "seat" }, { A: "daemon", DOCKER_HOST: "d", SSH_AUTH_SOCK: "s" });
    expect(env).toMatchObject({ A: "seat", DOCKER_HOST: "d", SSH_AUTH_SOCK: "s" });
  });
  it("drops the parent session, tmux and hc names from what it states", () => {
    const { env } = seatEnvironment({}, { CLAUDECODE: "1", CLAUDE_EFFORT: "high", HERDR_ENV: "x", TMUX: "t", TMUX_PANE: "%1", HC_TERMINAL_ID: "t9", HC_RUNTIME: "r", KEEP: "k" });
    expect(Object.keys(env).sort()).toEqual(["KEEP", "OPENRIG_TRANSCRIPTS_LINES", "OPENRIG_TRANSCRIPTS_POLL_INTERVAL_SECONDS"]);
  });
  it("keeps user configuration with a similar name", () => {
    expect(seatEnvironment({}, { CLAUDE_CODE_USE_BEDROCK: "1" }).env.CLAUDE_CODE_USE_BEDROCK).toBe("1");
    expect(seatEnvironment({}, { CLAUDE_EFFORT: "high" }).env.CLAUDE_EFFORT).toBe("high");
  });
  it("blanks the transcript policy unless the seat sets it", () => {
    expect(seatEnvironment({}, {}).env.OPENRIG_TRANSCRIPTS_LINES).toBe("");
    expect(seatEnvironment({ OPENRIG_TRANSCRIPTS_LINES: "9" }, {}).env.OPENRIG_TRANSCRIPTS_LINES).toBe("9");
  });
  it("unsets what the core may hold, except what the seat states", () => {
    const { unset } = seatEnvironment({ CLAUDECODE: "mine" }, {});
    expect(unset).toEqual(expect.arrayContaining(["CLAUDE_CODE_SESSION_ID", "HERDR_ENV", "TMUX", "TMUX_PANE", "CLAUDE_EFFORT"]));
    expect(unset).not.toContain("CLAUDECODE");
  });
  describe("operator credentials", () => {
    const operator = { OPENRIG_AUTH_BEARER_TOKEN: "op-a", OPENRIG_TERMINAL_BEARER_TOKEN: "op-t", SLACK_BOT_TOKEN: "xoxb", SLACK_APP_TOKEN: "xapp" };
    it("never inherits them from the daemon", () => {
      const { env } = seatEnvironment({}, { ...operator, KEEP: "k" });
      for (const name of Object.keys(operator)) expect(env).not.toHaveProperty(name);
      expect(env.KEEP).toBe("k");
    });
    it("unsets all of them, so a core started with them does not pass them on", () => {
      expect(seatEnvironment({}, operator).unset).toEqual(expect.arrayContaining(Object.keys(operator)));
      expect(seatEnvironment({}, {}).unset).toEqual(expect.arrayContaining(Object.keys(operator)));
    });
    it("keeps one the seat states itself, and does not unset it", () => {
      const { env, unset } = seatEnvironment({ OPENRIG_TERMINAL_BEARER_TOKEN: "mine" }, operator);
      expect(env.OPENRIG_TERMINAL_BEARER_TOKEN).toBe("mine");
      expect(unset).not.toContain("OPENRIG_TERMINAL_BEARER_TOKEN");
      expect(unset).toContain("OPENRIG_AUTH_BEARER_TOKEN");
    });
    it("still delivers the seat's own activity hook token and provider keys", () => {
      const { env, unset } = seatEnvironment({ OPENRIG_ACTIVITY_HOOK_TOKEN: "seat-hook" }, { ANTHROPIC_API_KEY: "prov" });
      expect(env).toMatchObject({ OPENRIG_ACTIVITY_HOOK_TOKEN: "seat-hook", ANTHROPIC_API_KEY: "prov" });
      expect(unset).not.toContain("OPENRIG_ACTIVITY_HOOK_TOKEN");
    });
  });
  it("refuses a name hc would take silently, and never prints a value", () => {
    expect(() => seatEnvironment({ "A=B": "x" }, {})).toThrow(/invalid environment name/);
    expect(() => seatEnvironment({ "": "x" }, {})).toThrow(/invalid environment name/);
    let message = "";
    try { seatEnvironment({ TOKEN: "sec\0ret" }, {}); } catch (e) { message = (e as Error).message; }
    expect(message).toContain("TOKEN");
    expect(message).not.toContain("sec");
  });
});

describe("HcHost.createSession", () => {
  const seatEnv = { OPENRIG_NODE_ID: "n1", API_KEY: "s3cret" };

  it("launches a login shell, with the seat label and the mapped name, and its env off the argv", async () => {
    const client = new FakeClient(() => terminal("live"));
    const host = new HcHost(client, { daemonEnv: { SHELL: "/bin/zsh" } });
    await expect(host.createSession("qa@rig", "/w", seatEnv)).resolves.toEqual({ ok: true });
    // OF-280: the run is preceded by one read of the seat's previous terminal (its placement); that read is pinned in hc-seat-placement-carry.test.ts.
    expect(client.calls.map(([m]) => m)).toEqual(["terminal.get", "terminal.run"]);
    const [method, params] = client.calls[1]!;
    expect(method).toBe("terminal.run");
    expect(params).toMatchObject({ name: hcTerminalName("qa@rig"), cwd: "/w", labels: { "openrig.seat": "qa@rig" }, no_parent: true, no_notify: true, outlive_parent: true });
    expect(params).not.toHaveProperty("keep");
    const argv = params!.argv as string[];
    expect(argv[0]).toBe("env");
    expect(argv.slice(-2)).toEqual(["/bin/zsh", "-l"]);
    expect(argv.join(" ")).toContain("-u CLAUDECODE");
    expect(argv.join(" ")).not.toContain("s3cret");
    expect(params!.env).toMatchObject({ API_KEY: "s3cret" });
  });
  it("does not state the daemon's operator bearer to the seat, in env or argv, and unsets it for the core's side", async () => {
    const client = new FakeClient(() => terminal("live"));
    const host = new HcHost(client, { daemonEnv: { SHELL: "/bin/zsh", OPENRIG_AUTH_BEARER_TOKEN: "op-secret", OPENRIG_TERMINAL_BEARER_TOKEN: "t-secret" } });
    await host.createSession("qa@rig", "/w", seatEnv);
    const params = client.calls.find(([m]) => m === "terminal.run")![1]!;
    expect(JSON.stringify(params)).not.toContain("-secret");
    expect((params.argv as string[]).join(" ")).toContain("-u OPENRIG_AUTH_BEARER_TOKEN");
    expect((params.argv as string[]).join(" ")).toContain("-u OPENRIG_TERMINAL_BEARER_TOKEN");
  });
  it("refuses a managed launch without its lease and runs nothing", async () => {
    const client = new FakeClient(() => terminal("live"));
    const host = new HcHost(client, { ownsLifecycle: () => false, daemonEnv: {} });
    await expect(host.createSession("s", "/w", seatEnv)).resolves.toMatchObject({ ok: false, code: "guard_lease_required" });
    await expect(host.createSession("s", "/w", {})).resolves.toMatchObject({ ok: false, code: "guard_lease_required" });
    expect(client.calls).toEqual([]);
  });
  it("launches with a lease", async () => {
    const host = new HcHost(new FakeClient(() => terminal("live")), { ownsLifecycle: (n) => n === "n1", daemonEnv: {} });
    await expect(host.createSession("s", "/w", seatEnv)).resolves.toEqual({ ok: true });
  });
  it("maps a taken name to the code callers read", async () => {
    const host = new HcHost(new FakeClient(() => { throw new HcError("t", "name_taken", -32000); }), { daemonEnv: {} });
    await expect(host.createSession("s")).resolves.toMatchObject({ ok: false, code: "duplicate_session" });
  });
  it("never repeats the core's text, which could hold what this call carried", async () => {
    const host = new HcHost(new FakeClient(() => { throw new HcError("failed for s3cret", "spawn_failed", -32000); }), { daemonEnv: {} });
    const result = await host.createSession("s", "/w", seatEnv);
    expect(result).toMatchObject({ ok: false, code: "unknown" });
    expect(JSON.stringify(result)).not.toContain("s3cret");
  });
  it("tells an unreachable core from an unknown outcome", async () => {
    await expect(new HcHost(new FakeClient(() => { throw new HcUnavailableError("d"); }), { daemonEnv: {} }).createSession("s"))
      .resolves.toMatchObject({ ok: false, code: "transport_unavailable" });
    await expect(new HcHost(new FakeClient(() => { throw new HcOutcomeUnknownError("l", "terminal.run"); }), { daemonEnv: {} }).createSession("s"))
      .resolves.toMatchObject({ ok: false, code: "launch_outcome_unknown" });
  });
  it("refuses a bad env name before reaching the core", async () => {
    const client = new FakeClient(() => terminal("live"));
    await expect(new HcHost(client, { daemonEnv: {} }).createSession("s", "/w", { "A=B": "x" })).resolves.toMatchObject({ ok: false, code: "invalid_env" });
    expect(client.calls).toEqual([]);
  });
});
