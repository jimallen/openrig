// OF-45 / OF-62: the damaged columns of a seat's saved node row, as the node carries them
// (`sessionSourceUnreadable` / `packageRefsUnreadable`, set by rig-repository.ts when a column is not what was written).
//
// ONE predicate for every reader that has to act on the damage: snapshot capture refuses on it (so restore's own
// pre-restore capture refuses), and the restore plan and restore-check forecast that refusal from the same words.

export interface NodeRowDamageFields {
  sessionSourceUnreadable?: string | null;
  packageRefsUnreadable?: string | null;
}

/** The reasons this seat's saved row is damaged; empty when it is readable. */
export function savedRowDamage(node: NodeRowDamageFields): string[] {
  return [node.sessionSourceUnreadable, node.packageRefsUnreadable].filter((reason): reason is string => !!reason);
}

/** How restore's pre-restore capture words one damaged seat (snapshot-capture.ts), minus the lead-in. */
export function savedRowDamageMessage(logicalId: string, damage: readonly string[]): string {
  return `${logicalId}'s saved row is damaged (${damage.join("; ")})`;
}
