import type { Rig } from "./types.js";

/**
 * OF-135: a rig named in a command — `rig up <rig> --existing`, the `<rig>` of a `<seat>@<rig>` ref — is a rig id or a rig
 * name. Rig names are not unique; ids are. The precedence is the CLI's (cli/src/rig-handle.ts, used by `rig down`,
 * `rig add` and `rig spec-source`): an exact id first, across every rig including archived ones, then a name.
 */
export interface RigRefLookup {
  findRigById(id: string): { rig: Rig; archived: boolean } | null;
  findUnarchivedRigsByName(name: string): Rig[];
}

/** The rigs a seat ref's rig part names: the rig with that id (none if it is archived: seat refs never reach an archived
 *  rig, by id or by name), else the unarchived rigs with that name (two or more is the caller's ambiguity, as before). */
export function seatRefRigs(rigs: RigRefLookup, ref: string): Rig[] {
  const byId = rigs.findRigById(ref);
  if (byId) return byId.archived ? [] : [byId.rig];
  return rigs.findUnarchivedRigsByName(ref);
}

/**
 * What advice should print for a rig in `rig up <rig> --existing` or `<seat>@<rig>`: its name while that name reaches it
 * and only it, else its id (OF-135; the rule `rig down` advice already follows, OF-123). The name reaches it when no rig has
 * the name as its id (an id wins) and this rig is the one unarchived rig with that name. Unreadable state gives the id,
 * which is always exact. Not quoted: callers quote for the shell.
 */
export function rigAdviceHandle(rigs: RigRefLookup, rigId: string, rigName: string): string {
  try {
    if (rigs.findRigById(rigName)) return rigId;
    const named = rigs.findUnarchivedRigsByName(rigName);
    return named.length === 1 && named[0]!.id === rigId ? rigName : rigId;
  } catch {
    return rigId;
  }
}
