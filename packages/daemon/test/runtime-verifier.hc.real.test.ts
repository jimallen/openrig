// The seat-host check against a private hc core (own HOME, HC_SESSION and XDG paths; never the machine's core).
// Skipped where hc is absent.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { HcClient, resolveHcSocket } from "../src/adapters/hc-client.js";
import { HC_PINNED_VERSION, RuntimeVerifier } from "../src/domain/runtime-verifier.js";

const HC = spawnSync("sh", ["-c", "command -v hc"], { encoding: "utf8" }).stdout.trim();
const run = promisify(execFile);

describe.skipIf(!HC)("RuntimeVerifier.verifyHc against a private hc core", () => {
  const root = mkdtempSync(join(tmpdir(), "rvhc-"));
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, HOME: join(root, "h"), HC_SESSION: `v${process.pid}`,
    XDG_CONFIG_HOME: join(root, "c"), XDG_DATA_HOME: join(root, "d"), XDG_STATE_HOME: join(root, "s"), XDG_RUNTIME_DIR: join(root, "r"),
  };
  const socket = resolveHcSocket(env, env.HOME);
  const installed = /(\d+\.\d+\.\d+)/.exec(spawnSync(HC, ["--version"], { encoding: "utf8" }).stdout)?.[1];
  let db: Database.Database;
  let started = false;
  // hc runs under the private env, as the probe would find it; the hello goes to the private socket.
  const verifier = () => new RuntimeVerifier({
    exec: async (cmd) => (await run("sh", ["-c", cmd], { env })).stdout,
    db,
    hcHello: () => new HcClient(socket).hello(),
  });

  beforeAll(() => {
    for (const d of ["h", "c", "d", "s", "r"]) mkdirSync(join(root, d), { recursive: true, mode: 0o700 });
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
  });
  afterAll(() => {
    db.close();
    if (started) spawnSync(HC, ["server", "stop"], { env, stdio: "ignore" });
    rmSync(root, { recursive: true, force: true });
  });

  it("with no core: degraded, and verifying started none", async () => {
    const result = await verifier().verifyHc();
    expect(result.status).toBe(installed === HC_PINNED_VERSION ? "degraded" : "error");
    expect(existsSync(socket)).toBe(false);
  });

  it("with a core: verified at the pin, naming the generation it answered", async () => {
    execFileSync(HC, ["server", "start"], { env, stdio: "ignore" });
    started = true;
    const result = await verifier().verifyHc();
    if (installed === HC_PINNED_VERSION) {
      expect(result.status).toBe("verified");
      expect(JSON.parse(result.capabilitiesJson!)).toEqual({ generation: 1, coreVersion: HC_PINNED_VERSION });
    } else {
      expect(result.status).toBe("error");  // an hc that is not the pin is refused whatever the core says
      expect(result.error).toContain(HC_PINNED_VERSION);
    }
  });
});
