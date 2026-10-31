// OF-183. ~/.codex/config.toml is host-wide: every Codex seat's CODEX_HOME symlinks it, and it carries the
// top-level OpenRig activity-hook commands and the `[hooks.state.*] trusted_hash` records of live seats. A scratch
// or dev daemon that upserted it repointed those hooks at ITS build and changed live seats' trust records (twice on
// Sparky, 2026-10-30/31; the second time on daemon start, with no Codex seat at all).
//
// These rows pin the consequence, not the mechanism: a daemon that is not the host's installed OpenRig leaves the
// shared config byte-identical through EVERY writer, and the installed daemon still writes through the same writers.
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexRuntimeAdapter, type CodexAdapterFsOps } from "../src/adapters/codex-runtime-adapter.js";
import type { ProjectionPlan } from "../src/domain/projection-planner.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import {
  canonicalizeBestEffort,
  createCodexConfigWritePolicy,
  type CodexConfigWritePolicy,
  type CodexConfigWritePolicyFacts,
} from "../src/domain/codex-config-write-policy.js";
import { startupCodexConfigWritePolicy } from "../src/domain/codex-config-write-policy.js";
import { ensureCodexSeatHome } from "../src/domain/codex-seat-home.js";

const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

// ---- pure rows: the condition, on injected facts --------------------------------------------------------------
const HOST = "/home/jim";
const installedRoot = "/usr/lib/node_modules/@openrig/cli/daemon";
const facts = (over: Partial<CodexConfigWritePolicyFacts> = {}): CodexConfigWritePolicyFacts => ({
  codeRoot: installedRoot,
  openrigHome: `${HOST}/.openrig`,
  hostHome: HOST,
  processHome: HOST,
  readPackageName: (dir) => (dir === "/usr/lib/node_modules/@openrig/cli" ? "@openrig/cli" : undefined),
  canonicalize: (p) => path.resolve(p),
  ...over,
});
const HOST_CONFIG = `${HOST}/.codex/config.toml`;

describe("OF-183 the installed-daemon condition", () => {
  it("CONTROL: the installed daemon (npm layout + @openrig/cli manifest + the host's default OPENRIG_HOME) may write the host-wide config", () => {
    expect(createCodexConfigWritePolicy(facts()).decide(HOST_CONFIG).allowed).toBe(true);
  });

  it("a checkout or worktree build is not the installed daemon, even on the host's default OPENRIG_HOME", () => {
    const d = createCodexConfigWritePolicy(facts({ codeRoot: "/work/openrig/packages/daemon" })).decide(HOST_CONFIG);
    expect(d.allowed).toBe(false);
  });

  it("a checkout build is not installed even if a manifest named @openrig/cli sits above it (layout alone is judged)", () => {
    const d = createCodexConfigWritePolicy(facts({ codeRoot: "/work/openrig/packages/daemon", readPackageName: () => "@openrig/cli" })).decide(HOST_CONFIG);
    expect(d.allowed).toBe(false);
  });

  it("the host-wide home stays refused even when the scratch daemon's OPENRIG_HOME encloses it", () => {
    const d = createCodexConfigWritePolicy(facts({ codeRoot: "/work/x/packages/daemon", openrigHome: HOST })).decide(HOST_CONFIG);
    expect(d.allowed).toBe(false);
  });

  it("the npm layout on another OPENRIG_HOME is not the host's installed daemon", () => {
    expect(createCodexConfigWritePolicy(facts({ openrigHome: "/scratch/of183/.openrig" })).decide(HOST_CONFIG).allowed).toBe(false);
  });

  it("the npm layout without the @openrig/cli manifest is not the installed daemon", () => {
    expect(createCodexConfigWritePolicy(facts({ readPackageName: () => "something-else" })).decide(HOST_CONFIG).allowed).toBe(false);
    expect(createCodexConfigWritePolicy(facts({ readPackageName: () => undefined })).decide(HOST_CONFIG).allowed).toBe(false);
  });

  it("fails closed when the account home cannot be read: not installed, and the host-wide config is refused", () => {
    expect(createCodexConfigWritePolicy(facts({ hostHome: null })).decide(HOST_CONFIG).allowed).toBe(false);
  });

  it("a process that claims the host's HOME through $HOME alone is judged by the passwd home, not by that claim", () => {
    // A scratch daemon with a different code root and OPENRIG_HOME, HOME set to the real home: still refused.
    const d = createCodexConfigWritePolicy(facts({ codeRoot: "/work/x/packages/daemon", openrigHome: "/scratch/.openrig", processHome: HOST }));
    expect(d.decide(HOST_CONFIG).allowed).toBe(false);
  });

  describe("a non-installed daemon may still use an isolated config of its own", () => {
    const scratch = facts({ codeRoot: "/work/x/packages/daemon", openrigHome: "/scratch/of183/.openrig" });
    it("inside its own OPENRIG_HOME", () => {
      expect(createCodexConfigWritePolicy(scratch).decide("/scratch/of183/.openrig/codex/config.toml").allowed).toBe(true);
    });
    it("inside a private HOME (the process HOME differs from the account home)", () => {
      expect(createCodexConfigWritePolicy({ ...scratch, processHome: "/scratch/of183/home" }).decide("/scratch/of183/home/.codex/config.toml").allowed).toBe(true);
    });
    it("but not a home it cannot prove private: an arbitrary CODEX_HOME under the real home is refused", () => {
      expect(createCodexConfigWritePolicy(scratch).decide(`${HOST}/somewhere/codex/config.toml`).allowed).toBe(false);
    });
    it("nor the host-wide home, even when the scratch daemon's HOME is private", () => {
      expect(createCodexConfigWritePolicy({ ...scratch, processHome: "/scratch/of183/home" }).decide(HOST_CONFIG).allowed).toBe(false);
    });
  });
});

