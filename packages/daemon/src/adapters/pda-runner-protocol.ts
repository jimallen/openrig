// pda runtime L0 (pda-runtime-design-9l Rev 2): the shared, PURE contract between the pda runtime adapter
// (L2a), the pda resume adapter (L2a), the rig-spec schema (L2b), the usage route and store (L2c), and the
// pane-hosted pda-runner with its client and outbox (L1a, L1b).
//
// Bounded contexts. OpenRig owns the seat (node, occupant, binding, resume token, readiness). pda owns the
// agent (a named conversation in its Harness). The runner's `pda-client.ts` (L1a) is the anti-corruption
// layer and the only module that speaks pda's HTTP vocabulary. This file holds only OpenRig's side of the
// shared language: names, shapes, predicates and the rules more than one lane must apply identically.
//
// Everything here is side-effect-free: constants, types, parsers and string builders. It imports only node
// builtins, so the runner entry can import it without daemon dependencies. Nothing here is reachable from a
// launch until L2a registers runtime "pda"; until then this module is inert in production.

import nodePath from "node:path";

export const PDA_RUNTIME = "pda";
export const PDA_RESUME_TYPE = "pda_agent";

// ── The binding: which pda agent a seat drives, and where ─────────────────────

/** pda's agent-name rule, pinned by value (pda `app.mjs:22` NAME_PATTERN). OpenRig never imports pda. */
export const PDA_AGENT_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,39}$/;
/** pda's root agent (`app.mjs:23` ROOT_NAME = "main"), pinned by value. A seat may never bind it (Jim, J-1). */
export const PDA_ROOT_AGENT = "main";
/** pda binds 127.0.0.1 only (`main.mjs:60`); this is its default port. */
export const PDA_DEFAULT_BASE_URL = "http://127.0.0.1:8150";

export interface PdaBinding {
  agent: string;
  /** Always the canonical loopback form `http://127.0.0.1:<port>`, no trailing slash. */
  baseUrl: string;
}

// Canonical form only: no leading zero, so two spellings of one port can never compare unequal.
const LOOPBACK_BASE_URL = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/;

/** The ONE loopback rule. The schema (L2b), the runner's --base-url check (L1a) and the resume-token
 *  validator (L2a) all call this, so "loopback only" cannot drift between its three sites. `localhost` is a
 *  name and `[::1]` could never connect to pda; both are refused, as are https, paths, userinfo and ports
 *  outside 1-65535. */
export function isPdaLoopbackBaseUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const m = LOOPBACK_BASE_URL.exec(value);
  if (!m) return false;
  const port = Number(m[1]);
  return port >= 1 && port <= 65535;
}

export type PdaAgentNameProblem = "not_a_string" | "pattern" | "root_agent";

/** Why `value` cannot name a pda agent a seat may bind, or null when it can. */
export function pdaAgentNameProblem(value: unknown): PdaAgentNameProblem | null {
  if (typeof value !== "string") return "not_a_string";
  if (!PDA_AGENT_NAME_PATTERN.test(value)) return "pattern";
  if (value === PDA_ROOT_AGENT) return "root_agent";
  return null;
}

// ── The `pda:` member block of a rig spec (schema rule; L2b wires it into rigspec-schema.ts) ──

/** The closed key set of a member's `pda:` block. */
export const PDA_SPEC_BLOCK_KEYS = ["agent", "base_url"] as const;

export type PdaSpecBlockResult =
  | { ok: true; binding: PdaBinding }
  | { ok: false; errors: string[] };

/** Validate a member's `pda:` block. `agent` is required and has NO default; `agent: main` is refused
 *  (J-1). `base_url` is optional, defaults to PDA_DEFAULT_BASE_URL, and must be `http://127.0.0.1:<port>`.
 *  Unknown keys are refused. `where` prefixes every error (e.g. `pods[0].members[1].pda`). */
