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

/** `rig` is the rig as advice names it: its name, or its id when the name is shared (rig-handle.ts rigAdviceHandle, OF-135). */
export function freshSeatLaunchCommand(logicalId: string, rig: string, startupFrom?: StartupFromArg): string {
  const seat = `'${`${logicalId}@${rig}`.replace(/'/g, `'"'"'`)}'`;
  // OF-32: under `rig up --existing --startup-from stored`, the seats it could not start are told the same escape.
  return `rig seat launch ${seat} --fresh${startupFrom && startupFrom !== "spec" ? ` --startup-from ${startupFrom}` : ""} --reason "<why>"`;
}

/** OF-53, reworded for OF-200: the per-seat hint for a seat whose session is gone. On hc the agent is its terminal's own program, so a crashed
 *  agent takes the terminal with it (on tmux, the tmux session); the text no longer says tmux. Both ways back are real commands, and both touch
 *  this seat alone: `rig launch <rig id> <seat>` brings it back on its own conversation (`rig up --existing` would not: it is refused while any
 *  seat of the rig is live, which is the usual case for one lost seat), and `rig seat launch --fresh` starts it on a new one. `rig launch` takes
 *  the rig's id, never its name. */
export function missingSessionAdvice(logicalId: string, rigHandle: string, rigId: string = rigHandle): string {
  const word = (value: string) => (/^[A-Za-z0-9._@:-]+$/.test(value) ? value : `'${value.replace(/'/g, `'"'"'`)}'`);
  return `session missing (its agent ended and its terminal with it); bring it back on its own conversation with rig launch ${word(rigId)} ${word(logicalId)}, or start only this seat fresh with ${freshSeatLaunchCommand(logicalId, rigHandle)}`;
}
