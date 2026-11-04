// OF-205 (b), from the OF-200 review G3: a supported stop (`rig down`), a script-backed restart, a handover respawn or a restore ends a seat's terminal a moment
// before the session row is written. A reconcile poll inside that moment read `session_missing`, and the verdict stays until the next poll (5 s), so `rig health`
// reported a `seat.lost` (critical if messages wait) that cleared by itself. The reconciler now records a missing session only when two polls in a row read it:
// the first such read leaves the previous verdict standing. A crash is reported one poll later; it is never missed.
// Production entrypoint: startup.ts constructs the reconciler over the hc host and starts its 5 s timer; seat-lost-health.ts reads the verdict it records.
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

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

const A = "dev-a@solo-rig";
const B = "dev-b@solo-rig";
type Core = { live: string[]; down: boolean };

function fixture(seatNames = [A]) {
  const db = createFullTestDb(); databases.push(db);
  db.prepare("INSERT INTO rigs (id, name) VALUES ('rig-1', 'solo-rig')").run();
  seatNames.forEach((name, i) => {
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id, runtime, cwd) VALUES (?, 'rig-1', ?, 'claude-code', '/tmp')").run(`n${i}`, `dev.${name[4]}`);
    db.prepare("INSERT INTO sessions (id, node_id, session_name, status, startup_status, created_at) VALUES (?, ?, ?, 'running', 'ready', '2026-11-04 11:00:00')").run(`s${i}`, `n${i}`, name);
    db.prepare("INSERT INTO bindings (id, node_id, attachment_type, tmux_session, terminal_address) VALUES (?, ?, 'hc', ?, ?)").run(`b${i}`, `n${i}`, name, `t${i + 7}`);
  });
  const core: Core = { live: [...seatNames], down: false };
  const host = new HcAdapter(new FakeHc({
    "terminal.list": () => {
      if (core.down) throw new HcUnavailableError("core is down");
      return { terminals: core.live.map((name) => terminal({ address: `t${seatNames.indexOf(name) + 7}`, labels: { [SEAT_LABEL]: name } })), hidden_finished: 0 };
    },
    "terminal.get": (params) => {
      if (core.down) throw new HcUnavailableError("core is down");
      const name = seatNames.find((n) => core.live.includes(n) && params["terminal"] === `t${seatNames.indexOf(n) + 7}`);
      if (!name) throw new HcUnavailableError("not asked in this test");
      return terminal({ address: params["terminal"] as string, labels: { [SEAT_LABEL]: name } });
    },
  }));
  let tick = 0;
  const rec = new SeatIdentityReconciler({ db, tmux: host, now: () => new Date(Date.UTC(2026, 10, 4, 12, 0, 5 * tick++)) });
  const store = new SeatIdentityStore(db);
  const reason = (node: string) => store.getForNode(node)?.reason ?? "(no verdict)";
  const lost = () => new SeatLostHealthSource({ inventory: () => inventoryOfLiveRigs(db), waiting: () => null, now: () => new Date("2026-11-04T13:00:00Z") }).read().flatMap((o) => (o.kind === "seat-lost" ? [o.sessionName] : []));
  return { db, core, rec, store, reason, lost };
}

describe("OF-205 (b): a missing session is recorded only when two polls in a row read it", () => {
  it("a crash: the first poll that finds the terminal gone records nothing new, the second records session_missing and seat.lost reports it", async () => {
    const f = fixture();
    await f.rec.reconcileAll();
    const before = f.store.getForNode("n0")!.verdict;
    expect(before).not.toBe("pane_missing");
    f.core.live = [];
    await f.rec.reconcileAll();
    expect(f.store.getForNode("n0")?.verdict, "the first read of a gone terminal leaves the previous verdict standing").toBe(before);
    expect(f.lost()).toEqual([]);
    await f.rec.reconcileAll();
    expect(f.reason("n0")).toBe("session_missing");
    expect(f.lost()).toEqual([A]);
  });

  it("a restart blip: the terminal is missing for one poll and back at the next, and no verdict ever says missing", async () => {
    const f = fixture();
    await f.rec.reconcileAll();
    f.core.live = [];
    await f.rec.reconcileAll();
    f.core.live = [A];
    await f.rec.reconcileAll();
    expect(f.reason("n0")).not.toBe("session_missing");
    f.core.live = [];
    await f.rec.reconcileAll();  // gone again: this is a first read once more, not the second of the earlier pair
    expect(f.reason("n0")).not.toBe("session_missing");
    expect(f.lost()).toEqual([]);
  });

  it("two reads must be consecutive: a poll that could not ask the core in between starts the count again", async () => {
    const f = fixture();
    await f.rec.reconcileAll();
    f.core.live = [];
    await f.rec.reconcileAll();           // first read
    f.core.down = true;
    await f.rec.reconcileAll();           // the core could not be asked: neither confirms nor refutes
    f.core.down = false;
    await f.rec.reconcileAll();           // first read again
    expect(f.reason("n0")).not.toBe("session_missing");
    await f.rec.reconcileAll();
    expect(f.reason("n0")).toBe("session_missing");
  });

  it("each seat counts on its own: one seat gone for two polls is lost while its sibling's single missed poll is not", async () => {
    const f = fixture([A, B]);
    await f.rec.reconcileAll();
    f.core.live = [B];                    // A gone
    await f.rec.reconcileAll();
    f.core.live = [];                     // B blips as A stays gone
    await f.rec.reconcileAll();
    expect(f.reason("n0"), "A: second read").toBe("session_missing");
    expect(f.reason("n1"), "B: first read").not.toBe("session_missing");
    f.core.live = [B];
    await f.rec.reconcileAll();
    expect(f.reason("n0")).toBe("session_missing");
    expect(f.reason("n1")).not.toBe("session_missing");
    expect(f.lost()).toEqual([A]);
  });

  it("a seat that never had a verdict has none after its first missing read (an absent verdict never down-ranks)", async () => {
    const f = fixture();
    f.core.live = [];
    await f.rec.reconcileAll();
    expect(f.store.getForNode("n0")).toBeNull();
  });

  it("a missing read of one session name does not count toward another: a new session on the same node starts the count again", async () => {
    const f = fixture();
    await f.rec.reconcileAll();
    f.core.live = [];
    await f.rec.reconcileAll();           // A, first read
    f.db.prepare("INSERT INTO sessions (id, node_id, session_name, status, startup_status, created_at) VALUES ('s9', 'n0', 'dev-a2@solo-rig', 'running', 'ready', '2026-11-04 11:30:00')").run();
    await f.rec.reconcileAll();           // dev-a2, first read
    expect(f.reason("n0")).not.toBe("session_missing");
    await f.rec.reconcileAll();
    expect(f.reason("n0")).toBe("session_missing");
  });

  it("a node that stopped running forgets its first read: a restart that replaces its session row starts the count again", async () => {
    const f = fixture();
    await f.rec.reconcileAll();
    f.core.live = [];
    await f.rec.reconcileAll();           // first read
    f.db.prepare("UPDATE sessions SET status = 'exited' WHERE id = 's0'").run();
    await f.rec.reconcileAll();           // the node has no running seat now: nothing is read, and the first read is dropped
    f.db.prepare("INSERT INTO sessions (id, node_id, session_name, status, startup_status, created_at) VALUES ('s8', 'n0', 'dev-a@solo-rig', 'running', 'ready', '2026-11-04 11:45:00')").run();
    await f.rec.reconcileAll();           // the same name, still gone: a first read again
    expect(f.reason("n0")).not.toBe("session_missing");
    await f.rec.reconcileAll();
    expect(f.reason("n0")).toBe("session_missing");
  });
});
