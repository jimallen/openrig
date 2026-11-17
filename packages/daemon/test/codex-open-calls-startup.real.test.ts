// workspaces-o9o.31: the production wiring, through the real createDaemon. The unit and route rows inject the Codex open-call source
// themselves; this one fails if startup.ts stops building it, or stops handing it to the SessionTransport or to the server's deps.
//
// A real daemon (helpers/seat-posture-startup-daemon.ts, as for OF-267) on a database file and a PRIVATE hc core, with CODEX_HOME a temp
// folder holding a state_5.sqlite whose `threads` row names the seat's rollout, the way Codex records it. The seat's resume token is that
// thread; its rollout has a turn with one `exec` call and no output. Both of the daemon's own answers must name it.
//
// Runs on a host with `hc` only, like the OF-267 row. Not proven: a real Codex process (the rollout is written by the test, in the shape
// measured on this host's codex-cli 0.137-0.166 rollouts).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { EventBus } from "../src/domain/event-bus.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { hcTerminalName } from "../src/adapters/hc-seat.js";
import { HC, PrivateCore, until } from "./hc-private-core.js";

const here = dirname(fileURLToPath(import.meta.url));
const CHILD = resolve(here, "helpers/seat-posture-startup-daemon.ts");
const SEAT = "cx1@o31-rig";
const THREAD = "019a0000-0000-7000-8000-00000000o931";

interface Answers { viaTransport: { kind: string; tool: string | null; line: string } | null; viaRoute: { kind: string; tool: string | null } | null }

describe.skipIf(!HC)("a Codex seat's running tool, through the real createDaemon", () => {
  const core = new PrivateCore("o31");
  let dir: string;
  let db: string;
  let rigId: string;
  let codexHome: string;

  beforeAll(async () => {
    core.start();
    dir = mkdtempSync(join(core.root, "w-"));
    mkdirSync(join(dir, "h"), { recursive: true });
    codexHome = join(dir, "codex-home");
    mkdirSync(codexHome);
    const now = Date.now();
    const rollout = join(codexHome, "rollout-o9o31.jsonl");
    writeFileSync(rollout, [
      { timestamp: new Date(now - 90_000).toISOString(), type: "event_msg", payload: { type: "task_started" } },
      { timestamp: new Date(now - 30_000).toISOString(), type: "response_item", payload: { type: "custom_tool_call", call_id: "c1", name: "exec", status: "completed", input: "sleep 600" } },
    ].map((r) => JSON.stringify(r)).join("\n") + "\n");
    const state = new Database(join(codexHome, "state_5.sqlite"));
    state.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, source TEXT)");
    state.prepare("INSERT INTO threads (id, rollout_path, source) VALUES (?, ?, 'cli')").run(THREAD, rollout);
    state.close();

    db = join(dir, "d.sqlite");
    const handle = createDb(db);
    migrate(handle, ALL_MIGRATIONS);
    const repo = new RigRepository(handle);
    const sessions = new SessionRegistry(handle);
    const rig = repo.createRig("o31-rig");
    rigId = rig.id;
    const node = repo.addNode(rig.id, "cx1", { role: "worker", runtime: "codex", cwd: dir });
    const session = sessions.registerSession(node.id, SEAT);
    sessions.updateStatus(session.id, "running");
    // A live terminal for the seat on the private core, silent, as OF-267's row binds its seat.
    const terminal = await core.client.call<{ id: string }>("terminal.run", {
      argv: ["/bin/sh", "-c", "sleep 600"], name: hcTerminalName(SEAT), labels: { "openrig.seat": SEAT }, no_parent: true, no_notify: true, outlive_parent: true, cwd: dir,
    });
    sessions.updateBinding(node.id, { attachmentType: "hc", tmuxSession: SEAT, terminalAddress: terminal.id });
    expect(sessions.updateResumeToken(session.id, "codex", THREAD, "operator")).toBe(true);
    const generation = sessions.currentOccupantTenure(node.id)!.generationUuid;
    const store = new AgentActivityStore({ db: handle, eventBus: new EventBus(handle) });
    expect(store.recordHookEvent({ sessionName: SEAT, runtime: "codex", hookEvent: "UserPromptSubmit", subtype: null, occurredAt: new Date(now - 90_000).toISOString(), generation }).ok).toBe(true);
    handle.close();
  }, 60_000);
  afterAll(() => core.stop());

  it("the daemon's own transport and node list name the open exec", async () => {
    const out = join(dir, "answers.json");
    const env: NodeJS.ProcessEnv = {
      ...core.env, PATH: `${dirname(HC)}:/usr/bin:/bin`, TMPDIR: join(core.root, "h"), OPENRIG_HOME: join(core.root, "h", "openrig"), OPENRIG_NO_KERNEL: "1",
      CODEX_HOME: codexHome, SPS_DB: db, SPS_OUT: out, SPS_SEAT: SEAT, SPS_RIG: rigId,
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
    expect(answers.viaTransport, "startup hands the source to the SessionTransport").toMatchObject({ kind: "busy", tool: "exec" });
    expect(answers.viaTransport!.line).toMatch(/^busy: running exec for \d+ s \(since \d\d:\d\dZ\)$/);
    expect(answers.viaRoute, "the node list route sees it through the server's context").toMatchObject({ kind: "busy", tool: "exec" });
  }, 120_000);
});
