import os from "node:os";

/**
 * workspaces-o9o.174: the error a test wait throws when it gives up. `lead` is the wait's own text, kept byte for byte; appended are how
 * long it waited (from `startedAt`) and the 1-minute load average with the core count at that moment, so a timeout in a loaded gate
 * carries its own evidence of whether load caused it. `last`, when given, is the value the wait saw last.
 */
export function waitTimedOut(lead: string, startedAt: number, last?: string): Error {
  const [load1] = os.loadavg();
  const evidence = `after ${Date.now() - startedAt} ms (1-minute load ${(load1 ?? 0).toFixed(2)} on ${os.cpus().length} cores)`;
  return new Error(`${lead} ${evidence}${last === undefined ? "" : `; last: ${last}`}`);
}
