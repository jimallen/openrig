// workspaces-o9o.151: switching the Codex profile copies a saved profile onto the active auth, so the profile is a secret read under
// the credential rule: it must really live in CODEX_HOME's profile dir (verify-sec's probe: a 0644 profile in a symlinked dir was
// copied), be a plain file of this user's with no group/other bits, and fit the size cap. A refusal writes nothing.
// The values here are fake and not credential-shaped. Every fixture sets its own mode.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { authSwitch, resolveCodexHome } from "../src/lib/codex-auth.js";

let root: string;
let paths: ReturnType<typeof resolveCodexHome>;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codex-cred-")));
  fs.mkdirSync(path.join(root, "home"), { mode: 0o700 });
  paths = resolveCodexHome({ CODEX_HOME: path.join(root, "home") });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const PROFILE = JSON.stringify({ auth_mode: "chatgpt", tokens: { note: "fake-profile-body" } });
function profile(mode: number, dir = paths.profileDir): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const p = path.join(dir, "work.json");
  fs.writeFileSync(p, PROFILE);
  fs.chmodSync(p, mode);
}
const activeExists = () => { try { fs.lstatSync(paths.activeAuth); return true; } catch { return false; } };

describe("authSwitch copies only a profile that passes the credential rule (o9o.151)", () => {
  it("CONTROL: a 0600 profile in CODEX_HOME's profile dir is activated at 0600", () => {
    profile(0o600);
    expect(authSwitch(paths, "work")).toMatchObject({ ok: true });
    expect(fs.readFileSync(paths.activeAuth, "utf8")).toBe(PROFILE);
    expect(fs.statSync(paths.activeAuth).mode & 0o777).toBe(0o600);
  });

  it("refuses a profile dir that is a symlink out of CODEX_HOME (verify-sec's probe), and writes nothing", () => {
    const outside = path.join(root, "outside-profiles");
    profile(0o600, outside);
    fs.symlinkSync(outside, paths.profileDir);
    expect(authSwitch(paths, "work")).toEqual({ ok: false, reason: "unsafe_path" });
    expect(activeExists()).toBe(false);
  });

  it("refuses the probe exactly as found: a 0644 profile in a symlinked dir", () => {
    const outside = path.join(root, "outside-profiles");
    profile(0o644, outside);
    fs.symlinkSync(outside, paths.profileDir);
    expect(authSwitch(paths, "work").ok).toBe(false);
    expect(activeExists()).toBe(false);
  });

  it("refuses a profile others can read, and writes nothing", () => {
    profile(0o644);
    expect(authSwitch(paths, "work")).toEqual({ ok: false, reason: "unsafe_permissions" });
    expect(activeExists()).toBe(false);
  });

  it("refuses a profile the group can read", () => {
    profile(0o640);
    expect(authSwitch(paths, "work")).toEqual({ ok: false, reason: "unsafe_permissions" });
  });
});
