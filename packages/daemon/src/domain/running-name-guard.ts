import type Database from "better-sqlite3";
import { getNodeInventory } from "./node-inventory.js";
import { identityVerdictConfirmsSessionMissing } from "./types.js";
import { rigAdviceHandle, type RigRefLookup } from "./rig-ref.js";
import { shellWord } from "./active-occupant.js";

/**
 * S5b (OPR.0.5.4.11) — the running-name guard, the FLOOR against duplicate rig
 * identity: `rig up` on a name whose rig is RUNNING must refuse before any
 * create/launch, because session addresses are name-keyed
 * (`{pod}-{member}@{rig}`) and a second running rig collides tmux names, queue
 * destinations, and transcripts while doubling seat launches on one namespace.
 *
 * RUNNING is derived exactly as the daemon already derives it — the rigs table
 * has no status column; a rig is running iff it has at least one sessions row
 * with status='running' (the classifier-lease liveness derivation,
 * startup.ts; the ps summary running-count uses the same predicate), EXCEPT a
 * row whose terminal the daemon has CONFIRMED gone (OF-287): the same applicable
 * `session_missing` verdict that makes `rig ps --nodes` read the seat `detached`
 * and `rig ps` read the rig stopped. A terminal that died leaves its row
 * status='running' (nothing writes `exited` for it), so counting the row alone
 * made a rig with no live terminal block `rig up` and rig-here's resume until
 * `rig down`. Anything short of confirmed absence still counts as running.
 *
 * Deliberately NOT here: global name uniqueness, stopped-generation reuse
 * semantics (plural-aware findRigsByName is load-bearing — a same-name rig
 * whose sessions are all non-running never trips this guard), any schema
 * change. The restore-vs-up name-reuse design is a 0.5.5 intake.
 */

export interface RunningRigIdentity {
  id: string;
  name: string;
  runningSessionCount: number;
}

export type RunningNameGuardVerdict =
  | { ok: true }
  | { ok: false; code: "rig_name_running"; message: string; runningRig: RunningRigIdentity };

export interface RunningNameGuardDeps {
  /** The repo's existing plural-aware name lookup (ORDER BY created_at). */
  findRigsByName(name: string): Array<{ id: string; name: string }>;
  /** Count of sessions rows with status='running' belonging to the rig's nodes. */
  countRunningSessions(rigId: string): number;
}

/** A lifecycle-lease reader (the delivery guard's `lifecycleHeld`): true while a relaunch, handover, restore, restart or
 *  `rig down` holds the seat. Optional everywhere; absent, no seat is treated as held. */
export type LifecycleHeld = (nodeId: string) => boolean;

/** The lease reader of an adapter that carries a delivery guard, or undefined. */
export function lifecycleHeldOf(tmux: { deliveryGuard?: { lifecycleHeld(nodeId: string): boolean } } | undefined): LifecycleHeld | undefined {
  const guard = tmux?.deliveryGuard;
  return guard ? (nodeId) => guard.lifecycleHeld(nodeId) : undefined;
}

/** Every `running` sessions row of the rig, raw: the read this module used before OF-287. */
export function countStoredRunningSessions(db: Database.Database, rigId: string): number {
  return (db.prepare(
    "SELECT COUNT(*) AS c FROM sessions s JOIN nodes n ON n.id = s.node_id WHERE n.rig_id = ? AND s.status = 'running'",
  ).get(rigId) as { c: number }).c;
}

/** A folder as one word of a command line an operator will paste: bare while it is only path characters, else single-quoted, so a
 *  space, quote, `$`, backtick, `;` or newline in a folder name cannot split or run the command (OF-287 review F4). Not the
 *  adapters' `shellWord`, which has the same bare set: the domain may not import an adapter (hexagonal ratchet), and the domain's
 *  own `shellWord` (active-occupant) quotes every `/`, which would rewrite every path in the existing wording. A leading `=` is
 *  quoted: zsh rewrites a bare `=word` to the path of a command. */
function shellPath(value: string): string {
  return /^[A-Za-z0-9_@%+:,./-][A-Za-z0-9_@%+=:,./-]*$/.test(value) ? value : `'${value.replace(/'/g, `'"'"'`)}'`;
}

/** A command set off inside a sentence: in single quotes, as the refusal always did, unless the command itself holds a single quote
 *  (a quoted folder name does), when the quotes would end it early; then in backticks, which a quoted word never ends. */
function setOff(command: string): string {
  return command.includes("'") ? `\`${command}\`` : `'${command}'`;
}

/** OF-287: the refusal for a plain import over a rig whose seats all lost their terminals while their rows still read `running`.
 *  Call it AFTER the running-name guard has passed (so every stored `running` row left is a confirmed-gone, un-leased one) and
 *  BEFORE anything is written: the instantiator calls it before creating or archiving, the bundle orchestrator before it
 *  replaces the install folder. One predicate and one text for both, so the refusal's "nothing was created" holds on every route. */
