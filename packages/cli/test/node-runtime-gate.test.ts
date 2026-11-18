// workspaces-o9o.180: the Node-major and native-SQLite check runs in the CLI itself, since npm 11 (Node 24 and 26) skips the
// postinstall on a global registry install. Unit rows drive the gate's decisions; the process rows run the real CLI entry
// (src/index.ts under tsx) with process.version spoofed by a preload, or with better-sqlite3 made to fail by NODE_OPTIONS.
import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { nodeRuntimeGate, RUNTIME_CHECK_RECORD, type NodeRuntimeGateDeps } from "../src/node-runtime-gate.js";

function deps(over: Partial<NodeRuntimeGateDeps> = {}) {
  const calls = { load: 0, open: 0, written: [] as string[], errors: [] as string[] };
  const d: NodeRuntimeGateDeps = {
    nodeVersion: "v22.1.0", cliVersion: "9.9.9", argv: ["node", "rig", "ps"],
    readRecord: () => null,
    writeRecord: (t) => { calls.written.push(t); },
    loadNativeAddon: () => { calls.load++; },
    openNativeDatabase: () => { calls.open++; return { ok: true }; },
    err: (t) => { calls.errors.push(t); },
    ...over,
  };
  return { d, calls };
}

describe("nodeRuntimeGate", () => {
  it("a supported Node passes silently: the first run opens a database and records it; a recorded run touches no native code", () => {
    const first = deps();
    expect(nodeRuntimeGate(first.d)).toEqual({ proceed: true });
    expect(first.calls).toMatchObject({ load: 1, open: 1, errors: [] });
    expect(first.calls.written).toEqual([`${JSON.stringify({ passed: "9.9.9 v22.1.0" })}\n`]);
    const again = deps({ readRecord: () => first.calls.written[0]! });
    expect(nodeRuntimeGate(again.d)).toEqual({ proceed: true });
    expect(again.calls).toMatchObject({ load: 0, open: 0, written: [], errors: [] });
  });

  it("another CLI version or another Node version checks again", () => {
    const record = `${JSON.stringify({ passed: "9.9.8 v22.1.0" })}\n`;
    expect(deps({ readRecord: () => record }).calls.open).toBe(0);
    const other = deps({ readRecord: () => record });
    nodeRuntimeGate(other.d);
    expect(other.calls.open).toBe(1);
  });

  it.each(["v20.11.0", "v23.1.0", "v25.0.0"])("Node %s is refused (exit 1), named with the supported range, and no native code runs", (version) => {
    const { d, calls } = deps({ nodeVersion: version });
    expect(nodeRuntimeGate(d)).toEqual({ proceed: false, exitCode: 1 });
    expect(calls.errors.join("\n")).toContain(version);
    expect(calls.errors.join("\n")).toMatch(/22, 24 (or|and) 26/);
    expect(calls).toMatchObject({ load: 0, open: 0, written: [] });
  });

  it.each([["doctor"], ["--version"], ["-V"], ["--help"], ["help"]])("rig %s still runs on a refused Node, after the message", (arg) => {
    const { d, calls } = deps({ nodeVersion: "v20.11.0", argv: ["node", "rig", arg] });
    expect(nodeRuntimeGate(d)).toEqual({ proceed: true });
    expect(calls.errors.join("\n")).toContain("v20.11.0");
  });

  it("an untested even major is warned about once, on the first run, and recorded", () => {
    const { d, calls } = deps({ nodeVersion: "v28.0.0" });
    expect(nodeRuntimeGate(d)).toEqual({ proceed: true });
    expect(calls.errors.join("\n")).toContain("untested");
    expect(calls.written).toHaveLength(1);
  });

  it("a binding that will not open refuses (exit 1) with the rebuild fix, and records nothing", () => {
    const { d, calls } = deps({ openNativeDatabase: () => ({ ok: false, detail: "database open was killed by SIGSEGV" }) });
    expect(nodeRuntimeGate(d)).toEqual({ proceed: false, exitCode: 1 });
    expect(calls.errors.join("\n")).toContain("npm rebuild better-sqlite3");
    expect(calls.errors.join("\n")).toContain("SIGSEGV");
    expect(calls.written).toEqual([]);
    const load = deps({ loadNativeAddon: () => { throw new Error("was compiled against a different Node.js version using NODE_MODULE_VERSION 108"); } });
    expect(nodeRuntimeGate(load.d)).toEqual({ proceed: false, exitCode: 1 });
    expect(load.calls.errors.join("\n")).toContain("does not match this Node");
  });

  it("a record it cannot write or read only means the check runs again", () => {
    const unwritable = deps({ writeRecord: () => { throw new Error("EACCES"); } });
    expect(nodeRuntimeGate(unwritable.d)).toEqual({ proceed: true });
    const garbage = deps({ readRecord: () => "{not json" });
    expect(nodeRuntimeGate(garbage.d)).toEqual({ proceed: true });
    expect(garbage.calls.open).toBe(1);
  });
});

