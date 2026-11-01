import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { HcClient, HcError, HcUnavailableError, type HcTerminal } from "../src/adapters/hc-client.js";
import { SEAT_LABEL, hcTerminalName } from "../src/adapters/hc-seat.js";
import { HcLifecycle, PROBE_LABEL } from "../src/adapters/hc-lifecycle.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { migrate } from "../src/db/migrate.js";
import { SeatDeliveryGuard, resolveGuardTarget } from "../src/domain/seat-delivery-guard.js";

// Security review N3: kill, respawn and signal on hc go through the delivery guard, as tmux.ts's guardedInput does. The guard is
// the real one on a real schema; the core is fake here and real in hc-lifecycle-guard.real.test.ts.
const SEAT = "hc-worker@fixture";
const NODE = "h";

type Answer = (method: string, params: Record<string, unknown> | undefined) => unknown;
class FakeClient extends HcClient {
  calls: string[] = [];
  /** Runs once per call, before the answer: the moment a binding changes under a read. */
  onCall?: (method: string, nth: number) => void;
  constructor(private readonly answer: Answer) { super("/nonexistent"); }
  override async call<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    this.calls.push(method);
    this.onCall?.(method, this.calls.filter((m) => m === method).length);
    const reply = this.answer(method, params);
    if (reply instanceof Error) throw reply;
    return reply as T;
  }
}

const term = (seat = SEAT, over: Partial<HcTerminal> = {}): HcTerminal => ({
  address: "t7", name: hcTerminalName(seat), labels: { [SEAT_LABEL]: seat }, argv: [], cwd: "/w", state: "live", created_ms: 0, screen: "exact", cols: 80, rows: 24, pid: 4242, ...over,
});
const notFound = () => new HcError("none", "not_found", -32000);

/** A live seat that ends when killed and restarts at a new address. */
const seatCore = (terminal: HcTerminal = term()): Answer => (method) => {
  if (method === "terminal.get") return terminal;
  if (method === "terminal.kill") return { ...terminal, state: "finished" };
  if (method === "terminal.run") return { address: "t9" };
  if (method === "terminal.list") return { terminals: [] };
  return new Error(`unexpected ${method}`);
};

function fixture(answer: Answer = seatCore()) {
  const db = new Database(":memory:");
  migrate(db, ALL_MIGRATIONS);
  db.exec(`INSERT INTO rigs(id,name) VALUES ('r','fixture');
    INSERT INTO nodes(id,rig_id,logical_id) VALUES ('h','r','hc-worker');
    INSERT INTO bindings(id,node_id,attachment_type,tmux_session,tmux_pane,terminal_address) VALUES ('bh','h','hc','${SEAT}',NULL,'t7');
    INSERT INTO sessions(id,node_id,session_name,status) VALUES ('sh','h','${SEAT}','running');
    INSERT INTO occupant_tenures(id,node_id,generation_ordinal,generation_uuid,kind) VALUES ('gh','h',1,'g1','fresh');`);
  const guard = new SeatDeliveryGuard(db, (name) => resolveGuardTarget(db, name));
  const client = new FakeClient(answer);
  const signals: Array<[number, string]> = [];
  const lifecycle = new HcLifecycle(client, { guard, daemonEnv: { SHELL: "/bin/sh" }, kill: (pid, signal) => { signals.push([pid, signal]); } });
  const nextOccupant = () => db.exec("UPDATE occupant_tenures SET generation_uuid = 'g2' WHERE node_id = 'h'");
  return { db, guard, client, lifecycle, signals, nextOccupant };
}

const effects = (client: FakeClient) => client.calls.filter((m) => m === "terminal.kill" || m === "terminal.run");

const OPERATIONS = [
  ["killSession", (l: HcLifecycle) => l.killSession(SEAT)],
  ["respawnPane", (l: HcLifecycle) => l.respawnPane(SEAT, "exec sleep 1")],
  ["signalPaneProcess", (l: HcLifecycle) => l.signalPaneProcess(SEAT, "TERM")],
] as const;

