// workspaces-o9o.182: Codex's config.toml and profile files, read-modify-written by OpenRig, are judged by the credential rule before
// they are changed: a config another user, a second name or the group could change is left exactly as it is (and said), a dotfiles
// link at the shared config (OF-42) is followed to its real file, which keeps its mode, and nothing is written through a link.
import { TMP_CREDENTIAL_FILES } from "./helpers/credential-files.js";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { CodexRuntimeAdapter, type CodexAdapterFsOps } from "../src/adapters/codex-runtime-adapter.js";
import { rewriteGuardedFile } from "../src/adapters/guarded-rewrite.js";
import { codexSeatHomePath, ensureCodexSeatHome } from "../src/domain/codex-seat-home.js";
import { unrestrictedCodexConfigWrites } from "../src/domain/codex-config-write-policy.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { ProjectionPlan } from "../src/domain/projection-planner.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";

const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

let tmp: string;
let codexHome: string;
let config: string;
let relay: string;
let warn: MockInstance;
beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "o182-codex-")));
  codexHome = path.join(tmp, ".codex");
  fs.mkdirSync(codexHome, { recursive: true });
  config = path.join(codexHome, "config.toml");
  relay = path.join(tmp, "build", "activity-relay.cjs");
  fs.mkdirSync(path.dirname(relay), { recursive: true });
  fs.writeFileSync(relay, "// relay");
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => { warn.mockRestore(); fs.rmSync(tmp, { recursive: true, force: true }); });

/** The daemon's own wiring of the adapter's file ops (startup.ts): node:fs, with the credential rule's guarded rewrite. */
const daemonFs: CodexAdapterFsOps = {
  readFile: (p) => fs.readFileSync(p, "utf-8"),
  writeFile: (p, c) => fs.writeFileSync(p, c, "utf-8"),
  exists: (p) => fs.existsSync(p),
  mkdirp: (p) => { fs.mkdirSync(p, { recursive: true }); },
  rewriteGuarded: (p, policy, mutate, options) => rewriteGuardedFile(p, policy, mutate, options),
};
const tmux = () => ({ sendText: vi.fn(async () => ({ ok: true as const })) }) as Partial<TmuxAdapter> as TmuxAdapter;
const adapter = () => new CodexRuntimeAdapter({ tmux: tmux(), fsOps: daemonFs, activityRelayPath: relay, codexHome, configWritePolicy: unrestrictedCodexConfigWrites });
const trust = (a: CodexRuntimeAdapter, cwd: string) => a.ensureManagedBootstrap({ cwd });
const binding = (cwd: string): NodeBinding => ({ id: "b1", nodeId: "n1", tmuxSession: "r01-dev", tmuxWindow: null, tmuxPane: null, updatedAt: "", cwd });
const ORIGINAL = 'model = "gpt-test"\n\n[features]\nhooks = true\n';

describe("Codex config.toml read-modify-writes are judged first (workspaces-o9o.182)", () => {
  it("a config.toml the group can write is left byte-identical by every writer, and the refusal names it with the fix", () => {
    fs.writeFileSync(config, ORIGINAL);
    fs.chmodSync(config, 0o664);
    const a = adapter();
    a.ensureCodexActivityHooks();
    trust(a, tmp);
    a.removeCodexActivityHooks();
    a.ensureCodexFeatureFlag(true, { codexVersion: "0.120.0" });
    expect(fs.readFileSync(config, "utf-8")).toBe(ORIGINAL);
    expect(fs.statSync(config).mode & 0o777).toBe(0o664);  // never chmod-ed
    expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(new RegExp(`${config.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^\\n]*chmod go-w`));
  });

  it("a config.toml with a second hard link is left as it is, and so is the other name", () => {
    fs.writeFileSync(config, ORIGINAL, { mode: 0o600 });
    const other = path.join(tmp, "other-name.toml");
    fs.linkSync(config, other);
    adapter().ensureCodexActivityHooks();
    expect(sha(fs.readFileSync(other))).toBe(sha(ORIGINAL));
    expect(sha(fs.readFileSync(config))).toBe(sha(ORIGINAL));
  });

  it("a config fragment for a refused config is not projected, the refusal names the config, and the config is unchanged", async () => {
    fs.writeFileSync(config, ORIGINAL);
    fs.chmodSync(config, 0o666);
    const fragment = path.join(tmp, "fragment.toml");
    fs.writeFileSync(fragment, '[mcp_servers.exa]\nurl = "https://mcp.exa.ai/mcp"\n');
    const plan: ProjectionPlan = {
      runtime: "codex", cwd: tmp,
      entries: [{
        category: "runtime_resource", effectiveId: "exa", sourceSpec: "base", sourcePath: tmp, resourcePath: "runtime/codex-config.toml",
        absolutePath: fragment, classification: "safe_projection", resourceType: "codex_config_fragment",
      }],
      startup: { files: [], actions: [] }, conflicts: [], noOps: [], diagnostics: [],
    };
    const result = await adapter().project(plan, binding(tmp));
    expect(result.projected).toEqual([]);
    expect(JSON.stringify(result)).toContain(config);
    expect(fs.readFileSync(config, "utf-8")).toBe(ORIGINAL);
  });

  it("OF-42 dotfiles layout: a link at the shared config is followed, the real file is changed and keeps its mode, and the link stays", () => {
    const dotfiles = path.join(tmp, "dotfiles", "codex.toml");
    fs.mkdirSync(path.dirname(dotfiles), { recursive: true });
    fs.writeFileSync(dotfiles, ORIGINAL, { mode: 0o640 });
    fs.chmodSync(dotfiles, 0o640);
    fs.symlinkSync(dotfiles, config);
    trust(adapter(), tmp);
    expect(fs.lstatSync(config).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(dotfiles, "utf-8")).toContain("[projects.");
    expect(fs.readFileSync(dotfiles, "utf-8")).toContain('model = "gpt-test"');
    expect(fs.statSync(dotfiles).mode & 0o777).toBe(0o640);
  });

  it("positive control: a clean config is changed in place, keeps its mode, and leaves no temp file beside it", () => {
    fs.writeFileSync(config, ORIGINAL, { mode: 0o600 });
    fs.chmodSync(config, 0o600);
    trust(adapter(), tmp);
    expect(fs.readFileSync(config, "utf-8")).toContain("[projects.");
    expect(fs.statSync(config).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(codexHome)).toEqual(["config.toml"]);
  });
});

