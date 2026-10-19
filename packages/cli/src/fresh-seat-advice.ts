/** The ONE command the CLI names for a seat that could not be resumed and needs a deliberate fresh start.
 *  It is the per-seat door: `rig seat launch` touches only that seat and works whether its siblings are live.
 *  `rig up --existing <rig> --fresh <seat>` is NOT offered: restore refuses a rig with any live seat
 *  (`rig_not_stopped`, HTTP 409), and a restore that leaves one seat awaiting a decision has normally just
 *  started its siblings. Mirrors the daemon's `freshSeatLaunchCommand` (domain/active-occupant.ts). */
export function freshSeatLaunchCommand(logicalId: string, rigName: string): string {
  const seat = `'${`${logicalId}@${rigName}`.replace(/'/g, `'"'"'`)}'`;
  return `rig seat launch ${seat} --fresh --reason "<why>"`;
}
