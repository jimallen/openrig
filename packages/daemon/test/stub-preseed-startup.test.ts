// workspaces-o9o.136 review (verify-qa; CoS ruling: one source): the daemon gives every seat HOME = its own daemonHome (os.homedir(),
// startup.ts launchSessionEnv), so the stub adapter must preseed under that same value, not read HOME from the env itself. With HOME unset,
// os.homedir() still names a home and the seat gets it; an adapter reading process.env.HOME would write nothing, and a healthy seat would
// report the preseed NOT reached. os.homedir is pointed at a scratch folder so nothing touches the real home.
import { afterEach, describe, expect, it, vi } from "vitest";
import os from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import nodePath from "node:path";
import { createDaemon } from "../src/startup.js";

const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("startup gives the stub adapter its own daemonHome", () => {
  it("with HOME unset, the stub adapter preseeds under startup's daemonHome (the HOME every seat is given)", async () => {
    const home = mkdtempSync(nodePath.join(os.tmpdir(), "o9o136-home-"));
    dirs.push(home);
    vi.spyOn(os, "homedir").mockReturnValue(home);
    vi.stubEnv("HOME", undefined);
    const { db, deps } = await createDaemon({ dbPath: ":memory:" });
    try {
      const stub = (deps as { runtimeAdapters: Record<string, object> }).runtimeAdapters["stub"];
      expect(stub).toBeDefined();
      expect(Reflect.get(stub!, "daemonHome")).toBe(home);
    } finally {
      db.close();
    }
  });
});
