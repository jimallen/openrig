import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  ensureCodexSeatHome,
  codexProfileIdentityVars,
  codexSeatHomePath,
  mirrorCodexHookTrust,
  sanitizeSessionForPath,
} from "../src/domain/codex-seat-home.js";
import { computeCodexHookTrust } from "../src/adapters/codex-runtime-adapter.js";

let tmp: string;
let openrigHome: string;
let shared: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "codex-seat-home-test-"));
  openrigHome = path.join(tmp, ".openrig");
  shared = path.join(tmp, ".codex");
  await fs.mkdir(shared, { recursive: true });
  await fs.writeFile(path.join(shared, "auth.json"), "{}");
  await fs.writeFile(path.join(shared, "config.toml"), "");
  await fs.mkdir(path.join(shared, "packages", "app-server-daemon", "releases", "0.158.0-aarch64-apple-darwin", "bin"), { recursive: true });
  await fs.writeFile(path.join(shared, "packages", "app-server-daemon", "releases", "0.158.0-aarch64-apple-darwin", "bin", "codex"), "fake");
  await fs.symlink(
    path.join(shared, "packages", "app-server-daemon", "releases", "0.158.0-aarch64-apple-darwin"),
    path.join(shared, "packages", "app-server-daemon", "current"),
  );
  await fs.writeFile(path.join(shared, "packages", "app-server-daemon", "auto-update-version"), "0.158.0-aarch64-apple-darwin");
  await fs.mkdir(path.join(shared, "packages", "other-package"));
  await fs.writeFile(path.join(shared, "rig-yolo.config.toml"), "approval_policy = \"never\"\n");
  // runtime state that must NOT be shared into seat homes
  await fs.writeFile(path.join(shared, "history.jsonl"), "");
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("codex-seat-home", () => {
  it("places the seat home under <openrigHome>/codex-seats/<session>, keeping @", async () => {
    expect(sanitizeSessionForPath("verify-qa@jims-team")).toBe("verify-qa@jims-team");
    const home = await ensureCodexSeatHome("verify-qa@jims-team", { openrigHome, sharedCodexHome: shared });
    expect(home.path).toBe(codexSeatHomePath(openrigHome, "verify-qa@jims-team"));
    const stat = await fs.lstat(home.path);
    expect(stat.isDirectory()).toBe(true);
  });

  it("bounds long session names (SUN_LEN: codex app-server unix sockets live under the home)", async () => {
    // 'verify-qa@jims-team-rfp-rulz' measured failing in production with
    // 'shorter than SUN_LEN' — the daemon socket path could not bind.
    const short = sanitizeSessionForPath("verify-qa@jims-team-rfp-rulz");
    expect(short.length).toBeLessThanOrEqual(24);
    expect(short.startsWith("verify-qa@")).toBe(true);
    // deterministic + distinct per session, so two long instance names never collide
    expect(short).toBe(sanitizeSessionForPath("verify-qa@jims-team-rfp-rulz"));
    expect(short).not.toBe(sanitizeSessionForPath("verify-qa@jims-team-other"));
    // no-@ names also bound
    expect(sanitizeSessionForPath("x".repeat(100)).length).toBeLessThanOrEqual(24);
  });

  it("symlinks shared account material but copies profile fragments", async () => {
    const home = await ensureCodexSeatHome("verify-qa@jims-team", { openrigHome, sharedCodexHome: shared });
    const auth = await fs.lstat(path.join(home.path, "auth.json"));
    expect(auth.isSymbolicLink()).toBe(true);
    const pkgs = await fs.lstat(path.join(home.path, "packages"));
    expect(pkgs.isDirectory() && !pkgs.isSymbolicLink()).toBe(true); // real dir: app-server bookkeeping must be seat-local

    const profile = await fs.lstat(path.join(home.path, "rig-yolo.config.toml"));
    // copied, not linked: canonical path stays per-seat (distinct codex resume keys)
    expect(profile.isSymbolicLink()).toBe(false);
    expect(await fs.readFile(path.join(home.path, "rig-yolo.config.toml"), "utf8"))
      .toContain("approval_policy");
    expect(home.copiedProfiles).toContain("rig-yolo.config.toml");

    // app-server payload shared via releases symlink; `current` rooted INSIDE
    // the seat home so another seat's install can never repoint it away
    const releases = await fs.lstat(path.join(home.path, "packages", "app-server-daemon", "releases"));
    expect(releases.isSymbolicLink()).toBe(true);
    const current = await fs.readlink(path.join(home.path, "packages", "app-server-daemon", "current"));
    expect(current.startsWith(home.path)).toBe(true);
    const daemonBin = path.join(home.path, "packages", "app-server-daemon", "current", "bin", "codex");
    expect(await fs.readFile(daemonBin, "utf8")).toBe("fake"); // resolves through the link chain

    // runtime state never leaks in
    await expect(fs.lstat(path.join(home.path, "history.jsonl"))).rejects.toThrow();
  });

  it("is idempotent and never overwrites a working seat home", async () => {
    const first = await ensureCodexSeatHome("exec-cos@jims-team", { openrigHome, sharedCodexHome: shared });
    // operator/scratch writes inside the seat home must survive a re-seed
    await fs.writeFile(path.join(first.path, "notes.md"), "seat work product");
    await fs.writeFile(path.join(shared, "new-thing"), "x");
    const second = await ensureCodexSeatHome("exec-cos@jims-team", { openrigHome, sharedCodexHome: shared });
    expect(second.path).toBe(first.path);
    expect(await fs.readFile(path.join(first.path, "notes.md"), "utf8")).toBe("seat work product");
  });

  it("tolerates a missing shared codex home (codex bootstraps its own state)", async () => {
    await fs.rm(shared, { recursive: true, force: true });
    const home = await ensureCodexSeatHome("build-impl@jims-team", { openrigHome, sharedCodexHome: shared });
    const stat = await fs.lstat(home.path);
    expect(stat.isDirectory()).toBe(true);
    expect(home.linked).toHaveLength(0);
    expect(home.copiedProfiles).toHaveLength(0);
  });
});

