import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ConfigStore } from "../../cli/src/config-store.js";
import { DaemonClient } from "../../cli/src/client.js";

describe("test instance environment", () => {
  // The default-routing discriminator that scripts/test-instance-isolation.test.mjs runs against a disposable outer instance is
  // instance-environment-probe.opt-in.ts, outside the suite's collection.
  it("preserves explicit fixture overrides made after setup", async () => {
    const root = mkdtempSync(join(tmpdir(), "instance-override-"));
    try {
      vi.stubEnv("OPENRIG_HOME", root);
      vi.stubEnv("OPENRIG_DB", join(root, "chosen.sqlite"));
      vi.stubEnv("OPENRIG_URL", "http://fixture.invalid:12345");
      expect(new ConfigStore().resolve().db.path).toBe(join(root, "chosen.sqlite"));
      const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
      const client = new DaemonClient(undefined, { fetchImpl });
      expect(client.baseUrl).toBe("http://fixture.invalid:12345");
      await client.get("/api/test-isolation");
      expect(fetchImpl).toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
