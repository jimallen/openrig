// OPR.0.3.4.2 — rig up --existing: resume-original default surface.
// --fresh opt-in forwarding, the awaiting-decision ASK/offer (TTY [y/N] via
// injected prompt; headless honest machine-status + --fresh hint), and the
// five-term distinct-naming render. NEVER an auto-substitution.

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import http from "node:http";
import { Command } from "commander";
import { upCommand } from "../src/commands/up.js";
import { DaemonClient, DaemonConnectionError } from "../src/client.js";
import { STATE_FILE, type LifecycleDeps, type DaemonState } from "../src/daemon-lifecycle.js";
import { printedSeatLaunchCommands, runPrintedSeatCommand } from "./helpers/advised-command.js";

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

function captureLogs(fn: () => Promise<void>): Promise<{ logs: string[]; exitCode: number | undefined }> {
  return new Promise(async (resolve) => {
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
    resolve({ logs, exitCode });
  });
}

describe("rig up --existing — resume-original default (OPR.0.3.4.2)", () => {
  let server: http.Server;
  let port: number;
  let upBodies: Array<Record<string, unknown>> = [];
  let seatPosts: Array<{ path: string; body: Record<string, unknown> }> = [];
  let seatAnswer: (path: string) => { status: number; data: Record<string, unknown>; raw?: string };
  /** Per-test response factory keyed on the freshLogicalIds in the request. */
  let respond: (body: Record<string, unknown>) => Record<string, unknown>;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c: Buffer) => { raw += c; });
      req.on("end", () => {
        if (req.method === "POST" && req.url === "/api/up") {
          const body = JSON.parse(raw || "{}");
          upBodies.push(body);
          // The daemon refuses a whole-rig restore while any sibling is live (rig_not_stopped, HTTP 409). In these tests a
          // sibling is always live, so a fresh-listed /api/up gets exactly that answer.
          if (body.plan !== true && Array.isArray(body.freshLogicalIds) && body.freshLogicalIds.length > 0) {
            res.writeHead(409, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Rig rig-1 has live sessions. Stop the rig with 'rig down' before restoring", code: "rig_not_stopped" }));
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(respond(body)));
          return;
        }
        if (req.method === "POST" && req.url?.startsWith("/api/seat/launch/")) {
          seatPosts.push({ path: req.url, body: JSON.parse(raw || "{}") });
          const answer = seatAnswer(req.url);
          if (answer.raw !== undefined) {
            res.writeHead(answer.status, { "Content-Type": "text/plain" });
            res.end(answer.raw);
            return;
          }
          res.writeHead(answer.status, { "Content-Type": "application/json" });
          res.end(JSON.stringify(answer.data));
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
    upBodies = [];
    seatPosts = [];
    seatAnswer = () => ({ status: 200, data: { ok: true, status: "ready" } });
    respond = () => ({ status: "restored", rigId: "rig-1", rigName: "myrig", rigResult: "fully_restored", nodes: [], warnings: [] });
  });

  function deps(promptYesNo?: (q: string) => Promise<boolean>) {
    return {
      lifecycleDeps: {
        ...mockLifecycleDeps(),
        exists: vi.fn((p: string) => p === STATE_FILE),
        readFile: vi.fn((p: string) => p === STATE_FILE
          ? JSON.stringify({ pid: 123, port, db: "t.sqlite", startedAt: "2026-06-11T00:00:00Z" } as DaemonState)
          : null),
        fetch: vi.fn(async () => ({ ok: true })),
      },
      clientFactory: (url: string) => new DaemonClient(url),
      promptYesNo,
    };
  }

  function makeCmd(promptYesNo?: (q: string) => Promise<boolean>): Command {
    const prog = new Command();
    prog.exitOverride();
    prog.addCommand(upCommand(deps(promptYesNo)));
    return prog;
  }

  it("--fresh seats forward as freshLogicalIds in the /api/up body (operation B)", async () => {
    await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "up", "myrig", "--existing", "--fresh", "dev.impl", "dev.qa"]);
    });
    expect(upBodies).toHaveLength(1);
    expect(upBodies[0]!.freshLogicalIds).toEqual(["dev.impl", "dev.qa"]);
  });

  // OF-32 stage 3: the restore's escape from re-reading the spec.
  it.each([
    [["--startup-from", "stored"], "stored"],
    [["--startup-from", "spec"], "spec"],
    [[], undefined],
  ] as const)("rig up --existing %j forwards startupFrom %s in the /api/up body", async (flag, expected) => {
    await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "up", "myrig", "--existing", ...flag]);
    });
    expect(upBodies).toHaveLength(1);
    expect(upBodies[0]!.startupFrom).toBe(expected);
    expect("startupFrom" in upBodies[0]!).toBe(expected !== undefined);
  });

  it("rig up --startup-from refuses a value other than spec or stored, before any request", async () => {
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "up", "myrig", "--existing", "--startup-from", "release"]);
    });
    expect(logs.join("\n")).toContain(`--startup-from takes spec, stored or snapshot:<snapshot-id> (got "release")`);
    expect(exitCode).toBe(1);
    expect(upBodies).toHaveLength(0);
  });

  it("under --startup-from stored, an accepted fresh start after a failed resume replays the saved files too", async () => {
    respond = () => ({
      status: "restored", rigId: "rig-1", rigName: "myrig", rigResult: "partially_restored",
      nodes: [{ logicalId: "dev.impl", status: "awaiting-decision", error: "no token available" }], warnings: [],
    });
    await captureLogs(async () => {
      await makeCmd(vi.fn(async () => true)).parseAsync(["node", "rig", "up", "myrig", "--existing", "--startup-from", "stored"]);
    });
    expect(seatPosts).toEqual([{
      path: "/api/seat/launch/dev.impl%40myrig",
      body: { fresh: true, reason: "operator accepted fresh start at rig up", startupFrom: "stored" },
    }]);
  });

  it("under --startup-from stored, the headless fresh-start advice carries the escape and runs as printed", async () => {
    respond = () => ({
      status: "restored", rigId: "rig-1", rigName: "myrig", rigResult: "partially_restored",
      nodes: [{ logicalId: "dev.impl", status: "awaiting-decision", error: "no token available" }], warnings: [],
    });
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "up", "myrig", "--existing", "--startup-from", "stored"]);
    });
    const advised = printedSeatLaunchCommands(logs.join("\n"));
    expect(advised).toEqual([`rig seat launch 'dev.impl@myrig' --fresh --startup-from stored --reason "<why>"`]);
    const posted = await runPrintedSeatCommand(advised[0]!);
    expect(posted.body).toMatchObject({ fresh: true, startupFrom: "stored" });
  });

  // OF-36 re-check G1 / R5: snapshot:<id> was named for the listed seats; the CLI cannot check it for another seat, so
  // neither its advice line nor an accepted fresh start for a seat left awaiting a decision carries it. (The fake daemon
  // refuses a fresh-listed /api/up, so the restore here lists no seat; the CLI path that prints the advice is the same.)
  it("under --startup-from snapshot:<id>, the headless advice and an accepted fresh start for an awaiting seat do not name the snapshot", async () => {
    respond = () => ({
      status: "restored", rigId: "rig-1", rigName: "myrig", rigResult: "partially_restored",
      nodes: [{ logicalId: "dev.qa", status: "awaiting-decision", error: "no token available" }], warnings: [],
    });
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "up", "myrig", "--existing", "--startup-from", "snapshot:01SNAP"]);
    });
    expect(printedSeatLaunchCommands(logs.join("\n")), logs.join("\n")).toEqual([`rig seat launch 'dev.qa@myrig' --fresh --reason "<why>"`]);
    expect(upBodies.at(-1)).toMatchObject({ startupFrom: "snapshot:01SNAP" });

    await captureLogs(async () => {
      await makeCmd(vi.fn(async () => true)).parseAsync(["node", "rig", "up", "myrig", "--existing", "--startup-from", "snapshot:01SNAP"]);
    });
    expect(seatPosts.at(-1)).toEqual({ path: "/api/seat/launch/dev.qa%40myrig", body: { fresh: true, reason: "operator accepted fresh start at rig up" } });
  });

  // OF-32 stage 3 review must-fix 1: each seat the restore started fresh says where its startup files came from.
  it("rig up --existing prints, under each fresh seat, where its startup files came from and any agent version move", async () => {
    respond = () => ({
      status: "restored", rigId: "rig-1", rigName: "myrig", rigResult: "partially_restored",
      nodes: [
        { logicalId: "dev.impl", status: "fresh-primed", startupSource: { kind: "spec", specSource: "/lib/team/rig.yaml", specPath: "/rel/b/rigs/team/rig.yaml", previousSpecVersion: "1.0.0", specVersion: "2.0.0" } },
        { logicalId: "dev.qa", status: "fresh-primed", startupSource: { kind: "stored", reason: "no_recorded_source" } },
        { logicalId: "dev.ops", status: "fresh-primed", startupSource: { kind: "snapshot", reason: "saved_context_unreadable" } },
        { logicalId: "dev.lead", status: "resumed" },
      ], warnings: [],
    });
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "up", "myrig", "--existing"]);
    });
    const at = (line: string) => logs.indexOf(line);
    expect(at("    startup files re-read from /lib/team/rig.yaml (now /rel/b/rigs/team/rig.yaml); agent 1.0.0 -> 2.0.0")).toBe(at("  dev.impl: fresh-primed") + 1);
    expect(at("    startup files replayed from the seat's last successful launch (this rig records no spec source)")).toBe(at("  dev.qa: fresh-primed") + 1);
    expect(at("    startup files replayed from this snapshot (the seat's saved startup files cannot be used)")).toBe(at("  dev.ops: fresh-primed") + 1);
    expect(logs[at("  dev.lead: resumed") + 1] ?? "").not.toContain("startup files");
  });

  it("a seat restore refused before its launch prints why, not only 'failed'", async () => {
    const why = "Fresh start refused: This rig's spec source /lib/team/rig.yaml cannot be used for a fresh launch: the file (or a link on its path) no longer exists. No session was started.";
    respond = () => ({
      status: "restored", rigId: "rig-1", rigName: "myrig", rigResult: "partially_restored",
      nodes: [{ logicalId: "dev.impl", status: "failed", error: why }, { logicalId: "dev.qa", status: "resumed" }], warnings: [],
    });
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "up", "myrig", "--existing"]);
    });
    expect(logs).toContain(`  dev.impl: failed — ${why}`);
    expect(logs).toContain("  dev.qa: resumed");
    expect(exitCode).toBe(1);
  });

  it("headless awaiting-decision: honest machine status + --fresh hint, exit 1, NO auto-substitution", async () => {
    respond = () => ({
      status: "restored", rigId: "rig-1", rigName: "myrig", rigResult: "partially_restored",
      nodes: [{ logicalId: "dev.impl", status: "awaiting-decision", error: "Original session unresumable: resume attempted but failed." }],
      warnings: [],
    });
    // No promptYesNo injected and no TTY in vitest -> the headless path.
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "up", "myrig", "--existing"]);
    });
    const output = logs.join("\n");
    expect(output).toContain("dev.impl: awaiting-decision");
    // The advice must work in the state it is printed in: this restore left a seat awaiting a decision, which
    // normally means its siblings were just started, and then `rig up --existing --fresh` is refused with
    // rig_not_stopped (HTTP 409). The advised command is the per-seat door; run it through the real command tree.
    expect(output).not.toMatch(/rig up .*--fresh/);
    const advised = printedSeatLaunchCommands(output);
    expect(advised, output).toEqual([`rig seat launch 'dev.impl@myrig' --fresh --reason "<why>"`]);
    const posted = await runPrintedSeatCommand(advised[0]!);
    expect(posted.path).toBe("/api/seat/launch/dev.impl%40myrig");
    expect(posted.body).toMatchObject({ fresh: true, reason: "advice executed by test" });
    expect(exitCode).toBe(1);
    // CRITICAL: exactly one POST — nothing auto-substituted a fresh session.
    expect(upBodies).toHaveLength(1);
  });

  // OF-32 (N4): accepting a fresh start shows the daemon's no-source warning, and a refusal's stored-escape guidance.
  it.each([
    [{ status: 200, data: { ok: true, status: "ready", warnings: ["This rig records no spec source (fixture)."] } }, "dev.impl: warning: This rig records no spec source (fixture)."],
    [{ status: 409, data: { ok: false, code: "startup_source_unavailable", message: "gone", guidance: "run again with --startup-from stored (fixture)" } }, "dev.impl: run again with --startup-from stored (fixture)"],
  ] as const)("accepted fresh start prints what the daemon said: %j", async (answer, line) => {
    respond = () => ({
      status: "restored", rigId: "rig-1", rigName: "myrig", rigResult: "partially_restored",
      nodes: [{ logicalId: "dev.impl", status: "awaiting-decision", error: "no token available" }, { logicalId: "dev.qa", status: "resumed" }], warnings: [],
    });
    seatAnswer = () => answer as never;
    const { logs } = await captureLogs(async () => {
      await makeCmd(vi.fn(async () => true)).parseAsync(["node", "rig", "up", "myrig", "--existing"]);
    });
    expect(logs).toContain(`  ${line}`);
  });

  // OF-135: a daemon that names the rig's advice handle (its id when another rig shares the name) is followed; one that
  // does not (older daemons, the row below) leaves the canonical name.
  it("headless hint names the rig by the daemon's rigHandle when it sends one", async () => {
    respond = () => ({
      status: "restored", rigId: "01RIGID", rigName: "kernel", rigHandle: "01RIGID", rigResult: "partially_restored",
      nodes: [{ logicalId: "operator.human", status: "awaiting-decision", error: "Original session unresumable: no resume token was captured for this seat." }],
      warnings: [],
    });
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "up", "kern", "--existing"]);
    });
    expect(printedSeatLaunchCommands(logs.join("\n"))).toEqual([`rig seat launch 'operator.human@01RIGID' --fresh --reason "<why>"`]);
  });

  it("headless hint names the rig by the daemon's canonical name, not by whatever the operator typed after `rig up`", async () => {
    respond = () => ({
      status: "restored", rigId: "01RIGID", rigName: "kernel", rigResult: "partially_restored",
      nodes: [{ logicalId: "operator.human", status: "awaiting-decision", error: "Original session unresumable: no resume token was captured for this seat." }],
      warnings: [],
    });
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "up", "kern", "--existing"]);
    });
    const advised = printedSeatLaunchCommands(logs.join("\n"));
    expect(advised).toEqual([`rig seat launch 'operator.human@kernel' --fresh --reason "<why>"`]);
    expect((await runPrintedSeatCommand(advised[0]!)).path).toBe("/api/seat/launch/operator.human%40kernel");
  });

  it("TTY ASK accepted: [y/N] offer names seat + reason, then starts that seat fresh on its own while a sibling is live", async () => {
    respond = () => ({
      status: "restored", rigId: "rig-1", rigName: "myrig", rigResult: "partially_restored",
      nodes: [
        { logicalId: "dev.impl", status: "awaiting-decision", error: "no token available" },
        { logicalId: "dev.qa", status: "resumed" },
      ], warnings: [],
    });
    const prompt = vi.fn(async () => true);

    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd(prompt).parseAsync(["node", "rig", "up", "myrig", "--existing"]);
    });

    expect(prompt).toHaveBeenCalledTimes(1);
    const question = prompt.mock.calls[0]![0] as string;
    expect(question).toContain("dev.impl");
    expect(question).toContain("no token available");
    expect(question).toContain("[y/N]");
    // One restore only: a second whole-rig /api/up with freshLogicalIds is refused (409) while dev.qa is live. The
    // accepted seat goes through the per-seat fresh launch, the route behind `rig seat launch --fresh`.
    expect(upBodies).toHaveLength(1);
    expect(upBodies.every((b) => b.freshLogicalIds === undefined)).toBe(true);
    expect(seatPosts).toEqual([{
      path: "/api/seat/launch/dev.impl%40myrig",
      body: { fresh: true, reason: "operator accepted fresh start at rig up" },
    }]);
    expect(logs.join("\n")).toContain("dev.impl: fresh-primed");
    expect(logs.join("\n")).not.toContain("fresh start failed");
    expect(exitCode).toBe(1); // the restore itself still left a seat awaiting a decision
  });

  it("TTY ASK accepted but the daemon refuses the fresh launch: the refusal is reported, never dropped", async () => {
    respond = () => ({
      status: "restored", rigId: "rig-1", rigName: "myrig", rigResult: "partially_restored",
      nodes: [{ logicalId: "dev.impl", status: "awaiting-decision", error: "no token available" }], warnings: [],
    });
    seatAnswer = () => ({ status: 409, data: { ok: false, code: "session_live", message: "A live managed occupant requires --stop." } });
    const { logs } = await captureLogs(async () => {
      await makeCmd(vi.fn(async () => true)).parseAsync(["node", "rig", "up", "myrig", "--existing"]);
    });
    const output = logs.join("\n");
    expect(output).toContain("dev.impl: fresh start failed (HTTP 409): session_live: A live managed occupant requires --stop.");
    expect(output).not.toContain("dev.impl: fresh-primed");
  });

  it("TTY ASK accepted and the daemon answers 200 with ok:false: that is a refusal too", async () => {
    respond = () => ({
      status: "restored", rigId: "rig-1", rigName: "myrig", rigResult: "partially_restored",
      nodes: [{ logicalId: "dev.impl", status: "awaiting-decision", error: "no token available" }], warnings: [],
    });
    seatAnswer = () => ({ status: 200, data: { ok: false, code: "attention_required", message: "The new occupant needs attention." } });
    const { logs } = await captureLogs(async () => {
      await makeCmd(vi.fn(async () => true)).parseAsync(["node", "rig", "up", "myrig", "--existing"]);
    });
    expect(logs.join("\n")).toContain("dev.impl: fresh start failed (HTTP 200): attention_required: The new occupant needs attention.");
    expect(logs.join("\n")).not.toContain("dev.impl: fresh-primed");
  });

  it("TTY ASK accepted names the seat's rig by the daemon's canonical name, not by what was typed after `rig up`", async () => {
    respond = () => ({
      status: "restored", rigId: "01RIGID", rigName: "kernel", rigResult: "partially_restored",
      nodes: [{ logicalId: "operator.human", status: "awaiting-decision", error: "no resume token was captured for this seat" }], warnings: [],
    });
    await captureLogs(async () => {
      await makeCmd(vi.fn(async () => true)).parseAsync(["node", "rig", "up", "kern", "--existing"]);
    });
    expect(seatPosts.map((p) => p.path)).toEqual(["/api/seat/launch/operator.human%40kernel"]);
  });

  // OF-135 (review-x2 F1): with a shared name the daemon names the rig by id, and the accepted seat is launched there.
  it("TTY ASK accepted launches the seat on the rig the daemon's rigHandle names", async () => {
    respond = () => ({
      status: "restored", rigId: "01RIGID", rigName: "kernel", rigHandle: "01RIGID", rigResult: "partially_restored",
      nodes: [{ logicalId: "operator.human", status: "awaiting-decision", error: "no resume token was captured for this seat" }], warnings: [],
    });
    await captureLogs(async () => {
      await makeCmd(vi.fn(async () => true)).parseAsync(["node", "rig", "up", "01RIGID", "--existing"]);
    });
    expect(seatPosts.map((p) => p.path)).toEqual(["/api/seat/launch/operator.human%4001RIGID"]);
  });

  // Each accepted seat is independent: a bad answer for one must not hide the others' results or stop them being tried.
  it("several accepted seats: one unreadable answer in the middle does not stop the rest or hide earlier results", async () => {
    respond = () => ({
      status: "restored", rigId: "rig-1", rigName: "myrig", rigResult: "partially_restored",
      nodes: [
        { logicalId: "a.one", status: "awaiting-decision", error: "no token" },
        { logicalId: "b.two", status: "awaiting-decision", error: "no token" },
        { logicalId: "c.three", status: "awaiting-decision", error: "no token" },
      ], warnings: [],
    });
    seatAnswer = (path) => path.includes("b.two")
      ? { status: 502, data: {}, raw: "Bad Gateway" }
      : { status: 200, data: { ok: true, status: "ready" } };
    const { logs } = await captureLogs(async () => {
      await makeCmd(vi.fn(async () => true)).parseAsync(["node", "rig", "up", "myrig", "--existing"]);
    });
    const output = logs.join("\n");
    expect(seatPosts.map((p) => p.path)).toEqual([
      "/api/seat/launch/a.one%40myrig", "/api/seat/launch/b.two%40myrig", "/api/seat/launch/c.three%40myrig",
    ]);
    expect(output).toContain("a.one: fresh-primed");
    expect(output).toContain("c.three: fresh-primed");
    expect(output).toMatch(/b\.two: fresh start failed \(HTTP 502\): unreadable response from the daemon/);
    expect(output).not.toContain("b.two: fresh-primed");
  });

  it("several accepted seats: a refusal for the first still lets the second be tried and reported", async () => {
    respond = () => ({
      status: "restored", rigId: "rig-1", rigName: "myrig", rigResult: "partially_restored",
      nodes: [
        { logicalId: "a.one", status: "awaiting-decision", error: "no token" },
        { logicalId: "b.two", status: "awaiting-decision", error: "no token" },
      ], warnings: [],
    });
    seatAnswer = (path) => path.includes("a.one")
      ? { status: 409, data: { ok: false, code: "session_live", message: "A live managed occupant requires --stop." } }
      : { status: 200, data: { ok: true } };
    const { logs } = await captureLogs(async () => {
      await makeCmd(vi.fn(async () => true)).parseAsync(["node", "rig", "up", "myrig", "--existing"]);
    });
    expect(seatPosts).toHaveLength(2);
    expect(logs.join("\n")).toContain("a.one: fresh start failed (HTTP 409)");
    expect(logs.join("\n")).toContain("b.two: fresh-primed");
  });

  it("TTY ASK declined names each seat's rig by the daemon's rigHandle when it sends one (OF-135)", async () => {
    respond = () => ({
      status: "restored", rigId: "01RIGID", rigName: "kernel", rigHandle: "01RIGID", rigResult: "partially_restored",
      nodes: [{ logicalId: "operator.human", status: "awaiting-decision", error: "no token" }], warnings: [],
    });
    const { logs } = await captureLogs(async () => {
      await makeCmd(vi.fn(async () => false)).parseAsync(["node", "rig", "up", "kern", "--existing"]);
    });
    expect(printedSeatLaunchCommands(logs.join("\n"))).toEqual([`rig seat launch 'operator.human@01RIGID' --fresh --reason "<why>"`]);
  });

  it("TTY ASK declined names each seat's rig by the daemon's canonical name, not by what was typed after `rig up`", async () => {
    respond = () => ({
      status: "restored", rigId: "01RIGID", rigName: "kernel", rigResult: "partially_restored",
      nodes: [{ logicalId: "operator.human", status: "awaiting-decision", error: "no token" }], warnings: [],
    });
    const { logs } = await captureLogs(async () => {
      await makeCmd(vi.fn(async () => false)).parseAsync(["node", "rig", "up", "kern", "--existing"]);
    });
    expect(printedSeatLaunchCommands(logs.join("\n"))).toEqual([`rig seat launch 'operator.human@kernel' --fresh --reason "<why>"`]);
  });

  it("TTY ASK declined: no second POST, no session started", async () => {
    respond = () => ({
      status: "restored", rigId: "rig-1", rigName: "myrig", rigResult: "partially_restored",
      nodes: [{ logicalId: "dev.impl", status: "awaiting-decision", error: "no token available" }],
      warnings: [],
    });
    const prompt = vi.fn(async () => false);

    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd(prompt).parseAsync(["node", "rig", "up", "myrig", "--existing"]);
    });

    expect(upBodies).toHaveLength(1);
    expect(logs.join("\n")).toContain("No fresh sessions started");
    // Declining still leaves the operator a command that works: the per-seat launch, not a bare `--fresh <seat...>`.
    const declinedAdvice = printedSeatLaunchCommands(logs.join("\n"));
    expect(declinedAdvice).toEqual([`rig seat launch 'dev.impl@myrig' --fresh --reason "<why>"`]);
    expect((await runPrintedSeatCommand(declinedAdvice[0]!)).path).toBe("/api/seat/launch/dev.impl%40myrig");
    expect(logs.join("\n")).not.toMatch(/Re-run with --fresh/);
    expect(exitCode).toBe(1);
  });

  // OF-163: a seat restore brought back by reattaching its adopted session (rig down left it running) says so, in the result
  // and in the plan, instead of a bare "resumed" / "resume-original".
  it("a reattached seat prints as reattached, naming the adopted session", async () => {
    respond = () => ({
      status: "restored", rigId: "rig-1", rigName: "myrig", rigResult: "fully_restored",
      nodes: [{ logicalId: "dev.impl", status: "resumed", reattached: { sessionId: "s-1", sessionName: "person-shell" } }, { logicalId: "dev.qa", status: "resumed" }], warnings: [],
    });
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "up", "myrig", "--existing"]);
    });
    expect(logs).toContain("  dev.impl: reattached — adopted session person-shell, which rig down left running");
    expect(logs).toContain("  dev.qa: resumed");
  });

  it("--plan names a seat it would reattach as a reattach", async () => {
    respond = () => ({
      status: "plan", mode: "restore", rigId: "rig-1", rigName: "myrig",
      snapshot: { id: "snap-9", kind: "auto-pre-down", createdAt: "2026-06-11T00:00:00Z" }, wouldCaptureCurrentState: false,
      nodes: [
        { logicalId: "dev.impl", intendedAction: "resume-original", reattach: { sessionId: "s-1", sessionName: "person-shell" }, reason: "reattaches its adopted session person-shell", tokenState: "missing" },
        { logicalId: "dev.qa", intendedAction: "resume-original", tokenState: "present" },
      ],
      mutated: false,
    });
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "up", "myrig", "--existing", "--plan"]);
    });
    const output = logs.join("\n");
    expect(output).toContain("dev.impl: reattach — reattaches its adopted session person-shell");
    expect(output).toContain("dev.qa: resume-original");
    // Review F2: a reattach starts nothing, so no token line is printed under it; a resumed seat keeps its line (control).
    expect(output).not.toContain("token: missing");
    expect(output).toContain("token: present");
  });

  // OPR.0.3.4.4 — plan-restore preview render + honest-async timeout.
  it("--plan restore preview renders per-seat intended actions and 'No changes made.'", async () => {
    respond = () => ({
      status: "plan",
      mode: "restore",
      rigId: "rig-1",
      rigName: "myrig",
      snapshot: { id: "snap-9", kind: "auto-pre-down", createdAt: "2026-06-11T00:00:00Z" },
      wouldCaptureCurrentState: false,
      nodes: [
        { logicalId: "dev.impl", intendedAction: "resume-original" },
        { logicalId: "dev.qa", intendedAction: "awaiting-decision", reason: "resume source 'claude_name' recorded but no token available — apply would stop and ask (zero session)" },
      ],
      mutated: false,
    });

    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "up", "myrig", "--existing", "--plan"]);
    });
    const output = logs.join("\n");
    expect(output).toContain('Plan: restore rig "myrig"');
    expect(output).toContain("snap-9");
    expect(output).toContain("dev.impl: resume-original");
    expect(output).toContain("dev.qa: awaiting-decision");
    expect(output).toContain("no token available");
    expect(output).toContain("No changes made.");
    expect(exitCode).toBeUndefined();
    // The plan flag reached the daemon body.
    expect(upBodies).toHaveLength(1);
    expect(upBodies[0]!.plan).toBe(true);
  });

  it("--plan --fresh posts BOTH plan:true and freshLogicalIds, and renders the fresh-primed preview", async () => {
    respond = (body) => ({
      status: "plan",
      mode: "restore",
      rigId: "rig-1",
      rigName: "myrig",
      snapshot: { id: "snap-9", kind: "auto-pre-down", createdAt: "2026-06-11T00:00:00Z" },
      wouldCaptureCurrentState: false,
      nodes: Array.isArray(body.freshLogicalIds) && (body.freshLogicalIds as string[]).includes("dev.impl")
        ? [{ logicalId: "dev.impl", intendedAction: "fresh-primed", reason: "listed in --fresh — apply would deliberately skip the resume (operation B)" }]
        : [{ logicalId: "dev.impl", intendedAction: "resume-original" }],
      mutated: false,
    });

    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "up", "myrig", "--existing", "--plan", "--fresh", "dev.impl"]);
    });

    expect(upBodies).toHaveLength(1);
    expect(upBodies[0]!.plan).toBe(true);
    expect(upBodies[0]!.freshLogicalIds).toEqual(["dev.impl"]);
    const output = logs.join("\n");
    expect(output).toContain("dev.impl: fresh-primed");
    expect(output).toContain("No changes made.");
  });

  // OF-32 follow-up: the plan names a listed seat apply would refuse, in restore's own words, and says when it could not predict.
  it("--plan --fresh prints a refusal the daemon predicted, and nothing for a seat it did not", async () => {
    respond = () => ({
      status: "plan", mode: "restore", rigId: "rig-1", rigName: "myrig",
      snapshot: { id: "snap-9", kind: "auto-pre-down", createdAt: "2026-06-11T00:00:00Z" },
      wouldCaptureCurrentState: false,
      nodes: [
        { logicalId: "dev.impl", intendedAction: "fresh-primed", reason: "listed in --fresh", wouldRefuse: "This rig's spec source /lib/team/rig.yaml cannot be used for a fresh launch: the file no longer exists." },
        { logicalId: "dev.qa", intendedAction: "fresh-primed", reason: "listed in --fresh" },
      ],
      mutated: false,
    });

    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "up", "myrig", "--existing", "--plan", "--fresh", "dev.impl", "dev.qa"]);
    });

    const output = logs.join("\n");
    expect(output).toContain("would be refused: Fresh start refused: This rig's spec source /lib/team/rig.yaml cannot be used for a fresh launch: the file no longer exists. No session would be started.");
    expect(output.match(/would be refused/g)).toHaveLength(1);
    expect(output).toContain("No changes made.");
  });

  // OF-62 (review B2): a rig-level refusal (a damaged saved row) is printed, once, before "No changes made."
  it("--plan prints the rig-level refusal the daemon reports, and nothing when there is none", async () => {
    const plan = (extra: Record<string, unknown>) => ({
      status: "plan", mode: "restore", rigId: "rig-1", rigName: "myrig", snapshot: null, wouldCaptureCurrentState: true,
      nodes: [{ logicalId: "dev.impl", intendedAction: "awaiting-decision", restoreStatus: "failed" }, { logicalId: "dev.qa", intendedAction: "resume-original" }],
      mutated: false, ...extra,
    });
    respond = () => plan({ restoreRefusal: { reason: "restore would refuse the whole rig and start no seat: dev.impl's saved row is damaged (package_refs is not JSON). Repair the row first.", seats: ["dev.impl"] } });
    const refused = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "up", "myrig", "--existing", "--plan"]);
    });
    const out = refused.logs.join("\n");
    expect(out).toContain("Restore would be refused for the whole rig: restore would refuse the whole rig and start no seat: dev.impl's saved row is damaged (package_refs is not JSON). Repair the row first.");
    expect(out.match(/Restore would be refused/g)).toHaveLength(1);
    respond = () => plan({});
    const clean = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "up", "myrig", "--existing", "--plan"]);
    });
    expect(clean.logs.join("\n")).not.toContain("Restore would be refused");
  });

  it("--plan says so when the daemon could not predict the listed seats' refusals", async () => {
    respond = () => ({
      status: "plan", mode: "restore", rigId: "rig-1", rigName: "myrig", snapshot: null, wouldCaptureCurrentState: true,
      nodes: [{ logicalId: "dev.impl", intendedAction: "fresh-primed" }], mutated: false, refusalPredictionError: "spec reader exploded",
    });

    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "up", "myrig", "--existing", "--plan", "--fresh", "dev.impl"]);
    });

    expect(logs.join("\n")).toContain("Could not predict which listed seats apply would refuse: spec reader exploded");
  });

  it("HONEST TIMEOUT (apply mode): DaemonConnectionError renders in-progress/unknown + verify command, never a bare failure", async () => {
    const throwingClient = {
      get: async () => { throw new DaemonConnectionError("request timed out after 120000ms"); },
      post: async () => { throw new DaemonConnectionError("request timed out after 120000ms"); },
    } as unknown as DaemonClient;
    const customDeps = { ...deps(), clientFactory: () => throwingClient };
    const prog = new Command();
    prog.exitOverride();
    prog.addCommand(upCommand(customDeps));

    const { logs, exitCode } = await captureLogs(async () => {
      await prog.parseAsync(["node", "rig", "up", "myrig", "--existing"]);
    });
    const output = logs.join("\n");
    // Honest in-progress/unknown framing, not a false "failed".
    expect(output).toContain("may still be processing");
    expect(output).toContain("does not mean the operation failed");
    expect(output).toContain("rig ps");
    expect(output).not.toContain("Up failed");
    expect(exitCode).toBe(1);
  });

  // OPR.0.3.4.6 — cross-surface regression guard: CLI exit-code + JSON.
  it("OPR.0.3.4.6 guard: attention_required/awaiting-decision -> partially_restored -> exit 1, never exit 0", async () => {
    respond = () => ({
      status: "restored", rigId: "rig-1", rigName: "myrig", rigResult: "partially_restored",
      nodes: [
        { logicalId: "a", status: "resumed" },
        { logicalId: "b", status: "attention_required" },
        { logicalId: "c", status: "awaiting-decision", error: "no token" },
      ],
      warnings: [],
    });
    const { exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "up", "myrig", "--existing"]);
    });
    expect(exitCode).toBe(1);
  });

  it("OPR.0.3.4.6 guard: JSON passes raw per-node status for all five terms (never collapsed)", async () => {
    respond = () => ({
      status: "restored", rigId: "rig-1", rigName: "myrig", rigResult: "partially_restored",
      nodes: [
        { logicalId: "a", status: "resumed" },
        { logicalId: "b", status: "fresh-primed" },
        { logicalId: "c", status: "awaiting-decision", error: "no token" },
        { logicalId: "d", status: "attention_required" },
        { logicalId: "e", status: "failed" },
      ],
      warnings: [],
    });
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "up", "myrig", "--existing", "--json"]);
    });
    const jsonLine = logs.find((l) => l.startsWith("{"));
    expect(jsonLine).toBeDefined();
    const parsed = JSON.parse(jsonLine!);
    const statuses = (parsed.nodes as Array<{ status: string }>).map((n) => n.status);
    expect(statuses).toContain("resumed");
    expect(statuses).toContain("fresh-primed");
    expect(statuses).toContain("awaiting-decision");
    expect(statuses).toContain("attention_required");
    expect(statuses).toContain("failed");
  });

  it("distinct naming: all five vocabulary terms render distinctly per seat", async () => {
    respond = () => ({
      status: "restored", rigId: "rig-1", rigName: "myrig", rigResult: "partially_restored",
      nodes: [
        { logicalId: "a", status: "resumed" },
        { logicalId: "b", status: "fresh-primed" },
        { logicalId: "c", status: "awaiting-decision", error: "no token available" },
        { logicalId: "d", status: "attention_required" },
        { logicalId: "e", status: "failed" },
      ],
      warnings: [],
    });
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "up", "myrig", "--existing"]);
    });
    const output = logs.join("\n");
    expect(output).toContain("a: resumed");
    expect(output).toContain("b: fresh-primed");
    expect(output).toContain("c: awaiting-decision");
    expect(output).toContain("d: attention_required");
    expect(output).toContain("e: failed");
    expect(exitCode).toBe(1);
  });
});