describe("nothing loads the binding before the gate", () => {
  // A static runtime import of better-sqlite3 anywhere in the entry's graph loads the binding at import, before the gate, so a
  // binding built for another Node crashes the CLI with a raw stack. Only src/sqlite-binding.ts loads it, on first use.
  it("no CLI source file imports better-sqlite3 at runtime (type-only imports are fine)", () => {
    const SRC = fileURLToPath(new URL("../src/", import.meta.url));
    const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? files(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : []);
    const all = files(SRC);
    expect(all.length).toBeGreaterThan(100);
    const STATIC = /^\s*import\s+(?!type\b)[^;]*?\bfrom\s+["']better-sqlite3["']/m;
    expect(all.filter((f) => STATIC.test(readFileSync(f, "utf8"))).map((f) => f.slice(SRC.length))).toEqual([]);
  });
});

describe("the real CLI entry (src/index.ts) on an unsupported or broken Node", () => {
  const CLI = fileURLToPath(new URL("../src/index.ts", import.meta.url));
  const roots: string[] = [];
  afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
  const scratch = () => {
    const root = mkdtempSync(join(tmpdir(), "o9o180-"));
    roots.push(root);
    writeFileSync(join(root, "spoof.mjs"), "Object.defineProperty(process, 'version', { value: process.env.O9O180_NODE_VERSION, configurable: true });\n");
    writeFileSync(join(root, "break-sqlite.cjs"), [
      "const Module = require('node:module');",
      "const load = Module._load;",
      "Module._load = function (request, ...rest) {",
      "  if (request === 'better-sqlite3' || /better-sqlite3/.test(String(request))) throw new Error('was compiled against a different Node.js version using NODE_MODULE_VERSION 108');",
      "  return load.call(this, request, ...rest);",
      "};",
    ].join("\n"));
    return root;
  };
  // OPENRIG_URL names a port nothing listens on: a command the gate lets through must never reach a real daemon.
  const run = (root: string, args: string[], extraEnv: Record<string, string> = {}, preload: string[] = []) => spawnSync(
    process.execPath, ["--import", "tsx", ...preload, CLI, ...args],
    { encoding: "utf8", timeout: 60_000, env: { PATH: process.env.PATH, HOME: join(root, "home"), OPENRIG_HOME: join(root, "openrig"), OPENRIG_URL: "http://127.0.0.1:1", ...extraEnv } },
  );

  it("Node 20 and an odd major: any command exits 1 naming the version and the supported range", () => {
    const root = scratch();
    for (const version of ["v20.11.0", "v23.1.0"]) {
      const r = run(root, ["ps", "--json"], { O9O180_NODE_VERSION: version }, ["--import", join(root, "spoof.mjs")]);
      expect(r.status, r.stderr).toBe(1);
      expect(r.stderr).toContain(version);
      expect(r.stderr).toMatch(/22, 24 (or|and) 26/);
    }
  });

  it("a binding that will not load: the first run exits 1 with the rebuild fix and records nothing", () => {
    const root = scratch();
    const r = run(root, ["ps", "--json"], { NODE_OPTIONS: `--require ${join(root, "break-sqlite.cjs")}` });
    expect(r.status, r.stderr).toBe(1);
    expect(r.stderr).toContain("npm rebuild better-sqlite3");
    expect(existsSync(join(root, "openrig", RUNTIME_CHECK_RECORD))).toBe(false);
  });

  it("positive control: this Node passes, and the first run records (cli version, Node version)", () => {
    const root = scratch();
    const r = run(root, ["--version"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).not.toMatch(/requires Node|not support/);
    expect(JSON.parse(readFileSync(join(root, "openrig", RUNTIME_CHECK_RECORD), "utf8")).passed).toContain(process.version);
  });
});
