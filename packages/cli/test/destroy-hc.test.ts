import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import {
  DESTROY_CONFIRM_TOKEN,
  HcDestroyRefusedError,
  HcDestroyUnavailableError,
  buildDestroyPlan,
  executeDestroy,
  hcCallOverSocket,
  killHcSeat,
  listManagedHcSeatsFromDb,
  listManagedTmuxSessionsFromDb,
  type DestroyDeps,
  type DestroyPlan,
  type HcCall,
  type HcSeatOutcome,
} from "../src/destroy-helpers.js";
import { destroyCommand } from "../src/commands/destroy.js";

// Restated here, not imported: the name is a durable address. A seat whose name changed across revisions would be
// invisible to destroy and keep running after `rig destroy --all` reported success.
const nameOf = (seat: string) => `s-${createHash("sha256").update(seat).digest("hex").slice(0, 24)}`;

interface Call { method: string; params: Record<string, unknown> }
type Reply = unknown | Error | ((params: Record<string, unknown>) => unknown);

/** A scripted core: answers by method, records every call. A method with no script fails the test by throwing. */
function fakeCore(script: Record<string, Reply>): { call: HcCall; calls: Call[] } {
  const calls: Call[] = [];
  const call: HcCall = async (method, params) => {
    calls.push({ method, params });
    if (!(method in script)) throw new Error(`unscripted hc method ${method}`);
    const reply = script[method];
    const value = typeof reply === "function" ? (reply as (p: Record<string, unknown>) => unknown)(params) : reply;
    if (value instanceof Error) throw value;
    return value;
  };
  return { call, calls };
}

const notFound = () => new HcDestroyRefusedError("not_found", "not_found");
const down = () => new HcDestroyUnavailableError("hc core: not reachable");
const live = (seat: string, address = "t7") => ({ address, state: "live", labels: { "openrig.seat": seat } });
const finished = (seat: string, address = "t7", reason = "killed") => ({ address, state: "finished", reason, labels: { "openrig.seat": seat } });

describe("killHcSeat: ends one seat's terminal and nothing else", () => {
  it("looks the seat up by its derived name, then kills by the address the core returned", async () => {
    const core = fakeCore({ "terminal.get": live("qa@rig", "t41"), "terminal.kill": finished("qa@rig", "t41") });
    await expect(killHcSeat("qa@rig", core.call)).resolves.toBe("killed");
    expect(core.calls).toEqual([
      { method: "terminal.get", params: { terminal: nameOf("qa@rig") } },
      { method: "terminal.kill", params: { terminal: "t41" } },
    ]);
  });

  it("calls no method but terminal.get and terminal.kill: no tab, space, rm, stop or restart", async () => {
    const outcomes: HcSeatOutcome[] = [];
    const seen = new Set<string>();
    const scripts: Array<Record<string, Reply>> = [
      { "terminal.get": live("a@r"), "terminal.kill": finished("a@r") },
      { "terminal.get": notFound() },
      { "terminal.get": live("other@r") },
      { "terminal.get": down() },
      { "terminal.get": finished("a@r") },
      { "terminal.get": live("a@r"), "terminal.kill": down() },
    ];
    for (const script of scripts) {
      const core = fakeCore(script);
      outcomes.push(await killHcSeat("a@r", core.call));
      for (const c of core.calls) seen.add(c.method);
    }
    expect(outcomes).toEqual(["killed", "missing", "refused", "unconfirmed", "missing", "unconfirmed"]);
    expect([...seen].sort()).toEqual(["terminal.get", "terminal.kill"]);
  });

  it("reads not_found as gone, and never kills", async () => {
    const core = fakeCore({ "terminal.get": notFound() });
    await expect(killHcSeat("qa@rig", core.call)).resolves.toBe("missing");
    expect(core.calls.map((c) => c.method)).toEqual(["terminal.get"]);
  });

  it("never reads an unreachable core, a silent core or an unknown refusal as gone", async () => {
    for (const failure of [down(), new Error("no reply in 10000 ms"), new HcDestroyRefusedError("machine_unknown", "machine_unknown")]) {
      const core = fakeCore({ "terminal.get": failure });
      await expect(killHcSeat("qa@rig", core.call)).resolves.toBe("unconfirmed");
      expect(core.calls.map((c) => c.method)).toEqual(["terminal.get"]);
    }
  });

  it("refuses a terminal that carries another seat's label, or none", async () => {
    for (const found of [live("someone-else@rig"), { address: "t9", state: "live", labels: {} }, { address: "t9", state: "live" }]) {
      const core = fakeCore({ "terminal.get": found, "terminal.kill": finished("x@y") });
      await expect(killHcSeat("qa@rig", core.call)).resolves.toBe("refused");
      expect(core.calls.map((c) => c.method)).toEqual(["terminal.get"]);
    }
  });

  it("treats a finished terminal as gone, but a spawn still pending as unknown", async () => {
    const done = fakeCore({ "terminal.get": finished("qa@rig", "t3", "exited") });
    await expect(killHcSeat("qa@rig", done.call)).resolves.toBe("missing");
    expect(done.calls.map((c) => c.method)).toEqual(["terminal.get"]);
    const pending = fakeCore({ "terminal.get": finished("qa@rig", "t3", "spawn_pending") });
    await expect(killHcSeat("qa@rig", pending.call)).resolves.toBe("unconfirmed");
  });

  it("reports a kill the core did not observe finishing, or did not answer, as unconfirmed", async () => {
    await expect(killHcSeat("qa@rig", fakeCore({ "terminal.get": live("qa@rig"), "terminal.kill": live("qa@rig") }).call)).resolves.toBe("unconfirmed");
    await expect(killHcSeat("qa@rig", fakeCore({ "terminal.get": live("qa@rig"), "terminal.kill": new Error("no reply") }).call)).resolves.toBe("unconfirmed");
    await expect(killHcSeat("qa@rig", fakeCore({ "terminal.get": live("qa@rig"), "terminal.kill": notFound() }).call)).resolves.toBe("missing");
  });
});

