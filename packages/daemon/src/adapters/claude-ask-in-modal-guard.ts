// The ask-in-modal guard: a Stop hook in the ONE `--settings` JSON of a Claude launch whose seat declared `ask_in_modal: true`.
//
// The hook (assets/plugins/openrig-core/hooks/scripts/ask-in-modal-guard.cjs) sends a turn back when it ends with a question
// for the human in prose, so the seat moves it into an AskUserQuestion modal. It rides in the launch settings, not in the
// plugin's hooks/claude.json, because it is per seat (only the declaring seat runs it) and because the openrig-core plugin is
// not installed in every seat's Claude home, while the launch settings reach every Claude launch path (operationalLaunchArgs).
// Two `--settings` flags do not merge (measured on Claude Code 2.1.318, see claude-rig-body-guard.ts), so the hook is merged
// INTO the launch's settings JSON as a Stop group. Nothing is written to disk.
//
// Unlike the rig-body guard, a missing script does not refuse the launch: the hook then fails as a non-blocking hook error and
// the seat runs unguarded, which costs a prose question, not a command that runs. Refusing a coordinator's launch over it
// would cost more.
import nodePath from "node:path";
import { shellQuote } from "./shell-quote.js";

/** The hook script the settings point at: the plugin asset shipped with this daemon. src/adapters and dist/adapters are the same depth. */
export function askInModalGuardScriptPath(adaptersDir: string = import.meta.dirname): string {
  return nodePath.resolve(adaptersDir, "../../assets/plugins/openrig-core/hooks/scripts/ask-in-modal-guard.cjs");
}

/** Seconds Claude Code gives the hook. The script reads at most a 4 MB transcript tail and does no network I/O. */
export const ASK_IN_MODAL_GUARD_TIMEOUT_SECONDS = 5;

/** The guard's Stop group. The daemon's own node runs it by absolute path (a bare `node` would fail on a seat whose PATH has none). */
export function askInModalGuardGroup(scriptPath: string = askInModalGuardScriptPath(), nodePath: string = process.execPath): { hooks: Array<{ type: "command"; command: string; timeout: number }> } {
  return { hooks: [{ type: "command", command: `${shellQuote(nodePath)} ${shellQuote(scriptPath)}`, timeout: ASK_IN_MODAL_GUARD_TIMEOUT_SECONDS }] };
}

const SETTINGS_FLAG = "--settings";
const SETTINGS_EQ = "--settings=";

/** Add the guard's Stop group to a Claude launch's argv, keeping exactly one `--settings` (in the form it came in, or a new
 *  `--settings <json>` when there was none). Idempotent. Throws, so the launch does not happen with a caller's settings
 *  silently dropped, when more than one settings flag goes in, the value is missing or not a JSON object, `hooks` is not an
 *  object or `hooks.Stop` is not an array (the same fail-closed shape rules as withRigBodyGuard). */
export function withAskInModalGuard(args: string[], scriptPath: string = askInModalGuardScriptPath()): string[] {
  const flagAt: number[] = [];
  args.forEach((a, i) => { if (a === SETTINGS_FLAG || a.startsWith(SETTINGS_EQ)) flagAt.push(i); });
  if (flagAt.length > 1) throw new Error("a Claude launch carries more than one --settings; they do not merge");
  const group = askInModalGuardGroup(scriptPath);
  if (flagAt.length === 0) return [...args, SETTINGS_FLAG, JSON.stringify({ hooks: { Stop: [group] } })];
  const at = flagAt[0]!;
  const equalsForm = args[at]!.startsWith(SETTINGS_EQ);
  const raw = equalsForm ? args[at]!.slice(SETTINGS_EQ.length) : args[at + 1];
  if (raw === undefined) throw new Error("the --settings of a Claude launch has no value; not launching Claude without the ask-in-modal guard");
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch (error) {
    throw new Error(`the --settings value of a Claude launch is not valid JSON (${error instanceof Error ? error.message : String(error)}); not launching Claude without the ask-in-modal guard`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("the --settings value of a Claude launch is not a JSON object; not launching Claude without the ask-in-modal guard");
  const settings = parsed as Record<string, unknown>;
  const rawHooks = settings["hooks"];
  if (rawHooks !== undefined && (rawHooks === null || typeof rawHooks !== "object" || Array.isArray(rawHooks))) throw new Error("the --settings hooks of a Claude launch is not an object; not launching Claude without the ask-in-modal guard");
  const hooks = { ...((rawHooks ?? {}) as Record<string, unknown>) };
  const rawStop = hooks["Stop"];
  if (rawStop !== undefined && !Array.isArray(rawStop)) throw new Error("the --settings hooks.Stop of a Claude launch is not an array; not launching Claude without the ask-in-modal guard");
  const existing = (rawStop ?? []) as Array<{ hooks?: Array<{ command?: string }> }>;
  const already = existing.some((g) => !!g && typeof g === "object" && Array.isArray(g.hooks) && g.hooks.some((h) => !!h && h.command === group.hooks[0]!.command));
  hooks["Stop"] = already ? existing : [...existing, group];
  const json = JSON.stringify({ ...settings, hooks });
  return equalsForm ? [...args.slice(0, at), `${SETTINGS_EQ}${json}`, ...args.slice(at + 1)] : [...args.slice(0, at + 1), json, ...args.slice(at + 2)];
}
