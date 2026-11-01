import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HcAdapter } from "../src/adapters/hc-adapter.js";
import type { HcTerminal } from "../src/adapters/hc-client.js";
import { hcTerminalName } from "../src/adapters/hc-seat.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { migrate } from "../src/db/migrate.js";
import { SeatDeliveryGuard, resolveGuardTarget } from "../src/domain/seat-delivery-guard.js";
import { HC, PrivateCore } from "./hc-private-core.js";

// Security review N3 on a real core, through the adapter production uses, with the real guard. The fake can only assume what
// hc does with an address, a finished terminal and a respawn's new address; here the core answers.
describe.skipIf(!HC)("HcAdapter's lifecycle through the delivery guard, on a private hc core", () => {
  const core = new PrivateCore("hclg");
  const db = new Database(":memory:");
  let adapter: HcAdapter;
  let guard: SeatDeliveryGuard;
  let next = 0;

  const get = (seat: string) => core.client.call<HcTerminal>("terminal.get", { terminal: hcTerminalName(seat) });
  /** A managed node, launched through the adapter under a lifecycle lease, its binding committed as the launcher does. */
  async function launched(): Promise<{ id: string; seat: string; address: string }> {
    const id = `n${++next}`;
    const logical = `worker${next}`;
    const seat = `${logical}@fixture`;
    db.prepare("INSERT INTO nodes(id,rig_id,logical_id) VALUES (?,'r',?)").run(id, logical);
    db.prepare("INSERT INTO occupant_tenures(id,node_id,generation_ordinal,generation_uuid,kind) VALUES (?,?,1,?,'fresh')").run(`g${next}`, id, `u${next}`);
    return guard.lifecycle([id], async () => {
      await expect(adapter.createSession(seat, core.root, { OPENRIG_NODE_ID: id })).resolves.toMatchObject({ ok: true });
      const { address } = await get(seat);
      db.prepare("INSERT INTO bindings(id,node_id,attachment_type,tmux_session,terminal_address) VALUES (?,?,'hc',?,?)").run(`b${next}`, id, seat, address);
      db.prepare("INSERT INTO sessions(id,node_id,session_name,status) VALUES (?,?,?,'running')").run(`s${next}`, id, seat);
      guard.rebindLifecycle(id);
      adapter.finishLaunchBinding(seat);
      return { id, seat, address };
    });
  }

  beforeAll(() => {
    core.start();
    migrate(db, ALL_MIGRATIONS);
    db.exec("INSERT INTO rigs(id,name) VALUES ('r','fixture')");
    guard = new SeatDeliveryGuard(db, (name) => resolveGuardTarget(db, name));
    adapter = new HcAdapter(core.client);
    adapter.deliveryGuard = guard;
  });
  afterAll(() => { db.close(); core.stop(); });

  it("kills a seat under its lifecycle lease and without one, and a second kill reads as gone", async () => {
    const leased = await launched();
    await expect(guard.lifecycle([leased.id], () => adapter.killSession(leased.seat))).resolves.toEqual({ ok: true });
    await expect(adapter.killSession(leased.seat)).resolves.toMatchObject({ ok: false, code: "session_not_found" });
    const bare = await launched();
    await expect(adapter.killSession(bare.seat)).resolves.toEqual({ ok: true });
    expect((await get(bare.seat)).state).toBe("finished");
  });

  it("refuses all three while the typing guard is on, and the seat stays live at the same address", async () => {
    const { id, seat, address } = await launched();
    await guard.set(id, true, "person", "typing");
    for (const result of [await adapter.killSession(seat), await adapter.respawnPane(seat, "exec sleep 60"), await adapter.signalPaneProcess(seat, "KILL")]) {
      expect(result).toMatchObject({ ok: false, code: "typing_guard_enabled" });
    }
    expect(await get(seat)).toMatchObject({ state: "live", address });
    await guard.set(id, false, "person", "done");
    await expect(adapter.killSession(seat)).resolves.toEqual({ ok: true });
  });

  it("rolls a launch back before its binding exists, under the launch's lease", async () => {
    const id = `n${++next}`;
    const name = "rolled-back-launch";  // not what the node's name computes to, so only the launch's own record reaches it
    db.prepare("INSERT INTO nodes(id,rig_id,logical_id) VALUES (?,'r',?)").run(id, `other${next}`);
    await guard.lifecycle([id], async () => {
      await expect(adapter.createSession(name, core.root, { OPENRIG_NODE_ID: id })).resolves.toMatchObject({ ok: true });
      await expect(adapter.killSession(name)).resolves.toEqual({ ok: true });
    });
    expect((await get(name)).state).toBe("finished");
  });

  it("ends a launch's exception when its binding commits: the adapter hands that on", async () => {
    const id = `n${++next}`;
    const name = "committed-launch";
    db.prepare("INSERT INTO nodes(id,rig_id,logical_id) VALUES (?,'r',?)").run(id, `other${next}`);
    await guard.lifecycle([id], async () => {
      await adapter.createSession(name, core.root, { OPENRIG_NODE_ID: id });
      adapter.finishLaunchBinding(name);
      await expect(adapter.killSession(name)).resolves.toMatchObject({ ok: false, code: "guard_target_unknown" });
    });
    expect((await get(name)).state).toBe("live");
    await core.client.call("terminal.kill", { terminal: (await get(name)).address });
  });

  it("runs the in-place cutover by address under a lease: signal, respawn of the finished terminal, kill by name after the address moved", async () => {
    const { id, seat, address } = await launched();
    await guard.lifecycle([id], async () => {
      await expect(adapter.signalPaneProcess(address, "KILL")).resolves.toEqual({ ok: true });
      for (let i = 0; i < 200 && !(await adapter.isPaneDead(address)); i++) await new Promise((resolve) => setTimeout(resolve, 25));
      await expect(adapter.respawnPane(address, "exec sleep 60")).resolves.toMatchObject({ ok: true });
    });
    const after = await get(seat);
    expect(after).toMatchObject({ state: "live" });
    expect(after.address).not.toBe(address);
    // The binding still names the old address, as it does until a reconcile. Neither form may wedge.
    await expect(adapter.signalPaneProcess(after.address, "TERM")).resolves.toEqual({ ok: true });
    await expect(guard.lifecycle([id], () => adapter.respawnPane(after.address, "exec sleep 60"))).resolves.toMatchObject({ ok: true });
    await expect(adapter.killSession(seat)).resolves.toEqual({ ok: true });
  });

  it("creates a metadata probe and removes it with no lease, though no record names it", async () => {
    await expect(adapter.createProbeSession("rigged-refresh-p", core.root)).resolves.toEqual({ ok: true });
    await expect(adapter.killSession("rigged-refresh-p")).resolves.toEqual({ ok: true });
    expect((await get("rigged-refresh-p")).state).toBe("finished");
  });

  it("refuses a kill by the address of a terminal that is not a seat's, which stays live", async () => {
    const plain = await core.client.call<HcTerminal>("terminal.run", { argv: ["sleep", "120"], name: "person", no_parent: true, no_notify: true, outlive_parent: true });
    await expect(adapter.killSession(plain.address)).resolves.toMatchObject({ ok: false });
    expect((await core.client.call<HcTerminal>("terminal.get", { terminal: plain.address })).state).toBe("live");
    await core.client.call("terminal.kill", { terminal: plain.address });
  });
});