for (const [name, run] of OPERATIONS) {
  describe(`${name} through the guard`, () => {
    it("is refused while the seat's typing guard is on, and does nothing", async () => {
      const { db, guard, client, lifecycle, signals } = fixture();
      await guard.set(NODE, true, "person", "typing");
      await expect(run(lifecycle)).resolves.toMatchObject({ ok: false, code: "typing_guard_enabled" });
      expect(effects(client)).toEqual([]);
      expect(signals).toEqual([]);
      db.close();
    });

    it("waits for an operation in flight on the seat, and does nothing until it ends", async () => {
      const { db, guard, client, lifecycle, signals } = fixture();
      let release!: () => void;
      let entered!: () => void;
      const started = new Promise<void>((resolve) => { entered = resolve; });
      const inFlight = guard.operation(NODE, () => { entered(); return new Promise<void>((resolve) => { release = resolve; }); });
      await started;
      const pending = run(lifecycle);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(effects(client)).toEqual([]);
      expect(signals).toEqual([]);
      release();
      await inFlight;
      await expect(pending).resolves.toMatchObject({ ok: true });
      expect(effects(client).length + signals.length).toBeGreaterThan(0);
      db.close();
    });

    it("joins a lifecycle lease held by its caller, without waiting", async () => {
      const { db, guard, client, lifecycle, signals } = fixture();
      await expect(guard.lifecycle([NODE], () => run(lifecycle))).resolves.toMatchObject({ ok: true });
      expect(effects(client).length + signals.length).toBeGreaterThan(0);
      db.close();
    });

    it("is refused when the occupant changes under the last read, after every check before it", async () => {
      const { db, client, lifecycle, signals, nextOccupant } = fixture();
      // Reads: the look before the lease, the look inside it, the operation's own. The change lands on the third.
      client.onCall = (method, nth) => { if (method === "terminal.get" && nth === 3) nextOccupant(); };
      await expect(run(lifecycle)).resolves.toMatchObject({ ok: false, code: "guard_target_changed" });
      expect(effects(client)).toEqual([]);
      expect(signals).toEqual([]);
      db.close();
    });

    it("is refused when the terminal under the seat's name carries another seat's label", async () => {
      const { db, client, lifecycle, signals } = fixture(seatCore(term("other@fixture", { name: hcTerminalName(SEAT) })));
      db.exec("INSERT INTO nodes(id,rig_id,logical_id) VALUES ('o','r','other'); INSERT INTO bindings(id,node_id,attachment_type,tmux_session) VALUES ('bo','o','hc','other@fixture');");
      await expect(run(lifecycle)).resolves.toMatchObject({ ok: false });
      expect(effects(client)).toEqual([]);
      expect(signals).toEqual([]);
      db.close();
    });

    it("says the core is down rather than refusing or reading the seat as gone", async () => {
      const { db, lifecycle } = fixture(() => new HcUnavailableError("down"));
      await expect(run(lifecycle)).resolves.toMatchObject({ ok: false, code: "transport_unavailable" });
      db.close();
    });
  });
}

describe("a respawn's second effect", () => {
  it("is refused when the occupant changes while the old program is being killed: nothing is started", async () => {
    const { db, client, lifecycle, nextOccupant } = fixture();
    client.onCall = (method) => { if (method === "terminal.kill") nextOccupant(); };
    await expect(lifecycle.respawnPane(SEAT, "exec sleep 1")).resolves.toMatchObject({ ok: false, code: "guard_target_changed" });
    expect(effects(client)).toEqual(["terminal.kill"]);
    db.close();
  });
  it("respawns a finished seat held for a cutover", async () => {
    const { db, client, lifecycle } = fixture(seatCore(term(SEAT, { state: "finished" })));
    await expect(lifecycle.respawnPane("t7", "exec sleep 1")).resolves.toMatchObject({ ok: true });
    expect(effects(client)).toEqual(["terminal.run"]);
    db.close();
  });
});

