import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { HcAdapter } from "../src/adapters/hc-adapter.js";
import { HcClient } from "../src/adapters/hc-client.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { PodRepository } from "../src/domain/pod-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { DiscoveryRepository } from "../src/domain/discovery-repository.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { RigLifecycleService } from "../src/domain/rig-lifecycle-service.js";
import { SeatDeliveryGuard, resolveGuardTarget } from "../src/domain/seat-delivery-guard.js";
import { findHc, startHcScratch, type HcScratch } from "./helpers/hc-scratch.js";

describe.skipIf(!findHc())("shrink a pod holding an already-exited seat, on a private hc core", () => {
  let scratch: HcScratch;
  beforeAll(() => { scratch = startHcScratch(); vi.stubEnv("SHELL", "/bin/sh"); }, 60_000);
  afterAll(() => { vi.unstubAllEnvs(); scratch?.cleanup(); });

  it("shrinks a pod containing an already-exited hc seat and preserves siblings", async () => {
    const db = createDb();
    try {
      migrate(db, ALL_MIGRATIONS);
      const rigRepo = new RigRepository(db), sessionRegistry = new SessionRegistry(db), eventBus = new EventBus(db);
      const podRepo = new PodRepository(db);
      const rig = rigRepo.createRig("shrink-fixture"), pod = podRepo.createPod(rig.id, "crew", "Crew");
      // The daemon's own adapter carries the delivery guard (a managed launch needs its lease); the seats are made by a second,
      // unguarded one over the same core, the way a person or an earlier daemon would have made them.
      const seeder = new HcAdapter(scratch.client());
      const hc = new HcAdapter(scratch.client());
      hc.deliveryGuard = new SeatDeliveryGuard(db, (name) => resolveGuardTarget(db, name));
      const lifecycle = new RigLifecycleService({ db, rigRepo, sessionRegistry, eventBus,
        discoveryRepo: new DiscoveryRepository(db), queueRepo: new QueueRepository(db, eventBus), tmuxAdapter: hc });
      const seats = new Map<string, { node: { id: string }; session: { id: string }; name: string }>();
      for (const member of ["a", "b", "c", "sibling"]) {
        const name = `${member}@shrink-fixture`;
        expect(await seeder.createSession(name, scratch.root)).toEqual({ ok: true });
        const [pane] = await seeder.listPanes(name);
        const node = rigRepo.addNode(rig.id, member, { runtime: "terminal", ...(member === "sibling" ? {} : { podId: pod.id }) });
        const session = sessionRegistry.registerSession(node.id, name);
        sessionRegistry.updateStatus(session.id, "running");
        sessionRegistry.updateBinding(node.id, { tmuxSession: name, tmuxPane: pane!.id });
        seats.set(member, { node, session, name });
      }
      const stopped = seats.get("b")!;
      expect(await seeder.killSession(stopped.name)).toEqual({ ok: true });
      sessionRegistry.updateStatus(stopped.session.id, "exited");

      const result = await lifecycle.shrinkPod(rig.id, pod.id);
      expect(result.ok && result.status, JSON.stringify(result)).toBe("ok");
      if (!result.ok) return;
      expect(result.removedLogicalIds).toEqual(["a", "b", "c"]);
      expect(result.sessionsKilled).toBe(2);
      expect(podRepo.getPod(pod.id)).toBeNull();
      expect((db.prepare("SELECT COUNT(*) AS n FROM nodes WHERE pod_id = ?").get(pod.id) as { n: number }).n).toBe(0);
      const sibling = seats.get("sibling")!;
      expect((await hc.probeSession(sibling.name)).state).toBe("present");
      for (const member of ["a", "c"]) expect((await hc.probeSession(seats.get(member)!.name)).state, member).toBe("absent");
      expect(sessionRegistry.getBindingForNode(sibling.node.id)?.tmuxPane).toBe((await hc.listPanes(sibling.name))[0]!.id);
      expect(podRepo.createPod(rig.id, "crew", "Replacement"), "the removed namespace can be reused").toBeTruthy();

      // A conservative refusal control: a core that cannot be reached does not authorize removal. (tmux also had present,
      // permission-denied and binding-changed controls; they have no hc form, see the conversion note in the PR.)
      const unreachable = new HcAdapter(new HcClient(join(scratch.root, "no-core.sock")));
      unreachable.deliveryGuard = hc.deliveryGuard;
      const outcome = await unreachable.killSession(sibling.name);
      expect(outcome.ok).toBe(false);
      expect(outcome.ok === false && outcome.code).toBe("transport_unavailable");
      expect((await hc.probeSession(sibling.name)).state).toBe("present");
    } finally { db.close(); }
  }, 60_000);
});