export function parsePdaSpecBlock(raw: unknown, where = "pda"): PdaSpecBlockResult {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, errors: [`${where}: must be a mapping with a required 'agent'`] };
  }
  const block = raw as Record<string, unknown>;
  const errors: string[] = [];
  for (const key of Object.keys(block)) {
    if (!(PDA_SPEC_BLOCK_KEYS as readonly string[]).includes(key)) {
      errors.push(`${where}.${key}: unknown key; a pda block takes only ${PDA_SPEC_BLOCK_KEYS.join(", ")}`);
    }
  }
  const agentProblem = "agent" in block ? pdaAgentNameProblem(block.agent) : "missing";
  if (agentProblem === "missing") errors.push(`${where}.agent: required; it names the pda agent this seat drives (there is no default)`);
  else if (agentProblem === "not_a_string" || agentProblem === "pattern") {
    errors.push(`${where}.agent: must match ${PDA_AGENT_NAME_PATTERN.source}`);
  } else if (agentProblem === "root_agent") {
    errors.push(`${where}.agent: '${PDA_ROOT_AGENT}' is pda's root agent and cannot be bound to a seat`);
  }
  const baseUrl = "base_url" in block ? block.base_url : PDA_DEFAULT_BASE_URL;
  if (!isPdaLoopbackBaseUrl(baseUrl)) {
    errors.push(`${where}.base_url: must be http://127.0.0.1:<port> with a port from 1 to 65535 (pda listens on loopback only)`);
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, binding: { agent: block.agent as string, baseUrl: baseUrl as string } };
}

// ── Resume token ─────────────────────────────────────────────────────────────

/** The resume token names the binding: `http://127.0.0.1:<port>/agents/<agent>`. It holds no secret. */
export function formatPdaResumeToken(binding: PdaBinding): string {
  return `${binding.baseUrl}/agents/${binding.agent}`;
}

const RESUME_TOKEN = /^(http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4})\/agents\/([^/]+)$/;

/** The binding a resume token names, or null when it is not a well-formed pda token. Strict: the same
 *  loopback and agent-name rules as the spec block, so a token can never name `main` or a remote host. */
export function parsePdaResumeToken(token: unknown): PdaBinding | null {
  if (typeof token !== "string") return null;
  const m = RESUME_TOKEN.exec(token);
  if (!m) return null;
  const [, baseUrl, agent] = m as unknown as [string, string, string];
  if (!isPdaLoopbackBaseUrl(baseUrl) || pdaAgentNameProblem(agent) !== null) return null;
  return { agent, baseUrl };
}

/** Review nit D4: restore resumes the TOKEN's binding. When the node's persisted spec binding
 *  (`nodes.pda_binding`, L2b) names another agent or URL, restore must say so rather than silently doing
 *  something other than the spec says. Returns the warning text, or null when they agree or the spec
 *  binding is unknown. L2a's pda resume branch emits it; pda has no fresh start, so the only rebind is to
 *  re-instantiate the seat. */
export function pdaRestoreBindingWarning(specBinding: PdaBinding | null, tokenBinding: PdaBinding): string | null {
  if (!specBinding) return null;
  if (specBinding.agent === tokenBinding.agent && specBinding.baseUrl === tokenBinding.baseUrl) return null;
  return `The seat's spec binds pda agent '${specBinding.agent}' at ${specBinding.baseUrl}, but its resume token names `
    + `'${tokenBinding.agent}' at ${tokenBinding.baseUrl}. Restore resumes '${tokenBinding.agent}' (the token), and messages `
    + `read for one agent are never sent to the other. To bind the seat to '${specBinding.agent}', re-instantiate the seat; `
    + `a pda seat has no fresh start.`;
}

// ── Seat state layout ─────────────────────────────────────────────────────────
// <stateRoot>/<sessionName>/              dir 0700; every file 0600
//   runner-state.json      the sidecar (PdaRunnerState)
//   outbox.log             append-only PdaOutboxRecord lines (L1a)
//   rejected.log           rejected records kept before compaction (L1a)
//   own-submissions.json   the last 500 submission ids this seat made (L1b, J-3 attribution)
//   usage-pending.json     usage facts not yet stored when the runner stopped (OF-93; the usage sink writes and loads it)
//   release.request        operator control file for `rig seat pda-release` (L2a writes, runner polls)

export interface PdaSeatPaths {
  seatRoot: string;
  runnerStatePath: string;
  outboxPath: string;
  rejectedPath: string;
  ownSubmissionsPath: string;
  usagePendingPath: string;
  releaseRequestPath: string;
}

export function pdaSeatPaths(stateRoot: string, sessionName: string): PdaSeatPaths {
  const seatRoot = nodePath.join(stateRoot, sessionName);
  return {
    seatRoot,
    runnerStatePath: nodePath.join(seatRoot, "runner-state.json"),
    outboxPath: nodePath.join(seatRoot, "outbox.log"),
    rejectedPath: nodePath.join(seatRoot, "rejected.log"),
    ownSubmissionsPath: nodePath.join(seatRoot, "own-submissions.json"),
    usagePendingPath: nodePath.join(seatRoot, "usage-pending.json"),
    releaseRequestPath: nodePath.join(seatRoot, "release.request"),
  };
}

