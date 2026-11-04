// OF-207: `seat.lost` never fired when the lost seat was the last live terminal in its hc core. The reconciler read zero live sessions as a
// transient tmux blip (`tmux_unavailable`, which `rig ps` and `rig health` do not treat as a lost seat), so a single-seat core whose one terminal
// died kept reading "unavailable" for as long as it stayed empty (240+ s measured with a real Claude seat; launching another seat flipped it to
// `session_missing` within one poll). On hc the listing throws when the core cannot be reached, so an empty listing from a core that ANSWERED is a
// fact: every running seat's terminal is gone. A tmux server with no sessions keeps the blip reading (it cannot be told from a server that has not
// started). Production entrypoint: startup.ts constructs `SeatIdentityReconciler({ db, tmux: tmuxAdapter })` with the HcAdapter; `seat-lost-health.ts`
// (the `seat.lost` source) reads the verdict it persists through the node inventory.
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { FakeHc, terminal } from "./helpers/hc-fake-client.js";
import { HcAdapter } from "../src/adapters/hc-adapter.js";
import { HcUnavailableError } from "../src/adapters/hc-client.js";
import { SEAT_LABEL } from "../src/adapters/hc-host.js";
import { SeatIdentityReconciler } from "../src/domain/seat-identity-reconciler.js";
import { SeatIdentityStore } from "../src/domain/seat-identity-store.js";
import { SeatLostHealthSource, inventoryOfLiveRigs } from "../src/domain/seat-lost-health.js";

const NOW = () => new Date("2026-11-04T12:00:00.000Z");
const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function seed(runtime: string): Database.Database {
  const db = createFullTestDb(); databases.push(db);
  db.prepare("INSERT INTO rigs (id, name) VALUES ('rig-1', 'solo-rig')").run();
  db.prepare("INSERT INTO nodes (id, rig_id, logical_id, runtime, cwd) VALUES ('n1', 'rig-1', 'dev.impl', ?, '/tmp')").run(runtime);
  db.prepare("INSERT INTO sessions (id, node_id, session_name, status, startup_status, created_at) VALUES ('s1', 'n1', 'dev-impl@solo-rig', 'running', 'ready', '2026-11-04 11:00:00')").run();
  db.prepare("INSERT INTO bindings (id, node_id, attachment_type, tmux_session, terminal_address) VALUES ('b1', 'n1', 'hc', 'dev-impl@solo-rig', 't7')").run();
  return db;
}

/** An hc seat host over a core that answers `terminal.list` with these terminals, or does not answer (the core is down). */
function hcHost(listing: () => ReturnType<typeof terminal>[]): HcAdapter {
  return new HcAdapter(new FakeHc({
    "terminal.list": () => ({ terminals: listing(), hidden_finished: 0 }),
    "terminal.get": () => { throw new HcUnavailableError("not asked in this test"); },
  }));
}
/** OF-205 (b): a missing session is recorded when two polls in a row read it. */
const twice = async (rec: SeatIdentityReconciler) => { await rec.reconcileAll(); await rec.reconcileAll(); };
const down = (): never => { throw new HcUnavailableError("core is down"); };

describe("OF-207: the last seat terminal of an hc core", () => {
  it.each(["claude-code", "codex", "pi"])("%s: an empty listing from a core that answered is session_missing, and `seat.lost` reports it", async (runtime) => {
    const db = seed(runtime);
    await twice(new SeatIdentityReconciler({ db, tmux: hcHost(() => []), now: NOW }));
    expect(new SeatIdentityStore(db).getForNode("n1")).toMatchObject({ verdict: "pane_missing", reason: "session_missing", evidenceSource: "tmux_session" });
    const found = new SeatLostHealthSource({ inventory: () => inventoryOfLiveRigs(db), waiting: () => null, now: NOW }).read();
    expect(found.flatMap((o) => (o.kind === "seat-lost" ? [o.sessionName] : []))).toEqual(["dev-impl@solo-rig"]);
    expect(found, "nothing but the seat-lost finding").toHaveLength(1);
  });

  it("a terminal that is not a seat (no seat label) does not keep the seat alive: still session_missing", async () => {
    const db = seed("claude-code");
    await twice(new SeatIdentityReconciler({ db, tmux: hcHost(() => [terminal({ address: "t1", labels: {} })]), now: NOW }));
    expect(new SeatIdentityStore(db).getForNode("n1")?.reason).toBe("session_missing");
  });

  it("a core that does not answer stays tmux_unavailable and reports no lost seat (an unreachable core never reads as gone)", async () => {
    const db = seed("claude-code");
    await new SeatIdentityReconciler({ db, tmux: hcHost(down), now: NOW }).reconcileAll();
    expect(new SeatIdentityStore(db).getForNode("n1")).toMatchObject({ verdict: "tmux_unavailable", reason: "tmux_unavailable" });
    expect(new SeatLostHealthSource({ inventory: () => inventoryOfLiveRigs(db), waiting: () => null, now: NOW }).read()).toEqual([]);
  });

  it("a live seat terminal keeps the seat out of session_missing (positive control for the fix's branch)", async () => {
    const db = seed("claude-code");
    const live = terminal({ address: "t7", labels: { [SEAT_LABEL]: "dev-impl@solo-rig" } });
    await new SeatIdentityReconciler({ db, tmux: hcHost(() => [live]), now: NOW }).reconcileAll();
    expect(new SeatIdentityStore(db).getForNode("n1")?.reason).not.toBe("session_missing");
  });
});
