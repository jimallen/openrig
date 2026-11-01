// hc cutover (QA N7): an hc send nothing can settle must not stay silent. It surfaces in `rig health`, never as a resend.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createDaemon } from "../src/startup.js";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { OutboxHandler, labelForTmuxSend } from "../src/domain/outbox-handler.js";
import { HcUnsettledHealthSource, outboxHcUnsettledRows } from "../src/domain/hc-unsettled-health.js";
import type { HcPendingSend } from "../src/adapters/hc-delivery.js";

// Far from the wall clock, so a source that read Date.now() instead of its clock would see every row as long past or future.
const T0 = Date.parse("2031-03-04T05:00:00.000Z");
const MIN = 60_000;
const sqliteStamp = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 19);
const PENDING: HcPendingSend = { version: 1, seat: "reviewer@rig", address: "t4", token: null, sendStartedAtMs: T0, preTurn: 0, preStatus: null, preReported: false, commandLed: false, preScreen: null };

describe("HcUnsettledHealthSource", () => {
  let db: Database.Database;
  let outbox: OutboxHandler;
  beforeEach(() => { db = createDb(); migrate(db, ALL_MIGRATIONS); outbox = new OutboxHandler(db); });
  afterEach(() => db.close());

  /** An hc row left indeterminate, dispatched `agoMin` minutes before T0. */
  function unsettled(id: string, agoMin: number, destination = "reviewer@rig", reason: "waiting_on_person" | "delivery_outcome_unknown" = "waiting_on_person"): void {
    outbox.record({ outboxId: id, senderSession: "planner@rig", destinationSession: destination, body: "x", auditPointer: id, identityProvenance: "transport:v1" });
    db.prepare("UPDATE outbox_entries SET ts_dispatched = ? WHERE outbox_id = ?").run(sqliteStamp(T0 - agoMin * MIN), id);
    outbox.markIndeterminate(id, labelForTmuxSend({ ok: false, path: "hc", reason, hcPending: PENDING }));
  }
  const source = (nowMs = T0) => new HcUnsettledHealthSource(outboxHcUnsettledRows(outbox), () => new Date(nowMs));

  it("is silent while every open row is younger than the bound (15 min, restated here)", () => {
    unsettled("a", 14);
    expect(source().coverage()).toEqual([]);
    expect(source().read()).toEqual([]);
  });

  it("raises one notice once a row has waited over the bound, naming the oldest and its seat, and saying nothing is resent", () => {
    unsettled("young", 3, "other@rig");
    unsettled("old", 16, "reviewer@rig");
    unsettled("older", 90, "gone@rig", "delivery_outcome_unknown");
    const rows = source().coverage();
    expect(rows).toHaveLength(1);
    const notice = rows[0];
    if (notice?.status !== "notice") throw new Error("expected a notice row");
    expect(notice).toMatchObject({ source: "hc-unsettled-sends", status: "notice", partial: false, evaluatedAt: new Date(T0).toISOString() });
    expect(notice.reason).toContain("2 message(s)");   // old and older, not young
    expect(notice.reason).toContain("oldest older to gone@rig, 90 min");
    expect(notice.reason).toMatch(/not resent/);
    expect(notice.reason).toContain("rig capture gone@rig");
  });

  it("the bound is exclusive at 15 min and inclusive just past it", () => {
    unsettled("edge", 15);
    expect(source().coverage()).toEqual([]);
    expect(source(T0 + 1).coverage()).toHaveLength(1);
  });

  it("clears by itself when the row settles, and ignores rows that are not hc-unsettled", () => {
    unsettled("a", 60);
    expect(source().coverage()).toHaveLength(1);
    outbox.settleHcUnsettled("a", "delivered", { path: "hc", evidence: "verified_after_wait", detail: "turn_advanced" });
    expect(source().coverage()).toEqual([]);
    outbox.record({ outboxId: "plain", senderSession: "p@rig", destinationSession: "d@rig", body: "x", auditPointer: "plain", identityProvenance: "transport:v1" });
    db.prepare("UPDATE outbox_entries SET ts_dispatched = ? WHERE outbox_id = 'plain'").run(sqliteStamp(T0 - 600 * MIN));
    expect(source().coverage()).toEqual([]);
  });

  /** A wake intent a daemon claimed (`sending`) and then died on, dispatched `agoMin` minutes before T0. */
  function abandonedClaim(id: string, agoMin: number): void {
    outbox.record({ outboxId: id, senderSession: "planner@rig", destinationSession: "reviewer@rig", body: "x", auditPointer: id, identityProvenance: "transport:v1" });
    db.prepare("UPDATE outbox_entries SET ts_dispatched = ? WHERE outbox_id = ?").run(sqliteStamp(T0 - agoMin * MIN), id);
    expect(outbox.claimForDelivery(id)).toBe(true);
  }

  it("names what a crashed daemon left on an hc host: the abandoned claim carries no record and used to leave no trace", () => {
    abandonedClaim("wake-intent-crash", 20);
    expect(outbox.reconcileAbandonedSending("wake-intent-", "hc")).toBe(1);
    expect(outbox.getById("wake-intent-crash")).toMatchObject({ deliveryState: "indeterminate", deliveryPath: "hc", ackEvidence: "crash_reconciled" });
    const rows = source().coverage();
    expect(rows).toHaveLength(1);
    const notice = rows[0];
    if (notice?.status !== "notice") throw new Error("expected a notice row");
    expect(notice.reason).toContain("oldest wake-intent-crash to reviewer@rig, 20 min");
  });

  it("is silent about that claim for the first 15 minutes, as for any unsettled row", () => {
    abandonedClaim("wake-intent-fresh", 14);
    outbox.reconcileAbandonedSending("wake-intent-", "hc");
    expect(source().coverage()).toEqual([]);
  });

  it("leaves a tmux host's abandoned claim where it was: the default label is still tmux and the notice does not claim it", () => {
    abandonedClaim("wake-intent-old", 90);
    outbox.reconcileAbandonedSending("wake-intent-");
    expect(outbox.getById("wake-intent-old")).toMatchObject({ deliveryPath: "tmux", ackEvidence: "crash_reconciled" });
    expect(source().coverage()).toEqual([]);
  });

  it("names the verb that closes the row, with the row's own seat and id", () => {
    unsettled("old", 40, "reviewer@rig");
    const notice = source().coverage()[0];
    if (notice?.status !== "notice") throw new Error("expected a notice row");
    expect(notice.reason).toContain('rig seat retire-unsettled-send reviewer@rig old --reason "<what you found>"');
  });

  it("says which rows were proved lost, and that nothing resends them (QA F5)", () => {
    unsettled("waits", 40, "a@rig");
    unsettled("lost-1", 30, "b@rig");
    expect(outbox.markHcSendGone("lost-1")).toBe(true);
    const notice = source().coverage()[0];
    if (notice?.status !== "notice") throw new Error("expected a notice row");
    expect(notice.reason).toContain("2 message(s)");
    expect(notice.reason).toContain("1 of them (lost-1 to b@rig) were proved lost with a core restart: nothing resends them");
    const none = new HcUnsettledHealthSource(() => [{ outboxId: "x", destination: "a@rig", since: sqliteStamp(T0 - 40 * MIN) }], () => new Date(T0)).coverage()[0];
    if (none?.status !== "notice") throw new Error("expected a notice row");
    expect(none.reason).not.toContain("proved lost");
  });

  it("closes when an operator retires the row", () => {
    unsettled("old", 40, "reviewer@rig");
    expect(source().coverage()).toHaveLength(1);
    outbox.retireHcUnsettled("old", "reviewer@rig", "operator@rig", "looked", T0);
    expect(source().coverage()).toEqual([]);
  });

  it("reads only: no row changes", () => {
    unsettled("a", 60);
    const before = db.prepare("SELECT * FROM outbox_entries").all();
    source().coverage();
    expect(db.prepare("SELECT * FROM outbox_entries").all()).toEqual(before);
  });
});

