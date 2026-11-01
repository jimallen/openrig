// A fake lister and a fake kill can only assume that a refusal to list leaves the seats running. Here the seats are real terminals
// on a private hc core (own HOME, HC_SESSION and XDG paths, as destroy-hc.real.test.ts): with a database sqlite cannot open, the run
// must stop with those terminals still live and the state in place; with a readable one (control) the same run ends them.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { buildDestroyPlan, executeDestroy, hcCallOverSocket, killHcSeat, listManagedHcSeatsFromDb, listManagedTmuxSessionsFromDb, type DestroyDeps, type HcCall } from "../src/destroy-helpers.js";
import { resolveHcSocket } from "@openrig/daemon/hc";

const HC = spawnSync("sh", ["-c", "command -v hc"], { encoding: "utf8" }).stdout.trim();
const nameOf = (seat: string) => `s-${createHash("sha256").update(seat).digest("hex").slice(0, 24)}`;

describe.skipIf(!HC)("rig destroy --all with an unreadable database, against a private hc core", () => {
  const root = mkdtempSync(join(tmpdir(), "dnum-"));
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, HOME: join(root, "h"), HC_SESSION: `e${process.pid}`,
    XDG_CONFIG_HOME: join(root, "c"), XDG_DATA_HOME: join(root, "d"), XDG_STATE_HOME: join(root, "s"), XDG_RUNTIME_DIR: join(root, "r"),
  };
  let call: HcCall;
  let coreUp = false;
  const state = async (terminal: string) => ((await call("terminal.get", { terminal })) as { state: string }).state;
  const run = async (seat: string) =>
    ((await call("terminal.run", { argv: ["sleep", "300"], name: nameOf(seat), labels: { "openrig.seat": seat }, no_parent: true, no_notify: true, outlive_parent: true })) as { address: string }).address;

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

  function depsFor(removed: string[]): DestroyDeps {
    return {
      stopDaemon: async () => {}, inspectListener: async () => ({ kind: "unreachable" }), findListeningPid: () => null, killProcess: () => {},
      exists: existsSync, renamePath: () => {}, removePath: (p) => { removed.push(p); }, mkdirp: () => {},
      listManagedHcSeats: listManagedHcSeatsFromDb, listManagedTmuxSessions: listManagedTmuxSessionsFromDb,
      killHcSeat: (seat) => killHcSeat(seat, call),
      sleep: async () => {}, now: () => new Date("2031-03-04T05:06:07Z"),
    };
  }
  const cfg = (dbPath: string) => ({ stateRoot: join(root, "state"), dbPath, transcriptsPath: join(root, "state", "t"), daemonHost: "127.0.0.1", daemonPort: 7433 });

  it("leaves the seats' terminals live and the state in place when sqlite cannot open the database", async () => {
    const seat = await run("keep@proj");
    const dbPath = join(root, "broken.sqlite");
    writeFileSync(dbPath, "not a database ".repeat(200));
    const removed: string[] = [];
    const d = depsFor(removed);
    const killHc = vi.spyOn(d, "killHcSeat");
    const result = await executeDestroy(buildDestroyPlan("all", false, cfg(dbPath), d), d);
    expect(result.seatEnumerationFailures.length).toBeGreaterThan(0);
    expect(result.stateRecreated).toBe(false);
    expect(removed).toEqual([]);
    expect(killHc).not.toHaveBeenCalled();
    expect(await state(seat)).toBe("live");
  });

  it("control: the same run over a readable database ends the seat", async () => {
    const seat = await run("gone@proj");
    const dbPath = join(root, "ok.sqlite");
    const db = new Database(dbPath);
    db.exec(`CREATE TABLE nodes (id TEXT PRIMARY KEY);
      CREATE TABLE sessions (id TEXT PRIMARY KEY, node_id TEXT, session_name TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE bindings (id TEXT PRIMARY KEY, node_id TEXT NOT NULL, tmux_session TEXT, tmux_pane TEXT, attachment_type TEXT NOT NULL DEFAULT 'tmux', terminal_address TEXT);
      INSERT INTO nodes VALUES ('n1');
      INSERT INTO bindings (id, node_id, tmux_session, attachment_type) VALUES ('b1','n1','gone@proj','hc');`);
    db.close();
    mkdirSync(join(root, "state"), { recursive: true });
    const removed: string[] = [];
    const d = depsFor(removed);
    const result = await executeDestroy(buildDestroyPlan("all", false, cfg(dbPath), d), d);
    expect(result).toMatchObject({ seatEnumerationFailures: [], hcKilled: 1, stateRecreated: true });
    expect(await state(seat)).toBe("finished");
    expect(removed).toContain(join(root, "state"));
  });
});
