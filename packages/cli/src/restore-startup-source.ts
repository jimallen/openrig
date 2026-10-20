/** OF-32 stage 3: where a seat a restore started fresh took its startup files from. The daemon puts this on each such
 *  seat's restore result (`startupSource`); `rig up` and `rig start` print one line for it under the seat. */
export type RestoreStartupSourceReport =
  | { kind: "spec"; specSource: string; specPath: string; previousSpecVersion: string | null; specVersion: string }
  | { kind: "stored"; reason: "requested" | "no_recorded_source" | "not_in_spec" | "not_fresh_listed" }
  /** `snapshotId` (OF-36): another snapshot than the restored one (the newest whose copy can be used). */
  | { kind: "snapshot"; reason: "no_saved_context" | "saved_context_unreadable"; snapshotId?: string };

export function describeRestoreStartupSource(source: RestoreStartupSourceReport): string {
  if (source.kind === "spec") {
    const where = source.specPath === source.specSource ? source.specSource : `${source.specSource} (now ${source.specPath})`;
    const version = source.previousSpecVersion === source.specVersion
      ? `agent ${source.specVersion}, unchanged`
      : `agent ${source.previousSpecVersion ?? "(none recorded)"} -> ${source.specVersion}`;
    return `startup files re-read from ${where}; ${version}`;
  }
  if (source.kind === "stored") {
    const why = source.reason === "not_fresh_listed" ? "not listed with --fresh, so the spec was not re-read"
      : source.reason === "requested" ? "--startup-from stored"
      : source.reason === "not_in_spec" ? "the rig's spec does not declare this seat"
        : "this rig records no spec source";
    return `startup files replayed from the seat's last successful launch (${why})`;
  }
  const from = source.snapshotId ? `snapshot ${source.snapshotId}, the newest whose copy can be used` : "this snapshot";
  return source.reason === "saved_context_unreadable"
    ? `startup files replayed from ${from} (the seat's saved startup files cannot be used)`
    : `startup files replayed from ${from} (the seat has no saved startup files of its own)`;
}
