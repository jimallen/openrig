// The child run of scripts/test-instance-isolation.test.mjs (test:repo), not a test of the suite: that script supplies only a
// disposable outer home, database and HTTP server through OPENRIG_TEST_OUTER_INSTANCE and the OPENRIG_/RIGGED_ instance variables,
// then checks that none of them was touched. It runs this file with
//   npm test -w packages/daemon -- -c vitest.opt-in.config.ts test/instance-environment-probe.opt-in.ts ...
// Never run this discriminator against a real seat; without OPENRIG_TEST_OUTER_INSTANCE it fails rather than skips.
import { describe, expect, it } from "vitest";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createDb } from "../src/db/connection.js";
import { ConfigStore } from "../../cli/src/config-store.js";
import { DaemonClient } from "../../cli/src/client.js";

describe("test instance environment probe", () => {
  it("exercises default database and endpoint routing", async () => {
    if (!process.env.OPENRIG_TEST_OUTER_INSTANCE) throw new Error("run only as scripts/test-instance-isolation.test.mjs's child, with OPENRIG_TEST_OUTER_INSTANCE set");
    const file = new ConfigStore().resolve().db.path;
    mkdirSync(dirname(file), { recursive: true });
    const db = createDb(file);
    try { db.exec("CREATE TABLE IF NOT EXISTS isolation_probe (value TEXT)"); }
    finally { db.close(); }
    try {
      const response = await new DaemonClient().get("/api/test-isolation");
      expect(response.status).toBe(200);
    } catch (error) {
      // The isolated default is not a fixture server, and it must be rejected before any network request. Since o9o.181 the
      // client rejects it first: the fixture home is not ~/.openrig and names no daemon, so it never falls back to the default
      // address (the fetch guard stays behind it as the second line). The parent reaches the outer server, and checks that no
      // request was routed.
      expect(String(error)).toContain("names no daemon of its own");
      expect(String(error)).toContain("Nothing was sent");
    }
  });
});