function deps(overrides: Partial<DestroyDeps> = {}) {
  const base: DestroyDeps = {
    stopDaemon: async () => {},
    inspectListener: async () => ({ kind: "unreachable" }),
    findListeningPid: () => null,
    killProcess: () => {},
    exists: () => true,
    renamePath: vi.fn(),
    removePath: vi.fn(),
    mkdirp: vi.fn(),
    listManagedTmuxSessions: () => [],
    killTmuxSession: vi.fn(() => true),
    listManagedHcSeats: () => [],
    killHcSeat: vi.fn(async () => "killed" as const),
    sleep: async () => {},
    now: () => new Date("2026-04-10T08:10:11Z"),
    ...overrides,
  };
  return base;
}

function plan(overrides: Partial<DestroyPlan> = {}): DestroyPlan {
  return {
    scope: "all", backup: false, stateRoot: "/x/.openrig", daemonHost: "127.0.0.1", daemonPort: 7433,
    managedTmuxSessions: [], managedHcSeats: [], seatEnumerationFailures: [], targets: [{ path: "/x/.openrig", kind: "state_root" }], warnings: [],
    ...overrides,
  };
}

describe("executeDestroy with hc seats", () => {
  it("ends every managed hc seat, counts them, then removes the state", async () => {
    const killHcSeat = vi.fn(async (seat: string) => (seat === "gone@r" ? "missing" : "killed") as HcSeatOutcome);
    const d = deps({ killHcSeat });
    const result = await executeDestroy(plan({ managedHcSeats: ["a@r", "gone@r", "b@r"] }), d);
    expect(killHcSeat.mock.calls.map((c) => c[0])).toEqual(["a@r", "gone@r", "b@r"]);
    expect(result).toMatchObject({ hcKilled: 2, hcMissing: 1, hcRefused: [], hcUnconfirmed: [], stateRecreated: true });
    expect(d.removePath).toHaveBeenCalledWith("/x/.openrig");
    expect(d.mkdirp).toHaveBeenCalledWith("/x/.openrig");
  });

  it("leaves the state untouched when a seat's fate is unknown, and still ends the seats it can reach", async () => {
    const killHcSeat = vi.fn(async (seat: string) => (seat === "lost@r" ? "unconfirmed" : "killed") as HcSeatOutcome);
    const d = deps({ killHcSeat });
    const result = await executeDestroy(plan({ managedHcSeats: ["a@r", "lost@r", "b@r"] }), d);
    expect(killHcSeat.mock.calls.map((c) => c[0])).toEqual(["a@r", "lost@r", "b@r"]);
    expect(result).toMatchObject({ hcKilled: 2, hcUnconfirmed: ["lost@r"], stateRecreated: false, portCleared: true });
    expect(d.removePath).not.toHaveBeenCalled();
    expect(d.renamePath).not.toHaveBeenCalled();
    expect(d.mkdirp).not.toHaveBeenCalled();
    expect(result.warnings.join("\n")).toContain("lost@r");
    expect(result.warnings.join("\n")).toContain("State was left untouched");
  });

  it("treats a thrown kill as unknown, not as gone", async () => {
    const d = deps({ killHcSeat: async () => { throw new Error("boom"); } });
    const result = await executeDestroy(plan({ managedHcSeats: ["a@r"] }), d);
    expect(result.hcUnconfirmed).toEqual(["a@r"]);
    expect(d.removePath).not.toHaveBeenCalled();
  });

  it("keeps the state when a seat's terminal carries a different seat label, ends the other seats, and warns", async () => {
    const killHcSeat = vi.fn(async (seat: string) => (seat === "a@r" ? "refused" : "killed") as HcSeatOutcome);
    const d = deps({ killHcSeat });
    const result = await executeDestroy(plan({ managedHcSeats: ["a@r", "b@r"] }), d);
    expect(killHcSeat.mock.calls.map((c) => c[0])).toEqual(["a@r", "b@r"]);
    expect(result).toMatchObject({ hcRefused: ["a@r"], hcKilled: 1, hcUnconfirmed: [], stateRecreated: false });
    expect(d.removePath).not.toHaveBeenCalled();
    expect(d.renamePath).not.toHaveBeenCalled();
    expect(d.mkdirp).not.toHaveBeenCalled();
    expect(result.warnings.join("\n")).toContain("different seat label");
  });

  it("keeps the state for a refused seat even when others were unconfirmed or missing", async () => {
    const outcomes: Record<string, HcSeatOutcome> = { "a@r": "refused", "b@r": "unconfirmed", "c@r": "missing" };
    const d = deps({ killHcSeat: async (seat: string) => outcomes[seat]! });
    const result = await executeDestroy(plan({ managedHcSeats: ["a@r", "b@r", "c@r"] }), d);
    expect(result).toMatchObject({ hcRefused: ["a@r"], hcUnconfirmed: ["b@r"], hcMissing: 1, stateRecreated: false });
    expect(d.removePath).not.toHaveBeenCalled();
  });

  it("does not touch hc for --state", async () => {
    const killHcSeat = vi.fn(async () => "killed" as const);
    const listManagedHcSeats = vi.fn(() => ["a@r"]);
    const d = deps({ killHcSeat, listManagedHcSeats });
    const built = buildDestroyPlan("state", false, { stateRoot: "/x/.openrig", dbPath: "/x/.openrig/db", transcriptsPath: "/x/.openrig/t", daemonHost: "127.0.0.1", daemonPort: 7433 }, d);
    await executeDestroy(built, d);
    expect(listManagedHcSeats).not.toHaveBeenCalled();
    expect(killHcSeat).not.toHaveBeenCalled();
  });

  it("ends no hc seat for a --state plan even if one is handed in", async () => {
    const killHcSeat = vi.fn(async () => "killed" as const);
    const result = await executeDestroy(plan({ scope: "state", managedHcSeats: ["a@r"] }), deps({ killHcSeat }));
    expect(killHcSeat).not.toHaveBeenCalled();
    expect(result).toMatchObject({ hcKilled: 0, hcMissing: 0, hcUnconfirmed: [], stateRecreated: true });
  });

  it("ends no seat while the daemon is still up or not local", async () => {
    const killHcSeat = vi.fn(async () => "killed" as const);
    await executeDestroy(plan({ managedHcSeats: ["a@r"] }), deps({ killHcSeat, inspectListener: async () => ({ kind: "other_http" }) }));
    await executeDestroy(plan({ managedHcSeats: ["a@r"], daemonHost: "10.0.0.5" }), deps({ killHcSeat }));
    expect(killHcSeat).not.toHaveBeenCalled();
  });

  it("records, and does not carry on, when the hc seats cannot be enumerated (Jim, 2026-11-01: see destroy-enumeration-failure.test.ts)", () => {
    const d = deps({ listManagedHcSeats: () => { throw new Error("db locked"); }, listManagedTmuxSessions: () => ["t@r"] });
    const built = buildDestroyPlan("all", false, { stateRoot: "/x/.openrig", dbPath: "/x/.openrig/db", transcriptsPath: "/x/.openrig/t", daemonHost: "127.0.0.1", daemonPort: 7433 }, d);
    expect(built.managedHcSeats).toEqual([]);
    expect(built.managedTmuxSessions).toEqual(["t@r"]);
    expect(built.seatEnumerationFailures).toEqual(["hc seats: db locked"]);
    expect(built.warnings.join("\n")).toContain("db locked");
  });
});

