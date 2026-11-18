// workspaces-o9o.160: Codex's config.toml chooses the provider credential, so it is read under the credential rule. It is Codex's
// (or the operator's) file: OpenRig never chmods it. A link OpenRig did not make, another user's file, or one others can change is
// refused (CoS 13:51Z, from the live census); a Codex seat's config.toml linked to the shared CODEX_HOME config (OF-183) is the named
// exception (SEAT_CREDENTIAL_LINKS codex-config). Every fixture sets its own mode.
import { TMP_CREDENTIAL_FILES } from "./helpers/credential-files.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultInPlaceRestartIo } from "../src/domain/seat-restart-in-place.js";
import { codexSeatHomePath, ensureCodexSeatHome } from "../src/domain/codex-seat-home.js";
import { probeCodexReadiness } from "../src/domain/kernel-boot.js";

let dir: string;
let shared: string;
let seat: string;
beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codex-config-")));
  shared = path.join(dir, "codex-home");
  seat = path.join(dir, "seat-home");
  fs.mkdirSync(shared, { mode: 0o700 });
  fs.mkdirSync(seat, { mode: 0o700 });
  vi.stubEnv("CODEX_HOME", shared);
});
afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(dir, { recursive: true, force: true }); });

const STORE = 'cli_auth_credentials_store = "file"\n';
const put = (p: string, text: string, mode: number) => { fs.writeFileSync(p, text); fs.chmodSync(p, mode); };

describe("the in-place restart reads a seat's config.toml under the rule (o9o.160)", () => {
  const io = () => defaultInPlaceRestartIo();

  it("CONTROL: a plain config.toml of ours is read", () => {
    put(path.join(seat, "config.toml"), STORE, 0o644);
    expect(io().readCredentialStore(seat)).toBe("file");
  });

  it("follows the seat's OpenRig-made link to the shared CODEX_HOME config", () => {
    put(path.join(shared, "config.toml"), STORE, 0o600);
    fs.symlinkSync(path.join(shared, "config.toml"), path.join(seat, "config.toml"));
    expect(io().readCredentialStore(seat)).toBe("file");
  });

  it("treats a link to anywhere else as unreadable (the backend in effect is unknown)", () => {
    put(path.join(dir, "elsewhere.toml"), STORE, 0o600);
    fs.symlinkSync(path.join(dir, "elsewhere.toml"), path.join(seat, "config.toml"));
    expect(io().readCredentialStore(seat)).toBeUndefined();
  });

  it("treats a config.toml others can change as unreadable, and never chmods it", () => {
    put(path.join(seat, "config.toml"), STORE, 0o664);
    expect(io().readCredentialStore(seat)).toBeUndefined();
    expect(fs.statSync(path.join(seat, "config.toml")).mode & 0o777).toBe(0o664);
  });
});

describe("the kernel boot probe does not choose a credential from a refused config (o9o.160)", () => {
  it("reports Codex unavailable when the config is refused, without running a probe", async () => {
    let ran = false;
    const status = await probeCodexReadiness({ run: async () => { ran = true; return "ok"; }, readConfig: () => ({ refused: "the Codex config x can be changed by other users" }), env: {} });
    expect(status).toBe("unavailable");
    expect(ran).toBe(false);
  });
});

describe("a Codex seat's config.toml link is made and kept only to a shared config that passes the rule (o9o.160, the F2 shape)", () => {
  const openrigHome = () => path.join(dir, "openrig");
  const seatConfig = () => path.join(codexSeatHomePath(openrigHome(), "dev@r"), "config.toml");
  const launch = () => ensureCodexSeatHome("dev@r", { openrigHome: openrigHome(), sharedCodexHome: shared, log: () => {}, credentialFiles: TMP_CREDENTIAL_FILES });
  beforeEach(() => { fs.mkdirSync(path.join(dir, "openrig"), { mode: 0o700 }); });

  it("CONTROL: a shared config others may read but not change is linked", async () => {
    put(path.join(shared, "config.toml"), STORE, 0o644);
    await launch();
    expect(fs.readlinkSync(seatConfig())).toBe(path.join(shared, "config.toml"));
  });

  it("refuses the launch on a shared config others can change, and links nothing", async () => {
    put(path.join(shared, "config.toml"), STORE, 0o664);
    await expect(launch()).rejects.toThrow(/config\.toml.*chmod go-w/);
    expect(() => fs.lstatSync(seatConfig())).toThrow();
  });

  it("refuses the launch on an existing seat config link to another file, and leaves that link", async () => {
    put(path.join(shared, "config.toml"), STORE, 0o644);
    const other = path.join(dir, "other.toml");
    put(other, STORE, 0o644);
    fs.mkdirSync(codexSeatHomePath(openrigHome(), "dev@r"), { recursive: true });
    fs.symlinkSync(other, seatConfig());
    await expect(launch()).rejects.toThrow(/config\.toml.*other\.toml/);
    expect(fs.readlinkSync(seatConfig())).toBe(other);
  });
});
