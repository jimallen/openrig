import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { QueueRepositoryError, type QueueRepository } from "../queue-repository.js";
import type { SeatDeliveryGuard } from "../seat-delivery-guard.js";
import type { HeldBinding, HeldMessages, HoldStatus, SeatDirectory, SeatFate, SenderReturn, SenderReturnResult } from "./pump-ports.js";

/** The sender queue item's id, one per message, so a crash after the create repeats it on the same item (QueueRepository.create). */
export function returnQitemId(id: string): string {
  return `qitem-returned-${createHash("sha256").update(id).digest("hex").slice(0, 24)}`;
}

/**
 * A seat's fate, read from the rig records. Unarchived wins: a rig recreated under the same names is the seat's successor at the same
 * address, so it reads `live` and a message simply goes there. This build keeps no record of a successor under a different name, so
 * `successor` is never returned from here; the port carries it for when one exists.
 */
export class DbSeatDirectory implements SeatDirectory {
  constructor(private readonly db: Database.Database) {}

  fate(seat: string): SeatFate {
    const rows = this.db.prepare(`SELECT n.id AS nodeId, r.name AS rig, r.archived_at AS archivedAt,
        (SELECT generation_uuid FROM occupant_tenures t WHERE t.node_id = n.id ORDER BY generation_ordinal DESC LIMIT 1) AS occupant
      FROM nodes n JOIN rigs r ON r.id = n.rig_id LEFT JOIN bindings b ON b.node_id = n.id
      WHERE b.tmux_session = ? OR (b.tmux_session IS NULL AND replace(n.logical_id, '.', '-') || '@' || r.name = ?)`)
      .all(seat, seat) as Array<{ nodeId: string; rig: string; archivedAt: string | null; occupant: string | null }>;
    const live = rows.filter((row) => row.archivedAt === null);
    if (live.length === 1) return { kind: "live", occupantGeneration: live[0]!.occupant };
    if (live.length > 1) return { kind: "unknown" };
    if (rows.length > 0) return { kind: "gone", reason: `rig ${rows[0]!.rig} is archived` };
    return { kind: "gone", reason: `no seat ${seat} exists` };
  }
}

/** Whether the guard that held a message has lifted, and the seat is still the one that held it. */
export class GuardHeldMessages implements HeldMessages {
  constructor(private readonly guard: Pick<SeatDeliveryGuard, "preference" | "maybeTarget">) {}

  status(binding: HeldBinding | null, seat: string): HoldStatus {
    const target = this.guard.maybeTarget(binding?.nodeId ?? seat);
    const nodeId = binding?.nodeId ?? target?.nodeId;
    if (nodeId !== undefined) {
      const preference = this.guard.preference(nodeId);
      if (preference.desired || preference.effective) return "held";
    }
    // A binding that cannot be read has lost who held the message: that is never proof the seat is the same one.
    return binding !== null && target?.occupant === binding.occupant ? "lifted" : "occupant_changed";
  }
}

/** The sender's queue item for a message that can never arrive. Its text travels with it, so nothing is lost with the seat. */
/** Who a queue item can reach: a seat's address. A send with no identity has the sender `unknown`, which is what the compaction enforcer sends as,
 *  and the daemon's own senders read no queue: `watchdog@system` and the like, and `daemon@kernel`, whose rig exists so the queue would take it. */
function hasQueue(sender: string): boolean {
  return /^[^@\s]+@[^@\s]+$/.test(sender) && !sender.endsWith("@system") && sender !== "daemon@kernel";
}

export class QueueSenderReturn implements SenderReturn {
  constructor(private readonly queue: Pick<QueueRepository, "create">) {}

  async returnToSender(message: { id: string; seat: string; sender: string; body: string }, reason: string): Promise<SenderReturnResult> {
    if (!hasQueue(message.sender)) return { kind: "no_return_path", reason: `no sender a queue can reach (${message.sender})` };
    const qitemId = returnQitemId(message.id);
    try {
      await this.queue.create({
        qitemId, sourceSession: "daemon@kernel", destinationSession: message.sender, tags: ["seat-messaging:returned"],
        body: `Your message ${message.id} to ${message.seat} was not delivered and will not be: ${reason}. Its text:\n\n${message.body}`,
      });
    } catch (error) {
      // The queue checks the destination before it writes, so this one is final: a later pass would be refused the same way.
      if (error instanceof QueueRepositoryError && error.code === "unknown_destination_rig") return { kind: "no_return_path", reason: error.message };
      throw error;
    }
    return { kind: "returned", qitemId };
  }
}
