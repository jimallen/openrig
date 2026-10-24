// pda L2a round 2: `rig seat pda-release`. The operator asks a pda seat's runner to retry its held outbox head once
// more (design A2 "Release"). The daemon never touches the outbox: it creates the runner's control file
// `release.request` in the seat's state dir, and the runner applies it on its 60 s alive tick or its next attach
// (pda-runner.ts pollRelease; the outbox appends the `release` record).
//
// Fail-closed (L2a security review, section 10):
//   - the seat is resolved ONLY through the registry, and the path is built from the canonical session name stored
//     in the database, never from request text; that name must be one path segment;
//   - the seat must be a pda seat;
//   - its state dir must be a real directory (not a symlink) directly under the pda state root;
//   - the runner's sidecar must show a held head (nothing is released blind);
//   - `release.request` is created O_CREAT|O_EXCL|O_NOFOLLOW, mode 0600; one pending request at a time;
//   - a reason is required, and one audit event is written with ids and codes only, never message content.
// A release re-sends a message pda may already hold (an ambiguous earlier attempt), so the reply says it may arrive twice.

import fs from "node:fs";
import nodePath from "node:path";
import type Database from "better-sqlite3";
import { PDA_RUNTIME, parsePdaRunnerState, pdaSeatPaths } from "../adapters/pda-runner-protocol.js";
import { pdaSidecarAlive } from "../adapters/pda-runtime-adapter.js";

export type PdaReleaseResult =
  | { ok: true; sessionName: string; heldRequestId: string; heldCode: string; runnerAlive: boolean; message: string }
  | { ok: false; status: 400 | 404 | 409 | 500 | 503; code: string; error: string };

export interface PdaReleaseDeps {
  db: Database.Database;
  /** <OPENRIG_HOME>/state/pda, from the registered pda adapter; null when no pda adapter is registered. */
  stateRoot: string | null;
  findSession(sessionName: string): { sessionId: string; nodeId: string; rigId: string; runtime: string | null } | null;
  emit?: (event: { type: "seat.pda_release_requested"; rigId: string; nodeId: string; sessionName: string; heldRequestId: string; heldCode: string; reason: string; actor: string | null }) => void;
  now?: () => Date;
}

const refuse = (status: 400 | 404 | 409 | 500 | 503, code: string, error: string): PdaReleaseResult => ({ ok: false, status, code, error });

export function requestPdaRelease(deps: PdaReleaseDeps, input: { sessionName: string; reason: unknown; actor: string | null }): PdaReleaseResult {
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (!reason) return refuse(400, "missing_reason", "pda-release requires --reason (recorded in the audit event).");
  const ctx = deps.findSession(input.sessionName);
  if (!ctx) return refuse(404, "session_not_found", `Session '${input.sessionName}' not found.`);
  if (ctx.runtime !== PDA_RUNTIME) {
    return refuse(409, "not_a_pda_seat", `'${input.sessionName}' is not a pda seat (runtime ${ctx.runtime ?? "unknown"}); pda-release only releases a pda runner's held message.`);
  }
  if (!deps.stateRoot) return refuse(503, "pda_unavailable", "This daemon has no pda runtime registered.");
  const row = deps.db.prepare("SELECT session_name FROM sessions WHERE id = ?").get(ctx.sessionId) as { session_name: string } | undefined;
  const name = row?.session_name ?? "";
  // The canonical name from the database, as one path segment (the runner applies the same rule to --session-name).
  if (!name || name === "." || name === ".." || /[\\/\u0000]/.test(name)) {
    return refuse(409, "seat_state_unsafe", `'${input.sessionName}' has a session name that is not one path segment; nothing was written.`);
  }
  const root = nodePath.resolve(deps.stateRoot);
  const paths = pdaSeatPaths(root, name);
  if (nodePath.dirname(paths.seatRoot) !== root) {
    return refuse(409, "seat_state_unsafe", `The state dir of '${name}' is not directly under the pda state root; nothing was written.`);
  }
  let seatDir: fs.Stats;
  try { seatDir = fs.lstatSync(paths.seatRoot); } catch {
    return refuse(409, "no_held_message", `No message is held for '${name}' (its runner has never run here).`);
  }
  if (seatDir.isSymbolicLink() || !seatDir.isDirectory()) {
    return refuse(409, "seat_state_unsafe", `The state dir of '${name}' is not a real directory (a symlink or a file); nothing was written.`);
  }
  let state: ReturnType<typeof parsePdaRunnerState> = null;
  try {
    const st = fs.lstatSync(paths.runnerStatePath);
    if (st.isFile()) state = parsePdaRunnerState(fs.readFileSync(paths.runnerStatePath, "utf8"));
  } catch { state = null; }
  if (!state?.held) return refuse(409, "no_held_message", `No message is held for '${name}'; nothing to release.`);
  const held = state.held;
  try { fs.lstatSync(paths.releaseRequestPath); return refuse(409, "release_pending", `A release is already pending for '${name}'; the runner applies it on its next tick (within 60 s).`); } catch { /* absent: go on */ }
  let fd: number;
  try {
    fd = fs.openSync(paths.releaseRequestPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST" || code === "ELOOP") return refuse(409, "release_pending", `A release is already pending for '${name}', or its control file is not a regular file; nothing was written.`);
    return refuse(500, "release_write_failed", `The release request for '${name}' could not be written (${code ?? "error"}).`);
  }
  const now = (deps.now ?? (() => new Date()))();
  try { fs.writeSync(fd, `${JSON.stringify({ requestedAt: now.toISOString() })}\n`); } finally { fs.closeSync(fd); }
  deps.emit?.({ type: "seat.pda_release_requested", rigId: ctx.rigId, nodeId: ctx.nodeId, sessionName: name, heldRequestId: held.requestId, heldCode: held.code, reason, actor: input.actor });
  const runnerAlive = !state.exited && pdaSidecarAlive(state, now.getTime());
  return {
    ok: true, sessionName: name, heldRequestId: held.requestId, heldCode: held.code, runnerAlive,
    message: `Release requested for ${name} (held: ${held.code}). ${runnerAlive
      ? "The runner retries the held message once more on its next tick (within 60 s)."
      : "Its runner is not running now; it applies the release when the seat next starts (rig up <rig> --existing)."} `
      + "If pda already took that message on an earlier attempt that never answered, it may be delivered twice.",
  };
}
