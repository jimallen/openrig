// A project rig launched into a project that already has a stopped rig: rig up asks
// resume / fresh (or takes --on-existing), then runs that choice. Headless, it
// explains both commands and changes nothing.

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { upCommand } from "../src/commands/up.js";
import { DaemonClient } from "../src/client.js";
import { STATE_FILE, type LifecycleDeps, type DaemonState } from "../src/daemon-lifecycle.js";

function mockLifecycleDeps(): LifecycleDeps {
  return {
    spawn: vi.fn(() => ({ pid: 1, unref: vi.fn() }) as never),
    fetch: vi.fn(async () => ({ ok: true })),
    kill: vi.fn(() => true),
    readFile: vi.fn(() => null),
    writeFile: vi.fn(),
    removeFile: vi.fn(),
    exists: vi.fn(() => false),
    mkdirp: vi.fn(),
    openForAppend: vi.fn(() => 3),
    isProcessAlive: vi.fn(() => true),
  };
}

async function captureLogs(fn: () => Promise<void>): Promise<{ logs: string[]; exitCode: number | undefined }> {
  const logs: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  const origExitCode = process.exitCode;
  process.exitCode = undefined;
  console.log = (...args: unknown[]) => logs.push(args.join(" "));
  console.error = (...args: unknown[]) => logs.push(args.join(" "));
  try { await fn(); } finally { console.log = origLog; console.error = origErr; }
  const exitCode = process.exitCode;
  process.exitCode = origExitCode;
  return { logs, exitCode };
}

const EXISTS_MESSAGE = 'The project /p/eztrack already has a stopped rig named "eztrack". Resume it with: rig up eztrack --existing. Or start fresh (archives it): add --on-existing fresh.';

describe("rig up — project rig with an existing stopped rig", () => {
  let server: http.Server;
  let port: number;
  let bodies: Array<Record<string, unknown>> = [];
  let tmp: string;
  let spec: string;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c: Buffer) => { raw += c; });
      req.on("end", () => {
        if (req.method === "POST" && req.url === "/api/up") {
          const body = JSON.parse(raw || "{}") as Record<string, unknown>;
          bodies.push(body);
          if (body.cwdOverride === undefined && body.sourceRef !== "eztrack") {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ runId: "r0", status: "failed", code: "project_rig", errors: ["team is a project rig: launch it into a project with --cwd <project folder>."], warnings: [],
              stages: [{ stage: "resolve_spec", status: "failed", detail: { code: "project_rig" } }] }));
          } else if (body.sourceRef === "eztrack") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ status: "restored", rigId: "old-rig", rigName: "eztrack", rigResult: "fully_restored", nodes: [], warnings: [] }));
          } else if (body.onExisting === "fresh") {
            res.writeHead(201, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ runId: "r2", status: "completed", rigId: "new-rig", stages: [], errors: [], warnings: [] }));
          } else {
            res.writeHead(409, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              runId: "r1", status: "failed", code: "project_rig_exists", errors: [EXISTS_MESSAGE], warnings: [],
              stages: [{ stage: "resolve_spec", status: "failed", detail: { code: "project_rig_exists", rigName: "eztrack", rigIds: ["old-rig"] } }],
            }));
          }
          return;
        }
        res.writeHead(404).end();
      });
    });
    await new Promise<void>((r) => { server.listen(0, r); });
    port = (server.address() as { port: number }).port;
  });

  afterAll(() => { server.close(); });

  beforeEach(() => {
    bodies = [];
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "up-project-rig-"));
    spec = path.join(tmp, "rig.yaml");
    fs.writeFileSync(spec, "version: \"0.2\"\nname: team\nproject_rig: true\npods: []\nedges: []\n");
  });

  function makeCmd(promptProjectRigChoice?: (q: string) => Promise<"resume" | "fresh" | null>): Command {
    const prog = new Command();
    prog.exitOverride();
    prog.addCommand(upCommand({
      lifecycleDeps: {
        ...mockLifecycleDeps(),
        exists: vi.fn((p: string) => p === STATE_FILE),
        readFile: vi.fn((p: string) => p === STATE_FILE
          ? JSON.stringify({ pid: 123, port, db: "t.sqlite", startedAt: "2026-06-11T00:00:00Z" } as DaemonState)
          : null),
      },
      clientFactory: (url: string) => new DaemonClient(url),
      promptProjectRigChoice,
    }));
    return prog;
  }

  const up = (cmd: Command, ...extra: string[]) => captureLogs(() => cmd.parseAsync(["node", "rig", "up", spec, "--cwd", "/p/eztrack", ...extra]).then(() => undefined));

  it("headless: explains both commands, changes nothing, exits 1", async () => {
    const { logs, exitCode } = await up(makeCmd());
    expect(logs.join("\n")).toContain(EXISTS_MESSAGE);
    expect(exitCode).toBe(1);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.onExisting).toBeUndefined();
  });

  it("asked, the answer fresh re-runs the launch with onExisting fresh", async () => {
    const ask = vi.fn(async () => "fresh" as const);
    const { exitCode } = await up(makeCmd(ask));
    expect(ask).toHaveBeenCalledWith(expect.stringContaining('stopped rig "eztrack"'));
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toMatchObject({ sourceRef: spec, cwdOverride: "/p/eztrack", onExisting: "fresh" });
    expect(exitCode).toBeUndefined();
  });

  it("asked, the answer resume brings the stopped rig back by name", async () => {
    const { exitCode } = await up(makeCmd(async () => "resume"));
    expect(bodies).toHaveLength(2);
    expect(bodies[1]!.sourceRef).toBe("eztrack");
    expect(bodies[1]!.onExisting).toBeUndefined();
    expect(bodies[1]!.cwdOverride).toBeUndefined();
    expect(exitCode).toBeUndefined();
  });

  it("asked, any other answer cancels with nothing changed", async () => {
    const { logs, exitCode } = await up(makeCmd(async () => null));
    expect(logs.join("\n")).toContain("Cancelled; nothing was changed.");
    expect(bodies).toHaveLength(1);
    expect(exitCode).toBe(1);
  });

  it("--on-existing fresh sends the choice up front, without asking", async () => {
    const ask = vi.fn(async () => null);
    await up(makeCmd(ask), "--on-existing", "fresh");
    expect(ask).not.toHaveBeenCalled();
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.onExisting).toBe("fresh");
  });

  it("--on-existing resume resumes without asking", async () => {
    const ask = vi.fn(async () => null);
    await up(makeCmd(ask), "--on-existing", "resume");
    expect(ask).not.toHaveBeenCalled();
    expect(bodies.map((b) => b.sourceRef)).toEqual([spec, "eztrack"]);
  });

  it("refuses an unknown --on-existing value before contacting the daemon", async () => {
    const { logs, exitCode } = await up(makeCmd(), "--on-existing", "maybe");
    expect(logs.join("\n")).toContain('--on-existing takes resume or fresh (got "maybe").');
    expect(exitCode).toBe(1);
    expect(bodies).toHaveLength(0);
  });

  it("a launch without --cwd prints the daemon's project-rig refusal as is", async () => {
    const { logs, exitCode } = await captureLogs(() => makeCmd().parseAsync(["node", "rig", "up", spec]).then(() => undefined));
    expect(logs).toContain("team is a project rig: launch it into a project with --cwd <project folder>.");
    expect(logs.join("\n")).not.toContain("Up failed:");
    expect(exitCode).toBe(2);
  });
});
