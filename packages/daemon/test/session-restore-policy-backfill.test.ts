import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { sessionRestorePolicyBackfillSchema } from "../src/db/migrations/109_session_restore_policy_backfill.js";

// OF-28: sessions written before `registerSession` copied the seat's policy carry the column default whatever their node
// says. The backfill sets each session to its node's policy; it must not touch a row that already matches, must leave a
// node with no recorded policy alone, and must be safe to run twice.
const dbs: Database.Database[] = [];
afterEach(() => { for (const d of dbs.splice(0)) d.close(); });

function beforeBackfill() {
  const db = createDb(); dbs.push(db);
  migrate(db, ALL_MIGRATIONS.filter((m) => m.name !== sessionRestorePolicyBackfillSchema.name));
  db.prepare("INSERT INTO rigs (id, name) VALUES ('rig-1', 'kernel')").run();
  const node = (id: string, logical: string, policy: string | null) =>
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id, runtime, restore_policy) VALUES (?, 'rig-1', ?, 'terminal', ?)").run(id, logical, policy);
  const session = (id: string, nodeId: string, policy: string) =>
    db.prepare("INSERT INTO sessions (id, node_id, session_name, restore_policy) VALUES (?, ?, ?, ?)").run(id, nodeId, `${id}@kernel`, policy);
  node("n-term", "operator.human", "checkpoint_only");
  node("n-agent", "advisor.lead", "resume_if_possible");
  node("n-fresh", "queue.worker", "relaunch_fresh");
  node("n-null", "ghost.seat", null);
  session("s-term-old", "n-term", "checkpoint_only");     // already matches (the first, instantiator-patched session)
  session("s-term-1", "n-term", "resume_if_possible");    // differs: the bug's rows
  session("s-term-2", "n-term", "resume_if_possible");    // differs, newest
  session("s-agent", "n-agent", "resume_if_possible");    // matches
  session("s-fresh", "n-fresh", "resume_if_possible");    // differs, another non-default policy
  session("s-null", "n-null", "checkpoint_only");         // node records no policy: untouched
  return db;
}
const policies = (db: Database.Database) =>
  Object.fromEntries((db.prepare("SELECT id, restore_policy FROM sessions ORDER BY id").all() as Array<{ id: string; restore_policy: string }>).map((r) => [r.id, r.restore_policy]));

describe("109 session restore-policy backfill", () => {
  it("is registered in the canonical migration list", () => {
    expect(ALL_MIGRATIONS.map((m) => m.name)).toContain("109_session_restore_policy_backfill.sql");
  });

  it("corrects the rows that differ from their node, and only those", () => {
    const db = beforeBackfill();
    expect(policies(db)).toEqual({
      "s-agent": "resume_if_possible", "s-fresh": "resume_if_possible", "s-null": "checkpoint_only",
      "s-term-1": "resume_if_possible", "s-term-2": "resume_if_possible", "s-term-old": "checkpoint_only",
    });
    migrate(db, ALL_MIGRATIONS);
    expect(policies(db)).toEqual({
      "s-agent": "resume_if_possible",   // matched: untouched
      "s-fresh": "relaunch_fresh",       // corrected to its node's non-default policy
      "s-null": "checkpoint_only",       // node has no policy: untouched
      "s-term-1": "checkpoint_only",     // corrected
      "s-term-2": "checkpoint_only",     // corrected
      "s-term-old": "checkpoint_only",   // matched: untouched
    });
  });

  it("changes exactly the differing rows (3), not more", () => {
    const db = beforeBackfill();
    const changes = db.prepare(sessionRestorePolicyBackfillSchema.sql.trim().replace(/;\s*$/, "")).run().changes;
    expect(changes).toBe(3);
  });

  it("running it again is a no-op", () => {
    const db = beforeBackfill();
    migrate(db, ALL_MIGRATIONS);
    const once = policies(db);
    expect(db.prepare(sessionRestorePolicyBackfillSchema.sql.trim().replace(/;\s*$/, "")).run().changes).toBe(0);
    migrate(db, ALL_MIGRATIONS); // already recorded in schema_migrations
    expect(policies(db)).toEqual(once);
  });
});
