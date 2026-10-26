// OF-68 F9 — a session released with `rig unclaim` is marked `detached` and loses its binding while its tmux session lives on
// as the person's own. The owner lookup read only live statuses, so every kill path (rig down, rig remove, seat stop) saw no
// owner and could end that session. A released (`claimed`) row now owns its name; a `detached` row OpenRig launched is only a
// lost session and owns nothing; an archived rig's rows still never count (#174).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { findOtherSessionOwner } from "../src/domain/session-owner.js";

describe("findOtherSessionOwner: released and lost sessions", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessions: SessionRegistry;
  beforeEach(() => { db = createFullTestDb(); rigRepo = new RigRepository(db); sessions = new SessionRegistry(db); });
  afterEach(() => db.close());

  function holder(status: string, origin: "claimed" | "launched", archived = false) {
    const rig = rigRepo.createRig(`holder-${status}-${origin}-${archived}`);
    const node = rigRepo.addNode(rig.id, "human");
    const row = sessions.registerSession(node.id, "dev-shared@team");
    db.prepare("UPDATE sessions SET status = ?, origin = ? WHERE id = ?").run(status, origin, row.id);
    if (archived) db.prepare("UPDATE rigs SET archived_at = ? WHERE id = ?").run("2026-01-01T00:00:00Z", rig.id);
    return node.id;
  }
  const asker = () => rigRepo.addNode(rigRepo.createRig("asker").id, "seat").id;

  it.each([
    ["a released (detached claimed) session owns its name", "detached", "claimed", false, true],
    ["a running session owns its name (control)", "running", "launched", false, true],
    ["a detached session OpenRig launched is a lost session and owns nothing", "detached", "launched", false, false],
    ["an exited claimed row owns nothing", "exited", "claimed", false, false],
    ["a released session in an archived rig owns nothing when archived rigs are ignored", "detached", "claimed", true, false],
  ] as const)("%s", (_name, status, origin, archived, owned) => {
    const holderNode = holder(status, origin, archived);
    const owner = findOtherSessionOwner(db, "dev-shared@team", asker(), { ignoreArchived: true });
    expect(owner?.node_id ?? null).toBe(owned ? holderNode : null);
  });
});
