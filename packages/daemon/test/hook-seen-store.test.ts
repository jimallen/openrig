// S2: the daemon's reading of a hook gate's seen store, the file search reconcile rests on, and the `SeatGate` port over them.
import { describe, it, expect, afterEach } from "vitest";
import { chmodSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HookSeenStore, seatGateFolder, seatGateRoot, transcriptMarkers } from "../src/adapters/hook-seen-store.js";
import { hookSeatGate } from "../src/adapters/hook-seat-gate.js";
import { messageId } from "../src/domain/seat-messaging/ports.js";
import { NONCE, SEAT, marker, sessionStart, stubSeat, submit, type StubSeat } from "./helpers/stub-claude-hook.js";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const c of cleanups.splice(0).reverse()) c(); });

function seat(): StubSeat {
  const home = mkdtempSync(join(tmpdir(), "gate-store-"));
  cleanups.push(() => { rmSync(home, { recursive: true, force: true }); });
  return stubSeat(home);
}
const storeOf = (s: StubSeat) => new HookSeenStore(seatGateRoot(s.home));
function gateOf(s: StubSeat, nonce: string | null = NONCE) {
  return hookSeatGate({ store: storeOf(s), nonceOf: () => nonce, transcriptsOf: () => [s.transcript], fileIncludes: () => false });
}

describe("the SeatGate over the seen store", () => {
  it("reads what the real relay wrote, with its nonce", async () => {
    const s = seat();
    sessionStart(s);
    submit(s, `x\n\n${marker("m-1")}`);
    expect(await gateOf(s).lookup(SEAT, messageId("m-1"))).toMatchObject({ kind: "seen", record: { id: "m-1", nonce: NONCE } });
    expect(gateOf(s).version).toBe(1);
  });

  it("a record under another nonce is forged: it confirms nothing", async () => {
    const s = seat();
    sessionStart(s);
    submit(s, `x\n\n${marker("m-1", "ffffffffffffffff")}`);
    expect(await gateOf(s).lookup(SEAT, messageId("m-1"))).toEqual({ kind: "not_seen" });
  });

  it("a row with no nonce yet confirms nothing", async () => {
    const s = seat();
    sessionStart(s);
    submit(s, `x\n\n${marker("m-1")}`);
    expect(await gateOf(s, null).lookup(SEAT, messageId("m-1"))).toEqual({ kind: "not_seen" });
  });

  it("a seat that declared no gate is unavailable, not unseen: an older relay leaves no records to read", async () => {
    const s = seat();
    submit(s, `x\n\n${marker("m-1")}`);
    expect(await gateOf(s).lookup(SEAT, messageId("m-1"))).toEqual({ kind: "unavailable", cause: "no_gate_declared" });
  });

  it("a record whose contents name another message is not trusted, and one that holds no JSON is unavailable", () => {
    const s = seat();
    submit(s, `x\n\n${marker("m-1")}`);
    const dir = join(seatGateRoot(s.home), seatGateFolder(SEAT), "seen");
    const [name] = readdirSync(dir);
    const m1 = { id: "m-1", nonce: NONCE };
    expect(storeOf(s).read(SEAT, m1).kind).toBe("seen");
    writeFileSync(join(dir, name!), JSON.stringify({ id: "m-2", nonce: NONCE, recordedAt: "2020-01-01T00:00:00.000Z" }));
    expect(storeOf(s).read(SEAT, m1)).toEqual({ kind: "not_seen" });
    writeFileSync(join(dir, name!), "not json");
    expect(storeOf(s).read(SEAT, m1)).toEqual({ kind: "unavailable", cause: "malformed_record" });
  });

  it("a store that cannot be read says so", () => {
    const s = seat();
    submit(s, `x\n\n${marker("m-1")}`);
    const dir = join(seatGateRoot(s.home), seatGateFolder(SEAT), "seen");
    chmodSync(dir, 0o000);
    cleanups.push(() => { chmodSync(dir, 0o700); });
    expect(storeOf(s).read(SEAT, { id: "m-1", nonce: NONCE })).toMatchObject({ kind: "unavailable" });
  });
});

describe("seatGateFolder", () => {
  it("keeps a seat name to one safe folder, as the relay does", () => {
    expect(seatGateFolder("dev.impl@rig/1")).toBe("dev%2Eimpl%40rig%2F1");
    expect(seatGateFolder("..")).toBe("%2E%2E");
  });
});

describe("transcriptMarkers", () => {
  it("finds a marker that straddles two chunks", () => {
    const s = seat();
    const path = join(s.home, "t.jsonl");
    const text = marker("m-1");
    writeFileSync(path, `${"x".repeat(64 - 5)}${text}${"y".repeat(100)}`);
    expect([...transcriptMarkers(path, 64)!.values()]).toEqual([{ id: "m-1", nonce: NONCE }]);
  });

  it("no file is an empty answer; an unreadable one is no answer", () => {
    const s = seat();
    expect(transcriptMarkers(join(s.home, "absent"))!.size).toBe(0);
    const path = join(s.home, "t.jsonl");
    writeFileSync(path, "x");
    chmodSync(path, 0o000);
    cleanups.push(() => { chmodSync(path, 0o600); });
    expect(transcriptMarkers(path)).toBeNull();
  });
});
