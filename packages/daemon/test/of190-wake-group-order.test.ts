// OF-190: a coalesced wake group is written in the order its rows were staged, not in outbox-id string order.
// The tmux resend of a failed-over native group (claude-native-inbox groupFallbacks) is rebuilt from the rows and can only
// reproduce the write when the write itself follows staging order (nothing else about the order is stored).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository, type QueueNudgeTransport } from "../src/domain/queue-repository.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";

describe("OF-190: a coalesced wake group is sent in staging order", () => {
  let db: Database.Database;
  let repo: QueueRepository;
  let outbox: OutboxHandler;
  let texts: string[];
  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    outbox = new OutboxHandler(db);
    repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true });
    repo.attachOutbox(outbox);
    texts = [];
    const transport: QueueNudgeTransport = { async send(_session, text) { texts.push(text); return { ok: true, verified: true }; } };
    repo.attachTransport(transport);
  });
  afterEach(() => db.close());

  async function stage(ids: string[]) {
    const target = await repo.create({ nudge: false, sourceSession: "planner@rig", destinationSession: "owner@rig", body: "target" });
    // The ids are chosen so that string order (k10 < k2 < k3) differs from staging order (k2, k3, k10).
    for (const id of ids) outbox.record({ outboxId: `wake-intent-${id}`, senderSession: "planner@rig", destinationSession: "owner@rig", body: id, tags: ["queue:return:c1"], auditPointer: target.qitemId });
  }

  it("the drain writes the group in staging order: k2, k3, k10 (not k2, k10, k3)", async () => {
    await stage(["k2", "k3", "k10"]);
    await repo.drainPendingWakeIntents();
    expect(texts).toEqual(["k2\nk3\nk10"]);
  });

  it("a direct delivery that starts from a later-staged row still writes the whole group in staging order", async () => {
    await stage(["k2", "k3", "k10"]);
    const deliver = (repo as unknown as { deliverWakeIntent(id: string): Promise<string> }).deliverWakeIntent.bind(repo);
    await deliver("wake-intent-k3");
    expect(texts).toEqual(["k2\nk3\nk10"]);
  });
});
