// OF-235, from the OF-205/207 review (review-of205-f5c6cbc1.md, F1/Q2): the two-poll rule (OF-205 b) narrows a false `seat.lost` but does not close it. A
// respawn, `rig down`, restart, handover or restore can leave every labelled terminal absent for far longer than two 5 s polls, and the laptop core holds 27 seats.
// The reconciler now records no missing-session verdict for a seat while the delivery guard's lifecycle lease holds it (`SeatDeliveryGuard.lifecycleHeld`).
// Not `ownsLifecycle`: that reads the lease's async context, and the reconciler's timer is outside every operation's context, so it would always say no.
// A lease that is never released stops excusing after LIFECYCLE_EXCUSE_BASE_MS + LIFECYCLE_EXCUSE_PER_SEAT_MS per seat held (the restore loop is sequential, one startup wait per seat), so a hung operation cannot hide a real loss for ever.
//
// Production entrypoint: startup.ts constructs the SeatDeliveryGuard and the SeatIdentityReconciler (passing the guard's `lifecycleHeld`) and starts the 5 s timer;
// seat-lost-health.ts reads the verdict. These rows use the real guard, the real reconciler and the real health source over a fake hc core; the per-operation
// rows over the real services are in seat-identity-lifecycle-ops.real.test.ts. Times are far from wall clock (2026-11-04) and tick 5 s per sweep.
import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { FakeHc, terminal } from "./helpers/hc-fake-client.js";
import { HcAdapter } from "../src/adapters/hc-adapter.js";
import { HcUnavailableError } from "../src/adapters/hc-client.js";
import { SEAT_LABEL } from "../src/adapters/hc-host.js";
import { SeatDeliveryGuard, resolveGuardTarget } from "../src/domain/seat-delivery-guard.js";
import { LIFECYCLE_EXCUSE_BASE_MS, LIFECYCLE_EXCUSE_PER_SEAT_MS, SeatIdentityReconciler } from "../src/domain/seat-identity-reconciler.js";
import { STARTUP_TEXT_WAIT_MS } from "../src/domain/startup-orchestrator.js";
import { SeatIdentityStore } from "../src/domain/seat-identity-store.js";
import { SeatLostHealthSource, inventoryOfLiveRigs } from "../src/domain/seat-lost-health.js";

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

const SEATS = ["dev-a@solo-rig", "dev-b@solo-rig", "dev-c@solo-rig"];
const [A, B, C] = SEATS as [string, string, string];

function fixture(opts: { seats?: string[]; wired?: boolean; excuse?: { baseMs: number; perSeatMs: number } } = {}) {
  const seatNames = opts.seats ?? [A];
  const db = createDb(); databases.push(db); migrate(db, ALL_MIGRATIONS);
  db.prepare("INSERT INTO rigs (id, name) VALUES ('rig-1', 'solo-rig')").run();
  seatNames.forEach((name, i) => {
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id, runtime, cwd) VALUES (?, 'rig-1', ?, 'claude-code', '/tmp')").run(`n${i}`, `dev.${name[4]}`);
    db.prepare("INSERT INTO sessions (id, node_id, session_name, status, startup_status, created_at) VALUES (?, ?, ?, 'running', 'ready', '2026-11-04 11:00:00')").run(`s${i}`, `n${i}`, name);
    db.prepare("INSERT INTO bindings (id, node_id, attachment_type, tmux_session, terminal_address) VALUES (?, ?, 'hc', ?, ?)").run(`b${i}`, `n${i}`, name, `t${i + 7}`);
  });
  const core = { live: [...seatNames], down: false, onList: null as null | (() => void) };
  const host = new HcAdapter(new FakeHc({
    "terminal.list": () => {
      core.onList?.();
      if (core.down) throw new HcUnavailableError("core is down");
      return { terminals: core.live.map((name) => terminal({ address: `t${seatNames.indexOf(name) + 7}`, labels: { [SEAT_LABEL]: name } })), hidden_finished: 0 };
    },
    "terminal.get": (params) => {
      const name = seatNames.find((n) => core.live.includes(n) && params["terminal"] === `t${seatNames.indexOf(n) + 7}`);
      if (!name) throw new HcUnavailableError("not asked in this test");
      return terminal({ address: params["terminal"] as string, labels: { [SEAT_LABEL]: name } });
    },
  }));
  const guard = new SeatDeliveryGuard(db, (name) => resolveGuardTarget(db, name));
  let tick = 0;
  const rec = new SeatIdentityReconciler({
    db, tmux: host, now: () => new Date(Date.UTC(2026, 10, 4, 12, 0, 5 * tick++)),
    ...(opts.wired === false ? {} : { lifecycleHeld: (id: string) => guard.lifecycleHeld(id) }),
    ...(opts.wired === false ? {} : { lifecycleHeldCount: () => guard.lifecycleHeldCount() }),
    ...(opts.excuse ? { lifecycleExcuse: opts.excuse } : {}),
  });
  const store = new SeatIdentityStore(db);
  const reason = (node: string) => store.getForNode(node)?.reason ?? "(no verdict)";
  const lost = () => new SeatLostHealthSource({ inventory: () => inventoryOfLiveRigs(db), waiting: () => null, now: () => new Date("2026-11-04T13:00:00Z") }).read()
    .flatMap((o) => (o.kind === "seat-lost" ? [o.sessionName] : []));
  /** `n` polls, each followed by what seat.lost reports at that moment. */
  // The reconciler's timer is created outside every operation, so its polls run outside the lease's async context even while the test body is inside one: the
  // snapshot is taken here, before any lease, and each poll runs in it. (A poll made from inside the lease would let `ownsLifecycle` pass for `lifecycleHeld`.)
  const outside = AsyncLocalStorage.snapshot();
  const poll = async (n: number) => { const seen: string[][] = []; for (let i = 0; i < n; i++) { await outside(() => rec.reconcileAll()); seen.push(lost()); } return seen; };
  return { db, core, rec, guard, store, reason, lost, poll };
}

