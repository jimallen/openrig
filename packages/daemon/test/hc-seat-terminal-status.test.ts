// OF-267 (B): the daemon's bounded read of a seat's hc terminal status. Production path: startup.ts builds it from the daemon's HcClient
// (when an hc core is in use) and hands it to SessionTransport (the "not yet received" answer) and to the node routes (`rig ps`, graph).
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createSeatTerminalStatusReader } from "../src/adapters/hc-seat-terminal-status.js";

// Restated, not imported: hc takes names of 1-32 of a-z 0-9 - _ . and a seat name (`build-arch@eztrack`) is not one, so the
// terminal is named by a digest of the seat name (hc-seat.ts). A different recipe here would read some other seat's terminal.
const nameOf = (seat: string) => `s-${createHash("sha256").update(seat).digest("hex").slice(0, 24)}`;

function fakeClient(reply: (params: Record<string, unknown>) => unknown | Promise<unknown>) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  return {
    calls,
    call: async <T>(method: string, params: Record<string, unknown> = {}): Promise<T> => { calls.push({ method, params }); return (await reply(params)) as T; },
  };
}

describe("createSeatTerminalStatusReader", () => {
  it("asks the core for the seat's terminal by its digest name, and reads state, status and when the status began", async () => {
    const client = fakeClient(() => ({ state: "live", status: { state: "working" }, status_ms: 1_794_069_694_269, turn: 3 }));
    const read = createSeatTerminalStatusReader(client);
    expect(await read("build-arch@eztrack")).toEqual({ live: true, status: "working", sinceMs: 1_794_069_694_269 });
    expect(client.calls).toEqual([{ method: "terminal.get", params: { terminal: nameOf("build-arch@eztrack") } }]);
  });

  it("a finished terminal reads live:false; an unreported one reads status null; a missing status_ms reads null", async () => {
    expect(await createSeatTerminalStatusReader(fakeClient(() => ({ state: "finished", status: null, status_ms: 5 })))("a@b")).toEqual({ live: false, status: null, sinceMs: 5 });
    expect(await createSeatTerminalStatusReader(fakeClient(() => ({ state: "live", status: null })))("a@b")).toEqual({ live: true, status: null, sinceMs: null });
  });

  it("a status_ms that is not a finite number reads as no start time, never as one", async () => {
    for (const status_ms of ["1794069694269", null, Number.NaN, {}]) {
      expect(await createSeatTerminalStatusReader(fakeClient(() => ({ state: "live", status: { state: "working" }, status_ms })))("a@b")).toEqual({ live: true, status: "working", sinceMs: null });
    }
  });

  it("every failure is null: a refusal, a missing terminal, a core that is down", async () => {
    for (const err of [new Error("not_found"), new Error("hc core not reachable")]) {
      expect(await createSeatTerminalStatusReader(fakeClient(() => { throw err; }))("a@b")).toBeNull();
    }
  });

  it("a core that never answers is given up on after the timeout, whatever the client does with its own", async () => {
    const hung = fakeClient(() => new Promise(() => undefined));
    const started = Date.now();
    expect(await createSeatTerminalStatusReader(hung, { timeoutMs: 60 })("a@b")).toBeNull();
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("a late rejection after the timeout is nobody's unhandled error", async () => {
    const late = fakeClient(() => new Promise((_, reject) => setTimeout(() => reject(new Error("late")), 120)));
    const unhandled: unknown[] = [];
    const on = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", on);
    try {
      expect(await createSeatTerminalStatusReader(late, { timeoutMs: 30 })("a@b")).toBeNull();
      await new Promise((r) => setTimeout(r, 250));
    } finally { process.off("unhandledRejection", on); }
    expect(unhandled).toEqual([]);
  });

  it("answers from a short cache, per seat, and asks again after it", async () => {
    let clock = 1_000;
    const client = fakeClient(() => ({ state: "live", status: { state: "working" }, status_ms: 1 }));
    const read = createSeatTerminalStatusReader(client, { cacheMs: 5_000, now: () => clock });
    await read("a@b"); await read("a@b"); await read("c@d");
    expect(client.calls.length).toBe(2);
    clock += 4_999; await read("a@b");
    expect(client.calls.length).toBe(2);
    clock += 2; await read("a@b");
    expect(client.calls.length).toBe(3);
  });
});
