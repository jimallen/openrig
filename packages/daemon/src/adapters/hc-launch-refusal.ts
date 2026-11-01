import { HcError, type HcClient } from "./hc-client.js";
import type { TmuxResult } from "./tmux.js";

// hc cutover (W42, 2026-11-01). A launch (`terminal.run`) can come back `unavailable` from a core that answers everything
// else. Measured on private cores of hc 0.1.15 and 0.1.16 (Linux, aarch64): the core starts its holder lazily, on the first
// launch, by running the program file it was started from. If that file was replaced while the core ran (an `hc update`, the
// Herdr app updating its core, an installer), the holder is the new file's build, the core compares builds and refuses:
//   error kind `unavailable`, message "no holder: holder build elf:... differs from core build elf:...",
//   hint "run hc server restart on this machine, then retry".
// A core that already has a holder is not affected (new launches go to it); only a core with no holder is. The daemon used to
// show only the kind, so every seat read `hc refused <seat>: unavailable` with nothing to act on. It now says what was found
// and the fix, in its own words: the core's text is never quoted, because the call carried the seat's credentials.

/** What the daemon will say about a launch the core refused as `unavailable`, once it has asked the core for its holders. */
export interface HcLaunchRefusal {
  /** Words for the operator: what happened, that nothing was launched, and the fix. */
  message: string;
  /** True when the core has no holder at all, the case measured above. False when the cause was not determined. */
  noHolder: boolean;
}

const VERSION = /^\d+\.\d+\.\d+$/;

/** Reads `server.status` (answered by a core that has no holder) and words the refusal. A failed read gives the undetermined wording. */
export async function explainLaunchUnavailable(client: HcClient, what: string): Promise<HcLaunchRefusal> {
  let status: { version?: unknown; holder?: unknown; holders?: unknown } | null = null;
  try {
    status = await client.call<{ version?: unknown; holder?: unknown; holders?: unknown }>("server.status");
  } catch {
    status = null;
  }
  const noHolder = status !== null && status.holder == null && Array.isArray(status.holders) && status.holders.length === 0;
  if (!noHolder) {
    return { noHolder: false, message: `hc refused ${what}: unavailable (the core's own state could not be read to say why; run "hc server status" and see holder.log and core.log in its state directory)` };
  }
  const version = typeof status?.version === "string" && VERSION.test(status.version) ? ` ${status.version}` : "";
  return {
    noHolder: true,
    message: `hc cannot launch ${what}: the running hc core${version} has no holder for new terminals and could not start one. The usual cause is that the hc program file it was started from was replaced `
      + "while it ran (an hc or Herdr app update), so the holder it starts is another build and the core refuses it. Nothing was launched and no seat is lost: a core with no holder holds no terminals. "
      + `Fix: run "hc server restart" on this machine (it ends nothing), then launch again.`,
  };
}

/** The launch sites' shared answer to a refused `terminal.run`: a result for kind `unavailable`, null for any other error (the caller keeps its own wording).
 *  The client is told the message when the core has no holder, for `rig health` (HcClient.launchBlockedBecause). */
export async function refusedLaunch(client: HcClient, err: unknown, what: string): Promise<TmuxResult | null> {
  if (!(err instanceof HcError) || err.kind !== "unavailable") return null;
  const refusal = await explainLaunchUnavailable(client, what);
  if (refusal.noHolder) client.noteLaunchBlocked?.(refusal.message);
  return { ok: false, code: "unknown", message: refusal.message };
}
