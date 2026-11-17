// workspaces-o9o.87: a Codex seat's message gate reads the rollout of the seat's CURRENT session. The lookup took the newest session row that
// had a resume token, so a seat relaunched fresh (its new session's token not yet known) had its gate read the PREVIOUS session's thread: a
// message delivered into the current rollout read "not seen", and the pump would deliver it again.
//
// A real daemon (helpers/codex-gate-startup-daemon.ts) on a database file and a PRIVATE hc core, with CODEX_HOME a temp folder holding a
// state_5.sqlite whose `threads` row names the OLD session's rollout. The seat's gate.json (what the relay writes at SessionStart) declares the
// CURRENT rollout, which holds the delivered message's marker; the old rollout does not. Asked through the gate startup built, the message must
// read seen.
//
// Runs on a host with `hc` only, like the OF-267 and o9o.31 rows. Not proven: a real Codex process (the rollouts are written by the test, in the
// record shape codex-seat-gate.ts reads, measured on a real 0.166.0 rollout).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { hcTerminalName } from "../src/adapters/hc-seat.js";
import { seatGateFolder, seatGateRoot } from "../src/adapters/hook-seen-store.js";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { MessageStore } from "../src/domain/seat-messaging/message-store.js";
import { messageId } from "../src/domain/seat-messaging/ports.js";
import { HC, PrivateCore, until } from "./hc-private-core.js";

const here = dirname(fileURLToPath(import.meta.url));
const CHILD = resolve(here, "helpers/codex-gate-startup-daemon.ts");
const SEAT = "cx1@o87-rig";
const OLD_THREAD = "019a0000-0000-7000-8000-0000000old87";
const MESSAGE = "o87-msg-1";
const NONCE = "a1b2c3d4e5f60087";  // a marker nonce is 16 to 64 hex characters (seat-gate-marker MARKER_LINE)
/** A seat whose CURRENT session has its token: the gate reads that thread, whatever gate.json says (here it names no file). */
const TOKEN_SEAT = "cx2@o87-rig";
const CURRENT_THREAD = "019a0000-0000-7000-8000-000000cur087";
const TOKEN_MESSAGE = "o87-msg-2";
const TOKEN_NONCE = "b2c3d4e5f6a10087";

/** A user prompt record carrying `text`, in the shape the Codex gate reads (codexRolloutMarkers). */
const prompt = (text: string) => JSON.stringify({ timestamp: new Date().toISOString(), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } });

