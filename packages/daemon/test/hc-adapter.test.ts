import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HcAdapter } from "../src/adapters/hc-adapter.js";
import { HcClient, type HcTerminal } from "../src/adapters/hc-client.js";
import { hcTerminalName } from "../src/adapters/hc-seat.js";
import type { SeatDeliveryGuard } from "../src/domain/seat-delivery-guard.js";

const here = dirname(fileURLToPath(import.meta.url));

/** The tmux adapter's public methods, read from its source so a new one can't be missed. */
function tmuxPublicMethods(): string[] {
  const src = readFileSync(join(here, "..", "src", "adapters", "tmux.ts"), "utf8");
  const body = src.slice(src.indexOf("export class TmuxAdapter"));
  const end = body.indexOf("\n}\n");
  return [...new Set([...body.slice(0, end).matchAll(/^ {2}(async )?([a-zA-Z]\w*)(<[^(]*>)?\(/gm)].map((m) => m[2]!))]
    .filter((name) => name !== "constructor");
}

class FakeClient extends HcClient {
  calls: string[] = [];
  constructor() { super("/nonexistent"); }
  override async call<T>(method: string): Promise<T> {
    this.calls.push(method);
    const terminal: HcTerminal = { address: "t1", labels: {}, argv: [], cwd: "/", state: "live", created_ms: 0, screen: "exact", cols: 80, rows: 24 };
    return terminal as T;
  }
}

/** Wrappers that run a caller's function inside the delivery guard. They touch no tmux, so HcAdapter inherits them. */
const INHERITED_BY_DESIGN = ["humanInput", "operation"];

describe("HcAdapter", () => {
  it("overrides every public method of the tmux adapter that could reach tmux, the viewer's included", () => {
    const methods = tmuxPublicMethods();
    expect(methods.length).toBeGreaterThan(40);  // positive control: the source was really parsed
    // HcAdapter extends TmuxAdapter, so `typeof adapter[name] === "function"` is true for a method it forgot (inherited,
    // and running tmux through the refusing exec). Only an OWN method on the prototype means it was ported.
    const notOverridden = methods.filter((name) => !Object.prototype.hasOwnProperty.call(HcAdapter.prototype, name) && !INHERITED_BY_DESIGN.includes(name));
    expect(notOverridden.sort()).toEqual([]);
    // Control for the allow-list: each entry is a real tmux method that HcAdapter really leaves inherited.
    for (const name of INHERITED_BY_DESIGN) {
      expect(methods).toContain(name);
      expect(Object.prototype.hasOwnProperty.call(HcAdapter.prototype, name)).toBe(false);
    }
  });

  it("reaches the core through each area", async () => {
    const client = new FakeClient();
    await new HcAdapter(client).probeSession("qa@rig");
    expect(client.calls).toEqual(["terminal.get"]);
  });

  it("gives the lease check to launches once the guard is set", async () => {
    const client = new FakeClient();
    const adapter = new HcAdapter(client);
    const guard: Partial<SeatDeliveryGuard> = { ownsLifecycle: () => false };
    adapter.deliveryGuard = guard as SeatDeliveryGuard;
    await expect(adapter.createSession("s", "/w", { OPENRIG_NODE_ID: "n" })).resolves.toMatchObject({ ok: false, code: "guard_lease_required" });
    expect(client.calls).toEqual([]);
    adapter.deliveryGuard = undefined;
    await expect(adapter.createSession("s", "/w", {})).resolves.toEqual({ ok: true });
  });

  it("runs a human action through the guard when there is one", async () => {
    const seen: string[] = [];
    const adapter = new HcAdapter(new FakeClient());
    const guard: Partial<SeatDeliveryGuard> = { humanInput: async (target, fn) => { seen.push(target); return fn(); } };
    adapter.deliveryGuard = guard as SeatDeliveryGuard;
    await expect(adapter.humanInput(hcTerminalName("a"), async () => 7)).resolves.toBe(7);
    expect(seen).toEqual([hcTerminalName("a")]);
  });

  it("answers what has no meaning on hc without touching the core", async () => {
    const client = new FakeClient();
    const adapter = new HcAdapter(client);
    await expect(adapter.setServerOption("mouse", "on")).resolves.toEqual({ ok: true });
    await expect(adapter.startServer()).resolves.toEqual({ ok: true });
    expect(adapter.peekSessionWindowSnapshot(0)).toBeNull();
    expect(client.calls).toEqual([]);
  });
});
