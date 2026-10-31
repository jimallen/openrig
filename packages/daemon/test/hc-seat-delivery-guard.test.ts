// hc cutover: the delivery guard resolves a seat on herdr-core. Migration 121 clears `tmux_pane` for an hc row and puts the
// terminal's address in `terminal_address`, so the pane-shaped half of the guard's target is the address: a lease then
// names exactly one terminal, and a seat relaunched under a new address is a changed target.
import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { SeatDeliveryGuard, resolveGuardTarget } from "../src/domain/seat-delivery-guard.js";

function fixture() {
  const db = new Database(":memory:");
  migrate(db, ALL_MIGRATIONS);
  db.exec(`INSERT INTO rigs(id,name) VALUES ('r','fixture');
    INSERT INTO nodes(id,rig_id,logical_id) VALUES ('h','r','hc-worker'), ('t','r','tmux-worker');
    INSERT INTO bindings(id,node_id,attachment_type,tmux_session,tmux_pane,terminal_address) VALUES
      ('bh','h','hc','hc-worker@fixture',NULL,'t7'), ('bt','t','tmux','tmux-worker@fixture','%1',NULL);
    INSERT INTO sessions(id,node_id,session_name,status) VALUES ('sh','h','hc-worker@fixture','running'), ('st','t','tmux-worker@fixture','running');
    INSERT INTO occupant_tenures(id,node_id,generation_ordinal,generation_uuid,kind) VALUES ('gh','h',1,'g1','fresh'), ('gt','t',1,'g2','fresh');`);
  return { db, guard: new SeatDeliveryGuard(db, (name) => resolveGuardTarget(db, name)) };
}

describe("resolveGuardTarget for a seat on hc", () => {
  it("resolves by the seat's name, node, logical id and terminal address, with the address as the pane", () => {
    const { db } = fixture();
    const expected = { nodeId: "h", session: "hc-worker@fixture", occupant: "g1", pane: "t7" };
    for (const name of ["hc-worker@fixture", "h", "hc-worker", "t7"]) expect(resolveGuardTarget(db, name)).toEqual(expected);
    db.close();
  });

  it("leaves a tmux seat's pane id as it was", () => {
    const { db } = fixture();
    expect(resolveGuardTarget(db, "%1")).toEqual({ nodeId: "t", session: "tmux-worker@fixture", occupant: "g2", pane: "%1" });
    expect(resolveGuardTarget(db, "tmux-worker@fixture")?.pane).toBe("%1");
    db.close();
  });

  it("does not take an hc address for a tmux seat, or the reverse", () => {
    const { db } = fixture();
    expect(resolveGuardTarget(db, "t7")?.nodeId).toBe("h");
    expect(resolveGuardTarget(db, "%1")?.nodeId).toBe("t");
    expect(resolveGuardTarget(db, "t8")).toBeNull();
    db.close();
  });

  it("still resolves on a database without the address column", () => {
    const { db } = fixture();
    db.exec("ALTER TABLE bindings DROP COLUMN terminal_address;");
    expect(resolveGuardTarget(db, "tmux-worker@fixture")).toEqual({ nodeId: "t", session: "tmux-worker@fixture", occupant: "g2", pane: "%1" });
    expect(resolveGuardTarget(db, "hc-worker@fixture")?.pane).toBeNull();
    db.close();
  });

  it("sees the column when a migration adds it after the first look", () => {
    const db = new Database(":memory:");
    migrate(db, ALL_MIGRATIONS);
    db.exec("ALTER TABLE bindings DROP COLUMN terminal_address;");
    db.exec(`INSERT INTO rigs(id,name) VALUES ('r','fixture'); INSERT INTO nodes(id,rig_id,logical_id) VALUES ('h','r','hc-worker');
      INSERT INTO bindings(id,node_id,attachment_type,tmux_session) VALUES ('bh','h','hc','hc-worker@fixture');
      INSERT INTO sessions(id,node_id,session_name,status) VALUES ('sh','h','hc-worker@fixture','running');`);
    expect(resolveGuardTarget(db, "hc-worker@fixture")?.pane).toBeNull();  // looked, found no column
    db.exec("ALTER TABLE bindings ADD COLUMN terminal_address TEXT; UPDATE bindings SET terminal_address = 't9' WHERE node_id = 'h';");
    expect(resolveGuardTarget(db, "hc-worker@fixture")?.pane).toBe("t9");
    db.close();
  });

  it("makes a seat relaunched under a new address a changed target for an open lease", async () => {
    const { db, guard } = fixture();
    await guard.operation("hc-worker@fixture", async () => {
      db.prepare("UPDATE bindings SET terminal_address = 't8' WHERE node_id = 'h'").run();
      await expect(guard.input("hc-worker@fixture", async () => {})).rejects.toMatchObject({ code: "guard_target_changed" });
      expect(() => guard.checkInput("hc-worker@fixture")).toThrowError(expect.objectContaining({ code: "guard_target_changed" }));
    });
    db.close();
  });
});

describe("SeatDeliveryGuard.leaseOrigin", () => {
  it("says who holds the lease: an automatic operation, a person in the viewer, or nobody", async () => {
    const { db, guard } = fixture();
    const seat = "hc-worker@fixture";
    expect(guard.leaseOrigin(seat)).toBeNull();
    await guard.operation(seat, async () => { expect(guard.leaseOrigin(seat)).toBe("automatic"); });
    await guard.humanInput(seat, async () => { expect(guard.leaseOrigin(seat)).toBe("human"); });
    await guard.humanInput(seat, () => guard.input(seat, async () => { expect(guard.leaseOrigin(seat)).toBe("human"); }));
    expect(guard.leaseOrigin(seat)).toBeNull();
    db.close();
  });

  it("is null for a name that resolves to no seat, and for another seat's lease", async () => {
    const { db, guard } = fixture();
    expect(guard.leaseOrigin("nobody@fixture")).toBeNull();
    await guard.humanInput("tmux-worker@fixture", async () => { expect(guard.leaseOrigin("hc-worker@fixture")).toBeNull(); });
    db.close();
  });

  it("is null once the lease has ended, even for a task that outlives it", async () => {
    const { db, guard } = fixture();
    const seat = "hc-worker@fixture";
    // The task keeps the lease's async context (a timer started inside the operation) and looks after the lease has ended.
    let later!: Promise<string | null>;
    await guard.humanInput(seat, async () => {
      later = new Promise((resolve) => setTimeout(() => resolve(guard.leaseOrigin(seat)), 20));
    });
    expect(await later).toBeNull();
    db.close();
  });
});
