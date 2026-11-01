// A stub of how Codex treats its UserPromptSubmit hook, measured on 0.166.0 (s0 M4, M5, and a count of a real rollout): the hook runs
// before the rollout write, `decision: block` stops the prompt with no rollout record, and a hook that crashes fails OPEN, so the
// prompt runs and lands in the rollout unrecorded. It runs the real relay as a real process. No Codex here.
import { spawnSync } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const RELAY = fileURLToPath(new URL("../../assets/plugins/openrig-core/hooks/scripts/activity-relay.cjs", import.meta.url));
export const CRASH_PRELOAD = fileURLToPath(new URL("./relay-crash-preload.cjs", import.meta.url));
export const SEAT = "dev-impl@rig1";
export const NONCE = "0123456789abcdef0123";

export function marker(id: string, nonce = NONCE): string {
  return `[openrig-msg ${id}:${nonce}]`;
}

export interface StubCodexSeat { readonly home: string; readonly rollout: string; turns: string[] }

export function stubCodexSeat(home: string): StubCodexSeat {
  return { home, rollout: join(home, "rollout-stub.jsonl"), turns: [] };
}

export function codexHookEnv(seat: StubCodexSeat, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH, HOME: seat.home, OPENRIG_HOME: seat.home, OPENRIG_SESSION_NAME: SEAT, OPENRIG_NODE_ID: "node-a", OPENRIG_RUNTIME: "codex", ...extra };
}

export function rolloutUserLine(prompt: string): string {
  return `${JSON.stringify({ timestamp: "2031-03-04T05:06:07.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: prompt }] } })}\n`;
}

export interface CodexHookRun { blocked: boolean; reason: string | null; crashed: boolean; ran: boolean }

/** One prompt, as Codex takes it. `agentDiesInHook`: the agent is killed after the hook and before its rollout write (s0 M5). */
export function submitToCodex(seat: StubCodexSeat, prompt: string, opts: { relay?: string; nodeArgs?: string[]; env?: Record<string, string>; agentDiesInHook?: boolean } = {}): CodexHookRun {
  const input = JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt, transcript_path: seat.rollout, session_id: "t-1", turn_id: `turn-${seat.turns.length}` });
  const run = spawnSync(process.execPath, [...(opts.nodeArgs ?? []), opts.relay ?? RELAY], { input, env: codexHookEnv(seat, opts.env), encoding: "utf8", timeout: 15_000 });
  const crashed = run.signal !== null || run.status !== 0;
  let reason: string | null = null;
  try {
    const decision = JSON.parse(run.stdout.trim().split("\n").pop() ?? "") as { decision?: string; reason?: string };
    if (decision.decision === "block") reason = decision.reason ?? "";
  } catch { /* no decision */ }
  if (reason !== null || opts.agentDiesInHook) return { blocked: reason !== null, reason, crashed, ran: false };
  seat.turns.push(prompt);
  appendFileSync(seat.rollout, rolloutUserLine(prompt));
  return { blocked: false, reason, crashed, ran: true };
}

export function codexSessionStart(seat: StubCodexSeat, env: Record<string, string> = {}): void {
  spawnSync(process.execPath, [RELAY], { input: JSON.stringify({ hook_event_name: "SessionStart", source: "startup", session_id: "t-1", transcript_path: seat.rollout }), env: codexHookEnv(seat, env), encoding: "utf8", timeout: 15_000 });
}

/** A relay that cannot even load: the hook S0 broke by accident on Codex, which failed open. */
export function brokenRelay(dir: string): string {
  const path = join(dir, "broken-relay.cjs");
  writeFileSync(path, "this is not ( javascript\n");
  return path;
}
