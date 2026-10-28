// OF-168 (a3): createApp's same-db-handle guards. z4 pinned the sessionRegistry guard (OF-158) and down-route.test.ts pins the
// teardownOrchestrator guard; the other guards (below) had no row, so deleting any one of them survived the whole suite.
//
// Production consequence: a service built on a different database handle than the rig repository writes to a database the rest
// of the app never reads. A snapshot would be captured into a store restore cannot see, a claim would be recorded where the rig
// list does not look, and an instantiated pod would be absent from `rig ps`. The daemon builds every service on one handle in
// startup.ts createDaemon and passes them to createApp (server.ts); these guards fail the boot if that ever drifts.
//
// Census (instrument: `grep -c "must share the same db handle" src/server.ts` at the base e38e10c3 = 18 lines: 1 comment + 17 throws, each read in createApp):
// 17 guards = eventBus + sessionRegistry + teardownOrchestrator (already pinned) + 14 pinned here (13 unconditional + the
// optional selfAttachService, which is guarded only when present). One row per guard, each killed by deleting that guard alone.
import { describe, expect, it } from "vitest";
import { createApp } from "../src/server.js";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";

const GUARDED = [
  "snapshotRepo", "snapshotCapture", "restoreOrchestrator", "rigSpecExporter", "rigSpecPreflight", "rigInstantiator",
  "packageRepo", "installRepo", "bootstrapRepo", "discoveryRepo", "claimService", "selfAttachService",
  "psProjectionService", "podInstantiator",
] as const;

// Each guard throws "createApp: <name> must share the same db handle" (server.ts createApp); spelled out so a rename shows.
const MESSAGE: Record<(typeof GUARDED)[number], string> = {
  snapshotRepo: "createApp: snapshotRepo must share the same db handle",
  snapshotCapture: "createApp: snapshotCapture must share the same db handle",
  restoreOrchestrator: "createApp: restoreOrchestrator must share the same db handle",
  rigSpecExporter: "createApp: rigSpecExporter must share the same db handle",
  rigSpecPreflight: "createApp: rigSpecPreflight must share the same db handle",
  rigInstantiator: "createApp: rigInstantiator must share the same db handle",
  packageRepo: "createApp: packageRepo must share the same db handle",
  installRepo: "createApp: installRepo must share the same db handle",
  bootstrapRepo: "createApp: bootstrapRepo must share the same db handle",
  discoveryRepo: "createApp: discoveryRepo must share the same db handle",
  claimService: "createApp: claimService must share the same db handle",
  selfAttachService: "createApp: selfAttachService must share the same db handle",
  psProjectionService: "createApp: psProjectionService must share the same db handle",
  podInstantiator: "createApp: podInstantiator must share the same db handle",
};

describe("OF-168: every createApp same-handle guard is pinned by its own row", () => {
  it("control: the app built from services on one handle is created", () => {
    const { app: _app, ...services } = createTestApp(createFullTestDb());
    expect(() => createApp(services)).not.toThrow();
  });

  it.each(GUARDED)("throws, naming %s, when only that service sits on another handle", (key) => {
    const { app: _app, ...services } = createTestApp(createFullTestDb());
    const foreign = createTestApp(createFullTestDb());
    expect(foreign[key].db, "precondition: the foreign service really is on another handle").not.toBe(services.rigRepo.db);
    expect(() => createApp(Object.assign({}, services, { [key]: foreign[key] }))).toThrow(MESSAGE[key]);
  });

  it("selfAttachService is optional: an app built without one is created (the guard fires only for a present service)", () => {
    const { app: _app, ...services } = createTestApp(createFullTestDb());
    expect(() => createApp({ ...services, selfAttachService: undefined })).not.toThrow();
  });
});