export function goneGenerationRefusal(
  db: Database.Database, rigs: RigRefLookup, rigName: string, rigIds: readonly string[],
  /** A bundle install names its install folder: archiving the team does NOT let the same folder be reinstalled (the archived
   *  team no longer owns its files, so they block it with target_conflict), so a bundle's ways forward differ from a spec's. */
  bundle?: {
    targetRoot?: string; /** the attempted target as the filesystem names it (realpath), for comparison with the recorded root */ canonicalTargetRoot?: string;
    /** The install folder recorded for a bundle-installed rig (rigs.install_root; null for a rig that was not bundle-installed or predates the
     *  binding): RigRepository.getRigInstallRoot, passed in so this module keeps its one db dependency and does not read the table a second way. */
    installRootOf(rigId: string): string | null;
  },
): { rigId: string; message: string; resolutions: string[] } | null {
  const gone = rigIds.find((id) => countStoredRunningSessions(db, id) > 0);
  if (!gone) return null;
  const handle = rigAdviceHandle(rigs, gone, rigName);
  const head = `A rig named "${rigName}" already exists (${gone}), and all of its seats have lost their terminals. `;
  const resume = `rig up ${shellWord(handle)} --existing`;
  const archive = `rig archive ${shellWord(gone)}`;
  if (bundle) {
    // OF-287 X-N1: "its own folder" is where the crashed team's install is RECORDED (rigs.install_root, a canonical path), not
    // the folder of the install being attempted. When the two differ both are named, so each command's effect is told truthfully.
    const attempted = bundle.targetRoot;
    const recorded = bundle.installRootOf(gone);
    const elsewhere = recorded !== null && attempted !== undefined && recorded !== (bundle.canonicalTargetRoot ?? attempted);
    // With no recorded root (a spec-created team, an install before the binding, a v1 bundle) nothing is known about "its own
    // folder", so the text says only what the command does.
    const unrecorded = recorded === null;
    const ownDir = recorded !== null && (attempted === undefined || elsewhere) ? recorded : (attempted ?? "<dir>");
    // The folders in the two commands are quoted for a shell; the folders named in the sentences around them are prose, left as they are.
    const ownDirWord = recorded !== null && (attempted === undefined || elsewhere) ? shellPath(recorded) : attempted !== undefined ? shellPath(attempted) : "<dir>";
    const replaceOwn = `rig up <bundle> --target ${ownDirWord} --on-existing fresh`;
    const replaceHere = `rig up <bundle> --target ${shellPath(attempted ?? "")} --on-existing fresh`;
    const ownFolder = elsewhere ? `its own folder (${ownDir})` : "its own folder";
    const replaceWhere = unrecorded ? `it with the bundle installed in ${ownDir} (the team is archived)` : `it in ${ownFolder}`;
    const hereNote = `the team is archived and the bundle is installed in ${attempted}; ${ownDir} is left as it is`;
    return {
      rigId: gone,
      resolutions: [
        `Resume it on its own conversations: ${resume}.`,
        `Archive it first (${archive}), then install into a new or empty --target.`,
        `Replace ${replaceWhere} with ${replaceOwn}; /api/bundles/install and rig bundle install take no --on-existing.`,
        ...(elsewhere ? [`Or replace it from ${attempted} instead (${hereNote}) with ${replaceHere}.`] : []),
      ],
      message: head + `Nothing was created, no file was written and it was not archived. Resume it on its own conversations with ${setOff(resume)}, `
        + `or archive it first with ${setOff(archive)} and install into a new or empty --target, `
        + `or replace ${replaceWhere} with ${setOff(replaceOwn)}`
        + (elsewhere ? `, or replace it from ${attempted} instead (${hereNote}) with ${setOff(replaceHere)}.` : "."),
    };
  }
  return {
    rigId: gone,
    resolutions: [], // a plain spec import lists no resolutions; its message carries the two ways forward
    message: head + `Nothing was created and it was not archived. Resume it on its own conversations with ${setOff(resume)}, `
      + `or archive it first with ${setOff(archive)} to start fresh.`,
  };
}

/** The one liveness read, shared by every caller: sessions joined through the
 *  rig's nodes, status='running' — the daemon's existing running-derivation —
 *  minus ONE row per node: the node's NEWEST session row, when it is running and
 *  carries an APPLICABLE confirmed `session_missing` verdict (node-inventory
 *  gates a stored verdict to the current session, binding and time) and no
 *  lifecycle lease holds the node. Older `running` rows of the node, which the
 *  verdict does not describe, still count (restore classifies every running row).
 *
 *  How a `session_missing` verdict gets written, and so how much it proves:
 *   - SeatIdentityReconciler: after two consecutive polls in which the host (hc
 *     core or tmux) answered and did not list the session; never while a lease
 *     holds the seat, until the lease ceiling.
 *   - SessionTransport.recordSessionMissingVerdict (session-transport.ts), on ONE
 *     positive absence from a send or capture, with no lease check.
 *   - rebindAndVerifyPaneIdentity (seat-attention-reconciler.ts), on ONE empty
 *     pane listing (restore, seat lifecycle, restart-in-place, attention clear);
 *     on hc any non-live state counts, and hc's `machine_unknown` counts as absent.
 *  Every writer needs an answer from the host (an unreachable core writes
 *  `tmux_unavailable` or nothing), but the last two are single observations and
 *  can read a seat between its old terminal's end and its successor's row. That
 *  window is exactly a lifecycle lease, so a held node keeps counting here.
 *  No verdict, `tmux_unavailable`, a verdict about another pane or an earlier
 *  occupant, or any other reason: the row still counts. Never writes. */
