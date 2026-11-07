// OF-267 review F1: the production wiring of B, through the real createDaemon. The unit and route rows inject the hc terminal-status reader
// themselves; nothing else fails if startup.ts stops building it, or stops handing it to the SessionTransport or to the server's deps.
//
// A real daemon (helpers/seat-posture-startup-daemon.ts) on a database file and a PRIVATE hc core, and a Pi-like terminal on that core
// that reports OSC 7501 `working` and then sits silent. The seat's newest hook is a PreToolUse 66 minutes old (an open turn). With the wiring
// intact the daemon's own answers are "busy ... (hc status)"; with startup.ts not building the reader, or not passing it on, they fall back to the
// hook's unknown-open-turn. Both a surviving mutant of each kind (no reader built; none passed to the transport) now fail here.
//
// Runs on a host with `hc` only, and only on Sparky (OF-274: no hc real tests on the laptop).
// Not proven: a real Pi (the terminal is a shell that writes the status record the Pi runner writes), macOS.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hcTerminalName } from "../src/adapters/hc-seat.js";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { EventBus } from "../src/domain/event-bus.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import type { HcTerminal } from "../src/adapters/hc-client.js";
import { HC, PrivateCore, until } from "./hc-private-core.js";

const here = dirname(fileURLToPath(import.meta.url));
const CHILD = resolve(here, "helpers/seat-posture-startup-daemon.ts");
const SEAT = "build-arch@sps-rig";

interface Answers { hasReaderInDeps: boolean; viaTransport: { kind: string; source: string; line: string } | null; viaRoute: { kind: string; source: string } | null }

describe.skipIf(!HC)("the busy report's hc reader, through the real createDaemon and a private core", () => {
  const core = new PrivateCore("sps");
  let dir: string;
  let db: string;
  let rigId: string;

  beforeAll(async () => {
    core.start();
    dir = mkdtempSync(join(core.root, "w-"));
    mkdirSync(join(dir, "h"), { recursive: true });
    db = join(dir, "d.sqlite");
    const handle = createDb(db);
    migrate(handle, ALL_MIGRATIONS);
    const repo = new RigRepository(handle);
    const sessions = new SessionRegistry(handle);
    const rig = repo.createRig("sps-rig");
    rigId = rig.id;
    const node = repo.addNode(rig.id, "build.arch", { role: "worker", runtime: "pi", cwd: dir });
    const session = sessions.registerSession(node.id, SEAT);
    sessions.updateStatus(session.id, "running");
    // A Pi-like seat: reports `working` the way the Pi runner does (OSC 7501), then says nothing.
    const terminal = await core.client.call<{ id: string }>("terminal.run", {
      argv: ["/bin/sh", "-c", "printf '\\033]7501;state=working:app=pi-like\\033\\\\'; sleep 600"],
      name: hcTerminalName(SEAT), labels: { "openrig.seat": SEAT }, no_parent: true, no_notify: true, outlive_parent: true, cwd: dir,
    });
    sessions.updateBinding(node.id, { attachmentType: "hc", tmuxSession: SEAT, terminalAddress: terminal.id });
    const generation = sessions.currentOccupantTenure(node.id)!.generationUuid;
    const store = new AgentActivityStore({ db: handle, eventBus: new EventBus(handle) });
    const hookAt = new Date(Date.now() - 66 * 60_000).toISOString();
    expect(store.recordHookEvent({ sessionName: SEAT, runtime: "pi", hookEvent: "PreToolUse", subtype: "bash", occurredAt: hookAt, generation }).ok).toBe(true);
    handle.close();
    await until(() => core.client.call<HcTerminal>("terminal.get", { terminal: hcTerminalName(SEAT) }), (t) => t.status?.state === "working", "the seat to read working");
  }, 60_000);
  afterAll(() => core.stop());

  it("the daemon's own transport and node list say busy from hc status", async () => {
    const out = join(dir, "answers.json");
    const env: NodeJS.ProcessEnv = {
      ...core.env, PATH: `${dirname(HC)}:/usr/bin:/bin`, TMPDIR: join(core.root, "h"), OPENRIG_HOME: join(core.root, "h", "openrig"),
      SPS_DB: db, SPS_OUT: out, SPS_SEAT: SEAT, SPS_RIG: rigId,
    };
    const stderr: string[] = [];
    const child = spawn(process.execPath, ["--import", "tsx", CHILD], { cwd: resolve(here, ".."), env, stdio: ["ignore", "ignore", "pipe"] });
    child.stderr?.on("data", (b: Buffer) => { stderr.push(b.toString()); if (stderr.length > 40) stderr.shift(); });
    try {
      await until(async () => existsSync(out) || child.exitCode !== null, (done) => done, "the daemon's answers", 90_000);
      if (!existsSync(out)) throw new Error(`daemon died: ${stderr.join("").slice(0, 1500)}`);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    const answers = JSON.parse(readFileSync(out, "utf8")) as Answers;
    expect(answers.hasReaderInDeps, "startup hands the reader to the server's deps").toBe(true);
    expect(answers.viaTransport, "startup hands the reader to the SessionTransport").toMatchObject({ kind: "busy", source: "hc_status" });
    expect(answers.viaTransport!.line).toMatch(/^busy: working since .*Z \(hc status\)$/);
    expect(answers.viaRoute, "the node list route sees it through the server's context").toMatchObject({ kind: "busy", source: "hc_status" });
  }, 120_000);
});
