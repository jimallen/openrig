// A stub of how Claude Code treats a UserPromptSubmit hook, measured in S0 (M1, M4, M5): the hook runs before the transcript write,
// `decision: block` (or exit 2) stops the prompt, and a hook that crashes fails OPEN, so the prompt runs and nothing was recorded.
// It runs the real relay as a real process. No Claude here: the real-agent proof is S0 and the integration run.
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const RELAY = fileURLToPath(new URL("../../assets/plugins/openrig-core/hooks/scripts/activity-relay.cjs", import.meta.url));
export const CRASH_PRELOAD = fileURLToPath(new URL("./relay-crash-preload.cjs", import.meta.url));
export const SEAT = "dev-impl@rig1";
export const NONCE = "0123456789abcdef0123";

export function marker(id: string, nonce = NONCE): string {
  return `[openrig-msg ${id}:${nonce}]`;
}

export interface StubSeat {
  readonly home: string;
  readonly transcript: string;
  turns: string[];
  pid: number;
}

export function stubSeat(home: string): StubSeat {
  return { home, transcript: join(home, "transcript.jsonl"), turns: [], pid: 4242 };
}

export function hookEnv(seat: StubSeat, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH, HOME: seat.home, OPENRIG_HOME: seat.home, OPENRIG_SESSION_NAME: SEAT, OPENRIG_NODE_ID: "node-a",
    OPENRIG_RUNTIME: "claude-code", CLAUDE_PID: String(seat.pid), ...extra };
}

function promptPayload(seat: StubSeat, prompt: string): string {
  return JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt, transcript_path: seat.transcript, session_id: "s-1", prompt_id: `p-${seat.turns.length}` });
}

export interface HookRun { blocked: boolean; reason: string | null; crashed: boolean; ran: boolean }

/** One prompt, as Claude takes it: the hook first, and a turn with its transcript line unless the hook blocked it. */
export function submit(seat: StubSeat, prompt: string, opts: { relay?: string; nodeArgs?: string[]; env?: Record<string, string>; agentDiesInHook?: boolean } = {}): HookRun {
  const run = spawnSync(process.execPath, [...(opts.nodeArgs ?? []), opts.relay ?? RELAY], { input: promptPayload(seat, prompt), env: hookEnv(seat, opts.env), encoding: "utf8", timeout: 15_000 });
  const crashed = run.signal !== null || (run.status !== 0 && run.status !== 2);
  let reason: string | null = null;
  try {
    const decision = JSON.parse(run.stdout.trim().split("\n").pop() ?? "") as { decision?: string; reason?: string };
    if (decision.decision === "block") reason = decision.reason ?? "";
  } catch { /* no decision */ }
  const blocked = run.status === 2 || reason !== null;
  if (blocked || opts.agentDiesInHook) return { blocked, reason, crashed, ran: false };
  seat.turns.push(prompt);
  appendFileSync(seat.transcript, `${JSON.stringify({ type: "user", message: { role: "user", content: prompt } })}\n`);
  return { blocked, reason, crashed, ran: true };
}

/** The SessionStart hook of a seat. */
export function sessionStart(seat: StubSeat): void {
  spawnSync(process.execPath, [RELAY], { input: JSON.stringify({ hook_event_name: "SessionStart", source: "startup", session_id: "s-1", transcript_path: seat.transcript }), env: hookEnv(seat), encoding: "utf8", timeout: 15_000 });
}

/** A relay that cannot even load: the hook S0 broke by accident on Codex, which failed open. */
export function brokenRelay(dir: string): string {
  const path = join(dir, "broken-relay.cjs");
  writeFileSync(path, "this is not ( javascript\n");
  return path;
}

/** The relay as the daemon installs it for a seat, at `<home>/state/claude-activity-hooks/`. */
export function installedRelay(home: string): string {
  const path = join(home, "state", "claude-activity-hooks", "activity-relay.cjs");
  mkdirSync(dirname(path), { recursive: true });
  copyFileSync(RELAY, path);
  chmodSync(path, 0o755);
  return path;
}

/** Runs the relay and resolves when its first stdout byte arrives, or when it exits. */
export function firstStdout(seat: StubSeat, prompt: string, env: Record<string, string>): Promise<{ ms: number; text: string; exited: Promise<void> }> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [RELAY], { env: hookEnv(seat, env), stdio: ["pipe", "pipe", "ignore"] });
    const exited = new Promise<void>((done) => child.on("close", () => done()));
    child.stdout.once("data", (chunk: Buffer) => resolve({ ms: Date.now() - started, text: chunk.toString(), exited }));
    child.on("close", () => resolve({ ms: Date.now() - started, text: "", exited }));
    child.stdin.end(promptPayload(seat, prompt));
  });
}