describe("OF-183 canonicalizeBestEffort", () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "of183-canon-"))); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it("a symlink that leads to the host-wide home is refused for a non-installed daemon (the link does not hide it)", () => {
    const hostCodex = path.join(tmp, "host", ".codex");
    fs.mkdirSync(hostCodex, { recursive: true });
    const alias = path.join(tmp, "alias");
    fs.symlinkSync(hostCodex, alias);
    const policy = createCodexConfigWritePolicy({
      codeRoot: path.join(tmp, "work", "packages", "daemon"),
      openrigHome: path.join(tmp, "scratch", ".openrig"),
      hostHome: path.join(tmp, "host"),
      processHome: path.join(tmp, "host"),
      readPackageName: () => undefined,
      canonicalize: canonicalizeBestEffort,
    });
    expect(policy.decide(path.join(alias, "config.toml")).allowed).toBe(false);
  });

  it("a link inside the scratch daemon's own OPENRIG_HOME that leads to the host-wide home is refused, not taken for private", () => {
    const hostCodex = path.join(tmp, "host", ".codex");
    const own = path.join(tmp, "scratch", ".openrig");
    fs.mkdirSync(hostCodex, { recursive: true });
    fs.mkdirSync(own, { recursive: true });
    fs.symlinkSync(hostCodex, path.join(own, "codex"));
    const policy = createCodexConfigWritePolicy({
      codeRoot: path.join(tmp, "work", "packages", "daemon"),
      openrigHome: own,
      hostHome: path.join(tmp, "host"),
      processHome: path.join(tmp, "host"),
      readPackageName: () => undefined,
      canonicalize: canonicalizeBestEffort,
    });
    expect(policy.decide(path.join(own, "codex", "config.toml")).allowed).toBe(false);
  });

  it("resolves a path whose tail does not exist yet through its nearest existing ancestor", () => {
    const real = path.join(tmp, "real");
    fs.mkdirSync(real);
    fs.symlinkSync(real, path.join(tmp, "link"));
    expect(canonicalizeBestEffort(path.join(tmp, "link", "a", "b"))).toBe(path.join(real, "a", "b"));
  });
});

// ---- behavioural rows: the shared file stays byte-identical through every writer -------------------------------
let tmp: string;
let hostHome: string;
let hostCodex: string;
let hostConfig: string;
let relay: string;
let fragment: string;
let warn: ReturnType<typeof vi.spyOn>;