export const PDA_RUNNER_LABEL = "pda-runner";
export const PDA_RUNNER_READY_MARKER = "[pda-runner] READY";
export const PDA_RUNNER_EXIT_MARKER = "[pda-runner] EXITED";
export const PDA_RUNNER_ERROR_MARKER = "[pda-runner] ERROR";

// ── Runner argv ──────────────────────────────────────────────────────────────

export interface PdaRunnerArgs {
  sessionName: string;
  stateRoot: string;
  launchId: string;
  binding: PdaBinding;
  /** A PATH to pda's token file; the token itself never enters argv or env (design D1). */
  tokenFile: string;
  /** usage.pda_cost_facts is on: the runner posts usage facts. */
  usageFacts?: boolean;
}

/** The runner's argv after `node <entry>`. Holds no secret. */
export function buildPdaRunnerArgv(args: PdaRunnerArgs): string[] {
  const argv = [
    "--session-name", args.sessionName,
    "--state-root", args.stateRoot,
    "--launch-id", args.launchId,
    "--agent", args.binding.agent,
    "--base-url", args.binding.baseUrl,
    "--token-file", args.tokenFile,
  ];
  if (args.usageFacts) argv.push("--usage-facts");
  return argv;
}

// ── Token format (design A6) ─────────────────────────────────────────────────

/** pda writes `randomBytes(32).toString("base64url")` (43 chars, `main.mjs:28`). The runner checks this
 *  BEFORE any use, so an interior LF can never reach `new Headers` (which echoes the value in its error). */
export const PDA_TOKEN_FORMAT = /^[A-Za-z0-9_-]{16,512}$/;

export function isPdaTokenFormat(value: string): boolean {
  return PDA_TOKEN_FORMAT.test(value);
}

// ── Runner-state sidecar ─────────────────────────────────────────────────────

/** Codes that hold the outbox head and need a person. */
export type PdaHeldCode = "pda_message_held" | "pda_agent_missing" | "pda_unauthorized";
export type PdaRunnerErrorCode =
  | "pda_unreachable" | "pda_unauthorized" | "pda_agent_missing" | "pda_protocol" | "pda_token_format"
  | "pda_outbox_binding_mismatch";

/** The sidecar. It never holds the token, a message body, tool output, or a pda error body. */
export interface PdaRunnerState {
  ready: boolean;
  launchId: string;
  updatedAt: string;
  /** Rewritten every 60 s (file only, no DB). A reader treats a sidecar older than its alive window as no answer. */
  aliveAt: string;
  agent: string;
  baseUrl: string;
  connected: boolean;
  busy: boolean;
  lastEntryId?: string;
  outboxPending: number;
  held?: { requestId: string; code: PdaHeldCode; at: string };
  /** Pending records for another binding, set aside (design A1). */
  setAside?: number;
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  error?: { code: PdaRunnerErrorCode; at: string };
  exited?: { code: number | null; at: string };
}

/** The held codes, in one place for the sidecar parser, the hook mapping and the RSI permission-stall predicate. */
export const PDA_HELD_CODES: readonly PdaHeldCode[] = ["pda_message_held", "pda_agent_missing", "pda_unauthorized"];
const HELD_CODES: ReadonlySet<string> = new Set<PdaHeldCode>(PDA_HELD_CODES);

/** Is this subtype one of the codes the runner reports as a held message (`Notification/<code>`, OF-89)? The daemon
 *  maps exactly these, for a pda seat only, to needs_input. */
export function isPdaHeldCode(value: string | null | undefined): value is PdaHeldCode {
  return typeof value === "string" && HELD_CODES.has(value);
}
const ERROR_CODES: ReadonlySet<string> = new Set<PdaRunnerErrorCode>([
  "pda_unreachable", "pda_unauthorized", "pda_agent_missing", "pda_protocol", "pda_token_format", "pda_outbox_binding_mismatch",
]);

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/** Parse a sidecar. Null for anything that is not a complete, well-typed record: a reader that cannot
 *  parse the sidecar has no runner answer and must fall back, never guess. */
