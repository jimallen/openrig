// workspaces-o9o.123: Claude Code's Code Mode for a seat that declares `code_mode: true`.
//
// Measured on Claude Code 2.1.327 (o9o.122): a session started in Code Mode resumes or forks ONLY with this variable set to 1; without
// it claude prints "can't be resumed" and exits 1, leaving the seat's pane at a shell. So every claude launch of such a seat (fresh,
// resume, fork, restore, handover successor) and the resumability probe's throwaway resume set it. A seat that does not declare
// code_mode gets none of this: its launch is byte-identical to before.
//
// The first Code Mode launch in a Claude config home stops at a one-time "turn on Code Mode" picker; Claude keeps the answer in that
// home's .claude.json as the CODE_MODE_ACCEPTED_KEYS, all true. A code_mode seat's launch writes the ones that are ABSENT, and only
// into the seat's own Claude home (nodes.claude_config_dir), never the daemon's default or selected one and never through a link (verify-sec2's
// review of o9o.123; codeModeAnswerPlan below is the rule, the adapter is where it touches the disk).

/** The variable Claude Code reads (code.claude.com/docs/en/code-mode). */
export const CLAUDE_CODE_MODE_ENV = "CLAUDE_CODE_EXPERIMENTAL_CODE_MODE";

/** The .claude.json keys that record the one-time Code Mode answer: both are written when it is answered "Yes", and the picker shows
 *  again unless both are true (measured on Claude Code 2.1.327, launch only: either key alone still showed it, the two together did not). */
export const CODE_MODE_ACCEPTED_KEYS: readonly string[] = ["codeModeCaveatsAcceptedV1", "codeModeAutoModeCaveatAcceptedV1"];

/** What to do with Code Mode's one-time answer in a seat's Claude state.
 *  - "answered": every key is already true; nothing to write.
 *  - "write": the absent keys, each to be set true; every other field stays as it is.
 *  - "declined": a key is PRESENT with a value other than true. That is the user's (or Claude's) answer, not a gap, so nothing is
 *    written, the other key is not filled around it, and the launch says so. Invariant: a present answer is never overwritten. */
export type CodeModeAnswerPlan =
  | { kind: "answered" }
  | { kind: "write"; keys: readonly string[] }
  | { kind: "declined"; keys: readonly string[] };

export function codeModeAnswerPlan(state: Readonly<Record<string, unknown>>): CodeModeAnswerPlan {
  const declined = CODE_MODE_ACCEPTED_KEYS.filter((key) => Object.hasOwn(state, key) && state[key] !== true);
  if (declined.length > 0) return { kind: "declined", keys: declined };
  const absent = CODE_MODE_ACCEPTED_KEYS.filter((key) => !Object.hasOwn(state, key));
  return absent.length === 0 ? { kind: "answered" } : { kind: "write", keys: absent };
}

/** The launch environment entry for a managed launch (env -i passes only what it is given); {} when the seat does not declare it. */
export function claudeCodeModeEnv(codeMode: boolean | undefined): Record<string, string> {
  return codeMode === true ? { [CLAUDE_CODE_MODE_ENV]: "1" } : {};
}

/** The reads and the one write this module makes of the daemon's database, named here so the domain does not import the driver. */
export interface CodeModeDb {
  prepare(sql: string): { get(...params: unknown[]): unknown; run(...params: unknown[]): unknown };
}

// Invariant (CoS ruling, verify-sec2's finding 4): Code Mode belongs to the CONVERSATION. A session row records the mode its conversation
// was launched in (sessions.code_mode, migration 133); a launch that continues a conversation (resume, restore, fork, the resumability
// probe, the resume line OpenRig shows) uses that recorded mode, and only a FRESH launch takes the seat's declaration (nodes.code_mode).
// A conversation with no recorded mode (a row from before the column, or a session the person started and OpenRig claimed) is not Code
// Mode. A read that fails is the same answer, which types every line as it was before code_mode existed.

/** The mode a session's conversation was launched in (sessions.code_mode = 1). The resumability probe asks it per session. */
export function sessionCodeMode(db: CodeModeDb, sessionId: string): boolean {
  try {
    const row = db.prepare("SELECT code_mode AS v FROM sessions WHERE id = ?").get(sessionId) as { v: number | null } | undefined;
    return row?.v === 1;
  } catch {
    return false;
  }
}

/** The mode of the conversation a launch continues, found by its native id (the resume token a resume passes, the parent id a fork
 *  passes): the newest session row carrying that id, other than the row of the launch asking (which may already carry it). */
export function conversationCodeMode(db: CodeModeDb, conversationId: string, launchingSessionId?: string | null): boolean {
  try {
    const row = db.prepare("SELECT code_mode AS v FROM sessions WHERE resume_token = ? AND id IS NOT ? ORDER BY rowid DESC LIMIT 1")
      .get(conversationId, launchingSessionId ?? null) as { v: number | null } | undefined;
    return row?.v === 1;
  } catch {
    return false;
  }
}

/** The mode a launch should run in: the continued conversation's recorded mode, or (a fresh launch, `conversationId` absent) the seat's
 *  declaration. */
export function launchCodeMode(db: CodeModeDb, input: { declared: boolean; conversationId?: string | null; launchingSessionId?: string | null }): boolean {
  return input.conversationId ? conversationCodeMode(db, input.conversationId, input.launchingSessionId) : input.declared;
}

/** Record on a session row the mode its conversation runs in. Best effort: a database without the column keeps the row as it is. */
export function recordSessionCodeMode(db: CodeModeDb, sessionId: string, codeMode: boolean): void {
  try {
    db.prepare("UPDATE sessions SET code_mode = ? WHERE id = ?").run(codeMode ? 1 : null, sessionId);
  } catch { /* a reduced-schema database: nothing to record into */ }
}

/** A binding with `codeMode` set to the launch's mode: the key present only when true, so an undeclared launch is unchanged. */
export function withCodeMode<T extends { codeMode?: boolean }>(binding: T, codeMode: boolean): T {
  const { codeMode: _previous, ...rest } = binding;
  return (codeMode ? { ...rest, codeMode: true } : rest) as T;
}

/** The shell prefix for a typed launch line, with its trailing space; "" when the seat does not declare it. */
export function claudeCodeModePrefix(codeMode: boolean | undefined): string {
  return codeMode === true ? `${CLAUDE_CODE_MODE_ENV}=1 ` : "";
}
