// OF-138: restore stays quiet about "no durably-bound session name" only when the seat's NEWEST session row was ended by a
// supported stop (rig down / rig seat stop). Production consequence: a wrong answer here hides, or wrongly raises, the FR-5
// warning for a seat whose binding was lost without a stop.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { createFullTestDb } from "./helpers/test-app.js";

describe("SessionRegistry.latestSessionWasIntentionallyStopped", () => {
  let db: Database.Database;
  let registry: SessionRegistry;
  beforeEach(() => {
    db = createFullTestDb();
    registry = new SessionRegistry(db);
    db.prepare("INSERT INTO rigs (id, name) VALUES ('rig-1', 'r')").run();
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id, role, runtime) VALUES ('node-1', 'rig-1', 'dev', 'worker', 'claude-code')").run();
  });
  afterEach(() => { if (db.open) db.close(); });

  function twoRows(): { first: string; second: string } {
    const first = registry.registerSession("node-1", "first@r").id;
    const second = registry.registerSession("node-1", "second@r").id;
    expect(second > first, "ids are monotonic, so the second row is the newer one").toBe(true);
    return { first, second };
  }

  it("is false for a seat with no session row, and for a newest row that was not stopped on purpose", () => {
    expect(registry.latestSessionWasIntentionallyStopped("node-1")).toBe(false);
    const { first } = twoRows();
    registry.markIntentionallyStopped(first);
    expect(registry.latestSessionWasIntentionallyStopped("node-1"), "the newest row is the unstopped one").toBe(false);
  });

  it("equal created_at: the row with the higher id decides", () => {
    const { first, second } = twoRows();
    db.prepare("UPDATE sessions SET created_at = '2030-01-01 00:00:00' WHERE node_id = 'node-1'").run();
    registry.markIntentionallyStopped(first);
    expect(registry.latestSessionWasIntentionallyStopped("node-1"), "higher id is not stopped").toBe(false);
    registry.markIntentionallyStopped(second);
    expect(registry.latestSessionWasIntentionallyStopped("node-1"), "higher id is stopped").toBe(true);
  });

  it("a clock rollback does not change which row is newest: registration order (id) decides, not created_at", () => {
    const { first, second } = twoRows();
    db.prepare("UPDATE sessions SET created_at = '2030-01-01 00:00:00' WHERE id = ?").run(first);
    db.prepare("UPDATE sessions SET created_at = '2001-01-01 00:00:00' WHERE id = ?").run(second); // registered later, stamped earlier
    registry.markIntentionallyStopped(second);
    expect(registry.latestSessionWasIntentionallyStopped("node-1")).toBe(true);
  });

  it("an unreadable session table answers false, so the caller keeps warning", () => {
    const { second } = twoRows();
    registry.markIntentionallyStopped(second);
    expect(registry.latestSessionWasIntentionallyStopped("node-1"), "premise: readable and stopped").toBe(true);
    db.close();
    expect(registry.latestSessionWasIntentionallyStopped("node-1")).toBe(false);
  });
});