describe("a binding that has not followed a respawn (the seat's address moved on)", () => {
  const moved = () => seatCore(term(SEAT, { address: "t9" }));
  it("does not stop a kill by the seat's name", async () => {
    const { db, lifecycle } = fixture(moved());
    await expect(lifecycle.killSession(SEAT)).resolves.toEqual({ ok: true });
    db.close();
  });
  it("does not stop a signal or a respawn by the address the host reports now, which the guard has no row for", async () => {
    const { db, lifecycle, signals } = fixture(moved());
    expect(resolveGuardTarget(db, "t9")).toBeNull();  // positive control: the address alone is unknown to the guard
    await expect(lifecycle.signalPaneProcess("t9", "TERM")).resolves.toEqual({ ok: true });
    expect(signals).toEqual([[4242, "SIGTERM"]]);
    await expect(lifecycle.respawnPane("t9", "exec sleep 1")).resolves.toMatchObject({ ok: true });
    db.close();
  });
});

describe("killSession where nothing is left to end (teardown must finish)", () => {
  it("reads no terminal as session_not_found for a name the guard does not know", async () => {
    const { db, client, lifecycle } = fixture(() => notFound());
    await expect(lifecycle.killSession("removed@fixture")).resolves.toMatchObject({ ok: false, code: "session_not_found" });
    expect(effects(client)).toEqual([]);
    db.close();
  });
  it("reads a finished terminal as session_not_found for a seat the guard no longer knows", async () => {
    const { db, lifecycle } = fixture(seatCore(term("removed@fixture", { state: "finished" })));
    await expect(lifecycle.killSession("removed@fixture")).resolves.toMatchObject({ ok: false, code: "session_not_found" });
    db.close();
  });
  it("still refuses a live seat the guard does not know, as tmux does", async () => {
    const { db, client, lifecycle } = fixture(seatCore(term("removed@fixture")));
    await expect(lifecycle.killSession("removed@fixture")).resolves.toMatchObject({ ok: false, code: "guard_target_unknown" });
    expect(effects(client)).toEqual([]);
    db.close();
  });
  it("does not read a typing guard as a reason to report a gone seat as failed", async () => {
    const { db, guard, lifecycle } = fixture(() => notFound());
    await guard.set(NODE, true, "person", "typing");
    await expect(lifecycle.killSession(SEAT)).resolves.toMatchObject({ ok: false, code: "session_not_found" });
    db.close();
  });
  it("does not end a terminal that appears between the look and the kill (refused, closed)", async () => {
    let reads = 0;
    const answer: Answer = (method) => {
      if (method === "terminal.get") return ++reads === 1 ? notFound() : term();
      return new Error(`unexpected ${method}`);
    };
    const { db, client, lifecycle } = fixture(answer);
    await expect(lifecycle.killSession(SEAT)).resolves.toMatchObject({ ok: false, code: "guard_target_changed" });
    expect(effects(client)).toEqual([]);
    db.close();
  });
});

describe("the metadata probe (a session no managed record names)", () => {
  const PROBE = "rigged-refresh-x";
  const probe = (over: Partial<HcTerminal> = {}) => term(PROBE, { labels: { [PROBE_LABEL]: PROBE }, ...over });
  it("is killed without a seat's lease", async () => {
    const { db, client, lifecycle } = fixture(seatCore(probe()));
    expect(resolveGuardTarget(db, PROBE)).toBeNull();  // positive control: the guard alone would refuse it
    await expect(lifecycle.killSession(PROBE)).resolves.toEqual({ ok: true });
    expect(effects(client)).toEqual(["terminal.kill"]);
    db.close();
  });
  it("is refused when a managed record names it: a probe's label does not take a seat's name", async () => {
    const { db, client, lifecycle } = fixture(seatCore(term(SEAT, { labels: { [PROBE_LABEL]: SEAT } })));
    await expect(lifecycle.killSession(SEAT)).resolves.toMatchObject({ ok: false, code: "guard_target_changed" });
    expect(effects(client)).toEqual([]);
    db.close();
  });
  it("is not reached by its address", async () => {
    const { db, client, lifecycle } = fixture(seatCore(probe()));
    await expect(lifecycle.killSession("t7")).resolves.toMatchObject({ ok: false });
    expect(effects(client)).toEqual([]);
    db.close();
  });
});

