// OF-288: the commands the CLI prints for an operator outside the rig up / bundle-install refusals are set off and their names
// quoted, as the daemon's refusals are since OF-287 (packages/daemon/test/refusal-command-delimiting.test.ts). Each printed command
// goes through real `sh` (the daemon's test helper) so a paste of it is proved to give exactly the intended words and nothing else.
import { describe, it, expect, vi } from "vitest";
import { Command } from "commander";
import { setOff, shellPath, shellWord } from "../src/command-text.js";
import { shellWord as daemonShellWord } from "../../daemon/src/domain/active-occupant.js";
import { setOff as daemonSetOff } from "../../daemon/src/domain/running-name-guard.js";
import { archiveCommand } from "../src/commands/archive.js";
import { downCommand } from "../src/commands/down.js";
import { upCommand } from "../src/commands/up.js";
import { snapshotCommand } from "../src/commands/snapshot.js";
import { restoreCommand } from "../src/commands/restore.js";
import { specSourceCommand } from "../src/commands/spec-source.js";
import { walkSizedWarning } from "../src/context-resolve.js";
import type { DaemonClient } from "../src/client.js";
import { STATE_FILE, type LifecycleDeps } from "../src/daemon-lifecycle.js";
import type { StatusDeps } from "../src/commands/status.js";
import { shellArgv, setOffCommands, rigWords, closesCleanly } from "../../daemon/test/helpers/shell-argv.js";

const HOSTILE = ["my rig", "a;b", "$(id)", "it's", "=x", "a b;rm -rf x", "a`b", "a`b'c", "x``y'z"];
const NAMES = ["workshop", ...HOSTILE];

type Reply = { status: number; data: unknown };
type Route = (method: "GET" | "POST", path: string, body?: unknown) => Reply | undefined;

/** A daemon client answering from `route`; anything it does not answer is a 404. */
function deps(route: Route): StatusDeps {
  const lifecycleDeps: LifecycleDeps = {
    spawn: () => { throw new Error("no daemon is started here"); },
    fetch: async () => ({ ok: true }),
    kill: () => true,
    readFile: (p) => (p === STATE_FILE ? JSON.stringify({ pid: 1, port: 1, db: "t.sqlite", startedAt: "2026-11-13T00:00:00Z" }) : null),
    writeFile: () => {}, removeFile: () => {}, exists: (p) => p === STATE_FILE, mkdirp: () => {},
    openForAppend: () => 3, isProcessAlive: () => true,
  };
  const answer = (method: "GET" | "POST", path: string, body?: unknown) => route(method, path, body) ?? { status: 404, data: { error: "not found" } };
  const client = {
    get: async (path: string) => answer("GET", path),
    post: async (path: string, body?: unknown) => answer("POST", path, body),
  } as unknown as DaemonClient;
  return { lifecycleDeps, clientFactory: () => client };
}

/** Runs one command and returns everything it printed, stdout and stderr, as lines. */
async function run(command: Command, argv: string[]): Promise<string[]> {
  const lines: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { lines.push(a.join(" ")); });
  const err = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { lines.push(a.join(" ")); });
  const write = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => { lines.push(...String(chunk).split("\n")); return true; });
  const saved = process.exitCode;
  try {
    const program = new Command();
    program.exitOverride();
    program.addCommand(command);
    await program.parseAsync(["node", "rig", ...argv]);
    return lines;
  } finally {
    process.exitCode = saved;
    log.mockRestore(); err.mockRestore(); write.mockRestore();
  }
}

/** The one line holding `marker`, read from the marker on (a name in the prose before it may hold a quote), its set-off commands as
 *  rig words, and a check that each closes cleanly. */
function commandsOn(lines: string[], marker: string): string[][] {
  // A placeholder such as <rig> is not shell text (sh reads < as a redirect), so it is swapped for a word before sh reads the command.
  const found = lines.find((l) => l.includes(marker));
  if (!found) throw new Error(`no line with "${marker}" in:\n${lines.join("\n")}`);
  const line = found.slice(found.indexOf(marker));
  const commands = setOffCommands(line);
  for (const command of commands) expect(closesCleanly(line, command), `${command} closes cleanly in: ${line}`).toBe(true);
  return commands.map((c) => rigWords(c.replace(/<([A-Za-z.-]+)>/g, "PLACEHOLDER_$1")).map((w) => w.replace(/^PLACEHOLDER_(.+)$/, "<$1>")));
}

