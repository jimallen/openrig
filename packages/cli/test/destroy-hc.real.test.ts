import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import {
  buildDestroyPlan,
  executeDestroy,
  hcCallOverSocket,
  killHcSeat,
  listManagedHcSeatsFromDb,
  type DestroyDeps,
  type HcCall,
} from "../src/destroy-helpers.js";
import { resolveHcSocket } from "@openrig/daemon/hc";

const HC = spawnSync("sh", ["-c", "command -v hc"], { encoding: "utf8" }).stdout.trim();
const nameOf = (seat: string) => `s-${createHash("sha256").update(seat).digest("hex").slice(0, 24)}`;

/** A private core only (own HOME, HC_SESSION and XDG paths), as the daemon's hc-host.real.test.ts does. */
describe.skipIf(!HC)("rig destroy --all against a private hc core", () => {
  const root = mkdtempSync(join(tmpdir(), "dhc-"));
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, HOME: join(root, "h"), HC_SESSION: `d${process.pid}`,
    XDG_CONFIG_HOME: join(root, "c"), XDG_DATA_HOME: join(root, "d"), XDG_STATE_HOME: join(root, "s"), XDG_RUNTIME_DIR: join(root, "r"),
  };
  let call: HcCall;
  let coreUp = false;

  async function run(name: string, labels: Record<string, string>): Promise<string> {
    const t = (await call("terminal.run", { argv: ["sleep", "300"], name, labels, no_parent: true, no_notify: true, outlive_parent: true })) as { address: string };
    return t.address;
  }
  const state = async (terminal: string) => ((await call("terminal.get", { terminal })) as { state: string }).state;

  beforeAll(() => {
    for (const d of ["h", "c", "d", "s", "r"]) mkdirSync(join(root, d), { recursive: true, mode: 0o700 });
    execFileSync(HC, ["server", "start"], { env, stdio: "ignore" });
    coreUp = true;
    call = hcCallOverSocket(resolveHcSocket(env, env.HOME));
  });

  afterAll(() => {
    if (coreUp) spawnSync(HC, ["server", "stop"], { env, stdio: "ignore" });
    rmSync(root, { recursive: true, force: true });
  });

  it("ends the seat's terminal and leaves every other terminal running", async () => {
    const mine = await run(nameOf("qa@rig"), { "openrig.seat": "qa@rig" });
    const other = await run(nameOf("lead@rig"), { "openrig.seat": "lead@rig" });
    const bystander = await run("jims-own", { purpose: "mine" });
    expect(await state(mine)).toBe("live");
    await expect(killHcSeat("qa@rig", call)).resolves.toBe("killed");
    expect(await state(mine)).toBe("finished");
    expect(await state(other)).toBe("live");
    expect(await state(bystander)).toBe("live");
    await expect(killHcSeat("qa@rig", call)).resolves.toBe("missing");  // finished: positive evidence
    await expect(killHcSeat("never-ran@rig", call)).resolves.toBe("missing");  // not_found
  });

  it("refuses a terminal holding a seat's name but another seat's label", async () => {
    const squatter = await run(nameOf("squat@rig"), { "openrig.seat": "someone-else@rig" });
    await expect(killHcSeat("squat@rig", call)).resolves.toBe("refused");
    expect(await state(squatter)).toBe("live");
  });

  it("runs the whole command path over a real database: kills the bound seats, spares the rest, removes the state", async () => {
    const a = await run(nameOf("one@proj"), { "openrig.seat": "one@proj" });
    const b = await run(nameOf("two@proj"), { "openrig.seat": "two@proj" });
    const bystander = await run("not-a-seat", {});
    const dbPath = join(root, "o.sqlite");
    const db = new Database(dbPath);
    db.exec(`CREATE TABLE nodes (id TEXT PRIMARY KEY);
      CREATE TABLE sessions (id TEXT PRIMARY KEY, node_id TEXT, session_name TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE bindings (id TEXT PRIMARY KEY, node_id TEXT NOT NULL, tmux_session TEXT, tmux_pane TEXT, attachment_type TEXT NOT NULL DEFAULT 'tmux', terminal_address TEXT);
      INSERT INTO nodes VALUES ('n1'), ('n2');
      INSERT INTO bindings (id, node_id, tmux_session, attachment_type, terminal_address) VALUES ('b1','n1','one@proj','hc','${a}'), ('b2','n2','two@proj','hc',NULL);`);
    db.close();
    const removed: string[] = [];
    const deps: DestroyDeps = {
      stopDaemon: async () => {}, inspectListener: async () => ({ kind: "unreachable" }), findListeningPid: () => null, killProcess: () => {},
      exists: () => true, renamePath: () => {}, removePath: (p) => { removed.push(p); }, mkdirp: () => {},
      listManagedTmuxSessions: () => { throw new Error("tmux must not be consulted for hc-bound seats"); },
      killTmuxSession: () => { throw new Error("tmux must not be run"); },
      listManagedHcSeats: listManagedHcSeatsFromDb, killHcSeat: (seat) => killHcSeat(seat, call),
      sleep: async () => {}, now: () => new Date("2026-04-10T08:10:11Z"),
    };
    const plan = buildDestroyPlan("all", false, { stateRoot: join(root, "state"), dbPath, transcriptsPath: join(root, "state", "t"), daemonHost: "127.0.0.1", daemonPort: 7433 }, deps);
    expect(plan.managedHcSeats).toEqual(["one@proj", "two@proj"]);
    const result = await executeDestroy(plan, deps);
    expect(result).toMatchObject({ hcKilled: 2, hcUnconfirmed: [], stateRecreated: true });
    expect(await state(a)).toBe("finished");
    expect(await state(b)).toBe("finished");
    expect(await state(bystander)).toBe("live");
    expect(removed).toContain(join(root, "state"));
  });

  it("reads a core that is not there as unknown, never as gone", async () => {
    const nowhere = hcCallOverSocket(join(root, "r", "no-such-core.sock"));
    await expect(killHcSeat("qa@rig", nowhere)).resolves.toBe("unconfirmed");
  });
});
