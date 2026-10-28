// OF-158: createApp refuses a SessionRegistry that was built on a different database handle than the rig repository. Its
// sibling check for teardownOrchestrator was pinned (down-route.test.ts R4); this one was not, and removing it survived the suite.
//
// Production consequence: a registry on another handle would write session rows to a database the rest of the app never reads, so
// a launched seat would look unregistered (and a restore would then treat it as absent). The daemon builds all services on one
// handle in startup.ts; this guard is what fails the boot if that ever drifts.
//
// Deployed entrypoint: startup.ts createDaemon builds every service on one `db` and passes them to createApp (server.ts).
import { describe, expect, it } from "vitest";
import { createApp } from "../src/server.js";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";

describe("OF-158: createApp requires rigRepo and sessionRegistry to share one db handle", () => {
  it("control: the app built from services on one handle is created", () => {
    const { app: _app, ...services } = createTestApp(createFullTestDb());
    expect(() => createApp(services)).not.toThrow();
  });

  it("throws, naming the session registry, when the registry sits on another handle", () => {
    const { app: _app, ...services } = createTestApp(createFullTestDb());
    const foreign = createTestApp(createFullTestDb());
    expect(foreign.sessionRegistry.db).not.toBe(services.rigRepo.db);
    expect(() => createApp({ ...services, sessionRegistry: foreign.sessionRegistry }))
      .toThrow("createApp: rigRepo and sessionRegistry must share the same db handle");
  });

  it("the eventBus guard before it still names the eventBus, so the two guards are told apart", () => {
    const { app: _app, ...services } = createTestApp(createFullTestDb());
    const foreign = createTestApp(createFullTestDb());
    expect(() => createApp({ ...services, eventBus: foreign.eventBus }))
      .toThrow("createApp: rigRepo and eventBus must share the same db handle");
  });
});
