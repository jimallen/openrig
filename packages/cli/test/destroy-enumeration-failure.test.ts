// hc cutover (Jim, 2026-11-01): a full `rig destroy` that cannot list the seats it is about to delete the state of must stop,
// state untouched, naming the cause and the fix, as an unconfirmed seat does. A warning and carrying on would delete the only record
// of which terminals were ours, and leave them running. A database file that is not there is nothing to list, not a failure.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DESTROY_CONFIRM_TOKEN, buildDestroyPlan, executeDestroy, listManagedHcSeatsFromDb, listManagedTmuxSessionsFromDb, type DestroyDeps } from "../src/destroy-helpers.js";
import { destroyCommand } from "../src/commands/destroy.js";

const config = { stateRoot: "/x/.openrig", dbPath: "/x/.openrig/openrig.sqlite", transcriptsPath: "/x/.openrig/transcripts", daemonHost: "127.0.0.1", daemonPort: 7433 };

function deps(overrides: Partial<DestroyDeps> = {}): DestroyDeps {
  return {
    stopDaemon: vi.fn(async () => {}),
    inspectListener: vi.fn(async () => ({ kind: "unreachable" as const })),
    findListeningPid: vi.fn(() => null),
    killProcess: vi.fn(),
    exists: vi.fn(() => true),
    renamePath: vi.fn(),
    removePath: vi.fn(),
    mkdirp: vi.fn(),
    listManagedTmuxSessions: vi.fn(() => []),
    listManagedHcSeats: vi.fn(() => ["a@demo"]),
    killHcSeat: vi.fn(async () => "killed" as const),
    sleep: vi.fn(async () => {}),
    now: vi.fn(() => new Date("2031-03-04T05:06:07Z")),
    ...overrides,
  };
}

/** Nothing the run could do to the machine: no daemon stop or kill, no seat ended, no path moved, removed or made. */
function expectUntouched(d: DestroyDeps): void {
  for (const name of ["stopDaemon", "killProcess", "killHcSeat", "removePath", "renamePath", "mkdirp"] as const) {
    expect(d[name], name).not.toHaveBeenCalled();
  }
}

describe("rig destroy --all when the seats cannot be listed", () => {
  it("stops with state untouched when the hc seats cannot be listed, naming the cause and the fix", async () => {
    const d = deps({ listManagedHcSeats: () => { throw new Error("database disk image is malformed"); } });
    const plan = buildDestroyPlan("all", false, config, d);
    const result = await executeDestroy(plan, d);
    expectUntouched(d);
    expect(result).toMatchObject({ stateRecreated: false, hcKilled: 0, tmuxKilled: 0, backupPaths: [] });
    expect(result.seatEnumerationFailures).toHaveLength(1);
    const text = result.warnings.join("\n");
    expect(text).toContain("hc seats");
    expect(text).toContain("database disk image is malformed");  // the cause
    expect(text).toContain(config.dbPath);
    expect(text).toMatch(/State was left untouched/);
    expect(text).toMatch(/repair or restore the database/i);      // the fix
    expect(text).toContain("--state");
  });

  it("stops the same way when the tmux-bound seats cannot be listed", async () => {
    const d = deps({ listManagedTmuxSessions: () => { throw new Error("unable to open database file"); } });
    const result = await executeDestroy(buildDestroyPlan("all", false, config, d), d);
    expectUntouched(d);
    expect(result.seatEnumerationFailures).toHaveLength(1);
    expect(result.warnings.join("\n")).toContain("tmux-bound seats");
    expect(result.warnings.join("\n")).toContain("unable to open database file");
    expect(result.stateRecreated).toBe(false);
  });

  it("names both when both fail", async () => {
    const d = deps({ listManagedTmuxSessions: () => { throw new Error("tmux cause"); }, listManagedHcSeats: () => { throw new Error("hc cause"); } });
    const result = await executeDestroy(buildDestroyPlan("all", false, config, d), d);
    expect(result.seatEnumerationFailures).toHaveLength(2);
    const text = result.warnings.join("\n");
    expect(text).toContain("tmux cause");
    expect(text).toContain("hc cause");
    expectUntouched(d);
  });

  it("a database file that is not there is nothing to list: the run goes on (control)", async () => {
    const list = vi.fn(() => { throw new Error("must not be asked"); });
    const d = deps({ exists: vi.fn((p: string) => p !== config.dbPath), listManagedHcSeats: list, listManagedTmuxSessions: list });
    const result = await executeDestroy(buildDestroyPlan("all", false, config, d), d);
    expect(list).not.toHaveBeenCalled();
    expect(result.seatEnumerationFailures).toEqual([]);
    expect(result.stateRecreated).toBe(true);
    expect(d.removePath).toHaveBeenCalled();
  });

  it("--state still works with a database that cannot be read, and never lists seats (control)", async () => {
    const list = vi.fn(() => { throw new Error("must not be asked"); });
    const d = deps({ listManagedHcSeats: list, listManagedTmuxSessions: list });
    const result = await executeDestroy(buildDestroyPlan("state", false, config, d), d);
    expect(list).not.toHaveBeenCalled();
    expect(result).toMatchObject({ stateRecreated: true, seatEnumerationFailures: [] });
  });

  it("a list that works runs as before, and the error's text never leaks into a clean run (control)", async () => {
    const d = deps();
    const result = await executeDestroy(buildDestroyPlan("all", false, config, d), d);
    expect(result).toMatchObject({ hcKilled: 1, stateRecreated: true, seatEnumerationFailures: [] });
    expect(result.warnings.join("\n")).not.toContain("Failed to enumerate");
  });
});

