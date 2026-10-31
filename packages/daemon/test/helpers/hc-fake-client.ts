import { HcClient, HcError, type HcTerminal } from "../../src/adapters/hc-client.js";

export type HcHandler = (params: Record<string, unknown>) => unknown;

/** An HcClient that answers from a table of handlers, in place of a core, and records every call. A handler throws what the real client
 *  would throw. The one cast is the generic return of `call`, which the real client also makes from parsed JSON. */
export class FakeHc extends HcClient {
  calls: { method: string; params: Record<string, unknown> }[] = [];
  constructor(private readonly handlers: Record<string, HcHandler>) { super("/nonexistent"); }
  override async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ method, params });
    const handler = this.handlers[method];
    if (!handler) throw new Error(`unexpected hc call ${method}`);
    const answer: unknown = await handler(params);
    return answer as T;
  }
  count(method: string): number { return this.calls.filter((c) => c.method === method).length; }
}

export const notFound = (): HcError => new HcError("no terminal", "not_found", -32000);

/** A live terminal as `terminal.get` and `terminal.list` give it; fields are overridden per test. */
export function terminal(overrides: Partial<HcTerminal> = {}): HcTerminal {
  return {
    address: "t1", name: "s-x", labels: {}, argv: ["sh"], cwd: "/work", state: "live", created_ms: 1_700_000_123_456, screen: "exact",
    cols: 200, rows: 120, pid: 4242, foreground: { pid: 4242, name: "sh", argv: ["sh", "-l"], cwd: "/work/sub" }, ...overrides,
  };
}