describe("command-text: the CLI's copies give the daemon's words", () => {
  it.each(NAMES)("%j: shellWord and setOff paste as the daemon's do", (name) => {
    expect(shellArgv(shellWord(name))).toEqual([name]);
    expect(shellArgv(shellWord(name))).toEqual(shellArgv(daemonShellWord(name)));
    const cli = setOff(`rig up ${shellWord(name)} --existing`), daemon = daemonSetOff(`rig up ${daemonShellWord(name)} --existing`);
    expect(setOffCommands(cli).map(rigWords)).toEqual([["up", name, "--existing"]]);
    expect(setOffCommands(cli).map(rigWords)).toEqual(setOffCommands(daemon).map(rigWords));
  });

  it("names and paths that need no quotes print bare, as the daemon prints them", () => {
    expect(shellWord("workshop")).toBe("workshop");
    expect(shellWord("01JX0ABC")).toBe("01JX0ABC");
    expect(shellPath("/home/me/specs/rig.yaml")).toBe("/home/me/specs/rig.yaml");
    expect(setOff("rig ps")).toBe("'rig ps'");
  });

  it.each(["/my specs/rig.yaml", "/a;b/rig.yaml", "=x", "/it's/rig.yaml", "/a`b'c/rig.yaml"])("shellPath(%j) is the path, one word", (p) => {
    expect(shellArgv(shellPath(p))).toEqual([p]);
  });
});

describe("rig down: refusals and the restore hint (OF-288)", () => {
  it.each(NAMES)("--host %j with no <rig>: both commands paste as their words", async (host) => {
    const lines = await run(downCommand(deps(() => undefined), () => "/nowhere"), ["down", "--host", host]);
    expect(commandsOn(lines, "Error: ")).toEqual([["down", "--host", host]]);
    expect(commandsOn(lines, "Re-run with")).toEqual([["down", "<rig>", "--host", host]]);
  });

  it("the rig list cannot be read: the down and ps commands are set off", async () => {
    const lines = await run(downCommand(deps(() => ({ status: 500, data: {} })), () => "/nowhere"), ["down"]);
    expect(commandsOn(lines, "Name the rig")).toEqual([["down", "<rig>"], ["ps"]]);
  });

  it("no rig's project folder holds the folder: 'rig down' is set off both times", async () => {
    const lines = await run(downCommand(deps((m, p) => (p.startsWith("/api/rigs/summary") ? { status: 200, data: [] } : undefined)), () => "/nowhere"), ["down"]);
    expect(commandsOn(lines, "Run 'rig down' from inside")).toEqual([["down"], ["down", "<rig>"]]);
  });

  it("an ambiguous name: each per-id command is set off", async () => {
    const rigs = [{ id: "r-1", name: "dup" }, { id: "r-2", name: "dup" }];
    const lines = await run(downCommand(deps((m, p) => (p.startsWith("/api/rigs/summary") ? { status: 200, data: rigs } : undefined))), ["down", "dup"]);
    expect(commandsOn(lines, "Re-run with the specific id")).toEqual([["down", "r-1"], ["down", "r-2"]]);
  });

  it("an unknown rig and a failed teardown: 'rig ps' is set off", async () => {
    const none = await run(downCommand(deps((m, p) => (p.startsWith("/api/rigs/summary") ? { status: 200, data: [] } : undefined))), ["down", "ghost"]);
    expect(commandsOn(none, "List rigs with")).toEqual([["ps"]]);
    const failed = await run(downCommand(deps((m, p) => {
      if (p.startsWith("/api/rigs/summary")) return { status: 200, data: [{ id: "r-1", name: "w" }] };
      if (m === "POST" && p === "/api/down") return { status: 500, data: { error: "boom" } };
      return undefined;
    })), ["down", "w"]);
    expect(commandsOn(failed, "Down failed")).toEqual([["ps"]]);
  });

  it.each(NAMES)("a clean stop of a rig named %j: the restore command pastes as rig up <name>", async (name) => {
    const lines = await run(downCommand(deps((m, p) => {
      if (p.startsWith("/api/rigs/summary")) return { status: 200, data: [{ id: "r-1", name }] };
      if (m === "POST" && p === "/api/down") return { status: 200, data: { rigId: "r-1", sessionsKilled: 1, snapshotId: "snap-1", deleted: false, deleteBlocked: false, alreadyStopped: false, errors: [], rigName: name, isUniqueName: true } };
      return undefined;
    })), ["down", "r-1"]);
    expect(commandsOn(lines, "To restore")).toEqual([["up", name]]);
  });

  it("a clean stop of a rig whose name is shared: the restore command names the snapshot and the id", async () => {
    const lines = await run(downCommand(deps((m, p) => {
      if (p.startsWith("/api/rigs/summary")) return { status: 200, data: [{ id: "r-1", name: "w" }] };
      if (m === "POST" && p === "/api/down") return { status: 200, data: { rigId: "r-1", sessionsKilled: 1, snapshotId: "snap-1", deleted: false, deleteBlocked: false, alreadyStopped: false, errors: [], rigName: "w", isUniqueName: false } };
      return undefined;
    })), ["down", "r-1"]);
    expect(commandsOn(lines, "To restore")).toEqual([["restore", "snap-1", "--rig", "r-1"]]);
  });
});

