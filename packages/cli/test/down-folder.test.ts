// OF-173: `rig down` with no <rig> acts on the one project rig whose folder holds the current folder, and refuses (exit 2,
// nothing torn down, the candidates listed) when none or several do. A project rig's folder is known from its seats: every
// seat in <P>/.workspaces/<seat> and the rig named after <P> (see src/rig-folder.ts). A fake daemon serves the rig list, the
// seats and /api/down; the folders are real temp folders, so real-path comparison runs as it does for a user.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { downCommand } from "../src/commands/down.js";
import { DaemonClient } from "../src/client.js";
import { STATE_FILE, type LifecycleDeps } from "../src/daemon-lifecycle.js";
import type { StatusDeps } from "../src/commands/status.js";
import { projectRigSlug as cliSlug } from "../src/rig-folder.js";
import { projectRigSlug as daemonSlug } from "../../daemon/src/domain/project-rig.js";

interface FakeRig { id: string; name: string; archivedAt?: string | null; seats: Array<string | null> | "unreadable" | "dropped" }

let root: string;
let server: http.Server;
let port: number;
let rigs: FakeRig[];
let downBodies: Array<Record<string, unknown>>;

beforeAll(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "of173-")));
  server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const url = (req.url ?? "").split("?")[0]!;
    const reply = (status: number, data: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); };
    if (url === "/api/rigs/summary") return reply(200, rigs.map(({ id, name, archivedAt }) => ({ id, name, archivedAt: archivedAt ?? null })));
    const nodes = /^\/api\/rigs\/([^/]+)\/nodes$/.exec(url);
    if (nodes) {
      const rig = rigs.find((r) => r.id === decodeURIComponent(nodes[1]!));
      if (!rig || rig.seats === "unreadable") return reply(500, { error: "unreadable" });
      if (rig.seats === "dropped") { req.socket.destroy(); return; } // the connection drops: the client's read throws
      return reply(200, rig.seats.map((cwd, i) => ({ logicalId: `seat${i}`, nodeKind: "agent", sessionStatus: "running", cwd })));
    }
    if (url === "/api/down" && req.method === "POST") {
      const parsed: Record<string, unknown> = JSON.parse(body);
      downBodies.push(parsed);
      return reply(200, { rigId: "x", sessionsKilled: 1, snapshotId: null, deleted: false, deleteBlocked: false, alreadyStopped: false, errors: [] });
    }
    reply(404, { error: "not found" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the fake daemon has no TCP address");
  port = address.port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => { rigs = []; downBodies = []; });

/** A project folder under the test root with the given seats in its .workspaces (created on disk). */
function project(rel: string, seats = ["build-impl", "exec-cos"]): { folder: string; seats: string[] } {
  const folder = path.join(root, rel);
  const seatFolders = seats.map((s) => path.join(folder, ".workspaces", s));
  for (const s of seatFolders) fs.mkdirSync(s, { recursive: true });
  return { folder, seats: seatFolders };
}

function deps(): StatusDeps {
  const lifecycleDeps: LifecycleDeps = {
    spawn: () => { throw new Error("rig down never starts a daemon"); },
    fetch: async () => ({ ok: true }),
    kill: () => true,
    readFile: (p) => (p === STATE_FILE ? JSON.stringify({ pid: 1, port, db: "t.sqlite", startedAt: "2026-10-29T00:00:00Z" }) : null),
    writeFile: () => {}, removeFile: () => {}, exists: (p) => p === STATE_FILE, mkdirp: () => {},
    openForAppend: () => 3, isProcessAlive: () => true,
  };
  return { lifecycleDeps, clientFactory: (baseUrl) => new DaemonClient(baseUrl) };
}

async function down(folder: string, args: string[] = []): Promise<{ out: string; exitCode: number | undefined }> {
  const lines: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { lines.push(a.join(" ")); });
  const err = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { lines.push(a.join(" ")); });
  const saved = process.exitCode;
  process.exitCode = undefined;
  try {
    const program = new Command();
    program.exitOverride();
    program.addCommand(downCommand(deps(), () => folder));
    await program.parseAsync(["node", "rig", "down", ...args]);
    return { out: lines.join("\n"), exitCode: process.exitCode };
  } finally {
    process.exitCode = saved;
    log.mockRestore();
    err.mockRestore();
  }
}