describe("copied profiles never carry a seat identity (OF-43)", () => {
  const DIRTY = 'approval_policy = "never"\n[shell_environment_policy.set]\nOPENRIG_SESSION_NAME = "verify-ops@jims-team"\n';
  it("control: a clean shared profile is copied and nothing is refused", async () => {
    const home = await ensureCodexSeatHome("a-b@r", { openrigHome, sharedCodexHome: shared, log: () => {} });
    expect(home.copiedProfiles).toEqual(["rig-yolo.config.toml"]);
    expect(home.refusedProfiles).toEqual([]);
  });
  it("does not copy a shared profile that sets an identity variable, and says which, never the value", async () => {
    await fs.writeFile(path.join(shared, "rig-yolo.config.toml"), DIRTY);
    const logs: string[] = [];
    const home = await ensureCodexSeatHome("a-b@r", { openrigHome, sharedCodexHome: shared, log: (m) => logs.push(m) });
    expect(home.refusedProfiles).toEqual(["rig-yolo.config.toml"]);
    await expect(fs.lstat(path.join(home.path, "rig-yolo.config.toml"))).rejects.toThrow();
    expect(logs.join("\n")).toContain("OPENRIG_SESSION_NAME");
    expect(logs.join("\n")).not.toContain("verify-ops");
  });
  it("moves an already-copied profile aside on a later launch, then copies the clean source", async () => {
    const first = await ensureCodexSeatHome("a-b@r", { openrigHome, sharedCodexHome: shared, log: () => {} });
    await fs.writeFile(path.join(first.path, "rig-yolo.config.toml"), DIRTY);
    const again = await ensureCodexSeatHome("a-b@r", { openrigHome, sharedCodexHome: shared, log: () => {} });
    expect(again.refusedProfiles).toEqual(["rig-yolo.config.toml"]);
    const asides = (await fs.readdir(first.path)).filter((f) => f.startsWith("rig-yolo.config.toml.refused-openrig-identity"));
    expect(asides).toHaveLength(1);
    expect(await fs.readFile(path.join(first.path, asides[0]!), "utf8")).toBe(DIRTY);
    expect(await fs.readFile(path.join(first.path, "rig-yolo.config.toml"), "utf8")).not.toContain("OPENRIG_");
  });
  it.each([
    ["inline table", 'shell_environment_policy = { set = { OPENRIG_NODE_ID = "x" } }\n', "OPENRIG_NODE_ID"],
    ["mcp server env", '[mcp_servers.s.env]\nOPENRIG_OCCUPANT_GENERATION = "3"\n', "OPENRIG_OCCUPANT_GENERATION"],
    ["NAME=value string", 'env = ["OPENRIG_ACTIVITY_HOOK_TOKEN=zzz"]\n', "OPENRIG_ACTIVITY_HOOK_TOKEN"],
    ["unparseable text", "OPENRIG_RUNTIME = = oops\n", "OPENRIG_RUNTIME"],
  ])("detects %s", (_label, text, name) => {
    expect(codexProfileIdentityVars(text)).toEqual([name]);
  });
  it("a second refusal keeps the first moved-aside copy (nothing is overwritten)", async () => {
    const first = await ensureCodexSeatHome("a-b@r", { openrigHome, sharedCodexHome: shared, log: () => {} });
    const copy = path.join(first.path, "rig-yolo.config.toml");
    const editA = DIRTY + "# seat edit A\n";
    const editB = DIRTY + "# seat edit B\n";
    await fs.writeFile(copy, editA);
    await ensureCodexSeatHome("a-b@r", { openrigHome, sharedCodexHome: shared, log: () => {} });
    await fs.writeFile(copy, editB);
    await ensureCodexSeatHome("a-b@r", { openrigHome, sharedCodexHome: shared, log: () => {} });
    const asides = (await fs.readdir(first.path)).filter((f) => f.startsWith("rig-yolo.config.toml.refused-openrig-identity"));
    expect(asides).toHaveLength(2);
    const bodies = await Promise.all(asides.map((f) => fs.readFile(path.join(first.path, f), "utf8")));
    expect(bodies.sort()).toEqual([editA, editB]);
  });
  it("two refusals in the same millisecond still keep both copies", async () => {
    const first = await ensureCodexSeatHome("a-b@r", { openrigHome, sharedCodexHome: shared, log: () => {} });
    const copy = path.join(first.path, "rig-yolo.config.toml");
    const spy = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    try {
      await fs.writeFile(copy, DIRTY + "# A\n");
      await ensureCodexSeatHome("a-b@r", { openrigHome, sharedCodexHome: shared, log: () => {} });
      await fs.writeFile(copy, DIRTY + "# B\n");
      await ensureCodexSeatHome("a-b@r", { openrigHome, sharedCodexHome: shared, log: () => {} });
    } finally {
      spy.mockRestore();
    }
    const asides = (await fs.readdir(first.path)).filter((f) => f.startsWith("rig-yolo.config.toml.refused-openrig-identity"));
    expect(asides).toHaveLength(2);
  });
  // The cli, hooks and daemon fall back to these when the OPENRIG_ name is empty, and a profile's
  // shell_environment_policy can empty it (OF-43 trial copy: a session name set, the node id stripped).
  it.each([
    "RIGGED_NODE_ID", "RIGGED_SESSION_NAME", "RIGGED_RUNTIME", "RIGGED_OCCUPANT_GENERATION", "RIGGED_ACTIVITY_HOOK_TOKEN",
  ])("detects the legacy alias %s set through shell_environment_policy", (name) => {
    const text = `[shell_environment_policy]\ninherit = "core"\nexclude = ["OPENRIG_*"]\nset = { ${name} = "other-seat" }\n`;
    expect(codexProfileIdentityVars(text)).toEqual([name]);
  });
  it.each([
    ["after export", "export OPENRIG_SESSION_NAME=v"],
    ["after &&", "cd /x && OPENRIG_SESSION_NAME=v rig send"],
    ["after a leading space", " OPENRIG_SESSION_NAME=v"],
    ["after a semicolon", "true;OPENRIG_SESSION_NAME=v"],
  ])("detects NAME=value inside a shell string %s", (_label, str) => {
    expect(codexProfileIdentityVars(`args = ${JSON.stringify(["-c", str])}\n`)).toEqual(["OPENRIG_SESSION_NAME"]);
  });
  it("does not flag a longer name that merely ends in an identity name", () => {
    expect(codexProfileIdentityVars('args = ["-c", "MY_OPENRIG_SESSION_NAME=v"]\n')).toEqual([]);
  });
  it("does not flag non-identity OPENRIG_ settings or comments", () => {
    expect(codexProfileIdentityVars('# OPENRIG_SESSION_NAME is injected\n[x]\nOPENRIG_HOME = "/h"\n')).toEqual([]);
  });
});

