// OPR.0.4.1.30 — static packaging gate (static-gate-mirrors-runtime doctrine).
//
// The published @openrig/cli VENDORS the built daemon: packages/cli `files` includes `daemon`, and
// scripts/build-package.sh copies packages/daemon/dist into packages/cli/daemon. cli does NOT depend
// on @openrig/daemon and cli/src imports no hono — so the vendored daemon resolves its runtime deps
// from the GLOBAL install's node_modules. Therefore the published cli MUST declare every runtime
// dependency the daemon declares; anything the daemon needs but cli omits will be missing on a fresh
// `npm install -g @openrig/cli` (it only "works" in-repo via monorepo hoisting).
//
// 0.4.0 shipped with @hono/node-ws declared by the daemon (it statically imports createNodeWebSocket
// at packages/daemon/src/server.ts) but NOT by the cli — so a fresh global install could not start
// the daemon (the worst-audience first-run break). This gate makes that whole class un-shippable.
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

function runtimeDeps(pkgRelToTest: string): Record<string, string> {
  const pkg = JSON.parse(readFileSync(path.resolve(__dirname, pkgRelToTest), "utf8"));
  return pkg.dependencies ?? {};
}

describe("packaging: cli mirrors the vendored daemon's runtime deps (OPR.0.4.1.30)", () => {
  const daemonDeps = runtimeDeps("../../daemon/package.json");
  const cliDeps = runtimeDeps("../package.json");

  it("declares EVERY runtime dependency the vendored daemon requires", () => {
    // cli vendors the daemon, so cli.dependencies must be a superset of daemon.dependencies.
    const missing = Object.keys(daemonDeps).filter((dep) => !(dep in cliDeps));
    expect(missing).toEqual([]);
  });

  it("declares the terminal WebSocket's packages at the daemon's range (the 0.4.0 fresh-install break)", () => {
    // The 0.4.0 regression was @hono/node-ws in the daemon and absent in cli. Since workspaces-o9o.125 the daemon's
    // WebSocket is @hono/node-server 2's own upgradeWebSocket over a ws WebSocketServer, so those two carry it.
    for (const dep of ["@hono/node-server", "ws"]) {
      expect(daemonDeps[dep], dep).toBeDefined();
      expect(cliDeps[dep], dep).toBe(daemonDeps[dep]);
    }
    expect(daemonDeps["@hono/node-ws"]).toBeUndefined();
    expect(cliDeps["@hono/node-ws"]).toBeUndefined();
  });

  // workspaces-o9o.125: the root package.json keeps @hono/node-ws and @hono/node-server 1.x as dev-only pins for one test's old
  // daemon build. They resolve from the repo root, so a daemon or cli source file that imported @hono/node-ws would work in this
  // checkout and fail in a published install, which carries neither. No source file may name it as a module.
  it("no daemon or cli source file imports @hono/node-ws (it resolves only from the repo root's dev-only pins)", () => {
    const sourceFiles = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      return entry.isDirectory() ? sourceFiles(full) : /\.[cm]?[jt]sx?$/.test(entry.name) ? [full] : [];
    });
    const roots = ["../../daemon/src", "../src"].map((rel) => path.resolve(__dirname, rel));
    const files = roots.flatMap(sourceFiles);
    expect(files.length).toBeGreaterThan(500);
    const NAMES_IT = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["'`]@hono\/node-ws(?:\/[^"'`]*)?["'`]/;
    expect(files.filter((file) => NAMES_IT.test(readFileSync(file, "utf8"))).map((file) => path.relative(path.resolve(__dirname, "../.."), file))).toEqual([]);
  });

  it("keeps mirrored shared deps at matching ranges (no drift between cli + daemon)", () => {
    // For every dep both declare, the ranges must match so the global install can't resolve a
    // different version than the daemon was built/tested against.
    const drifted = Object.keys(daemonDeps)
      .filter((dep) => dep in cliDeps && cliDeps[dep] !== daemonDeps[dep])
      .map((dep) => `${dep}: cli ${cliDeps[dep]} vs daemon ${daemonDeps[dep]}`);
    expect(drifted).toEqual([]);
  });
});
