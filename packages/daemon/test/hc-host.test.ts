import { describe, expect, it } from "vitest";
import { HcClient, HcError, HcOutcomeUnknownError, HcUnavailableError, type HcTerminal } from "../src/adapters/hc-client.js";
import { HcHost, hcTerminalName } from "../src/adapters/hc-host.js";

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
