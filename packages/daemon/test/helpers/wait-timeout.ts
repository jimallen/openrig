import os from "node:os";

/** The machine's 1-minute load average and core count at one moment. */
export interface LoadReading { load1: number; cores: number }

/** The host's reading now. Tests of the scaling inject their own reading, never this one. */
export const hostLoad = (): LoadReading => ({ load1: os.loadavg()[0] ?? 0, cores: os.cpus().length });

/** The most a wait's bound stretches under load: a real hang still fails within 4x its bound. */
export const MAX_LOAD_SCALE = 4;

/** workspaces-o9o.174 part 3 (CoS ruling): load1/cores clamped to [1, 4]. At or below one runnable task per core the bound is unchanged. */
export function loadScale(reading: LoadReading): number {
  const ratio = reading.cores > 0 ? reading.load1 / reading.cores : 1;
  return Math.min(MAX_LOAD_SCALE, Math.max(1, Number.isFinite(ratio) ? ratio : 1));
}

/** A test wait's bound, scaled by the load measured when the wait starts. */
export interface WaitBound {
  readonly startedAt: number;
  /** The bound the wait names, in ms. */
  readonly baseMs: number;
  /** baseMs x scale: how long the wait actually allows. */
  readonly ms: number;
  readonly scale: number;
  /** The load reading the scale came from. */
  readonly reading: LoadReading;
  /** startedAt + ms. */
  readonly deadline: number;
  /** True once the clock reaches the deadline (at it counts: a loop that ran `while (now < deadline)` stops there, and a give-up that
   *  fired at `now > deadline` fires no later; verify-qa, part 3 round 1). */
  expired(): boolean;
  /** A counted poll loop's attempt budget, scaled the same way: ceil(n x scale). */
  attempts(n: number): number;
}

/**
 * workspaces-o9o.174 part 3: the bound for a test wait that names `baseMs`. Under full-suite load (1-minute load 24 to 74 on 20 cores,
 * measured in failing gates whose tests each passed alone) a fixed bound fails waits that were only slow; the bound stretches by
 * clamp(load1/cores, 1, 4). An idle machine keeps the bound it names; a real hang still fails within 4x.
 */
export function waitBound(baseMs: number, read: () => LoadReading = hostLoad, now: () => number = Date.now): WaitBound {
  const startedAt = now();
  const reading = read();
  const scale = loadScale(reading);
  const ms = Math.round(baseMs * scale);
  const deadline = startedAt + ms;
  return {
    startedAt, baseMs, ms, scale, reading, deadline,
    expired: () => now() >= deadline,
    attempts: (n) => Math.ceil(n * scale),
  };
}

/**
 * workspaces-o9o.174: the error a test wait throws when it gives up. `lead` is the wait's own text, kept byte for byte; appended are how
 * long it waited, the bound it named, the scale it ran under and the load reading on both sides of the wait, so a timeout in a loaded
 * gate carries its own evidence of whether load caused it. `last`, when given, is the value the wait saw last.
 */
export function waitTimedOut(
  lead: string, bound: WaitBound, last?: string,
  at: { now?: () => number; read?: () => LoadReading } = {},
): Error {
  const now = (at.now ?? Date.now)();
  const end = (at.read ?? hostLoad)();
  const evidence = `after ${now - bound.startedAt} ms (bound ${bound.baseMs} ms x ${bound.scale.toFixed(2)} = ${bound.ms} ms; `
    + `1-minute load ${bound.reading.load1.toFixed(2)} on ${bound.reading.cores} cores at the start, ${end.load1.toFixed(2)} at the end)`;
  return new Error(`${lead} ${evidence}${last === undefined ? "" : `; last: ${last}`}`);
}
