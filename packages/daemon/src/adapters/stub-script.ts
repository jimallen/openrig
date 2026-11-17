// OPR.0.5.1.1 — the PURE stub behavior-script model (A5 items 6-8).
//
// A per-seat script deterministically drives the pane-hosted stub-runner: pane
// output lines, named hook/behavior emissions, and (later) stepwise timing (PRD §4.2).
// This module is side-effect-free — parsing + validation + the built-in default only —
// so it unit-tests hermetically and both the runner (pane process) and the adapter
// (daemon) can import it without pulling daemon dependencies into the pane. The stub
// carries NO assertion logic; a script only says WHAT the seat does, never asserts.
//
// TWIN-PARITY: STUB_BEHAVIORS is the canonical, production-owned behavior repertoire.
// 51-02's scenario `emit` verb (scenario-schema.ts EMIT_BEHAVIORS) is a copy of the
// SAME shared contract; test/stub-script.test.ts guards the two against byte-drift.

/** The locked four-behavior repertoire (arch A4 terminal descope). Shared, byte-for-byte,
 *  with 51-02's EMIT_BEHAVIORS. usage_limit is deliberately absent — real-runtime-only. */
export const STUB_BEHAVIORS = ["compaction", "slow_output", "mid_turn_death", "restore"] as const;
export type StubBehavior = (typeof STUB_BEHAVIORS)[number];

/** Known-but-real-runtime-only behaviors: a stub cannot honestly feed the provider-usage
 *  lane, so the script model REFUSES them loudly (never accept-and-drop). Mirrors 51-02's
 *  REAL_RUNTIME_ONLY_EMIT_BEHAVIORS so a stub script and a stub scenario agree. */
export const REAL_RUNTIME_ONLY_BEHAVIORS = ["usage_limit"] as const;

/** A single deterministic script step. */
export type StubStep =
  | { kind: "say"; text: string }
  | { kind: "emit"; behavior: StubBehavior };

/** How a stub seat comes up (workspaces-o9o.29). "ready" (the default) reports ready and then runs its steps. "hold" prints
 *  its say steps and never reports ready: a seat held short of ready, so the launch's readiness wait runs out. "exit"
 *  prints its say steps and `[stub-runner] ERROR <error>`, records the exit and exits 1 before ready. This is a launch
 *  property, not a behavior: a behavior is a step a ready seat performs, so it is not in STUB_BEHAVIORS. */
export const STUB_READINESS = ["ready", "hold", "exit"] as const;
export type StubReadiness = (typeof STUB_READINESS)[number];

/** The exit code of a stub runner that exits before ready ("exit"). */
export const STUB_EXIT_BEFORE_READY_CODE = 1;

export interface StubScript {
  steps: StubStep[];
  /** Absent means "ready". */
  readiness?: StubReadiness;
  /** What the runner's ERROR line says; present exactly when readiness is "exit". */
  error?: string;
}

/** Loud, typed rejection — a malformed/dishonest script must fail, never silently no-op. */
export class StubScriptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StubScriptError";
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseStep(raw: unknown, path: string): StubStep {
  if (!isPlainObject(raw)) throw new StubScriptError(`${path}: step must be an object`);
  const kind = raw.kind;
  if (kind === "say") {
    const text = raw.text;
    if (typeof text !== "string" || text.length === 0) {
      throw new StubScriptError(`${path}.text: a say step requires a non-empty string`);
    }
    return { kind: "say", text };
  }
  if (kind === "emit") {
    const behavior = raw.behavior;
    if (typeof behavior === "string" && (STUB_BEHAVIORS as readonly string[]).includes(behavior)) {
      return { kind: "emit", behavior: behavior as StubBehavior };
    }
    if (typeof behavior === "string" && (REAL_RUNTIME_ONLY_BEHAVIORS as readonly string[]).includes(behavior)) {
      throw new StubScriptError(
        `${path}.behavior: "${behavior}" is real-runtime-only (a stub cannot honestly feed the ` +
        `provider-usage lane) — it is refused in a stub script, never a silent no-op`,
      );
    }
    throw new StubScriptError(
      `${path}.behavior: unknown behavior ${JSON.stringify(behavior)} — the stub repertoire is: ${STUB_BEHAVIORS.join(", ")}`,
    );
  }
  throw new StubScriptError(`${path}.kind: unknown step kind ${JSON.stringify(kind)} — expected "say" or "emit"`);
}

/** Parse + validate a stub script from its JSON string. Throws StubScriptError on any
 *  malformation so a bad script fails loudly at load, not with a silent partial run. */
export function parseStubScript(raw: string): StubScript {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new StubScriptError("stub script is not valid JSON");
  }
  if (!isPlainObject(parsed)) throw new StubScriptError("stub script must be an object { steps: [...] }");
  const steps = parsed.steps;
  if (!Array.isArray(steps)) throw new StubScriptError("stub script requires a steps array");
  const parsedSteps = steps.map((step, i) => parseStep(step, `steps[${i}]`));
  const readiness = parsed.readiness ?? "ready";
  if (typeof readiness !== "string" || !(STUB_READINESS as readonly string[]).includes(readiness)) {
    throw new StubScriptError(`readiness: unknown readiness ${JSON.stringify(parsed.readiness)} — expected one of: ${STUB_READINESS.join(", ")}`);
  }
  const error = parsed.error;
  if (readiness === "exit" && (typeof error !== "string" || error.length === 0)) {
    throw new StubScriptError(`error: a seat whose readiness is "exit" requires a non-empty error, the text of its ERROR line`);
  }
  if (readiness !== "exit" && error !== undefined) {
    throw new StubScriptError(`error: only a seat whose readiness is "exit" prints an ERROR line; this one's readiness is "${readiness}"`);
  }
  if (readiness !== "ready") {
    const emitAt = parsedSteps.findIndex((step) => step.kind === "emit");
    if (emitAt >= 0) {
      throw new StubScriptError(`steps[${emitAt}]: an emit needs a ready seat, and this seat's readiness is "${readiness}"; only say steps run`);
    }
  }
  if (readiness === "ready") return { steps: parsedSteps };
  return { steps: parsedSteps, readiness: readiness as StubReadiness, ...(readiness === "exit" ? { error: error as string } : {}) };
}

/** The built-in default script for a standalone stub seat (no scenario-resolved script):
 *  prompt + echo + a scripted reply, so the seat produces observable pane output. */
export const DEFAULT_STUB_SCRIPT: StubScript = {
  steps: [
    { kind: "say", text: "[stub] ready — awaiting prompt" },
    { kind: "say", text: "[stub] scripted reply: acknowledged" },
  ],
};