describe("a seat launched and not yet bound (the launch's rollback)", () => {
  // A session name the guard cannot reach from the node: the row's own name differs and no binding carries it yet.
  const NAME = "launched-under-its-own-name";
  const unbound = () => {
    const f = fixture(seatCore(term(NAME)));
    f.db.exec("DELETE FROM bindings WHERE node_id = 'h'");
    return f;
  };
  it("is killed under the launch's lifecycle lease", async () => {
    const { db, guard, client, lifecycle } = unbound();
    lifecycle.noteLaunched(NAME, NODE);
    await expect(guard.lifecycle([NODE], () => lifecycle.killSession(NAME))).resolves.toEqual({ ok: true });
    expect(effects(client)).toEqual(["terminal.kill"]);
    db.close();
  });
  it("is not killed without that lease", async () => {
    const { db, client, lifecycle } = unbound();
    lifecycle.noteLaunched(NAME, NODE);
    await expect(lifecycle.killSession(NAME)).resolves.toMatchObject({ ok: false, code: "guard_target_changed" });
    expect(effects(client)).toEqual([]);
    db.close();
  });
  it("loses the exception once its binding commits", async () => {
    const { db, guard, client, lifecycle } = unbound();
    lifecycle.noteLaunched(NAME, NODE);
    lifecycle.finishLaunchBinding(NAME);
    await expect(guard.lifecycle([NODE], () => lifecycle.killSession(NAME))).resolves.toMatchObject({ ok: false });
    expect(effects(client)).toEqual([]);
    db.close();
  });
  it("loses the exception once killed", async () => {
    const { db, guard, client, lifecycle } = unbound();
    lifecycle.noteLaunched(NAME, NODE);
    await guard.lifecycle([NODE], () => lifecycle.killSession(NAME));
    await expect(guard.lifecycle([NODE], () => lifecycle.killSession(NAME))).resolves.toMatchObject({ ok: false });
    expect(effects(client)).toEqual(["terminal.kill"]);
    db.close();
  });
});

describe("killSession of a terminal that is not a seat's, with or without a guard", () => {
  const plain = (client: FakeClient) => new HcLifecycle(client, { daemonEnv: {} });
  const cases: Array<[string, HcTerminal]> = [
    ["no label", term(SEAT, { name: "t1-free", labels: {} })],
    ["a forged seat label on a name that is not that seat's", term(SEAT, { name: "chatroom", labels: { [SEAT_LABEL]: SEAT } })],
    ["no name at all", term(SEAT, { name: null })],
  ];
  for (const [what, terminal] of cases) {
    it(`refuses an address with ${what}`, async () => {
      const bare = new FakeClient(seatCore(terminal));
      await expect(plain(bare).killSession("t1")).resolves.toMatchObject({ ok: false, code: "not_a_seat" });
      expect(effects(bare)).toEqual([]);
      const { db, client, lifecycle } = fixture(seatCore(terminal));
      await expect(lifecycle.killSession("t1")).resolves.toMatchObject({ ok: false });
      expect(effects(client)).toEqual([]);
      db.close();
    });
  }
  it("still kills a seat's own terminal by its address (control)", async () => {
    const bare = new FakeClient(seatCore());
    await expect(plain(bare).killSession("t7")).resolves.toEqual({ ok: true });
    const { db, lifecycle } = fixture();
    await expect(lifecycle.killSession("t7")).resolves.toEqual({ ok: true });
    db.close();
  });
});