const realFs: CodexAdapterFsOps = {
  readFile: (p) => fs.readFileSync(p, "utf-8"),
  writeFile: (p, c) => fs.writeFileSync(p, c, "utf-8"),
  exists: (p) => fs.existsSync(p),
  mkdirp: (p) => { fs.mkdirSync(p, { recursive: true }); },
};
const tmux = () => ({ sendText: vi.fn(async () => ({ ok: true as const })) }) as Partial<TmuxAdapter> as TmuxAdapter;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "of183-guard-")));
  hostHome = path.join(tmp, "host");
  hostCodex = path.join(hostHome, ".codex");
  hostConfig = path.join(hostCodex, "config.toml");
  fs.mkdirSync(hostCodex, { recursive: true });
  relay = path.join(tmp, "installed-build", "activity-relay.cjs");
  fs.mkdirSync(path.dirname(relay), { recursive: true });
  fs.writeFileSync(relay, "// relay");
  fragment = path.join(tmp, "fragment.toml");
  fs.writeFileSync(fragment, '[mcp_servers.exa]\nurl = "https://mcp.exa.ai/mcp"\n');
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => { warn.mockRestore(); fs.rmSync(tmp, { recursive: true, force: true }); });

const realSymlinkTarget = (p: string): string | undefined => {
  try { return fs.lstatSync(p).isSymbolicLink() ? fs.readlinkSync(p) : undefined; } catch { return undefined; }
};

/** The host's installed daemon: the npm layout under a lib dir, on the host's default OPENRIG_HOME. */
function installedPolicy(): CodexConfigWritePolicy {
  const cli = path.join(tmp, "lib", "node_modules", "@openrig", "cli");
  fs.mkdirSync(path.join(cli, "daemon", "dist"), { recursive: true });
  fs.writeFileSync(path.join(cli, "package.json"), JSON.stringify({ name: "@openrig/cli" }));
  return createCodexConfigWritePolicy({
    codeRoot: path.join(cli, "daemon"),
    openrigHome: path.join(hostHome, ".openrig"),
    hostHome,
    processHome: hostHome,
    readPackageName: (dir) => JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf-8")).name,
    canonicalize: canonicalizeBestEffort,
    symlinkTarget: realSymlinkTarget,
  });
}

/** A scratch or dev daemon: a checkout build on its own OPENRIG_HOME, sharing the real HOME (the measured incident). */
function secondDaemonPolicy(): CodexConfigWritePolicy {
  return createCodexConfigWritePolicy({
    codeRoot: path.join(tmp, "worktree", "packages", "daemon"),
    openrigHome: path.join(tmp, "scratch", ".openrig"),
    hostHome,
    processHome: hostHome,
    readPackageName: () => undefined,
    canonicalize: canonicalizeBestEffort,
    symlinkTarget: realSymlinkTarget,
  });
}

const adapter = (configWritePolicy: CodexConfigWritePolicy, activityRelayPath = relay) =>
  new CodexRuntimeAdapter({ tmux: tmux(), fsOps: { ...realFs, homedir: hostHome }, activityRelayPath, configWritePolicy });

