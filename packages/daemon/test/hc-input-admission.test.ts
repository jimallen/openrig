import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import type { HcAttachOpener } from "../src/adapters/hc-attach.js";
import { HcClient, HcError, HcOutcomeUnknownError, type HcTerminal } from "../src/adapters/hc-client.js";
import { HcInput } from "../src/adapters/hc-input.js";
import { HcLifecycle, PROBE_LABEL } from "../src/adapters/hc-lifecycle.js";
import { SEAT_LABEL, hcTerminalName } from "../src/adapters/hc-seat.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { migrate } from "../src/db/migrate.js";
import { SeatDeliveryGuard, resolveGuardTarget } from "../src/domain/seat-delivery-guard.js";

// The tmux adapter's guardedInput lets a fresh probe and a fresh launch through before it asks the guard about a seat. Every hc
// input does the same, by HcLifecycle's one rule. The guard and the lifecycle are real; the core and the attach are fake here, and
// real in hc-lifecycle-guard.real.test.ts.
const PROBE = "rigged-refresh-x";
const SEAT = "hc-worker@fixture";

class FakeClient extends HcClient {
  calls: string[] = [];
  terminal: HcTerminal | Error;
  keysReply: unknown = {};
  onCall?: (method: string) => void;
  constructor(terminal: HcTerminal | Error) { super("/nonexistent"); this.terminal = terminal; }
  override async call<T>(method: string): Promise<T> {
    this.calls.push(method);
    this.onCall?.(method);
    if (method === "terminal.run") return { address: "t7" } as T;
    if (method === "terminal.get") { if (this.terminal instanceof Error) throw this.terminal; return this.terminal as T; }
    if (this.keysReply instanceof Error) throw this.keysReply;
    return { turn: 1 } as T;
  }
}

const term = (name: string, labels: Record<string, string>, over: Partial<HcTerminal> = {}): HcTerminal => ({
  address: "t7", name: hcTerminalName(name), labels, argv: [], cwd: "/w", state: "live", created_ms: 0, screen: "exact", cols: 80, rows: 24, ...over,
});
const probeTerminal = (over: Partial<HcTerminal> = {}) => term(PROBE, { [PROBE_LABEL]: PROBE }, over);

function fixture(terminal: HcTerminal | Error, opts: { admission?: boolean } = {}) {
  const db = new Database(":memory:");
  migrate(db, ALL_MIGRATIONS);
  db.exec(`INSERT INTO rigs(id,name) VALUES ('r','fixture');
    INSERT INTO nodes(id,rig_id,logical_id) VALUES ('h','r','hc-worker');
    INSERT INTO bindings(id,node_id,attachment_type,tmux_session,tmux_pane,terminal_address) VALUES ('bh','h','hc','${SEAT}',NULL,'t7');
    INSERT INTO sessions(id,node_id,session_name,status) VALUES ('sh','h','${SEAT}','running');
    INSERT INTO occupant_tenures(id,node_id,generation_ordinal,generation_uuid,kind) VALUES ('gh','h',1,'g1','fresh');`);
  const guard = new SeatDeliveryGuard(db, (name) => resolveGuardTarget(db, name));
  const client = new FakeClient(terminal);
  const lifecycle = new HcLifecycle(client, { guard, daemonEnv: { SHELL: "/bin/sh" } });
  const writes: string[] = [];
  const opener: HcAttachOpener = {
    open: async (_target, handlers) => {
      handlers.onData(Buffer.from("painted"));
      return { write: (text: string) => { writes.push(text); }, detach: async () => ({ reason: "detached" as const }) } as never;
    },
  };
  const fileOps = { tmpName: () => "/tmp/x", writeFile: async () => {}, unlink: async () => {} } as never;
  const input = new HcInput(client, opener, { guard, fileOps, paintSettleMs: 1, paintMaxMs: 5, paintFirstMs: 50, ...(opts.admission === false ? {} : { admission: lifecycle }) });
  const delivered = () => writes.length + client.calls.filter((m) => m === "terminal.send" || m === "terminal.keys").length;
  return { db, guard, client, lifecycle, input, delivered };
}

const METHODS = [
  ["sendText", (i: HcInput, t: string) => i.sendText(t, "hello")],
  ["sendKeys", (i: HcInput, t: string) => i.sendKeys(t, ["Enter"])],
  ["sendShellCommand", (i: HcInput, t: string) => i.sendShellCommand(t, "echo hi")],
  ["submitText", (i: HcInput, t: string) => i.submitText(t, "hello")],
] as const;

