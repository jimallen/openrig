// workspaces-o9o.151 fix, attempt 3 (verify-sec2 FAIL 2; CoS rulings): (a) a credential-policy refusal of a Codex seat's auth link is
// its own error kind and stops the launch (no session is created), unlike an ordinary seeding failure; (b) the seat's existing
// auth.json is judged whether or not a shared source exists; (c) a hard-linked credential file (nlink > 1) is refused before any read
// or chmod, everywhere; (d) codex-seat-home judges through the port, with no file I/O of its own for it. Fake values only.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";
import { TmuxAdapter, type TmuxResult } from "../src/adapters/tmux.js";
import { codexSeatHomePath, ensureCodexSeatHome } from "../src/domain/codex-seat-home.js";
import { linkPiOperatorLogin } from "../src/adapters/pi-operator-login.js";
import { nodeCredentialFileReader, readCredentialFile } from "../src/adapters/node-credential-file-reader.js";
import { TERMINAL_TOKEN_POLICY } from "../src/domain/credential-file.js";

let dir: string;
beforeEach(() => { dir = fs.realpathSync(fs.mkdtempSync(nodePath.join(os.tmpdir(), "seat-refusal-"))); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });
const put = (p: string, text: string, mode: number) => { fs.writeFileSync(p, text); fs.chmodSync(p, mode); };
const exists = (p: string) => { try { fs.lstatSync(p); return true; } catch { return false; } };

/** A tmux host that only records the sessions it is asked to create (the TmuxAdapter subclass precedent: seat-message-removed-seat). */
class CountingTmux extends TmuxAdapter {
  readonly created: string[] = [];
  constructor() { super(async () => { throw new Error("stand-in: no exec"); }, undefined, async () => { throw new Error("stand-in: no exec"); }); }
  override async createSession(name: string): Promise<TmuxResult> { this.created.push(name); return { ok: true }; }
}

describe("(a) a refused shared Codex login stops the launch: no session is created", () => {
  it("NodeLauncher: a shared CODEX_HOME/auth.json others can read fails the launch, naming the file and the fix", async () => {
    const codex = nodePath.join(dir, "codex");
    fs.mkdirSync(codex, { mode: 0o700 });
    put(nodePath.join(codex, "auth.json"), '{"note":"login"}', 0o644);
    const db = createFullTestDb();
    const rigRepo = new RigRepository(db);
    const rig = rigRepo.createRig("refusal-rig");
    rigRepo.addNode(rig.id, "verify-qa", { role: "qa", runtime: "codex" });
    const tmux = new CountingTmux();
    const launcher = new NodeLauncher({
      db, rigRepo, sessionRegistry: new SessionRegistry(db), eventBus: new EventBus(db), tmuxAdapter: tmux,
      sessionEnv: { OPENRIG_HOME: nodePath.join(dir, "openrig"), CODEX_HOME: codex }, credentialFiles: nodeCredentialFileReader,
    });
    const result = await launcher.launchNode(rig.id, "verify-qa");
    expect(result).toMatchObject({ ok: false, code: "seat_credential_refused" });
    if (!result.ok) expect(result.message).toMatch(/auth\.json.*chmod 600/);
    expect(tmux.created).toEqual([]);
  });
});

describe("(b) the seat's existing auth.json is judged whether or not a shared source exists", () => {
  it("with no shared auth.json, a seat link someone made to another file refuses the launch and is kept", async () => {
    const codex = nodePath.join(dir, "codex");
    fs.mkdirSync(codex, { mode: 0o700 });
    const openrigHome = nodePath.join(dir, "openrig");
    const seatAuth = nodePath.join(codexSeatHomePath(openrigHome, "dev@r"), "auth.json");
    fs.mkdirSync(nodePath.dirname(seatAuth), { recursive: true });
    put(nodePath.join(dir, "other.json"), '{"note":"other"}', 0o600);
    fs.symlinkSync(nodePath.join(dir, "other.json"), seatAuth);
    await expect(ensureCodexSeatHome("dev@r", { openrigHome, sharedCodexHome: codex, log: () => {}, credentialFiles: nodeCredentialFileReader }))
      .rejects.toThrow(/auth\.json.*other\.json|auth\.json.*somewhere other than/);
    expect(fs.readlinkSync(seatAuth)).toBe(nodePath.join(dir, "other.json"));
  });
});

describe("(c) a hard-linked credential file is refused before any read or chmod", () => {
  it("the reader refuses a 0600 token that has a second name", () => {
    const p = nodePath.join(dir, "token");
    put(p, "abc", 0o600);
    fs.linkSync(p, nodePath.join(dir, "second-name"));
    expect(readCredentialFile(p, TERMINAL_TOKEN_POLICY)).toMatchObject({ ok: false, problem: "hard_linked" });
  });

  it("the Pi stub narrowing never chmods a hard-linked other name", () => {
    const state = nodePath.join(dir, "state");
    const agentDir = nodePath.join(state, "seat@t", "agent");
    const operator = nodePath.join(dir, "operator");
    fs.mkdirSync(agentDir, { recursive: true }); fs.mkdirSync(operator);
    put(nodePath.join(operator, "auth.json"), '{"note":"operator"}', 0o600);
    const other = nodePath.join(dir, "someone-elses-file");
    put(other, "{}", 0o644);
    fs.linkSync(other, nodePath.join(agentDir, "auth.json"));
    linkPiOperatorLogin({ stateRoot: state, agentDir, sessionName: "seat@t", operatorDir: operator, linkModels: false });
    expect(fs.statSync(other).mode & 0o777).toBe(0o644);
  });

  it("a hard-linked shared Codex login is not linked into a seat", async () => {
    const codex = nodePath.join(dir, "codex");
    fs.mkdirSync(codex, { mode: 0o700 });
    put(nodePath.join(codex, "auth.json"), '{"note":"login"}', 0o600);
    fs.linkSync(nodePath.join(codex, "auth.json"), nodePath.join(dir, "auth-second-name.json"));
    const openrigHome = nodePath.join(dir, "openrig");
    await expect(ensureCodexSeatHome("dev@r", { openrigHome, sharedCodexHome: codex, log: () => {}, credentialFiles: nodeCredentialFileReader })).rejects.toThrow(/hard link/);
    expect(exists(nodePath.join(codexSeatHomePath(openrigHome, "dev@r"), "auth.json"))).toBe(false);
  });
});

describe("(d) codex-seat-home judges through the port, with no file I/O of its own for it", () => {
  it("opens no file itself (no fs.open, no handle stat)", () => {
    const src = fs.readFileSync(nodePath.resolve(import.meta.dirname, "../src/domain/codex-seat-home.ts"), "utf8");
    expect(src.match(/\bfs\.open\(|handle\.stat\(|\bopenSync\(|\bfstatSync\(/g) ?? []).toEqual([]);
  });
});
