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