const plan = (): ProjectionPlan => ({
  runtime: "codex", cwd: path.join(tmp, "workspace"),
  entries: [{
    category: "runtime_resource", effectiveId: "frag", sourceSpec: "base", sourcePath: tmp,
    resourcePath: "fragment.toml", absolutePath: fragment, classification: "safe_projection", resourceType: "codex_config_fragment",
  } as never],
  startup: { files: [], actions: [] }, conflicts: [], noOps: [], diagnostics: [],
});
const binding = () => ({ id: "b", nodeId: "n", tmuxSession: "s", tmuxWindow: null, tmuxPane: null, cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", cwd: path.join(tmp, "workspace") });

describe("OF-183 the shared ~/.codex/config.toml, adapter writers", () => {
  /** The installed daemon provisions the host config once; that file is what a second daemon must not touch. */
  function provisionHostConfigAsInstalled(): string {
    adapter(installedPolicy()).ensureCodexActivityHooks();
    const bytes = fs.readFileSync(hostConfig, "utf-8");
    expect(bytes).toContain("BEGIN OPENRIG MANAGED ACTIVITY HOOKS");
    expect(bytes).toContain("trusted_hash");
    return bytes;
  }

  it("CONTROL: the installed daemon still writes the hooks and the hook trust through ensureCodexActivityHooks", () => {
    expect(fs.existsSync(hostConfig)).toBe(false);
    provisionHostConfigAsInstalled();
  });

  it("a second daemon's start-up (feature flag, activity hooks) leaves the provisioned file byte-identical", () => {
    const before = provisionHostConfigAsInstalled();
    const newerRelay = path.join(tmp, "scratch-build", "activity-relay.cjs");
    fs.mkdirSync(path.dirname(newerRelay), { recursive: true });
    fs.writeFileSync(newerRelay, "// relay");
    const second = adapter(secondDaemonPolicy(), newerRelay);
    second.ensureCodexFeatureFlag(true, { codexVersion: "0.12.0" });
    second.ensureCodexActivityHooks();
    expect(sha(fs.readFileSync(hostConfig))).toBe(sha(before));
    expect(fs.readFileSync(hostConfig, "utf-8")).not.toContain(newerRelay);
  });

  it("CONTROL: the same two calls from the installed daemon DO change a differently-provisioned file", () => {
    provisionHostConfigAsInstalled();
    const newerRelay = path.join(tmp, "installed-build-2", "activity-relay.cjs");
    fs.mkdirSync(path.dirname(newerRelay), { recursive: true });
    fs.writeFileSync(newerRelay, "// relay");
    const installed = adapter(installedPolicy(), newerRelay);
    installed.ensureCodexFeatureFlag(true, { codexVersion: "0.12.0" });
    installed.ensureCodexActivityHooks();
    expect(fs.readFileSync(hostConfig, "utf-8")).toContain(newerRelay);
    expect(fs.readFileSync(hostConfig, "utf-8")).toContain("codex_hooks");
  });

  it("a second daemon with hooks disabled does not strip the installed daemon's managed block", () => {
    const before = provisionHostConfigAsInstalled();
    adapter(secondDaemonPolicy()).removeCodexActivityHooks();
    expect(sha(fs.readFileSync(hostConfig))).toBe(sha(before));
  });

  it("CONTROL: removeCodexActivityHooks from the installed daemon does strip it", () => {
    provisionHostConfigAsInstalled();
    adapter(installedPolicy()).removeCodexActivityHooks();
    expect(fs.readFileSync(hostConfig, "utf-8")).not.toContain("BEGIN OPENRIG MANAGED ACTIVITY HOOKS");
  });

  it("a second daemon launching a seat does not add workspace trust to the host-wide config", () => {
    const before = provisionHostConfigAsInstalled();
    adapter(secondDaemonPolicy()).ensureManagedBootstrap({ cwd: path.join(tmp, "workspace") });
    expect(sha(fs.readFileSync(hostConfig))).toBe(sha(before));
  });

  it("CONTROL: the installed daemon launching a seat does add the workspace trust", () => {
    provisionHostConfigAsInstalled();
    adapter(installedPolicy()).ensureManagedBootstrap({ cwd: path.join(tmp, "workspace") });
    expect(fs.readFileSync(hostConfig, "utf-8")).toContain(`[projects.${JSON.stringify(path.join(tmp, "workspace"))}]`);
  });

  it("a second daemon projecting a codex_config_fragment leaves the file alone and reports the fragment as skipped, not projected", async () => {
    const before = provisionHostConfigAsInstalled();
    const result = await adapter(secondDaemonPolicy()).project(plan(), binding());
    expect(sha(fs.readFileSync(hostConfig))).toBe(sha(before));
    expect(result.projected).toEqual([]);
    expect(result.skipped).toEqual(["frag"]);
    expect(result.warnings?.join("\n")).toContain("not applied");
  });

  it("CONTROL: the installed daemon projects the same fragment into the host-wide config", async () => {
    provisionHostConfigAsInstalled();
    const result = await adapter(installedPolicy()).project(plan(), binding());
    expect(result.projected).toEqual(["frag"]);
    expect(fs.readFileSync(hostConfig, "utf-8")).toContain("[mcp_servers.exa]");
  });

  it("a second daemon does not create the host-wide config when none exists", () => {
    const second = adapter(secondDaemonPolicy());
    second.ensureCodexFeatureFlag(true, { codexVersion: "0.12.0" });
    second.ensureCodexActivityHooks();
    second.ensureManagedBootstrap({ cwd: path.join(tmp, "workspace") });
    second.removeCodexActivityHooks();
    expect(fs.existsSync(hostConfig)).toBe(false);
    expect(fs.existsSync(hostCodex) && fs.readdirSync(hostCodex)).toEqual([]);
  });

  it("a second daemon with a private CODEX_HOME still gets its own isolated config written", () => {
    const own = path.join(tmp, "scratch", ".openrig", "codex-home");
    fs.mkdirSync(own, { recursive: true });
    const isolated = new CodexRuntimeAdapter({
      tmux: tmux(), fsOps: { ...realFs, homedir: hostHome }, activityRelayPath: relay, codexHome: own, configWritePolicy: secondDaemonPolicy(),
    });
    isolated.ensureCodexActivityHooks();
    expect(fs.readFileSync(path.join(own, "config.toml"), "utf-8")).toContain("BEGIN OPENRIG MANAGED ACTIVITY HOOKS");
    expect(fs.existsSync(hostConfig)).toBe(false);
  });

  it("says why it left the config unchanged, once per file", () => {
    provisionHostConfigAsInstalled();
    const second = adapter(secondDaemonPolicy());
    second.ensureCodexActivityHooks();
    second.ensureCodexActivityHooks();
    second.ensureManagedBootstrap({ cwd: path.join(tmp, "workspace") });
    const lines = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("codex config unchanged"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("not the host's installed OpenRig");
  });
});

// ---- the seat-home trust mirror writes the shared file through the seat's config.toml symlink -------------------
describe("OF-183 the shared ~/.codex/config.toml, seat-home trust mirror", () => {
  let openrigHome: string;
  let logs: string[];
  const HOOKS = `[[hooks.Stop]]\n\n[[hooks.Stop.hooks]]\ntype = "command"\ncommand = "/opt/stop-probe"\ntimeout = 9\n\n`;
  const STOP_HASH = `sha256:${sha('{"event_name":"stop","hooks":[{"async":false,"command":"/opt/stop-probe","timeout":9,"type":"command"}]}')}`;

  beforeEach(() => {
    openrigHome = path.join(tmp, "scratch", ".openrig");
    logs = [];
    // A live seat trusted the user's Stop hook under the shared key: a new seat home would normally mirror it.
    fs.writeFileSync(hostConfig, `${HOOKS}[hooks.state.${JSON.stringify(`${hostConfig}:stop:0:0`)}]\ntrusted_hash = ${JSON.stringify(STOP_HASH)}\n`);
  });

  const launch = (configWritePolicy?: CodexConfigWritePolicy) =>
    ensureCodexSeatHome("dev-impl@r", { openrigHome, sharedCodexHome: hostCodex, log: (m: string) => logs.push(m), ...(configWritePolicy ? { configWritePolicy } : {}) });

  it("CONTROL: the installed daemon mirrors the trust to the seat key in the shared file", async () => {
    const before = fs.readFileSync(hostConfig);
    const seat = await launch(installedPolicy());
    expect(sha(fs.readFileSync(hostConfig))).not.toBe(sha(before));
    expect(fs.readFileSync(hostConfig, "utf-8")).toContain(`${path.join(fs.realpathSync(seat.path), "config.toml")}:stop:0:0`);
  });

  it("a second daemon launching a seat leaves the shared file byte-identical and links the seat to it unchanged", async () => {
    const before = fs.readFileSync(hostConfig);
    const seat = await launch(secondDaemonPolicy());
    expect(sha(fs.readFileSync(hostConfig))).toBe(sha(before));
    expect(fs.readlinkSync(path.join(seat.path, "config.toml"))).toBe(hostConfig);
    expect(logs.some((l) => l.includes("hook trust not mirrored"))).toBe(true);
    expect(fs.readdirSync(hostCodex).sort()).toEqual(["config.toml"]);
  });
});

// ---- census: no Codex config.toml writer escapes the policy -----------------------------------------------------
describe("OF-187 the policy checks the config FILE, not only its directory", () => {
  // A scratch daemon's private home holds a seat CODEX_HOME whose config.toml links to the host-wide file: the layout
  // codex-seat-home.ts builds. The directory is private; the file it writes through is not.
  const seatHome = () => path.join(tmp, "scratch", ".openrig", "codex-homes", "seat");
  const linkSeatConfig = (to: string) => {
    fs.mkdirSync(seatHome(), { recursive: true });
    fs.symlinkSync(to, path.join(seatHome(), "config.toml"));
    return path.join(seatHome(), "config.toml");
  };

  it("refuses a private directory's config.toml that is a symlink to the host-wide file, and leaves it byte-identical", () => {
    fs.writeFileSync(hostConfig, "# live\n");
    const before = fs.readFileSync(hostConfig);
    const decision = secondDaemonPolicy().decide(linkSeatConfig(hostConfig));
    expect(decision.allowed).toBe(false);
    expect(fs.readFileSync(hostConfig).equals(before)).toBe(true);
  });

  it("refuses a chain of symlinks that ends in the host-wide file", () => {
    fs.writeFileSync(hostConfig, "# live\n");
    const hop = path.join(tmp, "scratch", ".openrig", "hop.toml");
    fs.mkdirSync(path.dirname(hop), { recursive: true });
    fs.symlinkSync(hostConfig, hop);
    expect(secondDaemonPolicy().decide(linkSeatConfig(hop)).allowed).toBe(false);
  });

  it("refuses a DANGLING symlink whose target would be created inside the host-wide home", () => {
    fs.rmSync(hostConfig, { force: true });
    expect(secondDaemonPolicy().decide(linkSeatConfig(hostConfig)).allowed).toBe(false);
  });

  it("refuses a symlink loop (fails closed)", () => {
    const a = path.join(seatHome(), "config.toml");
    fs.mkdirSync(seatHome(), { recursive: true });
    fs.symlinkSync(a, a);
    expect(secondDaemonPolicy().decide(a).allowed).toBe(false);
  });

  it("CONTROL: a private config.toml that is a symlink to another private file stays allowed", () => {
    const real = path.join(tmp, "scratch", ".openrig", "real.toml");
    fs.mkdirSync(path.dirname(real), { recursive: true });
    fs.writeFileSync(real, "");
    expect(secondDaemonPolicy().decide(linkSeatConfig(real)).allowed).toBe(true);
  });

  it("the INSTALLED daemon keeps writing through a seat CODEX_HOME's symlinked config exactly as before", () => {
    fs.writeFileSync(hostConfig, "# live\n");
    expect(installedPolicy().decide(linkSeatConfig(hostConfig)).allowed).toBe(true);
  });
});

describe("OF-187 start-up wiring, from an npm-shaped layout", () => {
  const npmLayout = () => {
    const cli = path.join(tmp, "lib", "node_modules", "@openrig", "cli");
    fs.mkdirSync(path.join(cli, "daemon", "dist"), { recursive: true });
    fs.writeFileSync(path.join(cli, "package.json"), JSON.stringify({ name: "@openrig/cli" }));
    return path.join(cli, "daemon", "dist");
  };
  const passwdHome = () => os.userInfo().homedir;

  it("the start-up module dir `dist/` resolves to the daemon package root: installed on the host's OPENRIG_HOME", () => {
    const lines: string[] = [];
    const policy = startupCodexConfigWritePolicy(npmLayout(), path.join(passwdHome(), ".openrig"), (l) => lines.push(l));
    expect(policy.decide(path.join(passwdHome(), ".codex", "config.toml")).allowed).toBe(true);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("installed daemon (");
    expect(lines[0]).not.toContain("not the installed daemon");
  });

  it("the same layout on another OPENRIG_HOME is judged not installed, and the line names where it looked", () => {
    const lines: string[] = [];
    const dist = npmLayout();
    const scratchHome = path.join(tmp, "scratch", ".openrig");
    const policy = startupCodexConfigWritePolicy(dist, scratchHome, (l) => lines.push(l));
    expect(policy.decide(path.join(passwdHome(), ".codex", "config.toml")).allowed).toBe(false);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("not the installed daemon");
    expect(lines[0]).toContain(`code root ${path.dirname(dist)},`);
    expect(lines[0]).toContain(`OPENRIG_HOME ${scratchHome},`);
  });

  it("a checkout layout is judged not installed, with the reason in the line", () => {
    const lines: string[] = [];
    startupCodexConfigWritePolicy(path.join(tmp, "work", "packages", "daemon", "src"), path.join(passwdHome(), ".openrig"), (l) => lines.push(l));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("not the installed daemon");
    expect(lines[0]).toContain("is not an npm-installed @openrig/cli daemon");
  });
});

describe("OF-183 census of Codex config.toml writers (instrument: a text scan of packages/daemon/src)", () => {
  const srcRoot = path.resolve(import.meta.dirname, "../src");
  const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith(".ts") ? [path.join(dir, e.name)] : []);
  const files = walk(srcRoot);
  const write = /\b(writeFile|writeFileSync|rename|renameSync|appendFile|appendFileSync)\b/;

  it("every file that mentions config.toml and a write call is classified; a new one fails here until it is", () => {
    expect(files.length).toBeGreaterThan(100); // positive control: the scan saw the tree
    const hits = files.filter((f) => { const t = fs.readFileSync(f, "utf-8"); return /config\.toml/.test(t) && write.test(t); })
      .map((f) => path.relative(srcRoot, f)).sort();
    // Guarded writers of a Codex config.toml: the adapter (5 upserts) and the seat-home trust mirror.
    // Not Codex-config writers: startup.ts (hands fs ops to the adapter; names a profile file), codex-mcp-servers.ts
    // (a prose "rename"), settings-store.ts (writes OpenRig's own settings; a comment names config.toml).
    expect(hits).toEqual([
      "adapters/codex-runtime-adapter.ts",
      "domain/codex-mcp-servers.ts",
      "domain/codex-seat-home.ts",
      "domain/user-settings/settings-store.ts",
      "startup.ts",
    ]);
  });

  it("every `this.fs.writeFile(configPath` in the adapter is reached only after the policy check in the same method", () => {
    const text = fs.readFileSync(path.join(srcRoot, "adapters/codex-runtime-adapter.ts"), "utf-8").split("\n");
    const sites = text.flatMap((line, i) => (line.includes("this.fs.writeFile(configPath") ? [i] : []));
    expect(sites.length).toBe(6); // feature flag, hooks, hook trust, remove, fragment, workspace trust
    for (const i of sites) {
      let start = i;
      while (start > 0 && !/^  (private |async )?[A-Za-z]+\(.*\{$/.test(text[start]!)) start--;
      const body = text.slice(start, i).join("\n");
      expect(body, `writer at line ${i + 1}`).toMatch(/mayChangeConfig\(configPath\)|configWritePolicy\.decide\(configPath\)/);
    }
  });

  it("the seat-home mirror asks the policy before it writes the shared file", () => {
    const text = fs.readFileSync(path.join(srcRoot, "domain/codex-seat-home.ts"), "utf-8");
    const fn = text.slice(text.indexOf("async function syncSeatHookTrust"), text.indexOf("async function linkIfMissing"));
    expect(fn.indexOf("policy.decide(sharedKeySource)")).toBeGreaterThan(-1);
    expect(fn.indexOf("policy.decide(sharedKeySource)")).toBeLessThan(fn.indexOf("fs.writeFile(tmp"));
  });

  it("the handover route and service forward the policy to the successor launcher (text pin: no behavioural fixture reaches the route)", () => {
    const route = fs.readFileSync(path.join(srcRoot, "routes/seat.ts"), "utf-8");
    const service = fs.readFileSync(path.join(srcRoot, "domain/seat-handover-service.ts"), "utf-8");
    const server = fs.readFileSync(path.join(srcRoot, "server.ts"), "utf-8");
    expect(route).toMatch(/codexConfigWritePolicy: \(c\.get\("codexConfigWritePolicy" as never\)/);
    expect(service).toMatch(/new SuccessorSessionLauncher\([\s\S]*?codexConfigWritePolicy: deps\.codexConfigWritePolicy/);
    expect(server).toMatch(/c\.set\("codexConfigWritePolicy" as never, deps\.codexConfigWritePolicy\)/);
  });

  it("startup hands the policy to the adapter, the node launcher and the route context", () => {
    const startup = fs.readFileSync(path.join(srcRoot, "startup.ts"), "utf-8");
    expect(startup).toMatch(/const codexConfigWritePolicy = startupCodexConfigWritePolicy\(import\.meta\.dirname, OPENRIG_HOME\);/);
    expect(startup).toMatch(/new CodexRuntimeAdapter\(\{[^\n]*configWritePolicy: codexConfigWritePolicy/);
    expect(startup).toMatch(/new NodeLauncher\(\{[\s\S]*?codexConfigWritePolicy,\n  \}\);/);
    expect(startup).toMatch(/const deps: AppDeps = \{[\s\S]*?codexConfigWritePolicy,/);
  });
});
