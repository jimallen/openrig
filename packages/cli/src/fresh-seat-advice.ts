/** The ONE command the CLI names for a seat that could not be resumed and needs a deliberate fresh start.
 *  It is the per-seat door: `rig seat launch` touches only that seat and works whether its siblings are live.
 *  `rig up --existing <rig> --fresh <seat>` is NOT offered: restore refuses a rig with any live seat
 *  (`rig_not_stopped`, HTTP 409), and a restore that leaves one seat awaiting a decision has normally just
 *  started its siblings. Mirrors the daemon's `freshSeatLaunchCommand` (domain/active-occupant.ts). */
/** OF-36 Q2: `spec`, `stored` or `snapshot:<id>` (the daemon checks the snapshot itself). */
export type StartupFromArg = "spec" | "stored" | `snapshot:${string}`;

/** `--startup-from` as typed, or null when it is not an accepted spelling (mirrors the daemon's parseStartupFrom). */
export function parseStartupFromArg(value: string): StartupFromArg | null {
  if (value === "spec" || value === "stored") return value;
  return /^snapshot:[A-Za-z0-9_-]+$/.test(value) ? value as StartupFromArg : null;
}

export const STARTUP_FROM_HELP = "spec, stored or snapshot:<snapshot-id>";

export function freshSeatLaunchCommand(logicalId: string, rigName: string, startupFrom?: StartupFromArg): string {
  const seat = `'${`${logicalId}@${rigName}`.replace(/'/g, `'"'"'`)}'`;
  // OF-32: under `rig up --existing --startup-from stored`, the seats it could not start are told the same escape.
  return `rig seat launch ${seat} --fresh${startupFrom && startupFrom !== "spec" ? ` --startup-from ${startupFrom}` : ""} --reason "<why>"`;
}