export function parsePdaRunnerState(raw: string): PdaRunnerState | null {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!isObj(parsed)) return null;
  const s = parsed;
  if (typeof s.ready !== "boolean" || typeof s.connected !== "boolean" || typeof s.busy !== "boolean") return null;
  for (const key of ["launchId", "updatedAt", "aliveAt", "agent", "baseUrl"] as const) {
    if (typeof s[key] !== "string") return null;
  }
  if (!isCount(s.outboxPending)) return null;
  if (s.held !== undefined && !(isObj(s.held) && typeof s.held.requestId === "string" && typeof s.held.at === "string"
    && typeof s.held.code === "string" && HELD_CODES.has(s.held.code))) return null;
  if (s.error !== undefined && !(isObj(s.error) && typeof s.error.at === "string"
    && typeof s.error.code === "string" && ERROR_CODES.has(s.error.code))) return null;
  if (s.exited !== undefined && !(isObj(s.exited) && typeof s.exited.at === "string"
    && (s.exited.code === null || typeof s.exited.code === "number"))) return null;
  if (s.setAside !== undefined && !isCount(s.setAside)) return null;
  return parsed as unknown as PdaRunnerState;
}

// ── Outbox records (design A1, A2; L1a implements the log) ───────────────────

/** `openrig/<nodeId>/<launchId>/<seq>`: every requestId OpenRig sends is under `openrig/<nodeId>/`, which is
 *  how the runner recognises its own submissions in pda's stream (J-3 attribution). */
export function pdaRequestId(nodeId: string, launchId: string, seq: number): string {
  return `openrig/${nodeId}/${launchId}/${seq}`;
}

export type PdaOutboxRecord =
  | { op: "enq"; requestId: string; agent: string; baseUrl: string; content: string; at: string }
  | { op: "ack"; requestId: string; submissionId: string; at: string }
  | { op: "hold"; requestId: string; code: PdaHeldCode; status?: number; attempts: number; at: string }
  | { op: "reject"; requestId: string; status: number; code: "pda_rejected"; at: string }
  /** Written only through the operator's release request. */
  | { op: "release"; requestId: string; at: string };

// ── Pane sanitiser (design A5, mandatory) ────────────────────────────────────