describe("rig down with no <rig>: the rig of the current folder", () => {
  it("one rig's project folder holds the folder: says which rig and stops it", async () => {
    const ez = project("Code/eztrack"), other = project("Code/ezhome");
    rigs = [{ id: "rig-ez", name: "eztrack", seats: ez.seats }, { id: "rig-home", name: "ezhome", seats: other.seats }];
    const r = await down(ez.folder);
    expect(downBodies.map((b) => b["rigId"])).toEqual(["rig-ez"]);
    expect(r.out).toContain(`the project folder of rig eztrack (rig-ez)`);
    expect(r.exitCode).toBeUndefined();
  });

  it("a subfolder of the project counts as the project", async () => {
    const ez = project("Code/eztrack");
    const deep = path.join(ez.folder, "src", "deep");
    fs.mkdirSync(deep, { recursive: true });
    rigs = [{ id: "rig-ez", name: "eztrack", seats: ez.seats }];
    await down(deep);
    expect(downBodies.map((b) => b["rigId"])).toEqual(["rig-ez"]);
  });

  it("no rig's folder holds the folder: refuses with exit 2, tears nothing down and lists the rigs it knows", async () => {
    const ez = project("Code/eztrack");
    const elsewhere = path.join(root, "Code", "unrelated");
    fs.mkdirSync(elsewhere, { recursive: true });
    rigs = [{ id: "rig-ez", name: "eztrack", seats: ez.seats }];
    const r = await down(elsewhere);
    expect(r.exitCode).toBe(2);
    expect(downBodies).toEqual([]);
    expect(r.out).toMatch(/No rig's project folder holds/);
    expect(r.out).toContain(`eztrack (rig-ez) in ${ez.folder}`);
  });

  it("a sibling folder whose name only starts the same is not inside the project", async () => {
    const ez = project("Code/eztrack");
    const sibling = path.join(root, "Code", "eztrack2");
    fs.mkdirSync(sibling, { recursive: true });
    rigs = [{ id: "rig-ez", name: "eztrack", seats: ez.seats }];
    const r = await down(sibling);
    expect(r.exitCode).toBe(2);
    expect(downBodies).toEqual([]);
  });

  it("several rigs' folders hold the folder (nested projects): refuses with exit 2 and lists both, never guesses", async () => {
    const outer = project("Code/mono"), inner = project("Code/mono/apps/web");
    rigs = [{ id: "rig-mono", name: "mono", seats: outer.seats }, { id: "rig-web", name: "web", seats: inner.seats }];
    const r = await down(inner.folder);
    expect(r.exitCode).toBe(2);
    expect(downBodies).toEqual([]);
    expect(r.out).toContain("mono (rig-mono)");
    expect(r.out).toContain("web (rig-web)");
  });

  it("an archived rig is ignored: the folder's one non-archived rig is stopped", async () => {
    const ez = project("Code/eztrack");
    rigs = [
      { id: "rig-old", name: "eztrack", archivedAt: "2026-10-01T00:00:00Z", seats: ez.seats },
      { id: "rig-ez", name: "eztrack", seats: ez.seats },
    ];
    await down(ez.folder);
    expect(downBodies.map((b) => b["rigId"])).toEqual(["rig-ez"]);
  });

  it("two rigs share a name (two projects both called eztrack): the folder's own rig is stopped, by its id", async () => {
    const mine = project("Code/eztrack"), theirs = project("Work/eztrack");
    rigs = [{ id: "rig-mine", name: "eztrack", seats: mine.seats }, { id: "rig-theirs", name: "eztrack", seats: theirs.seats }];
    await down(mine.folder);
    expect(downBodies.map((body) => body["rigId"])).toEqual(["rig-mine"]);
  });

  it("a kernel-shaped rig (seats in <home>/.workspaces, not named after <home>) never owns a folder", async () => {
    const home = project("home", ["advisor-lead", "operator-agent"]);
    const inHome = path.join(home.folder, "Documents");
    fs.mkdirSync(inHome, { recursive: true });
    rigs = [{ id: "rig-kernel", name: "kernel", seats: home.seats }];
    const r = await down(inHome);
    expect(r.exitCode).toBe(2);
    expect(downBodies).toEqual([]);
  });

  it("a rig whose seats are not in <project>/.workspaces has no known folder", async () => {
    const folder = path.join(root, "Code", "plain");
    const seats = ["a", "b"].map((s) => path.join(folder, "seats", s));
    for (const s of seats) fs.mkdirSync(s, { recursive: true });
    rigs = [{ id: "rig-plain", name: "plain", seats }];
    const r = await down(folder);
    expect(r.exitCode).toBe(2);
    expect(downBodies).toEqual([]);
  });

  it("a rig whose seats cannot be read makes the answer unknown: refuses rather than guess", async () => {
    const ez = project("Code/eztrack");
    rigs = [{ id: "rig-ez", name: "eztrack", seats: ez.seats }, { id: "rig-x", name: "x", seats: "unreadable" }];
    const r = await down(ez.folder);
    expect(r.exitCode).toBe(2);
    expect(downBodies).toEqual([]);
    expect(r.out).toMatch(/could not be read/);
  });

  it("a seats read that throws (the connection drops) makes the answer unknown: refuses rather than guess", async () => {
    const ez = project("Code/eztrack");
    rigs = [{ id: "rig-ez", name: "eztrack", seats: ez.seats }, { id: "rig-x", name: "x", seats: "dropped" }];
    const r = await down(ez.folder);
    expect(r.exitCode).toBe(2);
    expect(downBodies).toEqual([]);
    expect(r.out).toMatch(/could not be read/);
  });

  it("a rig whose seats sit in two different projects (both named eztrack) has no known folder", async () => {
    const one = project("Code/eztrack", ["build-impl"]), two = project("Work/eztrack", ["exec-cos"]);
    rigs = [{ id: "rig-split", name: "eztrack", seats: [...one.seats, ...two.seats] }];
    for (const folder of [one.folder, two.folder]) expect((await down(folder)).exitCode, folder).toBe(2);
    expect(downBodies).toEqual([]);
  });

  it("a rig with a seat that records no folder has no known folder", async () => {
    const ez = project("Code/eztrack");
    rigs = [{ id: "rig-ez", name: "eztrack", seats: [...ez.seats, null] }];
    const r = await down(ez.folder);
    expect(r.exitCode).toBe(2);
    expect(downBodies).toEqual([]);
  });

  // The daemon names a project rig from the --cwd it was given (path.resolve, symlinks kept) and records the seats under
  // that path. A project launched through a link named differently from the real folder is still that rig's folder.
  it("a project launched through a symlink named differently is found from the link and from the real folder", async () => {
    const real = project("real/Eztrack-Checkout");
    const link = path.join(root, "links", "eztrack");
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(real.folder, link);
    const recorded = ["build-impl", "exec-cos"].map((s) => path.join(link, ".workspaces", s));
    rigs = [{ id: "rig-ez", name: "eztrack", seats: recorded }];
    fs.mkdirSync(path.join(real.folder, "src"));
    await down(path.join(link, "src"));
    await down(real.folder);
    expect(downBodies.map((b) => b["rigId"])).toEqual(["rig-ez", "rig-ez"]);
  });

  it("a seat whose folder was deleted does not hide the rig's folder (project launched through a symlink)", async () => {
    const real = project("real/tracker", ["build-impl", "exec-cos"]);
    const link = path.join(root, "links2", "tracker");
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(real.folder, link);
    fs.rmSync(path.join(real.folder, ".workspaces", "exec-cos"), { recursive: true });
    const recorded = ["build-impl", "exec-cos"].map((s) => path.join(link, ".workspaces", s));
    rigs = [{ id: "rig-tr", name: "tracker", seats: recorded }];
    await down(real.folder);
    expect(downBodies.map((b) => b["rigId"])).toEqual(["rig-tr"]);
  });

  it("with --host and no <rig> it refuses: the current folder is on this machine, the rigs on another", async () => {
    const r = await down(root, ["--host", "elsewhere"]);
    expect(r.exitCode).toBe(2);
    expect(downBodies).toEqual([]);
    expect(r.out).toMatch(/needs the rig named/);
  });

  it("rig down <rig> is unchanged: the named rig is stopped wherever the command runs", async () => {
    const ez = project("Code/eztrack"), other = project("Code/ezhome");
    rigs = [{ id: "rig-ez", name: "eztrack", seats: ez.seats }, { id: "rig-home", name: "ezhome", seats: other.seats }];
    await down(ez.folder, ["ezhome"]);
    expect(downBodies.map((b) => b["rigId"])).toEqual(["rig-home"]);
  });

  it("the CLI names a project's rig with the daemon's own rule", () => {
    for (const folder of ["/x/eztrack", "/x/My Project", "/x/--odd__name--", "/x/RFP-RULZ", "/x/a.b.c", "/x/two--hyphens"]) {
      expect(cliSlug(folder), folder).toBe(daemonSlug(folder));
    }
  });
});
