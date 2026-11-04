// OF-232 — no test-spawned daemon binds a non-loopback address.
//
// Measured on Sparky (release 54, fork/main f9d74d0f): a test that spawned the production entrypoint with only OPENRIG_PORT took
// the daemon's DEFAULT bind plan, loopback plus the host's own Tailscale address, and died on "listen EADDRINUSE 100.76.25.39:
// 45509". The same default was a test daemon reachable (and unauthenticated: the tailnet is the daemon's only auth boundary) on
// the tailnet for as long as the test ran. Two halves:
//
//  A. A STRUCTURAL census (TypeScript AST, not text): every test file in every package that both names the daemon entrypoint
//     (a string literal ending src/index.ts or dist/index.js) and calls spawn/fork/execFile is classified. A daemon spawner must
//     go through spawnDaemonEntrypoint (the helper that pins the bind host); a file that names an index file but starts
//     something else is listed with the reason. An unclassified file fails: a new spawner cannot arrive unpinned.
//  B. A BEHAVIOURAL check on the address actually bound, on any host: the child sees a fake Tailscale interface (the default bind
//     plan then appends 100.64.0.1). A pinned daemon reports only loopback listeners; a control that is not pinned fails
//     naming 100.64.0.1, which proves the instrument sees the tailnet attempt. The scenario-daemon route (`rig daemon start`
//     under the hermetic scaffold) is checked the same way where the CLI and an hc binary exist.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import { prepareHermeticEnv, type HermeticScaffold } from "./helpers/hermetic-env.js";
import { findHc, startHcScratch, type HcScratch } from "./helpers/hc-scratch.js";
import { killIfRunning, spawnDaemonEntrypoint, TEST_DAEMON_BIND_HOST } from "./helpers/daemon-entrypoint.js";
import { spawnScenarioDaemon, type ScenarioDaemon } from "./helpers/scenario-daemon.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../..");
const PRELOAD = path.join(HERE, "fixtures/fake-tailnet-interface.mjs");
const FAKE_TAILNET_ADDRESS = "100.64.0.1";
const CEILING_MS = 300_000;

const LOOPBACK = (host: string): boolean => host === "localhost" || host === "::1" || host === "[::1]" || /^127(\.\d{1,3}){3}$/.test(host);

// ---- A. structural census ---------------------------------------------------------------------------------------------------

const SPAWN_CALLEES = new Set(["spawn", "spawnSync", "fork", "execFile", "execFileSync"]);
const ENTRYPOINT_LITERAL = /(^|\/)(src|dist)\/index\.(ts|js)$/;
/** A literal names the DAEMON's index file: relative to a daemon test (and not another package's), or through a `daemon/` path. */
function namesDaemonEntrypoint(literal: string, pkg: string): boolean {
  if (!ENTRYPOINT_LITERAL.test(literal)) return false;
  return /(^|\/)daemon\//.test(literal) || (pkg === "daemon" && !/(^|\/)(cli|tui|ui)\//.test(literal));
}

interface FileFacts { file: string; entrypointLiteral: boolean; spawnCalls: number; importsPinnedHelper: boolean }

function testFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx|mts|mjs|js)$/.test(entry.name)) out.push(full);
    }
  };
  for (const pkg of fs.readdirSync(path.join(REPO_ROOT, "packages"))) {
    const dir = path.join(REPO_ROOT, "packages", pkg, "test");
    if (fs.existsSync(dir)) walk(dir);
  }
  return out.sort();
}

function factsOf(file: string): FileFacts {
  const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const pkg = path.relative(REPO_ROOT, file).split(path.sep)[1] ?? "";
  const facts: FileFacts = { file: path.relative(REPO_ROOT, file), entrypointLiteral: false, spawnCalls: 0, importsPinnedHelper: false };
  const visit = (node: ts.Node): void => {
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && namesDaemonEntrypoint(node.text, pkg)) facts.entrypointLiteral = true;
    if (ts.isCallExpression(node)) {
      const callee = ts.isIdentifier(node.expression) ? node.expression.text : ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : "";
      if (SPAWN_CALLEES.has(callee)) facts.spawnCalls++;
    }
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && /helpers\/daemon-entrypoint(\.js)?$/.test(node.moduleSpecifier.text)) {
      const named = node.importClause?.namedBindings;
      if (named && ts.isNamedImports(named) && named.elements.some((e) => (e.propertyName ?? e.name).text === "spawnDaemonEntrypoint")) facts.importsPinnedHelper = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return facts;
}