describe("across a restart", () => {
  it("a row's 15 minutes run from its own dispatch time in the database, so a restart neither resets them nor drops the row", () => {
    const dir = mkdtempSync(join(tmpdir(), "hc-unsettled-restart-"));
    const file = join(dir, "openrig.sqlite");
    try {
      const first = createDb(file);
      migrate(first, ALL_MIGRATIONS);
      const before = new OutboxHandler(first);
      before.record({ outboxId: "waiting", senderSession: "planner@rig", destinationSession: "reviewer@rig", body: "x", auditPointer: "waiting", identityProvenance: "transport:v1" });
      first.prepare("UPDATE outbox_entries SET ts_dispatched = ? WHERE outbox_id = 'waiting'").run(sqliteStamp(T0 - 16 * MIN));
      before.markIndeterminate("waiting", labelForTmuxSend({ ok: false, path: "hc", reason: "waiting_on_person", hcPending: PENDING }));
      expect(new HcUnsettledHealthSource(outboxHcUnsettledRows(before), () => new Date(T0)).coverage()).toHaveLength(1);
      first.close();  // the daemon is gone
      const second = createDb(file);  // a new process: nothing carried over but the file
      const after = new OutboxHandler(second);
      expect(new HcUnsettledHealthSource(outboxHcUnsettledRows(after), () => new Date(T0)).coverage()).toHaveLength(1);
      expect(new HcUnsettledHealthSource(outboxHcUnsettledRows(after), () => new Date(T0 - 2 * MIN)).coverage()).toEqual([]);  // and the age is the row's, not the process's
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the daemon's `rig health` carries it", () => {
  it("an hc send left unsettled for over the bound shows as a notice in the health projection, and a young one does not", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hc-unsettled-"));
    const file = join(dir, "openrig.sqlite");
    const seeded = createDb(file);
    migrate(seeded, ALL_MIGRATIONS);
    const outbox = new OutboxHandler(seeded);
    const add = (id: string, ageMin: number) => {
      outbox.record({ outboxId: id, senderSession: "planner@rig", destinationSession: "reviewer@rig", body: "x", auditPointer: id, identityProvenance: "transport:v1" });
      seeded.prepare("UPDATE outbox_entries SET ts_dispatched = ? WHERE outbox_id = ?").run(sqliteStamp(Date.now() - ageMin * MIN), id);
      outbox.markIndeterminate(id, labelForTmuxSend({ ok: false, path: "hc", reason: "waiting_on_person", hcPending: PENDING }));
    };
    add("hc-old", 45);
    add("hc-young", 2);
    seeded.close();
    const daemon = await createDaemon({ dbPath: file });
    try {
      const row = (daemon.deps.healthProjection!.list().coverage ?? []).find((c) => c.source === "hc-unsettled-sends");
      expect(row).toMatchObject({ status: "notice", partial: false });
      expect(JSON.stringify(row)).toContain("1 message(s)");
      expect(JSON.stringify(row)).toContain("oldest hc-old");
    } finally {
      daemon.hcCoreWatch?.stop();
      daemon.eventLoopMonitor.stop();
      daemon.db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it("a daemon killed while it held a wake claim on an hc seat: after the restart the claim shows in `rig health` once it is past the bound", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hc-unsettled-crash-"));
    const file = join(dir, "openrig.sqlite");
    const seeded = createDb(file);
    migrate(seeded, ALL_MIGRATIONS);
    const outbox = new OutboxHandler(seeded);
    for (const [id, ageMin] of [["wake-intent-crashed", 45], ["wake-intent-crashed-young", 2]] as const) {
      outbox.record({ outboxId: id, senderSession: "planner@rig", destinationSession: "reviewer@rig", body: "x", auditPointer: id, identityProvenance: "transport:v1" });
      seeded.prepare("UPDATE outbox_entries SET ts_dispatched = ? WHERE outbox_id = ?").run(sqliteStamp(Date.now() - ageMin * MIN), id);
      expect(outbox.claimForDelivery(id)).toBe(true);  // `sending`: the process died here
    }
    seeded.close();
    const daemon = await createDaemon({ dbPath: file });
    try {
      const row = (daemon.deps.healthProjection!.list().coverage ?? []).find((c) => c.source === "hc-unsettled-sends");
      expect(row).toMatchObject({ status: "notice", partial: false });
      expect(JSON.stringify(row)).toContain("1 message(s)");
      expect(JSON.stringify(row)).toContain("oldest wake-intent-crashed to reviewer@rig");
    } finally {
      daemon.hcCoreWatch?.stop();
      daemon.eventLoopMonitor.stop();
      daemon.db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
