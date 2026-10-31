import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { Reconciler } from "../src/domain/reconciler.js";
import { HcAdapter } from "../src/adapters/hc-adapter.js";
import { findHc, startHcScratch, type HcScratch } from "./helpers/hc-scratch.js";

// A seat's name is exact on hc: the terminal is found by the digest of the whole name (hcTerminalName), so a live seat whose
// name merely starts with a missing seat's name can never stand in for it. tmux resolved `-t name` as a prefix unless
// the target was written `=name`, and this file pinned that a live prefix neighbour cannot hide a detached seat.
describe.skipIf(!findHc())("exact seat names on a private hc core", () => {
  let scratch: HcScratch;
  let adapter: HcAdapter;

  beforeAll(async () => {
    scratch = startHcScratch();
    adapter = new HcAdapter(scratch.client());
    vi.stubEnv("SHELL", "/bin/sh");
    await expect(adapter.createSession("worker@demo2", scratch.root)).resolves.toEqual({ ok: true });
  }, 60_000);

  afterAll(() => {
    vi.unstubAllEnvs();
    scratch?.cleanup();
  });

  it("probes the exact name: the live seat is present, its missing prefix is absent", async () => {
    expect((await adapter.probeSession("worker@demo2")).state).toBe("present");
    expect((await adapter.probeSession("worker@demo")).state).toBe("absent");
  });

  it("lists the exact seat's pane by every spelling of its target, and nothing for the missing prefix", async () => {
    const [pane] = await adapter.listPanes("worker@demo2");
    expect(pane).toBeDefined();
    for (const target of ["worker@demo2:0", "=worker@demo2", "=worker@demo2:0", "worker@demo2:0.0", pane!.id]) {
      expect((await adapter.listPanes(target)).map((p) => p.id), target).toEqual([pane!.id]);
    }
    // tmux refused the missing target ("can't find window"); hc has no refusal to give, the terminal is not there.
    expect(await adapter.listPanes("worker@demo")).toEqual([]);
    expect(await adapter.listPanes("=worker@demo")).toEqual([]);
    expect(await adapter.listPanes("worker@demo:0")).toEqual([]);
  });

  it("the reconciler detaches the missing seat and leaves the live neighbour running", async () => {
    const db = createDb();
    try {
      migrate(db, ALL_MIGRATIONS);
      const repo = new RigRepository(db), registry = new SessionRegistry(db), eventBus = new EventBus(db);
      const rig = repo.createRig("demo"), neighborRig = repo.createRig("demo2");
      const missingNode = repo.addNode(rig.id, "worker", { runtime: "terminal" });
      const liveNode = repo.addNode(neighborRig.id, "worker", { runtime: "terminal" });
      const missing = registry.registerSession(missingNode.id, "worker@demo");
      const live = registry.registerSession(liveNode.id, "worker@demo2");
      registry.updateStatus(missing.id, "running"); registry.updateStatus(live.id, "running");
      const reconciler = new Reconciler({ db, sessionRegistry: registry, eventBus, tmuxAdapter: adapter });
      expect(await reconciler.reconcile(rig.id)).toEqual({ checked: 1, detached: 1, errors: [] });
      expect(registry.getSessionsForRig(rig.id)[0]!.status).toBe("detached");
      expect(registry.getSessionsForRig(neighborRig.id)[0]!.status).toBe("running");
      expect((await adapter.probeSession("worker@demo2")).state).toBe("present");
    } finally { db.close(); }
  });

  // The names a person could write that look like another name: a leading `=` (tmux's exact marker), and the name without it.
  // On hc the three arrangements are three different terminals, whatever each is called.
  it.each([
    { label: "only the `=` name", names: ["=worker@exact"] },
    { label: "only the plain name", names: ["worker@exact"] },
    { label: "both", names: ["=worker@exact", "worker@exact"] },
  ])("literal names ($label): each live name is present, each other absent, and a removed one reads absent", async ({ names }) => {
    const literal = "=worker@exact", plain = "worker@exact";
    try {
      for (const name of names) await expect(adapter.createSession(name, scratch.root)).resolves.toEqual({ ok: true });
      for (const name of names) expect((await adapter.probeSession(name)).state, name).toBe("present");
      for (const absent of [literal, plain].filter((name) => !names.includes(name))) {
        expect((await adapter.probeSession(absent)).state, absent).toBe("absent");
      }
      if (names.includes(literal)) {
        await expect(adapter.killSession(literal)).resolves.toEqual({ ok: true });
        await vi.waitFor(async () => expect((await adapter.probeSession(literal)).state).toBe("absent"), { timeout: 10_000 });
        if (names.includes(plain)) expect((await adapter.probeSession(plain)).state, "plain neighbour survives literal removal").toBe("present");
      }
    } finally {
      for (const name of names) await adapter.killSession(name).catch(() => undefined);
    }
  }, 30_000);

  // Found by this conversion (not a regression of it): listPanes() reads a leading `=` as tmux's exact marker (hcTerminalRef), so a seat
  // whose name literally starts with `=` is listed under the other name's digest. probeSession/killSession/createSession use the name as given.
  it.fails("lists the pane of a seat whose name literally starts with `=` (DEFECT: hcTerminalRef strips the `=`)", async () => {
    const literal = "=worker@listed";
    try {
      await expect(adapter.createSession(literal, scratch.root)).resolves.toEqual({ ok: true });
      expect(await adapter.listPanes(literal)).toHaveLength(1);
    } finally { await adapter.killSession(literal).catch(() => undefined); }
  }, 30_000);
});