describe("rig destroy --all command with hc seats", () => {
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

  it("exits 1, says which seats are unconfirmed, and removes nothing", async () => {
    const d = deps({ listManagedHcSeats: () => ["a@r", "lost@r"], killHcSeat: async (s) => (s === "lost@r" ? "unconfirmed" : "killed") });
    const { out, exitCode } = await run(d);
    expect(exitCode).toBe(1);
    expect(out).toContain("hc cleanup: enabled (2 managed seats)");
    expect(out).toContain("hc seats ended: 1");
    expect(out).toContain("hc seats NOT confirmed ended: 1");
    expect(out).toContain("fresh state root: not created");
    expect(d.removePath).not.toHaveBeenCalled();
  });

  it("exits cleanly when every seat is ended", async () => {
    const d = deps({ listManagedHcSeats: () => ["a@r"] });
    const { out, exitCode } = await run(d);
    expect(exitCode).toBeUndefined();
    expect(out).toContain("hc seats ended: 1");
    expect(out).not.toContain("NOT confirmed");
  });
});

describe("managed seat enumeration across the binding migration", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "destroy-hc-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  function database(withTerminalAddress: boolean): string {
    const path = join(dir, "db.sqlite");
    const db = new Database(path);
    db.exec(`
      CREATE TABLE nodes (id TEXT PRIMARY KEY);
      CREATE TABLE sessions (id TEXT PRIMARY KEY, node_id TEXT, session_name TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE bindings (id TEXT PRIMARY KEY, node_id TEXT NOT NULL, tmux_session TEXT, tmux_pane TEXT,
        attachment_type TEXT NOT NULL DEFAULT 'tmux'${withTerminalAddress ? ", terminal_address TEXT, pre_hc_tmux_pane TEXT" : ""});
    `);
    const node = db.prepare("INSERT INTO nodes (id) VALUES (?)");
    const bind = db.prepare("INSERT INTO bindings (id, node_id, tmux_session, attachment_type) VALUES (?, ?, ?, ?)");
    for (const id of ["n-hc", "n-tmux", "n-ext", "n-bare", "n-hc2"]) node.run(id);
    bind.run("b1", "n-hc", "hc-seat@demo", "hc");
    bind.run("b2", "n-tmux", "tmux-seat@demo", "tmux");
    bind.run("b3", "n-ext", "ext-seat@demo", "external_cli");
    bind.run("b4", "n-hc2", "hc-seat@demo", "hc");  // a second binding of the same seat name: listed once
    db.prepare("INSERT INTO sessions (id, node_id, session_name) VALUES ('s1', 'n-bare', 'bare-seat@demo')").run();
    db.close();
    return path;
  }

  it("lists hc-bound seats for hc and tmux-bound seats for tmux, never external_cli, each name once", () => {
    const path = database(true);
    expect(listManagedHcSeatsFromDb(path)).toEqual(["bare-seat@demo", "hc-seat@demo"]);
    expect(listManagedTmuxSessionsFromDb(path)).toEqual(["bare-seat@demo", "tmux-seat@demo"]);
  });

  it("reads a database that predates migration 121 (no terminal_address column)", () => {
    const path = database(false);
    expect(listManagedHcSeatsFromDb(path)).toEqual(["bare-seat@demo", "hc-seat@demo"]);
  });
});