describe("rig destroy --all command with a database that cannot be read", () => {
  const configStore = { resolve: () => ({ daemon: { port: 7433, host: "127.0.0.1" }, db: { path: "/tmp/db" }, transcripts: { enabled: true, path: "/tmp/tx" } }) };
  async function run(destroyDeps: DestroyDeps): Promise<{ out: string; exitCode: number | undefined }> {
    const program = new Command();
    program.exitOverride();
    program.addCommand(destroyCommand({ configStore, destroyDeps }));
    const logs: string[] = [];
    const log = console.log;
    const previous = process.exitCode;
    process.exitCode = undefined;
    console.log = (...a: unknown[]) => { logs.push(a.join(" ")); };
    try {
      await program.parseAsync(["node", "rig", "destroy", "--all", "--yes", "--confirm", DESTROY_CONFIRM_TOKEN]);
    } finally {
      console.log = log;
    }
    const exitCode = process.exitCode;
    process.exitCode = previous;
    return { out: logs.join("\n"), exitCode };
  }

  it("exits 1, says nothing was touched (not that the daemon is still responding), and removes nothing", async () => {
    const d = deps({ listManagedHcSeats: () => { throw new Error("file is not a database"); } });
    const { out, exitCode } = await run(d);
    expect(exitCode).toBe(1);
    expect(out).toContain("file is not a database");
    expect(out).toContain("fresh state root: not created");
    expect(out).toContain("daemon: not touched");
    expect(out).not.toContain("still responding");
    expect(out).not.toContain("still occupied");
    expectUntouched(d);
  });
});

describe("against a real database file", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "destroy-enum-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
  const real = (dbPath: string) => ({ ...config, stateRoot: join(dir, "state"), dbPath, transcriptsPath: join(dir, "state", "t") });
  const realDeps = () => deps({ exists: existsSync, listManagedHcSeats: listManagedHcSeatsFromDb, listManagedTmuxSessions: listManagedTmuxSessionsFromDb });

  it("a file that is not a database makes sqlite itself fail, and the run stops, untouched", async () => {
    const dbPath = join(dir, "openrig.sqlite");
    writeFileSync(dbPath, "this is not an sqlite database, it is text that sqlite refuses to open ".repeat(40));
    const d = realDeps();
    const result = await executeDestroy(buildDestroyPlan("all", false, real(dbPath), d), d);
    expect(result.seatEnumerationFailures).toHaveLength(2);
    expect(result.warnings.join("\n")).toMatch(/not a database/i);  // sqlite's own words
    expect(result.stateRecreated).toBe(false);
    expectUntouched(d);
  });

  it("a path that does not exist is not a failure, with the real exists and the real lister never reached", async () => {
    const dbPath = join(dir, "never-created.sqlite");
    const d = realDeps();
    const result = await executeDestroy(buildDestroyPlan("all", false, real(dbPath), d), d);
    expect(result.seatEnumerationFailures).toEqual([]);
    expect(result.warnings.join("\n")).not.toMatch(/enumerate|list the seats/i);
    expect(result.stateRecreated).toBe(true);
  });
});
