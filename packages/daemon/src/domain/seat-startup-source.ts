// OF-32: where a fresh seat's startup policy comes from. A fresh conversation has no continuity, so by default it
// re-reads the rig's recorded spec source as it is now (a library link follows its current target). The saved
// startup context (written by the seat's last successful launch: its first launch, or the last fresh launch that
// produced an occupant) is replayed only when the operator asks for it (`--startup-from stored`), when the rig
// records no source, or when the spec does not declare the seat. Resume never comes through here: it keeps the stored context, because the
// conversation already holds the text that context delivered.
import type { ProjectionPlan } from "./projection-planner.js";
import type { ResolvedStartupFile, RuntimeAdapter } from "./runtime-adapter.js";
import type { StartupAction } from "./types.js";

/** What the operator asked a fresh launch to start from. */
export type StartupFrom = "spec" | "stored";

export const STARTUP_FROM_VALUES: readonly StartupFrom[] = ["spec", "stored"];

export type SeatStartupRead =
  /** The rig records no spec source (created before OpenRig recorded one, or not from a spec file). */
  | { kind: "unrecorded" }
  /** The recorded spec does not declare this seat (added with `rig add` after launch, or dropped from the spec). */
  | { kind: "undeclared"; specSource: string }
  /** A source is recorded but cannot give this seat a startup policy; nothing was launched or written. */
  | { kind: "refused"; code: "startup_source_unavailable" | "startup_source_changed"; message: string; specSource: string }
  | {
      kind: "spec";
      /** The recorded spelling, for example a spec library link. */
      specSource: string;
      /** The file actually read, after re-anchoring and following links. */
      specPath: string;
      plan: ProjectionPlan;
      resolvedStartupFiles: ResolvedStartupFile[];
      startupActions: StartupAction[];
      resolvedSpec: { name: string; version: string; hash: string };
      warnings: string[];
    };

/** The seam a fresh launch asks for a re-read; PodRigInstantiator implements it. Reads only; writes nothing. */
export interface SeatStartupSpecReader {
  readSeatStartupFromSpec(input: { rigId: string; nodeId: string; adapter: RuntimeAdapter; sessionName: string }): Promise<SeatStartupRead>;
}
