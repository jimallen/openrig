// workspaces-o9o.151 fix (verify-sec2 FAIL F1, F2; CoS rulings). F1: the seat's 2-byte auth.json stub is read through the credential
// rule (O_NOFOLLOW on the opened file), so a name swapped to a link between the lstat and the read is never read through or replaced.
// F2: a Codex seat's auth.json link is made only to a shared CODEX_HOME/auth.json that passes the codex-auth policy, and an existing
// destination is judged too: a failing source, or a link someone made to another file, refuses the seat's launch naming the file
// and the fix; a link someone made is never silently replaced. Every fixture sets its own mode; the values are fake.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { linkPiOperatorLogin, realPiOperatorLoginFs, type PiOperatorLoginFs } from "../src/adapters/pi-operator-login.js";
import { codexSeatHomePath, ensureCodexSeatHome } from "../src/domain/codex-seat-home.js";

let dir: string;
beforeEach(() => { dir = fs.realpathSync(fs.mkdtempSync(nodePath.join(os.tmpdir(), "seat-links-fix-"))); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });
const put = (p: string, text: string, mode: number) => { fs.writeFileSync(p, text); fs.chmodSync(p, mode); };

describe("F1: the seat's 2-byte stub is read under the rule, never through a swapped-in link", () => {
  it("a stub swapped to a link after the lstat is left alone, not read through and replaced", () => {
    const state = nodePath.join(dir, "state");
    const operator = nodePath.join(dir, "operator");
    const agentDir = nodePath.join(state, "seat@t", "agent");
    fs.mkdirSync(operator); fs.mkdirSync(agentDir, { recursive: true });
    put(nodePath.join(operator, "auth.json"), '{"note":"operator"}', 0o600);
    const elsewhere = nodePath.join(dir, "elsewhere.json");
    put(elsewhere, "{}", 0o600);
    const regularTwin = nodePath.join(dir, "twin.json");
    put(regularTwin, "{}", 0o600);
    const seatAuth = nodePath.join(agentDir, "auth.json");
    fs.symlinkSync(elsewhere, seatAuth);
    // The window verify-sec2 named: the lstat sees a regular 2-byte stub, the read finds a link.
    const swapped: PiOperatorLoginFs = { ...realPiOperatorLoginFs, lstat: (p) => (p === seatAuth ? fs.lstatSync(regularTwin) : realPiOperatorLoginFs.lstat(p)) };
    linkPiOperatorLogin({ stateRoot: state, agentDir, sessionName: "seat@t", operatorDir: operator, linkModels: false, fsOps: swapped });
    expect(fs.readlinkSync(seatAuth)).toBe(elsewhere);
  });
});

describe("F2: a Codex seat's auth.json link is made and kept only to a shared login that passes the rule", () => {
  const shared = () => nodePath.join(dir, "codex");
  const openrigHome = () => nodePath.join(dir, "openrig");
  const seatAuth = () => nodePath.join(codexSeatHomePath(openrigHome(), "dev@r"), "auth.json");
  const launch = () => ensureCodexSeatHome("dev@r", { openrigHome: openrigHome(), sharedCodexHome: shared(), log: () => {} });
  beforeEach(() => { fs.mkdirSync(shared(), { mode: 0o700 }); fs.mkdirSync(openrigHome(), { mode: 0o700 }); });

  it("CONTROL: a 0600 shared auth.json of ours is linked", async () => {
    put(nodePath.join(shared(), "auth.json"), '{"note":"login"}', 0o600);
    await launch();
    expect(fs.readlinkSync(seatAuth())).toBe(nodePath.join(shared(), "auth.json"));
  });

  it("refuses the launch on a shared auth.json others can read (verify-sec2's probe), naming it and the fix, and links nothing", async () => {
    put(nodePath.join(shared(), "auth.json"), '{"note":"login"}', 0o644);
    await expect(launch()).rejects.toThrow(/auth\.json.*chmod 600/);
    expect(fs.existsSync(seatAuth()) || (() => { try { fs.lstatSync(seatAuth()); return true; } catch { return false; } })()).toBe(false);
  });

  it("refuses the launch on an existing seat link to another file (verify-sec2's probe), and leaves that link as someone made it", async () => {
    put(nodePath.join(shared(), "auth.json"), '{"note":"login"}', 0o600);
    const other = nodePath.join(dir, "other-auth.json");
    put(other, '{"note":"other"}', 0o600);
    fs.mkdirSync(codexSeatHomePath(openrigHome(), "dev@r"), { recursive: true });
    fs.symlinkSync(other, seatAuth());
    await expect(launch()).rejects.toThrow(/auth\.json.*other-auth\.json/);
    expect(fs.readlinkSync(seatAuth())).toBe(other);
  });

  it("refuses the launch when the shared auth.json is itself a link (a link is followed only from the seat, to the shared file)", async () => {
    const real = nodePath.join(dir, "real-auth.json");
    put(real, '{"note":"login"}', 0o600);
    fs.symlinkSync(real, nodePath.join(shared(), "auth.json"));
    await expect(launch()).rejects.toThrow(/auth\.json.*symbolic link/);
  });

  it("refuses the launch when the seat's own auth.json (it signed in itself) is readable by others, and leaves it", async () => {
    put(nodePath.join(shared(), "auth.json"), '{"note":"login"}', 0o600);
    fs.mkdirSync(codexSeatHomePath(openrigHome(), "dev@r"), { recursive: true });
    put(seatAuth(), '{"note":"seat"}', 0o644);
    await expect(launch()).rejects.toThrow(/auth\.json.*chmod 600/);
    expect(fs.lstatSync(seatAuth()).isFile()).toBe(true);
  });

  it("CONTROL: an existing seat link to the shared login is kept, and the shared file is still judged", async () => {
    put(nodePath.join(shared(), "auth.json"), '{"note":"login"}', 0o600);
    fs.mkdirSync(codexSeatHomePath(openrigHome(), "dev@r"), { recursive: true });
    fs.symlinkSync(nodePath.join(shared(), "auth.json"), seatAuth());
    await launch();
    fs.chmodSync(nodePath.join(shared(), "auth.json"), 0o644);
    await expect(launch()).rejects.toThrow(/chmod 600/);
  });
});