describe("hcCallOverSocket", () => {
  let dir: string;
  let server: Server | undefined;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "destroy-sock-")); });
  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  function serve(handler: (line: { id: number; method: string; params: unknown }, write: (value: unknown) => void) => void): string {
    const path = join(dir, "c.sock");
    server = createServer((socket) => {
      socket.setEncoding("utf8");
      let buffer = "";
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
          const line = JSON.parse(buffer.slice(0, end)) as { id: number; method: string; params: unknown };
          buffer = buffer.slice(end + 1);
          handler(line, (value) => socket.write(`${JSON.stringify(value)}\n`));
        }
      });
      socket.on("error", () => {});
    });
    server.listen(path);
    return path;
  }

  const hello = (id: number, generation = 1) => ({ jsonrpc: "2.0", id, result: { generation } });

  it("greets at generation 1, then sends the request and returns its result", async () => {
    const seen: Array<{ method: string; params: unknown }> = [];
    const path = serve((req, write) => {
      seen.push({ method: req.method, params: req.params });
      write(req.method === "hello" ? hello(req.id) : { jsonrpc: "2.0", id: req.id, result: { address: "t1" } });
    });
    await vi.waitFor(() => expect(server?.listening).toBe(true));
    await expect(hcCallOverSocket(path)("terminal.get", { terminal: "x" })).resolves.toEqual({ address: "t1" });
    expect(seen).toEqual([
      { method: "hello", params: { generation: 1, framed: false } },
      { method: "terminal.get", params: { terminal: "x" } },
    ]);
  });

  it("reports a refusal with its kind", async () => {
    const path = serve((req, write) => write(req.method === "hello" ? hello(req.id) : { jsonrpc: "2.0", id: req.id, error: { code: -32000, message: "not_found", data: { kind: "not_found" } } }));
    await vi.waitFor(() => expect(server?.listening).toBe(true));
    await expect(hcCallOverSocket(path)("terminal.get", {})).rejects.toMatchObject({ kind: "not_found" });
    await expect(hcCallOverSocket(path)("terminal.get", {})).rejects.toBeInstanceOf(HcDestroyRefusedError);
  });

  it("is unavailable when there is no socket, a foreign generation, or no reply", async () => {
    await expect(hcCallOverSocket(join(dir, "none.sock"))("terminal.get", {})).rejects.toBeInstanceOf(HcDestroyUnavailableError);
    const wrong = serve((req, write) => write(hello(req.id, 2)));
    await vi.waitFor(() => expect(server?.listening).toBe(true));
    await expect(hcCallOverSocket(wrong)("terminal.kill", { terminal: "t1" })).rejects.toBeInstanceOf(HcDestroyUnavailableError);
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    const silent = serve(() => {});
    await vi.waitFor(() => expect(server?.listening).toBe(true));
    await expect(hcCallOverSocket(silent, 150)("terminal.get", {})).rejects.toBeInstanceOf(HcDestroyUnavailableError);
  });

  it("does not send the request when the greeting is refused", async () => {
    const seen: string[] = [];
    const path = serve((req, write) => {
      seen.push(req.method);
      write({ jsonrpc: "2.0", id: req.id, error: { code: -32000, message: "unsupported_generation", data: { kind: "unsupported_generation" } } });
    });
    await vi.waitFor(() => expect(server?.listening).toBe(true));
    await expect(hcCallOverSocket(path)("terminal.kill", { terminal: "t1" })).rejects.toBeInstanceOf(HcDestroyUnavailableError);
    expect(seen).toEqual(["hello"]);
  });
});
