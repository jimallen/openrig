// OF-247 (a): the deployed wiring of the lifecycle excuse ceiling. startup.ts (createDaemon) constructs the SeatIdentityReconciler the daemon polls every 5 s and hands it the
// delivery guard's lease table and the readiness window in force (`runtime.readiness_timeout_seconds`, resolved as StartupOrchestrator resolves it for a launch).
// Production consequence of dropping the window: a seat whose launch waits the largest window the setting takes (600 s) is past its excuse by that much, so the ceiling
// ends the excuse while the launch is still inside its own timeout. The env variable overrides any config file, so the rows do not read the machine's config.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDaemon } from "../src/startup.js";

describe("startup wires the reconciler's excuse ceiling to the readiness window in force", () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it.each([
    ["600", 600_000 + 302_500 + 600_000],
    ["45", 600_000 + 302_500 + 45_000],
  ])("with runtime.readiness_timeout_seconds=%s, one seat's ceiling is 10 min + 5 min + 2.5 s + the window", async (seconds, expected) => {
    vi.stubEnv("OPENRIG_RUNTIME_READINESS_TIMEOUT_SECONDS", seconds);
    const { deps, db } = await createDaemon({ dbPath: ":memory:", tmuxExec: async () => "" });
    try {
      expect(deps.seatIdentityReconciler!.excuseCeilingMs(1)).toBe(expected);
      expect(deps.seatIdentityReconciler!.excuseCeilingMs(3), "three seats held").toBe(600_000 + 3 * (expected - 600_000));
    } finally {
      db.close();
    }
  });
});
