// OF-207 against a real private hc core: the core holds ONE seat terminal and nothing else. When that terminal ends, `seat.lost` must fire.
// (Measured at 0ef2941c with a real Claude seat: 240+ s without a finding; a second seat launched in the core flipped it within 10 s.)
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { HcAdapter } from "../src/adapters/hc-adapter.js";
import { hcTerminalName } from "../src/adapters/hc-host.js";
import type { HcTerminal } from "../src/adapters/hc-client.js";
import { SeatIdentityReconciler } from "../src/domain/seat-identity-reconciler.js";
import { SeatIdentityStore } from "../src/domain/seat-identity-store.js";
import { SeatLostHealthSource, inventoryOfLiveRigs } from "../src/domain/seat-lost-health.js";
import { HC, PrivateCore, waitUntil } from "./helpers/hc-private-core.js";

describe.skipIf(!HC)("seat.lost when the lost seat is the only terminal of a private hc core", () => {
  const core = new PrivateCore();
  let db: Database.Database;
  const SEAT = "solo@of207";

  beforeAll(async () => {
    core.start();
    db = createFullTestDb();
    await core.runSeat(SEAT, "sleep 600");
    const t = await core.client.call<HcTerminal>("terminal.get", { terminal: hcTerminalName(SEAT) });
    db.prepare("INSERT INTO rigs (id, name) VALUES ('rig-1', 'of207')").run();
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id, runtime, cwd) VALUES ('n1', 'rig-1', 'solo.seat', 'claude-code', '/tmp')").run();
    db.prepare("INSERT INTO sessions (id, node_id, session_name, status, startup_status) VALUES ('s1', 'n1', ?, 'running', 'ready')").run(SEAT);
    db.prepare("INSERT INTO bindings (id, node_id, attachment_type, tmux_session, terminal_address) VALUES ('b1', 'n1', 'hc', ?, ?)").run(SEAT, t.address);
  }, 30_000);
  afterAll(() => { db?.close(); core.stop(); });

  it("a live terminal is not lost; after it ends, the next poll says session_missing and seat.lost reports it", async () => {
    const rec = new SeatIdentityReconciler({ db, tmux: new HcAdapter(core.client) });
    const store = new SeatIdentityStore(db);
    const lost = () => new SeatLostHealthSource({ inventory: () => inventoryOfLiveRigs(db), waiting: () => null }).read();
    await rec.reconcileAll();
    expect(store.getForNode("n1")?.reason).not.toBe("session_missing");
    expect(lost()).toEqual([]);

    await core.client.call("terminal.kill", { terminal: hcTerminalName(SEAT) });
    const verdict = await waitUntil(async () => { await rec.reconcileAll(); return store.getForNode("n1"); }, (v) => v?.reason === "session_missing", "session_missing");
    expect(verdict).toMatchObject({ verdict: "pane_missing", evidenceSource: "tmux_session" });
    expect(lost().flatMap((o) => (o.kind === "seat-lost" ? [o.sessionName] : []))).toEqual([SEAT]);
  }, 30_000);
});
