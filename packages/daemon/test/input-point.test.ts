// OF-285: what the daemon's hook record says about whether a Claude seat has passed a point where it takes queued socket lines since a time.
import { beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { INPUT_POINT_EVENTS, seatInputPoint } from "../src/domain/seat-messaging/input-point.js";

const T0 = Date.parse("2026-11-10T08:07:12.000Z");

describe("seatInputPoint", () => {
  let db: Database.Database;
  const hook = (node: string, rawEvent: string, state: string, atMs: number, rawSubtype: string | null = null) => {
    db.prepare("INSERT INTO events (rig_id, node_id, type, payload) VALUES ('r', ?, 'agent.activity', ?)").run(node, JSON.stringify({
      activity: { rawEvent, rawSubtype, state, eventAt: new Date(atMs).toISOString() },
    }));
  };
  beforeEach(() => { db = createDb(); migrate(db, ALL_MIGRATIONS); });

  it("the events that count are exactly the ones Claude takes input at", () => {
    expect([...INPUT_POINT_EVENTS].sort()).toEqual(["PostToolUse", "PostToolUseFailure", "SessionStart", "Stop", "UserPromptSubmit"]);
  });
  it.each(["PostToolUse", "PostToolUseFailure", "Stop", "UserPromptSubmit", "SessionStart"])("%s after the write has passed one, whatever came after it", (event) => {
    hook("n", event, "idle", T0 + 1);
    hook("n", "PreToolUse", "running", T0 + 2, "Bash");
    expect(seatInputPoint(db, "n", T0)).toBe("passed");
  });
  it("only an event strictly after the write counts", () => {
    hook("n", "PostToolUse", "running", T0, "Bash");
    hook("n", "PreToolUse", "running", T0 + 5, "Bash");
    expect(seatInputPoint(db, "n", T0)).toBe("pending");
    expect(seatInputPoint(db, "n", T0 - 1)).toBe("passed");
  });
  it("another seat's input point is not this seat's", () => {
    hook("other", "Stop", "idle", T0 + 1);
    hook("n", "PreToolUse", "running", T0 - 1, "Bash");
    expect(seatInputPoint(db, "n", T0)).toBe("pending");
  });
  it("a seat last seen running or asking, with nothing since the write, has not passed one", () => {
    hook("n", "PreToolUse", "running", T0 - 1, "Bash");
    expect(seatInputPoint(db, "n", T0)).toBe("pending");
    hook("n", "PermissionRequest", "needs_input", T0 - 1, "AskUserQuestion");
    expect(seatInputPoint(db, "n", T0)).toBe("pending");
  });
  it("a seat last seen idle sits at one; a record that says nothing of its state proves nothing", () => {
    hook("n", "Stop", "idle", T0 - 10);
    expect(seatInputPoint(db, "n", T0)).toBe("passed");
    hook("n", "Notification", "unknown", T0 - 5, "auth_success");
    expect(seatInputPoint(db, "n", T0)).toBe("unknown");
  });
  it("no record, an unreadable one, or a database that cannot answer is unknown, never a hold", () => {
    expect(seatInputPoint(db, "n", T0)).toBe("unknown");
    db.prepare("INSERT INTO events (rig_id, node_id, type, payload) VALUES ('r', 'n', 'agent.activity', 'not json')").run();
    expect(seatInputPoint(db, "n", T0)).toBe("unknown");
    db.close();
    expect(seatInputPoint(db, "n", T0)).toBe("unknown");
  });
});