describe("OF-235: a seat a lifecycle lease holds is not reported lost while the operation runs", () => {
  it("a respawn: the terminal is gone for six polls under the lease and back at the end, and seat.lost never reports it", async () => {
    const f = fixture();
    await f.poll(1);
    await f.guard.lifecycle(["n0"], async () => {
      f.core.live = [];
      const seen = await f.poll(6);
      expect(seen, "seat.lost at each of six polls of the absence").toEqual([[], [], [], [], [], []]);
      expect(f.reason("n0")).not.toBe("session_missing");
      f.core.live = [A];
    });
    await f.poll(1);
    expect(f.reason("n0")).not.toBe("session_missing");
    expect(f.lost()).toEqual([]);
  });

  it("rig down of three seats under one lease: every labelled terminal is absent for six polls, and nothing is reported", async () => {
    const f = fixture({ seats: SEATS });
    await f.poll(1);
    await f.guard.lifecycle(["n0", "n1", "n2"], async () => {
      f.core.live = [];
      expect(await f.poll(6)).toEqual([[], [], [], [], [], []]);
    });
    // The operation ends the sessions it stopped (the teardown writes the rows before it releases the lease).
    f.db.prepare("UPDATE sessions SET status = 'exited'").run();
    await f.poll(2);
    expect(f.lost()).toEqual([]);
  });

  it("a crash outside any lifecycle operation is still reported within the two polls (the guard is wired, no lease is held)", async () => {
    const f = fixture();
    await f.poll(1);
    f.core.live = [];
    const seen = await f.poll(2);
    expect(seen).toEqual([[], [A]]);
    expect(f.reason("n0")).toBe("session_missing");
  });

  it("the lease is per seat: one seat under a lease is excused while its sibling's crash is reported on the second poll", async () => {
    const f = fixture({ seats: [A, B] });
    await f.poll(1);
    await f.guard.lifecycle(["n0"], async () => {
      f.core.live = [];                    // A is the operation's; B crashed
      expect(await f.poll(4)).toEqual([[], [B], [B], [B]]);
      expect(f.reason("n0")).not.toBe("session_missing");
      expect(f.reason("n1")).toBe("session_missing");
    });
  });

  it("when the lease ends with the terminal still gone, the two-poll rule starts then: not lost at the first poll after, lost at the second", async () => {
    const f = fixture();
    await f.poll(1);
    await f.guard.lifecycle(["n0"], async () => { f.core.live = []; await f.poll(5); });
    expect(await f.poll(2)).toEqual([[], [A]]);
  });

  it("a lease that is never released stops excusing at the ceiling: a real loss is reported two polls after it", async () => {
    const f = fixture({ excuse: { baseMs: 50_000, perSeatMs: 10_000 } });
    await f.poll(1);
    let release!: () => void;
    const hung = f.guard.lifecycle(["n0"], () => new Promise<void>((resolve) => { release = resolve; }));
    await new Promise((r) => setImmediate(r));
    expect(f.guard.lifecycleHeld("n0")).toBe(true);
    f.core.live = [];
    const seen = await f.poll(16);
    // The hold is first seen by the first of these polls, at t0; the sweeps at t0 .. t0+55 s (twelve of them) are excused, the sweep at t0+60 s is the first read, the next records.
    const firstLost = seen.findIndex((s) => s.length > 0);
    expect(firstLost, "poll index (0-based) of the first seat.lost").toBe(13);
    expect(seen.slice(0, 13).every((s) => s.length === 0)).toBe(true);
    expect(seen.slice(13).every((s) => s.length === 1 && s[0] === A)).toBe(true);
    release(); await hung;
  });

  it("the ceiling grows with the seats the lease table holds: three seats under one lease are excused for 80 s of a 50 s + 10 s per seat bound, not 60", async () => {
    const f = fixture({ seats: SEATS, excuse: { baseMs: 50_000, perSeatMs: 10_000 } });
    await f.poll(1);
    let release!: () => void;
    const hung = f.guard.lifecycle(["n0", "n1", "n2"], () => new Promise<void>((resolve) => { release = resolve; }));
    await new Promise((r) => setImmediate(r));
    expect(f.guard.lifecycleHeldCount()).toBe(3);
    f.core.live = [];
    const seen = await f.poll(20);
    // t0 .. t0+75 s (sixteen sweeps) are excused, the sweep at t0+80 s is the first read, the next records.
    expect(seen.findIndex((x) => x.length > 0), "poll index (0-based) of the first seat.lost").toBe(17);
    expect(seen[17]).toEqual(SEATS);
    release(); await hung;
  });

  it("the ceiling's terms: 10 min plus the startup wait of one seat (STARTUP_TEXT_WAIT_MS, 5 min) per seat held; a change to that wait shows up here", () => {
    expect(LIFECYCLE_EXCUSE_BASE_MS, "measured 0.4 s of OpenRig's own work for 27 stub seats (OF-241)").toBe(10 * 60_000);
    expect(LIFECYCLE_EXCUSE_PER_SEAT_MS, "the bound one seat's turn of the sequential restore can wait").toBe(STARTUP_TEXT_WAIT_MS);
    expect(STARTUP_TEXT_WAIT_MS, "the per-seat bound the ceiling relies on; if it changes, re-judge the ceiling").toBe(5 * 60_000);
    expect(LIFECYCLE_EXCUSE_BASE_MS + 27 * LIFECYCLE_EXCUSE_PER_SEAT_MS, "the laptop's 27 seats").toBe(145 * 60_000);
  });

  it("the hold clock of a seat that stopped running is forgotten: a new lease on it after a long gap starts a new clock", async () => {
    const f = fixture({ seats: [A, B], excuse: { baseMs: 5_000, perSeatMs: 5_000 } });   // 10 s bound with one seat held
    await f.poll(1);
    f.core.live = [B];
    await f.guard.lifecycle(["n0"], async () => {
      await f.poll(3);
      f.db.prepare("UPDATE sessions SET status = 'exited' WHERE id = 's0'").run();
    });
    await f.poll(8);                       // n0 is not running; B keeps the clock ticking (40 s, past the bound)
    f.db.prepare("UPDATE sessions SET status = 'running' WHERE id = 's0'").run();
    await f.guard.lifecycle(["n0"], async () => { expect(await f.poll(3), "a new lease on the relaunched seat").toEqual([[], [], []]); });
  });

  it("a lease taken while the core is being asked, after the pre-listing read, excuses that sweep even with a missing read already counted", async () => {
    const f = fixture();
    await f.poll(1);
    f.core.live = [];
    await f.poll(1);                       // first read of the gap, no lease yet
    let release!: () => void;
    let op!: Promise<void>;
    f.core.onList = () => {
      f.core.onList = null;
      op = f.guard.lifecycle(["n0"], () => new Promise<void>((resolve) => { release = resolve; }));   // the operation starts as the poll asks the core
    };
    expect(await f.poll(1), "the second read of the gap would have recorded it").toEqual([[]]);
    release(); await op;
  });

  it("a seat the lease held and released starts a fresh hold clock the next time", async () => {
    const f = fixture({ excuse: { baseMs: 20_000, perSeatMs: 10_000 } });
    await f.poll(1);
    f.core.live = [];
    await f.guard.lifecycle(["n0"], async () => { await f.poll(5); });   // 25 s of a 30 s ceiling
    await f.poll(1);                                                   // released: clears the clock (first read)
    await f.guard.lifecycle(["n0"], async () => { expect(await f.poll(5)).toEqual([[], [], [], [], []]); });
  });

  it("a lease that ends while the core is being asked still excuses that listing (it may show the middle of the operation)", async () => {
    const f = fixture();
    await f.poll(1);
    let release!: () => void;
    const op = f.guard.lifecycle(["n0"], () => new Promise<void>((resolve) => { release = resolve; }));
    await new Promise((r) => setImmediate(r));
    f.core.live = [];
    f.core.onList = () => { f.core.onList = null; release(); };     // the operation finishes as the poll asks the core, with the terminal still gone
    await f.poll(1);
    await op;
    expect(f.guard.lifecycleHeld("n0")).toBe(false);
    expect(await f.poll(2), "the sweep that straddled the end counted for nothing; the rule starts at the next one").toEqual([[], [A]]);
  });

  it("a missing read from before the lease does not count after it", async () => {
    const f = fixture();
    await f.poll(1);
    f.core.live = [];
    await f.poll(1);                       // first read, before any lease
    await f.guard.lifecycle(["n0"], async () => { expect(await f.poll(3)).toEqual([[], [], []]); });
    expect(await f.poll(2), "the lease's end restarts the count").toEqual([[], [A]]);
  });

  it("only a missing session is excused: under the lease, a seat whose terminal is alive still gets its verdict recorded each poll", async () => {
    const f = fixture();
    await f.poll(1);
    const before = f.store.getForNode("n0")!.observedAt;
    await f.guard.lifecycle(["n0"], async () => { await f.poll(2); });
    expect(f.store.getForNode("n0")!.observedAt, "the verdict written under the lease").not.toBe(before);
  });

  it("a daemon with no guard wired (lifecycleHeld absent) keeps the two-poll rule, as before", async () => {
    const f = fixture({ wired: false });
    await f.poll(1);
    await f.guard.lifecycle(["n0"], async () => {
      f.core.live = [];
      expect(await f.poll(2)).toEqual([[], [A]]);
    });
  });
});

