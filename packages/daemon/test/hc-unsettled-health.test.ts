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
const PENDING: HcPendingSend = { version: 1, seat: "reviewer@rig", address: "t4", token: null, sendStartedAtMs: T0, preTurn: 0, preStatus: null, preReported: false };

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

  it("reads only: no row changes", () => {
    unsettled("a", 60);
    const before = db.prepare("SELECT * FROM outbox_entries").all();
    source().coverage();
    expect(db.prepare("SELECT * FROM outbox_entries").all()).toEqual(before);
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
});