describe("rig archive: the not-found and success hints (OF-288)", () => {
  it("not found: 'rig ps' is set off", async () => {
    const lines = await run(archiveCommand(deps(() => undefined)), ["archive", "ghost"]);
    expect(commandsOn(lines, "Rig not found")).toEqual([["ps"]]);
  });

  it("archived: both follow-up commands are set off", async () => {
    const lines = await run(archiveCommand(deps((m) => (m === "POST" ? { status: 200, data: { ok: true, rigId: "r-1", archived: true } } : undefined))), ["archive", "r-1"]);
    expect(commandsOn(lines, "See it with")).toEqual([["ps", "--include-archived"]]);
    expect(commandsOn(lines, "Bring it back")).toEqual([["unarchive", "r-1"]]);
  });
});

describe("rig up <name>: the archived-name refusal and the library-spec ambiguity (OF-288)", () => {
  const archivedRoute = (name: string, ids: string[]): Route => (m, p) => {
    if (p === "/api/rigs/summary") return { status: 200, data: [] };
    if (p === "/api/rigs/summary?archived=only") return { status: 200, data: ids.map((id) => ({ id, name })) };
    return undefined;
  };
  // A name `rig up` reads as a rig name: no "/" and no spec extension.
  const UP_NAMES = NAMES.filter((n) => !n.includes("/"));

  it.each(UP_NAMES)("one archived rig named %j: unarchive by id, then rig up <name>", async (name) => {
    const lines = await run(upCommand(deps(archivedRoute(name, ["r-arc"]))), ["up", name]);
    expect(commandsOn(lines, "Bring it back first")).toEqual([["unarchive", "r-arc"]]);
    expect(commandsOn(lines, "Then power it on")).toEqual([["up", name]]);
  });

  it("several archived rigs: the --json action sets its placeholder command off", async () => {
    const lines = await run(upCommand(deps(archivedRoute("w", ["r-1", "r-2"]))), ["up", "w", "--json"]);
    const action = JSON.parse(lines.join("")).action as string;
    expect(setOffCommands(action)).toEqual(["rig unarchive <rigId>"]);
    expect(closesCleanly(action, setOffCommands(action)[0]!)).toBe(true);
  });

  it.each(UP_NAMES)("a name %j that is both a stopped rig and a library spec: both ways forward are set off", async (name) => {
    const specPath = `/lib/${name}/rig.yaml`;
    const lines = await run(upCommand(deps((m, p) => {
      if (p === "/api/rigs/summary") return { status: 200, data: [{ id: "r-1", name }] };
      if (p === "/api/rigs/summary?archived=only") return { status: 200, data: [] };
      if (p.startsWith("/api/specs/library")) return { status: 200, data: [{ id: "spec-1", kind: "rig", name, version: "1", sourceType: "user", sourcePath: specPath, relativePath: "rig.yaml", updatedAt: "" }] };
      return undefined;
    })), ["up", name]);
    expect(commandsOn(lines, "To launch the library spec")).toEqual([["up", specPath]]);
    expect(commandsOn(lines, "To recover the existing rig")).toEqual([["up", name, "--existing"]]);
  });

  it("a name shared by two stopped rigs and a library spec: the by-id command is set off before its list", async () => {
    const lines = await run(upCommand(deps((m, p) => {
      if (p === "/api/rigs/summary") return { status: 200, data: [{ id: "r-1", name: "w" }, { id: "r-2", name: "w" }] };
      if (p === "/api/rigs/summary?archived=only") return { status: 200, data: [] };
      if (p.startsWith("/api/specs/library")) return { status: 200, data: [{ id: "spec-1", kind: "rig", name: "w", version: "1", sourceType: "user", sourcePath: "/lib/w.yaml", relativePath: "w.yaml", updatedAt: "" }] };
      return undefined;
    })), ["up", "w"]);
    expect(commandsOn(lines, "To recover the existing rig")).toEqual([["up", "<rig-id>", "--existing"]]);
  });
});