describe("SeatDeliveryGuard.lifecycleHeld", () => {
  it("is true for a caller outside the lease's async context while the lease is held, which ownsLifecycle is not; false before and after", async () => {
    const f = fixture();
    expect(f.guard.lifecycleHeld("n0")).toBe(false);
    let inside: boolean | undefined; let insideOwns: boolean | undefined;
    let release!: () => void;
    const op = f.guard.lifecycle(["n0"], async () => {
      inside = f.guard.lifecycleHeld("n0"); insideOwns = f.guard.ownsLifecycle("n0");
      await new Promise<void>((resolve) => { release = resolve; });
    });
    await new Promise((r) => setImmediate(r));
    expect(inside).toBe(true); expect(insideOwns).toBe(true);
    expect(f.guard.lifecycleHeld("n0"), "from the timer's context").toBe(true);
    expect(f.guard.ownsLifecycle("n0"), "from the timer's context, ownsLifecycle cannot tell").toBe(false);
    expect(f.guard.lifecycleHeld("n1"), "another seat").toBe(false);
    release(); await op;
    expect(f.guard.lifecycleHeld("n0")).toBe(false);
  });

  it("a plain input lease (a send) is not a lifecycle lease", async () => {
    const f = fixture();
    let release!: () => void;
    const op = f.guard.input("n0", () => new Promise<void>((resolve) => { release = resolve; }));
    await new Promise((r) => setImmediate(r));
    expect(f.guard.lifecycleHeld("n0")).toBe(false);
    release(); await op;
  });
});
