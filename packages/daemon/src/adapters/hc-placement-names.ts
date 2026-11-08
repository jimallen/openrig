import type { AppLs, AppPort } from "./hc-placement.js";
import { HerdrAppUnavailableError } from "../domain/terminal/herdr-app-provider.js";
import type { PlacementNames } from "./hc-placement-carry.js";

/**
 * OF-281. Put a relaunched seat's space and tab names back.
 *
 * Measured on a scratch Herdr 0.1.13 with a private hc 0.1.18 core (2026-11-08): a seat alone in its tab loses the tab when its terminal ends, and the
 * app removes the tab (and the space, when it was the space's only tab) from its document with no grace: a new terminal carrying the same
 * `herdr.space` and `herdr.tab` 8 ms after the kill got the same ids, but the space was named after its folder and the tab by its position ("1").
 * No label names a space or a tab. `herdr-app do space.rename` / `tab.rename` put a name back (measured 0.07 s after the run).
 *
 * This renames and nothing else: it never creates or closes a space, a tab or a pane, so it cannot end a seat (requirement 3 of OF-280, narrowed by
 * agents-c1 on 2026-11-08 to allow a rename). It is best-effort and bounded: whatever goes wrong, the launch has already succeeded.
 *
 * Guards (each one a reason not to touch what a person named):
 *  - the tab is renamed only while its name is all digits, the app's automatic name for a tab nobody named;
 *  - the space is renamed only when it holds nothing but this launch's tab and this launch's terminal, so the launch made it. `herdr-app ls`
 *    does not say whether a space was named, and the automatic name is its repo, else its folder, so a name test would be a guess;
 *  - both are skipped when they already read as wanted.
 */
export interface PlacementNameOptions {
  /** The whole step, polling included. Default 2000 ms. */
  timeoutMs?: number;
  /** Between two reads of the app while it has not shown the terminal yet. Default 100 ms. */
  intervalMs?: number;
}

export type PlacementNameOutcome =
  | { kind: "renamed"; renamed: string[] }
  | { kind: "unchanged" }
  /** No herdr-app, or no window: nothing to do, and nothing worth a line. */
  | { kind: "no_app" }
  | { kind: "failed"; reason: string };

const DEFAULT_TIMEOUT_MS = 2000;
const DEFAULT_INTERVAL_MS = 100;
const AUTOMATIC_TAB_NAME = /^\d+$/;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function locate(ls: AppLs, address: string) {
  for (const space of ls.spaces) {
    for (const tab of space.tabs) {
      if (tab.terminals.some((t) => t.terminal === address)) return { space, tab };
    }
  }
  return null;
}

export async function restorePlacementNames(app: AppPort, address: string, names: PlacementNames, options: PlacementNameOptions = {}): Promise<PlacementNameOutcome> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  let timer: NodeJS.Timeout | undefined;
  /** Set when the deadline has answered: a step still running then must not touch the app any more. */
  let expired = false;
  const deadline = new Promise<PlacementNameOutcome>((resolve) => {
    timer = setTimeout(() => { expired = true; resolve({ kind: "failed", reason: `timed out after ${timeoutMs} ms` }); }, timeoutMs);
  });
  const work = (async (): Promise<PlacementNameOutcome> => {
    try {
      const startedAt = Date.now();
      for (;;) {
        const shown = locate(await app.ls(), address);
        if (expired) return { kind: "failed", reason: "expired" };
        if (shown) {
          const renamed: string[] = [];
          const { space, tab } = shown;
          if (space.tabs.length === 1 && tab.terminals.length === 1 && space.name !== names.space) {
            if (expired) return { kind: "failed", reason: "expired" };
            await app.do("space.rename", { id: space.id, name: names.space });
            renamed.push("space");
          }
          if (AUTOMATIC_TAB_NAME.test(tab.name) && tab.name !== names.tab) {
            if (expired) return { kind: "failed", reason: "expired" };
            await app.do("tab.rename", { id: tab.id, name: names.tab });
            renamed.push("tab");
          }
          return renamed.length > 0 ? { kind: "renamed", renamed } : { kind: "unchanged" };
        }
        if (Date.now() - startedAt >= timeoutMs) return { kind: "failed", reason: `the app did not show ${address} in time` };
        await sleep(intervalMs);
      }
    } catch (err) {
      if (err instanceof HerdrAppUnavailableError) return { kind: "no_app" };
      return { kind: "failed", reason: err instanceof Error ? err.message : String(err) };
    }
  })();
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** What the host and the lifecycle call after `terminal.run`: the warnings to carry back (none for a rename, none for no app). Never throws. */
export type PlacementNameRestorer = (seat: string, address: string, names: PlacementNames) => Promise<string[]>;

export function createPlacementNameRestorer(app: AppPort, options: PlacementNameOptions = {}): PlacementNameRestorer {
  return async (seat, address, names) => {
    const outcome = await restorePlacementNames(app, address, names, options).catch((err): PlacementNameOutcome => ({ kind: "failed", reason: err instanceof Error ? err.message : String(err) }));
    return outcome.kind === "failed" ? [`${seat}: its Herdr space and tab names were not restored (${outcome.reason.slice(0, 200)})`] : [];
  };
}