describe("rig snapshot and rig restore: follow-up commands (OF-288)", () => {
  it("a snapshot taken: the down and restore commands are set off", async () => {
    const lines = await run(snapshotCommand(deps((m) => (m === "POST" ? { status: 201, data: { id: "snap-1" } } : undefined))), ["snapshot", "r-1"]);
    expect(commandsOn(lines, "stop the rig first")).toEqual([["down", "r-1"]]);
    expect(commandsOn(lines, "To restore")).toEqual([["restore", "snap-1", "--rig", "r-1"]]);
  });

  it("a damaged snapshot listed: the fresh-snapshot command is set off", async () => {
    const lines = await run(snapshotCommand(deps(() => ({ status: 200, data: [{ id: "s", kind: "manual", status: "complete", createdAt: "t", unreadable: "bad" }] }))), ["snapshot", "list", "r-1"]);
    expect(commandsOn(lines, "Take a fresh one")).toEqual([["snapshot", "r-1"]]);
  });

  it("restore: not found, a conflict and an accepted attempt each set their command off", async () => {
    const notFound = await run(restoreCommand(deps(() => ({ status: 404, data: {} }))), ["restore", "snap-1", "--rig", "r-1"]);
    expect(commandsOn(notFound, "List snapshots with")).toEqual([["snapshot", "list", "--rig", "r-1"]]);
    const conflict = await run(restoreCommand(deps(() => ({ status: 409, data: { error: "rig is running" } }))), ["restore", "snap-1", "--rig", "r-1"]);
    expect(commandsOn(conflict, "Stop the rig first")).toEqual([["down", "r-1"]]);
    const started = await run(restoreCommand(deps(() => ({ status: 202, data: { attemptId: "att-1", status: "started" } }))), ["restore", "snap-1", "--rig", "r-1"]);
    expect(commandsOn(started, "Read the completed attempt")).toEqual([["restore", "status", "att-1", "--rig", "r-1"]]);
  });
});

describe("rig spec-source show: the not-found and record hints (OF-288)", () => {
  it("an unknown rig: 'rig ps' is set off", async () => {
    const lines = await run(specSourceCommand(deps((m, p) => (p.startsWith("/api/rigs/summary") ? { status: 200, data: [] } : undefined))), ["spec-source", "show", "ghost"]);
    expect(commandsOn(lines, "List rigs with")).toEqual([["ps"]]);
  });

  it.each(NAMES)("a rig named %j with no spec source: the record command pastes with the name as one word", async (name) => {
    const lines = await run(specSourceCommand(deps((m, p) => {
      if (p.startsWith("/api/rigs/summary")) return { status: 200, data: [{ id: "r-1", name: "w" }] };
      if (p === "/api/rigs/r-1/spec-source") return { status: 200, data: { rigName: name, specSource: null } };
      return undefined;
    })), ["spec-source", "show", "r-1"]);
    expect(commandsOn(lines, "Record one with")).toEqual([["spec-source", "set", name, "<path-to-rig.yaml>", "--operator", "<address>"]]);
  });
});

describe("walkSizedWarning: the rig walk command (OF-288)", () => {
  it.each(["packs/big", "ctx it's", "a`b'c"])("a context ref %j: the walk command pastes with the ref as one word", (ref) => {
    const warning = walkSizedWarning({ ref, text: "", bytes: 10 ** 9 }, "dev-impl@my-rig")!;
    // The ref is also named in the prose before the command, where a quote in it is not the command's; read from "Consider" on.
    const text = warning.slice(warning.indexOf("Consider"));
    expect(setOffCommands(text).map(rigWords)).toEqual([["walk", "dev-impl@my-rig", "--through", ref]]);
    expect(closesCleanly(text, setOffCommands(text)[0]!)).toBe(true);
  });

  it("no seat: the placeholder is left as written", () => {
    const text = walkSizedWarning({ ref: "pack", text: "", bytes: 10 ** 9 })!;
    expect(setOffCommands(text)).toEqual(["rig walk <seat> --through pack"]);
  });
});