// One left-to-right pass over every escape form. String-type sequences (OSC; DCS, SOS, PM, APC) run to
// their terminator, so their payload goes with them. An unterminated one loses only its introducer, and
// step 2 then removes any control left behind.
const ESCAPE_SEQUENCES = new RegExp([
  "\\u001b\\][\\s\\S]*?(?:\\u0007|\\u001b\\\\)",          // OSC ... BEL | ST
  "\\u001b[PX^_][\\s\\S]*?\\u001b\\\\",                  // DCS, SOS, PM, APC ... ST
  "\\u001b\\[[0-?]*[ -/]*[@-~]",                        // CSI
  "\\u001b[ -/]*[0-~]",                                 // 2-byte ESC (with intermediates)
  "\\u009d[\\s\\S]*?(?:\\u0007|\\u009c|\\u001b\\\\)",     // C1 OSC ... BEL | ST
  "[\\u0090\\u0098\\u009e\\u009f][\\s\\S]*?(?:\\u009c|\\u001b\\\\)", // C1 DCS, SOS, PM, APC ... ST
  "\\u009b[0-?]*[ -/]*[@-~]",                           // C1 CSI
].join("|"), "g");
// Every remaining C0, DEL and C1 control except LF and TAB: CR, BEL, ETX, a lone ESC, ...
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
// Bidi controls (embedding, override, isolate; the LRM, RLM and ALM marks) and the line and paragraph
// separators: they can make capture read differently from the bytes. Written as escapes so no editor or
// formatter can silently drop an invisible character out of the guard (review N5); a pin checks the source.
const BIDI_CONTROLS = /[\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

/** Strip every terminal control from text bound for the pane: escape sequences (7-bit and C1), then every
 *  control except `\n` and `\t`, then the bidi controls. Applied to EVERY string the runner prints. The
 *  runner applies exact-value token redaction AFTER this (L1b), and re-asserts `ESC[?2004h` itself after
 *  each output batch; this function emits no escape at all. */
export function sanitizeForPane(text: string): string {
  return text.replace(ESCAPE_SEQUENCES, "").replace(CONTROLS, "").replace(BIDI_CONTROLS, "");
}

// ── Usage wire payload (J-3, J-5) ────────────────────────────────────────────

/** Why a fact's cost is what it is. `model_priced`: pi-ai's price × tokens, stored as given (a real 0 only
 *  with 0 tokens). `declared_zero_price`: the provider declares a zero price table, so a 0 for tokens > 0 says
 *  nothing about spend and is stored as NULL. `absent`: no usable cost. */
export type PdaCostBasis = "model_priced" | "declared_zero_price" | "absent";
export type PdaUsageOrigin = "own" | "other" | "unknown";

export interface PdaUsageTokens { input: number; output: number; cacheRead: number; cacheWrite: number }

/** Jim's J-5 rule, the one place it is decided. `cost` is pi-ai's `usage.cost` object (or anything).
 *  - total > 0, finite                → total, model_priced
 *  - total == 0 and tokens > 0        → NULL, declared_zero_price
 *  - total == 0 and 0 tokens          → 0, model_priced (0 tokens at any price is a real 0)
 *  - no cost, non-number, negative, non-finite → NULL, absent
 *  - any token count NaN, infinite or negative → NULL, absent */
export function derivePdaCost(cost: unknown, tokens: PdaUsageTokens): { costTotal: number | null; costBasis: PdaCostBasis } {
  // Review N6: a token count that is not a finite, non-negative number makes the basis unknowable.
  for (const n of [tokens.input, tokens.output, tokens.cacheRead, tokens.cacheWrite]) {
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return { costTotal: null, costBasis: "absent" };
  }
  const total = isObj(cost) ? cost.total : undefined;
  if (typeof total !== "number" || !Number.isFinite(total) || total < 0) return { costTotal: null, costBasis: "absent" };
  if (total > 0) return { costTotal: total, costBasis: "model_priced" };
  const tokenSum = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
  return tokenSum > 0 ? { costTotal: null, costBasis: "declared_zero_price" } : { costTotal: 0, costBasis: "model_priced" };
}

/** One assistant entry's usage, as the runner posts it. Numbers and ids only: never text or tool output. */
export interface PdaUsageFact extends PdaUsageTokens {
  conversationId: string;
  entryId: string;
  entryTimestamp: string;
  kind: "assistant";
  provider: string | null;
  model: string | null;
  api: string | null;
  responseId: string | null;
  stopReason: string | null;
  costTotal: number | null;
  costBasis: PdaCostBasis;
  origin: PdaUsageOrigin;
}

/** `POST /api/activity/pda-usage` body (L2c route). Idempotent on (conversationId, entryId). */
export interface PdaUsagePayload {
  sessionName: string;
  nodeId?: string | null;
  generation?: string | null;
  agent: string;
  facts: PdaUsageFact[];
}

const strOrNull = (v: unknown): v is string | null => v === null || typeof v === "string";
const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const COST_BASES: ReadonlySet<string> = new Set<PdaCostBasis>(["model_priced", "declared_zero_price", "absent"]);
const ORIGINS: ReadonlySet<string> = new Set<PdaUsageOrigin>(["own", "other", "unknown"]);

/** The receiving side's check of one posted fact (L2c). Beyond shape, it enforces J-5's pairing, so no
 *  fact can be stored that would let a report sum a pda seat to $0 for real spend: a NULL cost has a
 *  non-priced basis, and a model_priced cost is finite, non-negative and is 0 only with 0 tokens. */
export function parsePdaUsageFact(raw: unknown): PdaUsageFact | null {
  if (!isObj(raw)) return null;
  const f = raw;
  if (!nonEmpty(f.conversationId) || !nonEmpty(f.entryId) || !nonEmpty(f.entryTimestamp) || f.kind !== "assistant") return null;
  for (const key of ["provider", "model", "api", "responseId", "stopReason"] as const) if (!strOrNull(f[key])) return null;
  for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) if (!isCount(f[key])) return null;
  if (typeof f.costBasis !== "string" || !COST_BASES.has(f.costBasis)) return null;
  if (typeof f.origin !== "string" || !ORIGINS.has(f.origin)) return null;
  const tokens = (f.input as number) + (f.output as number) + (f.cacheRead as number) + (f.cacheWrite as number);
  if (f.costBasis === "model_priced") {
    if (typeof f.costTotal !== "number" || !Number.isFinite(f.costTotal) || f.costTotal < 0) return null;
    if (f.costTotal === 0 && tokens > 0) return null;
  } else {
    if (f.costTotal !== null) return null;
    // A zero price is "declared" only for real tokens; 0 tokens is a model_priced 0.
    if (f.costBasis === "declared_zero_price" && tokens === 0) return null;
  }
  return f as unknown as PdaUsageFact;
}
