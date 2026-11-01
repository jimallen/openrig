import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { TerminalOpenResult } from "../daemon-client.js";

export function terminalWindowNotice(view: string, result: TerminalOpenResult): string {
  return [
    `Terminal view requested: ${view}`,
    `${result.opened.length} tiles prepared; ${result.absent.length} absent; ${result.degraded.length} degraded.`,
    ...(result.error ? [result.error] : []),
    ...result.absent.map(member => `Absent: ${member.seat} — ${member.reason}`),
    ...result.degraded.map(member => `Skipped: ${member.seat} — ${member.reason}`),
    ...(result.notes ?? []),
  ].join("\n");
}

/** Run the installed CLI against this TUI's daemon. */
export async function openTerminalInWindow(view: string, endpoint: string, cliEntry?: string, expectedPlan?: string, onUnavailable?: () => void): Promise<TerminalOpenResult> {
  const args = ["terminal", "open", "--window", "--json", ...(expectedPlan !== undefined ? ["--expected-plan", expectedPlan] : []), "--", view];
  let stdout: string;
  let executionError: string | undefined;
  try {
    ({ stdout } = await promisify(execFile)(cliEntry ? process.execPath : "rig", cliEntry ? [cliEntry, ...args] : args, {
      env: { ...process.env, OPENRIG_URL: endpoint }, timeout: 180_000, maxBuffer: 1024 * 1024, encoding: "utf8",
    }));
  } catch (error) {
    const failure = error as Error & { stdout?: string };
    if (!failure.stdout?.trim()) throw new Error(`${failure.message}. Inspect any new terminal before retrying; the window outcome is unconfirmed.`);
    executionError = failure.message;
    stdout = failure.stdout;
  }
  let result: TerminalOpenResult;
  try { result = JSON.parse(stdout); }
  catch { throw new Error("The terminal command returned no readable result. Inspect any new terminal before retrying."); }
  if (!result || typeof result !== "object") throw new Error("The terminal command returned no view result. Inspect any new terminal before retrying.");
  if (!Array.isArray(result.opened) || !Array.isArray(result.absent) || !Array.isArray(result.degraded)) {
    throw new Error(result.error ?? "The terminal command returned no view result. Inspect any new terminal before retrying.");
  }
  if (executionError || !result.opened.length) {
    // The one definite "nothing was opened" is the app not being open (`herdr_unavailable`: the provider checks the app before it
    // creates anything). Only then does the TUI return to the terminal preview and its attach commands; any other failure stays put.
    if (result.code === "herdr_unavailable" && !result.opened.length) onUnavailable?.();
    throw new Error([result.error ?? executionError ?? "No terminals were confirmed open.", ...(result.notes ?? []),
      ...result.absent.map(member => `Absent: ${member.seat} — ${member.reason}`),
      ...result.degraded.map(member => `Skipped: ${member.seat} — ${member.reason}`),
    ].join("\n"));
  }
  return result;
}