/** Files that name an index file and spawn something, and why none of them starts a daemon unpinned. Keyed by repo-relative path. */
const NOT_A_DAEMON_SPAWN: Record<string, string> = {
  "packages/daemon/test/helpers/daemon-entrypoint.ts": "the helper itself: its spawn sets OPENRIG_BIND_HOST (half B runs it)",
  "packages/daemon/test/test-daemon-loopback-census.test.ts": "this file: its one raw spawn is the unpinned CONTROL, on purpose, under a fake interface",
  "packages/daemon/test/slow-op-recorder-shutdown.test.ts": "its daemon pin goes through the helper; the remaining spawn imports src/index.ts as a module under --eval (not a direct run, no startServer, no listener)",
  "packages/cli/test/daemon-lifecycle.test.ts": "names daemon/dist/index.js as a path the lifecycle resolves; its spawn is a vi.fn fake, no process starts",
  "packages/daemon/test/daemon-cwd-anchor.test.ts": "reads src/index.ts as text; its spawnSync runs fixtures/daemon-cwd-anchor-probe.ts, which binds nothing",
  "packages/daemon/test/process-start-clock.test.ts": "reads src/index.ts as text; its spawn is `sleep`",
};

describe("A. the only test code that spawns the daemon entrypoint is the loopback-pinning helper", () => {
  const all = testFiles().map(factsOf);
  const candidates = all.filter((f) => f.entrypointLiteral && f.spawnCalls > 0).map((f) => f.file).sort();

  it("enumerates the population (positive control: files in several packages, and the known spawner is found)", () => {
    expect(all.length).toBeGreaterThan(500);
    expect(new Set(all.map((f) => f.file.split("/")[1])).size).toBeGreaterThanOrEqual(3);
    expect(candidates).toContain("packages/daemon/test/helpers/daemon-entrypoint.ts");
  });

  it("set-equality, count and set: every file that names the daemon entrypoint and spawns is the helper or listed with its reason", () => {
    const listed = Object.keys(NOT_A_DAEMON_SPAWN).sort();
    expect(candidates, `a test file spawns the daemon entrypoint outside test/helpers/daemon-entrypoint.ts (an unpinned spawn binds the host's Tailscale address too); candidates=${candidates.length}`).toEqual(listed);
  });

  it("the two former raw spawners now use the helper (the simulator test names no entrypoint literal any more)", () => {
    const users = all.filter((f) => f.importsPinnedHelper).map((f) => f.file);
    expect(users).toEqual(expect.arrayContaining([
      "packages/daemon/test/simulator-lifecycle-process.test.ts",
      "packages/daemon/test/slow-op-recorder-shutdown.test.ts",
    ]));
    expect(all.find((f) => f.file === "packages/daemon/test/simulator-lifecycle-process.test.ts")?.entrypointLiteral).toBe(false);
  });
});

