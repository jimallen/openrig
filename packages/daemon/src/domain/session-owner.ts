import type Database from "better-sqlite3";

export interface SessionOwnerRow {
  node_id: string;
  logical_id: string;
  rig_name: string;
  /** The owner's rig by id: rig names are not unique, so "same rig" is decided on this. */
  rig_id: string;
}

/**
 * The OTHER managed node that currently owns a tmux session name, if any: a node whose binding names
 * it, or a node with a live (not superseded, detached or exited) session row under it. A session name
 * can be shared across rigs, for example by an archived duplicate of a live rig, so the name alone
 * never proves which node a session belongs to. `ignoreArchived` skips owners in archived rigs: an
 * archived rig keeps its bindings, so its node would otherwise claim the live seat's session.
 * `countReleased` (OPT-IN, for the callers that ask "may I KILL this name?": rig down, node removal, seat stop and the
 * restore-check advice that mirrors them) makes a released session hold its name too: `rig unclaim` marks an adopted
 * session `detached` and clears its binding while the tmux session lives on as the person's own, so a `claimed` row in
 * that state owns the name for a kill (OF-68 F9). It is NOT part of "is this session managed by another seat": a
 * released session is by definition no longer managed, so seat handover (which asks that) leaves it off.
 * A `detached` row OpenRig launched is only a lost session, which owns nothing. The startup reconciler and restore
 * also write `detached` for an adopted session whose tmux session died, so such a dead adopted row holds its name
 * under `countReleased` as well; on a kill path that errs on the safe side (a same-named session is left running and
 * its row ended) and is accepted.
 * `excludeNodeIds` skips further nodes, such as the rest of a group being removed together; it is applied
 * in both lookups before the first match is taken, so an excluded node can't hide another owner.
 */
export function findOtherSessionOwner(
  db: Database.Database,
  tmuxSession: string,
  nodeId: string,
  opts?: { ignoreArchived?: boolean; excludeNodeIds?: readonly string[]; countReleased?: boolean },
): SessionOwnerRow | null {
  const live = opts?.ignoreArchived ? " AND r.archived_at IS NULL" : "";
  const released = opts?.countReleased ? " OR (s.status = 'detached' AND s.origin = 'claimed')" : "";
  const excluded = [nodeId, ...(opts?.excludeNodeIds ?? [])];
  const notExcluded = `n.id NOT IN (${excluded.map(() => "?").join(", ")})`;
  const bindingOwner = db.prepare(`
    SELECT n.id AS node_id, n.logical_id, r.name AS rig_name, r.id AS rig_id
    FROM bindings b
    JOIN nodes n ON n.id = b.node_id
    JOIN rigs r ON r.id = n.rig_id
    WHERE b.tmux_session = ? AND ${notExcluded}${live}
    LIMIT 1
  `).get(tmuxSession, ...excluded) as SessionOwnerRow | undefined;
  if (bindingOwner) return bindingOwner;

  return db.prepare(`
    SELECT n.id AS node_id, n.logical_id, r.name AS rig_name, r.id AS rig_id
    FROM sessions s
    JOIN nodes n ON n.id = s.node_id
    JOIN rigs r ON r.id = n.rig_id
    WHERE s.session_name = ? AND ${notExcluded} AND (s.status NOT IN ('superseded', 'detached', 'exited')${released})${live}
    LIMIT 1
  `).get(tmuxSession, ...excluded) as SessionOwnerRow | undefined ?? null;
}
