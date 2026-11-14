// Readers of a running Claude conversation's own files key on the home its session was LAUNCHED with (sessions.claude_config_dir),
// not the seat's current choice: `rig seat set-claude-home` restarts nothing. And the daemon wires those readers in (startup.ts).
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { seatClaudeHomeReaders } from "../src/adapters/seat-claude-home-readers.js";

const DAEMON = "/h/.claude";

function fixture() {
  const db = createFullTestDb();
  const rigRepo = new RigRepository(db);
  const registry = new SessionRegistry(db);
  const rig = rigRepo.createRig("r");
  return { db, rigRepo, registry, rig, readers: seatClaudeHomeReaders(db, DAEMON) };
}

describe("a session records the Claude home it was launched with", () => {
  it("a launch records the seat's home then; a later set-claude-home changes the seat, not the running session", () => {
    const f = fixture();
    const node = f.rigRepo.addNode(f.rig.id, "dev.cel", { runtime: "claude-code", cwd: "/w", claudeConfigDir: "/h/cel" });
    const first = f.registry.registerSession(node.id, "dev-cel@r");
    expect(f.readers.launchedHomeOfSession(first.id)).toBe("/h/cel");
    f.rigRepo.setNodeClaudeConfigDir(node.id, null);
    expect(f.readers.homeOfSession(first.id), "the running process is still on the home it started on").toBe("/h/cel");
    expect(f.readers.homeOfRunningNode(node.id)).toBe("/h/cel");
    const next = f.registry.registerSession(node.id, "dev-cel@r");
    expect(f.readers.launchedHomeOfSession(next.id), "the next launch is on the daemon's own").toBeNull();
    expect(f.readers.homeOfRunningNode(node.id)).toBe(DAEMON);
    f.db.close();
  });

  it("a handover successor OpenRig launched records the home; a session the person started and OpenRig claimed records none", () => {
    const f = fixture();
    const node = f.rigRepo.addNode(f.rig.id, "dev.cel", { runtime: "claude-code", cwd: "/w", claudeConfigDir: "/h/cel" });
    expect(f.readers.launchedHomeOfSession(f.registry.registerClaimedSession(node.id, "dev-cel@r", "handover", null, "launched").id)).toBe("/h/cel");
    expect(f.readers.launchedHomeOfSession(f.registry.registerClaimedSession(node.id, "dev-cel@r", "adopt", null, "claimed").id)).toBeNull();
    f.db.close();
  });

  it("names the daemon's home for a seat with no session, and every launched or chosen home's projects/ once", () => {
    const f = fixture();
    const a = f.rigRepo.addNode(f.rig.id, "dev.a", { runtime: "claude-code", cwd: "/w", claudeConfigDir: "/h/a" });
    f.registry.registerSession(a.id, "dev-a@r");
    f.rigRepo.setNodeClaudeConfigDir(a.id, "/h/b");
    f.rigRepo.addNode(f.rig.id, "dev.c", { runtime: "claude-code", cwd: "/w", claudeConfigDir: "/h/a" });
    expect(f.readers.homeOfRunningNode(f.rigRepo.addNode(f.rig.id, "dev.n", { runtime: "claude-code", cwd: "/w" }).id)).toBe(DAEMON);
    expect(f.readers.homeOfRunningNode(undefined)).toBe(DAEMON);
    expect(f.readers.seatProjectsRoots()).toEqual([path.join("/h/a", "projects"), path.join("/h/b", "projects")]);
    f.db.close();
  });
});

// The daemon's own wiring, read from its source (as provider-c4-reactive-tap.test.ts does): each reader of a seat's Claude files
// goes through the launched-home readers, and the per-home login read selects that home.
describe("startup wires each reader of a seat's Claude files to the seat's launched home", () => {
  const startup = readFileSync(path.join(import.meta.dirname, "../src/startup.ts"), "utf8");
  it.each([
    ["the readers, over the daemon's own selection", "seatClaudeHomeReaders(db, process.env.CLAUDE_CONFIG_DIR ?? nodePath.join(os.homedir(), \".claude\"))"],
    ["the self-report rung's sessions/ dir", "nodePath.join(seatClaudeHomes.homeOfRunningNode(seatNodeId), \"sessions\")"],
    ["the continuity transcript lookup", "const claudeRoot = seatClaudeHomes.homeOfSession(sessionId);"],
    ["the shutdown capture and resume probe", "seatClaudeConfigDir: (session) => seatClaudeHomes.launchedHomeOfSession(session.sessionId)"],
    ["rig ask's session search", "seatClaudeProjectsRoots: () => seatClaudeHomes.seatProjectsRoots()"],
    ["the per-home login read", "readClaudeHomeIdentity: (home: string) => claudeAuthStatusReader({ launchPath: process.env.PATH, home: daemonHome, claudeConfigDir: home })()"],
  ])("%s", (_label, wiring) => {
    expect(startup).toContain(wiring);
  });
});