// ---- B. behavioural: the address actually bound -----------------------------------------------------------------------------

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openrig-of232-"));
  tempDirs.push(dir);
  return dir;
}
const running: Array<() => void> = [];
afterEach(() => {
  for (const stop of running.splice(0)) stop();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function listeningHosts(stdout: string): string[] {
  return [...stdout.matchAll(/OpenRig daemon listening on http:\/\/(\[[^\]]+\]|[^:/\s]+):(\d+)/g)].map((m) => m[1]!);
}

describe("B. a test daemon binds loopback only, on a host that looks like it has a tailnet", () => {
  it("the production-entrypoint helper: every listener the daemon reports, and its bind plan, are loopback", async () => {
    const daemon = await spawnDaemonEntrypoint({
      home: tempDir(),
      nodeArgs: ["--import", pathToFileURL(PRELOAD).href],
      readyTimeoutMs: CEILING_MS - 20_000,
    });
    running.push(() => killIfRunning(daemon.child));
    const hosts = listeningHosts(daemon.stdout());
    expect(hosts.length, `no listener line in: ${daemon.stdout()}`).toBeGreaterThan(0);
    expect(hosts.filter((h) => !LOOPBACK(h)), `non-loopback listener(s): ${hosts.join(", ")}`).toEqual([]);
    const health = (await (await fetch(`http://${TEST_DAEMON_BIND_HOST}:${daemon.port}/healthz`)).json()) as { bind?: { mode: string; hosts: string[] } };
    expect(health.bind?.mode).toBe("explicit");
    expect(health.bind?.hosts.filter((h) => !LOOPBACK(h))).toEqual([]);
    expect(daemon.stderr()).not.toContain(FAKE_TAILNET_ADDRESS);
  }, CEILING_MS);

  it("CONTROL: the same child without the pin takes the default plan and tries the tailnet address (the instrument sees it)", async () => {
    const home = tempDir();
    const child = spawn(process.execPath, ["--import", "tsx", "--import", pathToFileURL(PRELOAD).href, path.resolve(HERE, "../src/index.ts")], {
      env: { ...process.env, OPENRIG_NO_KERNEL: "1", OPENRIG_HOME: home, OPENRIG_DB: path.join(home, "openrig.sqlite"), OPENRIG_PORT: "0", OPENRIG_URL: "", OPENRIG_BIND_HOST: "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    running.push(() => killIfRunning(child));
    let output = "";
    for (const stream of [child.stdout!, child.stderr!]) { stream.setEncoding("utf8"); stream.on("data", (c: string) => { output += c; }); }
    // Bounded: a daemon that did NOT refuse the fake address (it bound something else) must fail the row, not hang it.
    const exitedInTime = await Promise.race([
      new Promise<boolean>((resolve) => child.once("exit", () => resolve(true))),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 120_000)),
    ]);
    expect(exitedInTime, `the unpinned daemon stayed up instead of refusing ${FAKE_TAILNET_ADDRESS}: ${output}`).toBe(true);
    // The fake address is on no interface, so the bind to it is refused, and the refusal names it.
    expect(output).toContain(FAKE_TAILNET_ADDRESS);
    expect(output).toMatch(/EADDRNOTAVAIL/);
  }, CEILING_MS);

  describe.runIf(findHc() !== null)("the scenario-daemon route (rig daemon start under the hermetic scaffold)", () => {
    const rigBin = path.resolve(HERE, "../../cli/dist/bin-wrapper.js");
    let core: HcScratch | undefined;
    let scaffold: HermeticScaffold | undefined;
    let daemon: ScenarioDaemon | undefined;
    afterEach(async () => {
      if (daemon) await daemon.stop().catch(() => {});
      else scaffold?.cleanup();
      core?.cleanup();
      daemon = undefined; scaffold = undefined; core = undefined;
    });

    it("binds loopback only: the bind plan is explicit and names no tailnet address", async () => {
      scaffold = prepareHermeticEnv({ baseEnv: { HOME: process.env.HOME, PATH: process.env.PATH, TERM: "xterm" } });
      core = startHcScratch();
      Object.assign(scaffold.env, {
        HC_SESSION: core.session, XDG_RUNTIME_DIR: core.env.XDG_RUNTIME_DIR, HC_SOCKET: core.socketPath,
        NODE_OPTIONS: `--import ${pathToFileURL(PRELOAD).href}`,
      });
      daemon = await spawnScenarioDaemon(scaffold, { rigBin });
      const health = (await (await fetch(`${daemon.baseUrl}/healthz`)).json()) as { bind?: { mode: string; hosts: string[] } };
      expect(health.bind?.mode).toBe("explicit");
      expect(health.bind?.hosts.filter((h) => !LOOPBACK(h))).toEqual([]);
    }, CEILING_MS);
  });
});