describe("the Codex seat home: hook-trust mirror, identity scans and the profile copy (workspaces-o9o.182)", () => {
  let openrigHome: string;
  let logs: string[];
  beforeEach(() => {
    openrigHome = path.join(tmp, ".openrig");
    logs = [];
  });
  const launch = () => ensureCodexSeatHome("dev-impl@r", { openrigHome, sharedCodexHome: codexHome, log: (m: string) => logs.push(m), credentialFiles: TMP_CREDENTIAL_FILES });

  // The mirror's earlier temp name was predictable (the shared config, the pid, 8 hex of the seat key), and a plain writeFile followed
  // a link planted there. (A shared config the rule refuses never reaches the mirror: o9o.160's seat-link judge refuses the launch
  // first, so the mirror's own judgement is for the window between the two.)
  it("the hook-trust mirror never writes through a link planted at a temp name beside the shared config", async () => {
    const hooks = '[[hooks.Stop]]\n\n[[hooks.Stop.hooks]]\ntype = "command"\ncommand = "/opt/stop-probe"\ntimeout = 9\n\n';
    const hash = `sha256:${sha('{"event_name":"stop","hooks":[{"async":false,"command":"/opt/stop-probe","timeout":9,"type":"command"}]}')}`;
    fs.writeFileSync(config, hooks + `[hooks.state.${JSON.stringify(`${config}:stop:0:0`)}]\ntrusted_hash = ${JSON.stringify(hash)}\n`, { mode: 0o600 });
    const seatHome = codexSeatHomePath(openrigHome, "dev-impl@r");
    fs.mkdirSync(seatHome, { recursive: true });
    const seatKey = path.join(fs.realpathSync(seatHome), "config.toml");
    const victim = path.join(tmp, "victim.txt");
    fs.writeFileSync(victim, "keep me\n", { mode: 0o600 });
    fs.symlinkSync(victim, `${config}.openrig-${process.pid}-${sha(seatKey).slice(0, 8)}`);
    await launch();
    expect(fs.readFileSync(victim, "utf-8")).toBe("keep me\n");
    expect(fs.readFileSync(config, "utf-8")).toContain(`${seatKey}:stop:0:0`);  // the trust was still mirrored
    expect(fs.statSync(config).mode & 0o777).toBe(0o600);
  });

  it("a shared profile file the group can write is not copied into the seat home, and that is said", async () => {
    fs.writeFileSync(config, ORIGINAL, { mode: 0o600 });
    const profile = path.join(codexHome, "rig-yolo.config.toml");
    fs.writeFileSync(profile, 'approval_policy = "never"\n');
    fs.chmodSync(profile, 0o664);
    const home = await launch();
    expect(home.copiedProfiles).toEqual([]);
    expect(fs.existsSync(path.join(home.path, "rig-yolo.config.toml"))).toBe(false);
    expect(home.warnings.join("\n")).toMatch(/did not copy profile rig-yolo\.config\.toml: .*chmod go-w/);
  });

  // verify-sec2 (o9o.182 FAIL 3): a linked or non-regular shared profile was skipped by lstat BEFORE the policy ran, so it was silently
  // omitted. It is refused by name through the policy now.
  it("a shared profile that is a symbolic link is not copied, and the refusal names it", async () => {
    fs.writeFileSync(config, ORIGINAL, { mode: 0o600 });
    const real = path.join(tmp, "elsewhere.config.toml");
    fs.writeFileSync(real, 'approval_policy = "never"\n', { mode: 0o600 });
    fs.symlinkSync(real, path.join(codexHome, "rig-yolo.config.toml"));
    const home = await launch();
    expect(home.copiedProfiles).toEqual([]);
    expect(home.warnings.join("\n")).toMatch(/did not copy profile rig-yolo\.config\.toml: .*symbolic link/);
  });

  it("a shared profile name that is not a regular file (a directory) is not copied, and the refusal names it", async () => {
    fs.writeFileSync(config, ORIGINAL, { mode: 0o600 });
    fs.mkdirSync(path.join(codexHome, "odd.config.toml"));
    const home = await launch();
    expect(home.copiedProfiles).toEqual([]);
    expect(home.warnings.join("\n")).toMatch(/did not copy profile odd\.config\.toml: .*not a regular file/);
  });

  it("a shared profile is copied 0600 whatever the source's mode, and is the source's text", async () => {
    fs.writeFileSync(config, ORIGINAL, { mode: 0o600 });
    const profile = path.join(codexHome, "rig-yolo.config.toml");
    fs.writeFileSync(profile, 'approval_policy = "never"\n');
    fs.chmodSync(profile, 0o644);
    const home = await launch();
    const copy = path.join(home.path, "rig-yolo.config.toml");
    expect(home.copiedProfiles).toEqual(["rig-yolo.config.toml"]);
    expect(fs.lstatSync(copy).isFile()).toBe(true);
    expect(fs.statSync(copy).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(copy, "utf-8")).toBe('approval_policy = "never"\n');
  });
});