describe.skipIf(!HC)("a Codex seat's message gate reads its current session's rollout, through the real createDaemon", () => {
  const core = new PrivateCore("o87");
  let dir: string;
  let db: string;
  let home: string;
  let codexHome: string;

  beforeAll(async () => {
    core.start();
    dir = mkdtempSync(join(core.root, "w-"));
    home = join(core.root, "h", "openrig");
    mkdirSync(home, { recursive: true });
    codexHome = join(dir, "codex-home");
    mkdirSync(codexHome);
    // The previous session's thread: an earlier prompt, not this message.
    const oldRollout = join(codexHome, "rollout-old.jsonl");
    writeFileSync(oldRollout, `${prompt("an earlier prompt")}\n`);
    // The current session's rollout: this message, delivered.
    const currentRollout = join(codexHome, "rollout-current.jsonl");
    writeFileSync(currentRollout, `${prompt(`hello\n[openrig-msg ${MESSAGE}:${NONCE}]`)}\n`);
    const state = new Database(join(codexHome, "state_5.sqlite"));
    state.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, source TEXT)");
    state.prepare("INSERT INTO threads (id, rollout_path, source) VALUES (?, ?, 'cli')").run(OLD_THREAD, oldRollout);
    const tokenRollout = join(codexHome, "rollout-cx2.jsonl");
    writeFileSync(tokenRollout, `${prompt(`hello\n[openrig-msg ${TOKEN_MESSAGE}:${TOKEN_NONCE}]`)}\n`);
    state.prepare("INSERT INTO threads (id, rollout_path, source) VALUES (?, ?, 'cli')").run(CURRENT_THREAD, tokenRollout);
    state.close();

    db = join(dir, "d.sqlite");
    const handle = createDb(db);
    migrate(handle, ALL_MIGRATIONS);
    const repo = new RigRepository(handle);
    const sessions = new SessionRegistry(handle);
    const rig = repo.createRig("o87-rig");
    const node = repo.addNode(rig.id, "cx1", { role: "worker", runtime: "codex", cwd: dir });
    const previous = sessions.registerSession(node.id, SEAT);
    expect(sessions.updateResumeToken(previous.id, "codex", OLD_THREAD, "operator")).toBe(true);
    sessions.updateStatus(previous.id, "exited");
    const current = sessions.registerSession(node.id, SEAT, "fresh");
    sessions.updateStatus(current.id, "running");
    const terminal = await core.client.call<{ id: string }>("terminal.run", {
      argv: ["/bin/sh", "-c", "sleep 600"], name: hcTerminalName(SEAT), labels: { "openrig.seat": SEAT }, no_parent: true, no_notify: true, outlive_parent: true, cwd: dir,
    });
    sessions.updateBinding(node.id, { attachmentType: "hc", tmuxSession: SEAT, terminalAddress: terminal.id });
    const node2 = repo.addNode(rig.id, "cx2", { role: "worker", runtime: "codex", cwd: dir });
    const session2 = sessions.registerSession(node2.id, TOKEN_SEAT);
    expect(sessions.updateResumeToken(session2.id, "codex", CURRENT_THREAD, "operator")).toBe(true);
    sessions.updateStatus(session2.id, "running");
    const terminal2 = await core.client.call<{ id: string }>("terminal.run", {
      argv: ["/bin/sh", "-c", "sleep 600"], name: hcTerminalName(TOKEN_SEAT), labels: { "openrig.seat": TOKEN_SEAT }, no_parent: true, no_notify: true, outlive_parent: true, cwd: dir,
    });
    sessions.updateBinding(node2.id, { attachmentType: "hc", tmuxSession: TOKEN_SEAT, terminalAddress: terminal2.id });
    // Each message, already ended (so the daemon's pump leaves it alone), with the nonce its marker carries.
    const store = new MessageStore(handle);
    for (const [id, seat, nonce] of [[MESSAGE, SEAT, NONCE], [TOKEN_MESSAGE, TOKEN_SEAT, TOKEN_NONCE]] as const) {
      store.accept({ id: messageId(id), seat, sender: "lead@o87-rig", body: "hello", messageClass: "content" });
      handle.prepare("UPDATE outbox_entries SET native_nonce = ?, message_state = 'received' WHERE outbox_id = ?").run(nonce, id);
    }
    handle.close();
    const gateDir2 = join(seatGateRoot(home), seatGateFolder(TOKEN_SEAT));
    mkdirSync(gateDir2, { recursive: true });
    writeFileSync(join(gateDir2, "gate.json"), JSON.stringify({ version: 3 }));
    // What the relay writes at the current session's SessionStart: this seat's gate, and the file its prompts land in.
    const gateDir = join(seatGateRoot(home), seatGateFolder(SEAT));
    mkdirSync(gateDir, { recursive: true });
    writeFileSync(join(gateDir, "gate.json"), JSON.stringify({ version: 3, transcriptPath: currentRollout }));
  }, 60_000);
  afterAll(() => core.stop());

  /** The gate's answer, from the daemon startup built, for one message to one seat. */
  async function ask(seat: string, message: string): Promise<{ hasGate: boolean; answer: { kind: string } | null }> {
    const out = join(dir, `answer-${message}.json`);
    const env: NodeJS.ProcessEnv = {
      ...core.env, PATH: `${dirname(HC)}:/usr/bin:/bin`, TMPDIR: join(core.root, "h"), OPENRIG_HOME: home, OPENRIG_NO_KERNEL: "1",
      CODEX_HOME: codexHome, CGS_DB: db, CGS_OUT: out, CGS_SEAT: seat, CGS_MESSAGE: message,
    };
    const stderr: string[] = [];
    const child = spawn(process.execPath, ["--import", "tsx", CHILD], { cwd: resolve(here, ".."), env, stdio: ["ignore", "ignore", "pipe"] });
    child.stderr?.on("data", (b: Buffer) => { stderr.push(b.toString()); if (stderr.length > 40) stderr.shift(); });
    try {
      await until(async () => existsSync(out) || child.exitCode !== null, (done) => done, "the daemon's answer", 90_000);
      if (!existsSync(out)) throw new Error(`daemon died: ${stderr.join("").slice(0, 1500)}`);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    return JSON.parse(readFileSync(out, "utf8")) as { hasGate: boolean; answer: { kind: string } | null };
  }

  it("a seat relaunched fresh, its token not yet known: a message in its current rollout reads seen, not the previous thread's not seen", async () => {
    const result = await ask(SEAT, MESSAGE);
    expect(result.hasGate, "startup built a gate for the Codex seat").toBe(true);
    expect(result.answer).toMatchObject({ kind: "seen" });
  }, 120_000);

  it("a seat whose current session has its token: the gate reads that session's thread", async () => {
    const result = await ask(TOKEN_SEAT, TOKEN_MESSAGE);
    expect(result.hasGate).toBe(true);
    expect(result.answer).toMatchObject({ kind: "seen" });
  }, 120_000);
});
