// OF-221: tell a rig's Chief of Staff when simulators of its seats were erased. Every erase makes that device's next boot a slow first boot that loads the Mac,
// and the `simulator.erased` events (OF-208) reached nobody. Jim's decisions (2026-11-04, of221-design.md): one notice per rig per erase run, listing every
// device; `nudge: false` (the item waits in the CoS's queue and the wake ladder escalates a long-pending one); no notice for `rig_deleted` (the rig is gone, so
// is its CoS); no notice when no CoS resolves (the reason is logged and the erase events stay in the log).
import { createHash } from "node:crypto";
import { BYTES_PER_GB, type SimulatorEraseReason } from "./simulator-lifecycle.js";
import { rigChiefOfStaff, type TopologyDb } from "./rig-chief-of-staff.js";
import type { QueueCreateInput } from "./queue-repository.js";

/** The daemon's own author for system-origin queue items (as the returned-message items use). */
export const SIMULATOR_NOTICE_SOURCE = "daemon@kernel";

export interface ErasedDevice { seat: string; udid: string; name: string; sizeBytes: number | null }

/** What one erase run did for one rig. */
export interface SimulatorErasedNotice {
  rigId: string;
  reason: SimulatorEraseReason;
  capBytes?: number;
  /** ISO time of the run. */
  at: string;
  devices: ErasedDevice[];
}

export type SimulatorErasedNotifier = (notice: SimulatorErasedNotice) => Promise<void>;

/** The part of QueueRepository the notifier writes through. */
export interface NoticeQueue { create(input: QueueCreateInput): Promise<unknown> }

/** One id per (rig, reason, set of devices, minute): a repeat of the same run is the repository's idempotent re-delivery (same id, same source and destination
 *  returns the stored row: no second item). */
export function simulatorNoticeId(notice: SimulatorErasedNotice): string {
  const udids = notice.devices.map((d) => d.udid).sort().join(",");
  return `qitem-simerased-${createHash("sha256").update(`${notice.rigId}|${notice.reason}|${udids}|${notice.at.slice(0, 16)}`).digest("hex").slice(0, 24)}`;
}

function size(bytes: number | null): string {
  return bytes === null ? "size unknown" : `${(bytes / BYTES_PER_GB).toFixed(1)} GB`;
}

export function simulatorNoticeBody(rigName: string, notice: SimulatorErasedNotice): string {
  const why = notice.reason === "over_size_cap"
    ? `a shut-down simulator was over the size cap${notice.capBytes !== undefined ? ` (${(notice.capBytes / BYTES_PER_GB).toFixed(0)} GB)` : ""}`
    : "the seat that owned it was removed";
  const lines = notice.devices.map((d) => `- ${d.name} (${d.udid}), seat ${d.seat}, ${size(d.sizeBytes)}`);
  return [
    `OpenRig erased ${notice.devices.length} iOS simulator${notice.devices.length === 1 ? "" : "s"} of rig ${rigName}: ${why}.`,
    ...lines,
    "An erased device boots slowly the next time (a first boot), which loads the Mac. Nothing is needed from you unless a seat was about to use one.",
  ].join("\n");
}

export function makeSimulatorErasedNotifier(deps: { db: TopologyDb; queue: NoticeQueue; log?: (line: string) => void }): SimulatorErasedNotifier {
  const log = deps.log ?? ((line: string) => console.warn(line));
  return async (notice) => {
    try {
      if (notice.reason === "rig_deleted" || notice.devices.length === 0) return;
      const cos = rigChiefOfStaff(deps.db, notice.rigId);
      if (!cos.ok) {
        log(`[simulators] no notice for rig ${notice.rigId}: no Chief of Staff (${cos.reason}); erased ${notice.devices.map((d) => d.udid).join(", ")}`);
        return;
      }
      const rig = deps.db.prepare("SELECT name FROM rigs WHERE id = ?").get(notice.rigId) as { name: string } | undefined;
      const rigName = rig?.name ?? notice.rigId;
      await deps.queue.create({
        qitemId: simulatorNoticeId(notice),
        sourceSession: SIMULATOR_NOTICE_SOURCE,
        destinationSession: cos.session,
        body: simulatorNoticeBody(rigName, notice),
        priority: "routine",
        tags: ["simulator-erased", `rig:${rigName}`, `reason:${notice.reason}`],
        summary: `${notice.devices.length} simulator${notice.devices.length === 1 ? "" : "s"} erased in ${rigName}`,
        nudge: false,
      });
    } catch (err) {
      log(`[simulators] notice for rig ${notice.rigId} failed: ${err instanceof Error ? err.message : String(err)}; erased ${notice.devices.map((d) => d.udid).join(", ")}`);
    }
  };
}