for (const [name, send] of METHODS) {
  describe(`${name} under the guard`, () => {
    it("reaches a probe this adapter made", async () => {
      const f = fixture(probeTerminal());
      await f.lifecycle.createProbeSession(PROBE);
      await expect(send(f.input, PROBE)).resolves.toMatchObject({ ok: true });
      expect(f.delivered()).toBe(1);
      f.db.close();
    });
    it("refuses a terminal labelled as that probe that this adapter did not make", async () => {
      const f = fixture(probeTerminal());
      await expect(send(f.input, PROBE)).resolves.toMatchObject({ ok: false, code: "guard_target_unknown" });
      expect(f.delivered()).toBe(0);
      f.db.close();
    });
    it("refuses the probe's name once another terminal holds it", async () => {
      const f = fixture(probeTerminal());
      await f.lifecycle.createProbeSession(PROBE);
      f.client.terminal = probeTerminal({ address: "t9" });
      await expect(send(f.input, PROBE)).resolves.toMatchObject({ ok: false, code: "guard_target_unknown" });
      expect(f.delivered()).toBe(0);
      f.db.close();
    });
    it("refuses a probe a managed record claims after it was read, at the last check", async () => {
      const f = fixture(probeTerminal());
      await f.lifecycle.createProbeSession(PROBE);
      let reads = 0;
      f.client.onCall = (method) => {
        if (method === "terminal.get" && ++reads === 1) f.db.exec(`INSERT INTO nodes(id,rig_id,logical_id) VALUES ('c','r','${PROBE}');`);
      };
      const result = await send(f.input, PROBE);
      expect(result).toMatchObject({ ok: false, code: "guard_target_managed" });
      expect(f.delivered()).toBe(0);
      f.db.close();
    });
    it("refuses a name nothing knows, with or without a terminal", async () => {
      const plain = fixture(term("nobody", {}));
      await expect(send(plain.input, "nobody")).resolves.toMatchObject({ ok: false, code: "guard_target_unknown" });
      expect(plain.delivered()).toBe(0);
      plain.db.close();
      const gone = fixture(new HcError("none", "not_found", -32000));
      await expect(send(gone.input, "nobody")).resolves.toMatchObject({ ok: false });
      expect(gone.delivered()).toBe(0);
      gone.db.close();
    });
    it("still refuses a managed seat whose typing guard is on", async () => {
      const f = fixture(term(SEAT, { [SEAT_LABEL]: SEAT }));
      await f.guard.set("h", true, "person", "typing");
      await expect(send(f.input, SEAT)).resolves.toMatchObject({ ok: false, code: "typing_guard_enabled" });
      expect(f.delivered()).toBe(0);
      f.db.close();
    });
    it("reaches a launch not yet bound under its lease, and not without it", async () => {
      const NAME = "launched-under-its-own-name";
      const f = fixture(term(NAME, { [SEAT_LABEL]: NAME }));
      f.db.exec("DELETE FROM bindings WHERE node_id = 'h'");
      f.lifecycle.noteLaunched(NAME, "h");
      await expect(send(f.input, NAME)).resolves.toMatchObject({ ok: false, code: "guard_target_changed" });
      expect(f.delivered()).toBe(0);
      await expect(f.guard.lifecycle(["h"], () => send(f.input, NAME))).resolves.toMatchObject({ ok: true });
      expect(f.delivered()).toBe(1);
      f.lifecycle.finishLaunchBinding(NAME);
      await expect(f.guard.lifecycle(["h"], () => send(f.input, NAME))).resolves.toMatchObject({ ok: false });
      expect(f.delivered()).toBe(1);
      f.db.close();
    });
    it("stays refused where no admission is wired (the terminal WebSocket has none)", async () => {
      const f = fixture(probeTerminal(), { admission: false });
      await f.lifecycle.createProbeSession(PROBE);
      await expect(send(f.input, PROBE)).resolves.toMatchObject({ ok: false, code: "guard_target_unknown" });
      expect(f.delivered()).toBe(0);
      f.db.close();
    });
  });
}

describe("a managed seat's input", () => {
  it("reads nothing extra: the guard resolves it, so the admission never looks at the core", async () => {
    const f = fixture(term(SEAT, { [SEAT_LABEL]: SEAT }));
    await expect(f.input.submitText(SEAT, "hello")).resolves.toMatchObject({ ok: true });
    expect(f.client.calls).toEqual(["terminal.send"]);
    f.db.close();
  });
});

describe("a failure while writing to a probe", () => {
  it("keeps input's own wording: a lost reply may still deliver, so it is never the lifecycle's plain outcome", async () => {
    const f = fixture(probeTerminal());
    await f.lifecycle.createProbeSession(PROBE);
    f.client.keysReply = new HcOutcomeUnknownError("lost", "terminal.keys");
    await expect(f.input.sendKeys(PROBE, ["Enter"])).resolves.toMatchObject({ ok: false, code: "delivery_outcome_unknown" });
    f.db.close();
  });
});