export function makeRunningSessionCounter(db: Database.Database, lifecycleHeld?: LifecycleHeld): (rigId: string) => number {
  return (rigId: string): number => {
    const rows = db.prepare(
      `SELECT s.id AS id, s.node_id AS nodeId,
              (SELECT s2.id FROM sessions s2 WHERE s2.node_id = s.node_id ORDER BY s2.id DESC LIMIT 1) AS newestId
         FROM sessions s JOIN nodes n ON n.id = s.node_id WHERE n.rig_id = ? AND s.status = 'running'`,
    ).all(rigId) as Array<{ id: string; nodeId: string; newestId: string }>;
    if (rows.length === 0) return 0;
    const gone = new Set(getNodeInventory(db, rigId)
      .filter((entry) => identityVerdictConfirmsSessionMissing(entry.identityVerdict) && !lifecycleHeld?.(entry.nodeId))
      .map((entry) => entry.nodeId));
    return rows.filter((row) => !(gone.has(row.nodeId) && row.id === row.newestId)).length;
  };
}

/**
 * The ONE guard every instantiator create path calls before `createRig()`.
 * Returns ok when no same-name rig is running (including the all-stopped
 * generations case — reuse proceeds unchanged); otherwise a teaching refusal
 * naming the running rig, what was checked, that nothing was created or
 * launched, and the supported alternatives.
 */
export function checkRunningNameGuard(deps: RunningNameGuardDeps, name: string): RunningNameGuardVerdict {
  for (const rig of deps.findRigsByName(name)) {
    const runningSessionCount = deps.countRunningSessions(rig.id);
    if (runningSessionCount > 0) {
      return {
        ok: false,
        code: "rig_name_running",
        message:
          `A rig named "${name}" is already RUNNING: ${rig.id} with ${runningSessionCount} running session(s) ` +
          `(checked: existing rigs with this name for sessions in status 'running'). ` +
          `Nothing was created or launched. Alternatives: work with the running rig ` +
          `(rig ps --nodes / rig send), stop it first with 'rig down ${name}', ` +
          `or launch this spec under a different name.`,
        runningRig: { id: rig.id, name, runningSessionCount },
      };
    }
  }
  return { ok: true };
}

export type StoppedGenerationsVerdict =
  | { ok: true; rigIds: string[] }
  | { ok: false; rigId: string; reason: string };

/**
 * #141: before an explicit YAML import creates a replacement generation, find the unarchived same-name
 * generations it may archive. Each must have no running sessions (the guard above) and, for every
 * session name it has used, this daemon's tmux must report positive absence or, on the same socket the
 * launch uses, "no server running". Any other probe result is uncertainty, not absence. This is a
 * generation-management rule for the daemon's own tmux namespace, not proof that no process is alive.
 * `probe` is undefined when the adapter cannot probe; the caller then keeps its existing behavior.
 */
export async function confirmStoppedGenerations(
  db: Database.Database,
  unarchivedRigIds: string[],
  probe: (sessionName: string) => Promise<{ state: string; cause?: string }>,
  lifecycleHeld?: LifecycleHeld,
): Promise<StoppedGenerationsVerdict> {
  const running = makeRunningSessionCounter(db, lifecycleHeld);
  for (const rigId of unarchivedRigIds) {
    if (running(rigId) > 0) return { ok: false, rigId, reason: "it has a running session" };
    const names = (db.prepare(`
      SELECT b.tmux_session AS name FROM bindings b JOIN nodes n ON n.id = b.node_id WHERE n.rig_id = ? AND b.tmux_session IS NOT NULL
      UNION SELECT s.session_name FROM sessions s JOIN nodes n ON n.id = s.node_id WHERE n.rig_id = ?
    `).all(rigId, rigId) as Array<{ name: string }>).map((row) => row.name);
    for (const name of names) {
      let result: { state: string; cause?: string };
      try {
        result = await probe(name);
      } catch (err) {
        return { ok: false, rigId, reason: `tmux could not check session ${name}: ${(err as Error).message}` };
      }
      if (result.state === "absent") continue;
      if (result.state === "transport_unavailable" && result.cause?.includes("no server running")) continue;
      return {
        ok: false,
        rigId,
        reason: result.state === "present"
          ? `tmux session ${name} still exists`
          : `tmux could not check session ${name}${result.cause ? `: ${result.cause}` : ""}`,
      };
    }
  }
  return { ok: true, rigIds: unarchivedRigIds };
}