describe("seat hook trust follows the shared config's trust", () => {
  const entry = (key: string, hash: string) => `[hooks.state.${JSON.stringify(key)}]\ntrusted_hash = ${JSON.stringify(hash)}\n`;
  // OF-42: trust is only mirrored when its hash is the one Codex computes now for a hook that
  // is in the file, so these fixtures carry real hooks. The hashes restate Codex's recipe
  // (sha256 of the compact sorted-key JSON of the event, matcher and handler) independently.
  const sha = (json: string) => `sha256:${createHash("sha256").update(json, "utf8").digest("hex")}`;
  const handler = (cmd: string) => `{"async":false,"command":"${cmd}","timeout":5,"type":"command"}`;
  const HASH_SS0 = sha(`{"event_name":"session_start","hooks":[${handler("/u/a")}]}`);
  const HASH_SS1 = sha(`{"event_name":"session_start","hooks":[${handler("/u/b")}]}`);
  const HASH_STOP = sha(`{"event_name":"stop","hooks":[${handler("/u/s")}]}`);
  const hook = (event: string, cmd: string) => `[[hooks.${event}]]\n[[hooks.${event}.hooks]]\ntype = "command"\ncommand = "${cmd}"\ntimeout = 5\n\n`;
  const SS_HOOKS = hook("SessionStart", "/u/a") + hook("SessionStart", "/u/b");
  const STOP_HOOK = hook("Stop", "/u/s");

  it("mirrors each shared-path trust record to the seat's config path with the same hash", async () => {
    const sharedConfig = await fs.realpath(path.join(shared, "config.toml"));
    await fs.writeFile(sharedConfig, SS_HOOKS +
      entry(`${sharedConfig}:session_start:0:0`, HASH_SS0) +
      entry(`${sharedConfig}:session_start:1:0`, HASH_SS1) +
      entry("/elsewhere/.codex/hooks.json:stop:0:0", "sha256:other"));
    const home = await ensureCodexSeatHome("dev-qa@r", { openrigHome, sharedCodexHome: shared });
    const seatKey = path.join(await fs.realpath(home.path), "config.toml");
    const after = await fs.readFile(sharedConfig, "utf-8");
    expect(after).toContain(entry(`${seatKey}:session_start:0:0`, HASH_SS0).trimEnd());
    expect(after).toContain(entry(`${seatKey}:session_start:1:0`, HASH_SS1).trimEnd());
    expect(after).not.toContain(`${seatKey}:stop:0:0`); // another file's trust is not this file's
    expect(after.match(/sha256:other/g)?.length).toBe(1);

    await ensureCodexSeatHome("dev-qa@r", { openrigHome, sharedCodexHome: shared });
    expect(await fs.readFile(sharedConfig, "utf-8")).toBe(after); // idempotent
  });

  it("carries over trust given after the seat home already existed", async () => {
    const sharedConfig = await fs.realpath(path.join(shared, "config.toml"));
    await fs.writeFile(sharedConfig, STOP_HOOK);
    const home = await ensureCodexSeatHome("dev-qa@r", { openrigHome, sharedCodexHome: shared });
    await fs.appendFile(sharedConfig, entry(`${sharedConfig}:stop:0:0`, HASH_STOP));
    await ensureCodexSeatHome("dev-qa@r", { openrigHome, sharedCodexHome: shared });
    const seatKey = path.join(await fs.realpath(home.path), "config.toml");
    expect(await fs.readFile(sharedConfig, "utf-8")).toContain(entry(`${seatKey}:stop:0:0`, HASH_STOP).trimEnd());
  });

  it("leaves a seat-owned (non-symlinked) config alone", async () => {
    const home = codexSeatHomePath(openrigHome, "own@r");
    await fs.mkdir(home, { recursive: true });
    await fs.writeFile(path.join(home, "config.toml"), "");
    const sharedConfig = path.join(shared, "config.toml");
    await fs.writeFile(sharedConfig, entry(`${await fs.realpath(sharedConfig)}:stop:0:0`, "sha256:x"));
    const before = await fs.readFile(sharedConfig, "utf-8");
    await ensureCodexSeatHome("own@r", { openrigHome, sharedCodexHome: shared });
    expect(await fs.readFile(sharedConfig, "utf-8")).toBe(before);
    expect(await fs.readFile(path.join(home, "config.toml"), "utf-8")).toBe("");
  });

  it("never rolls back newer trust given inside the seat to the shared hash", () => {
    const c = entry("/s/config.toml:session_start:0:0", "sha256:old") + entry("/seat/config.toml:session_start:0:0", "sha256:new");
    expect(mirrorCodexHookTrust(c, "/s/config.toml", "/seat/config.toml")).toBe(c);
  });

  it("OpenRig's own hooks follow the managed block for the seat key, replacing a stale seat hash", () => {
    const relay = "/new/relay.cjs";
    const block = `# BEGIN OPENRIG MANAGED ACTIVITY HOOKS\n[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ntype = "command"\ncommand = 'node "${relay}"'\ntimeout = 5\n# END OPENRIG MANAGED ACTIVITY HOOKS\n`;
    const c = block + entry("/seat/config.toml:stop:0:0", "sha256:stale-old-relay");
    const out = mirrorCodexHookTrust(c, "/s/config.toml", "/seat/config.toml");
    const want = computeCodexHookTrust("Stop", { keySource: "/seat/config.toml", command: `node "${relay}"`, timeoutSec: 5 });
    expect(out).toContain(entry(want.key, want.hash).trimEnd());
    expect(out).not.toContain("sha256:stale-old-relay");
  });

  it("mirrors only records of the shared path itself, not of a path it prefixes", () => {
    const c = entry("/s/config.toml.bak:stop:0:0", "sha256:bak");
    expect(mirrorCodexHookTrust(c, "/s/config.toml", "/seat/config.toml")).toBe(c);
  });

  it("one failed sync does not stop later syncs of the same config", async () => {
    const sharedConfig = await fs.realpath(path.join(shared, "config.toml"));
    await fs.writeFile(sharedConfig, `[hooks.state."${sharedConfig}:\\U0001F600"]\ntrusted_hash = "sha256:x"\n`);
    await ensureCodexSeatHome("a@r", { openrigHome, sharedCodexHome: shared }); // mirror throws, swallowed
    await fs.writeFile(sharedConfig, STOP_HOOK + entry(`${sharedConfig}:stop:0:0`, HASH_STOP));
    const home = await ensureCodexSeatHome("b@r", { openrigHome, sharedCodexHome: shared });
    const seatKey = path.join(await fs.realpath(home.path), "config.toml");
    expect(await fs.readFile(sharedConfig, "utf-8")).toContain(`${seatKey}:stop:0:0`);
  });

  it("concurrent seat launches lose no records and leave no temp files", async () => {
    const sharedConfig = await fs.realpath(path.join(shared, "config.toml"));
    await fs.writeFile(sharedConfig, STOP_HOOK + entry(`${sharedConfig}:stop:0:0`, HASH_STOP));
    await fs.chmod(sharedConfig, 0o600);
    const seats = Array.from({ length: 8 }, (_, i) => `s${i}@r`);
    const homes = await Promise.all(seats.map((s) => ensureCodexSeatHome(s, { openrigHome, sharedCodexHome: shared })));
    const after = await fs.readFile(sharedConfig, "utf-8");
    for (const h of homes) expect(after).toContain(`${path.join(await fs.realpath(h.path), "config.toml")}:stop:0:0`);
    expect((await fs.readdir(shared)).filter((f) => f.includes(".openrig-"))).toEqual([]);
    expect((await fs.stat(sharedConfig)).mode & 0o777).toBe(0o600);
  });
});
