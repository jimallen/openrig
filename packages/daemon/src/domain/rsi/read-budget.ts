import type { HealthDetectorObservation, HealthObservationSource, HealthSourceCoverage } from "../health-detectors.js";

/**
 * The per-source time budget of an RSI read. better-sqlite3 cannot interrupt a running
 * statement, so the budget is checked between rows: a source stops examining rows once the
 * budget is spent and reports `partial` coverage. It never reports the rows it did not reach
 * as zero findings.
 */
export const RSI_DEFAULT_READ_BUDGET_MS = 1_000;

export interface RsiReadBudgetOptions {
  /** Milliseconds one source may spend examining rows. */
  budgetMs?: number;
  /** Monotonic millisecond clock; injected by tests. */
  nowMs?: () => number;
}

export class RsiReadBudget {
  private readonly budgetMs: number;
  private readonly clock: () => number;
  private startedAt = 0;

  constructor(options: RsiReadBudgetOptions = {}) {
    this.budgetMs = options.budgetMs ?? RSI_DEFAULT_READ_BUDGET_MS;
    this.clock = options.nowMs ?? (() => performance.now());
  }

  start(): void {
    this.startedAt = this.clock();
  }

  exceeded(): boolean {
    return this.clock() - this.startedAt >= this.budgetMs;
  }
}

/**
 * The per-source time budget applied to EVERY RSI source by the registry (registry.ts), not only
 * to the sources that also check a budget between rows (D1-D3). better-sqlite3 cannot interrupt a
 * running statement, and a file read is one call, so this wrapper cannot stop a read: it MEASURES
 * it. A read that took the whole budget or more keeps its findings (they were really found), and
 * each of its available coverage rows is marked `partial: true` with an `over-budget` note, so the
 * read is never presented as a complete one. An `unavailable` row is already partial and is left
 * as it is. A source that reported no coverage gets one row, so an over-budget read is never
 * invisible. `name` and `detectors` are the inner source's, so disabling its detectors still skips
 * the read, and the wake's detector-to-source map is unchanged.
 */
export class BudgetedRsiSource implements HealthObservationSource {
  readonly name?: string;
  readonly detectors?: readonly string[];
  private readonly budgetMs: number;
  private readonly clock: () => number;
  private lastCoverage: HealthSourceCoverage[] = [];

  constructor(readonly inner: HealthObservationSource, options: RsiReadBudgetOptions = {}) {
    this.name = inner.name;
    this.detectors = inner.detectors;
    this.budgetMs = options.budgetMs ?? RSI_DEFAULT_READ_BUDGET_MS;
    this.clock = options.nowMs ?? (() => performance.now());
  }

  coverage(): readonly HealthSourceCoverage[] {
    return this.lastCoverage;
  }

  read(): readonly HealthDetectorObservation[] {
    this.lastCoverage = [];
    const startedAt = this.clock();
    const observations = this.inner.read();
    const elapsedMs = this.clock() - startedAt;
    const coverage = [...(this.inner.coverage?.() ?? [])];
    if (elapsedMs < this.budgetMs) {
      this.lastCoverage = coverage;
      return observations;
    }
    const note = `over-budget: the read took ${Math.round(elapsedMs)} ms of a ${this.budgetMs} ms budget; `
      + "a running statement cannot be interrupted, so it ran to completion";
    this.lastCoverage = coverage.length === 0
      ? [{ source: this.name ?? "rsi-source", evaluatedAt: new Date().toISOString(), unit: "reads", limit: 1, total: 1, evaluated: 1,
        omitted: 0, partial: true, order: "single read", note }]
      : coverage.map((row) => row.status === "unavailable" ? row : { ...row, partial: true, note: row.note === undefined ? note : `${row.note}; ${note}` });
    return observations;
  }
}
