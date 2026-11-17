// workspaces-o9o.81: a port a test hands to something that binds it later is claimed, so two test processes are never handed the same one.
// Measured on release 4's suites: two copies of delivery-review.real (two heavy-run slots) took one port (/api/health answered from the
// other run's daemon), and a scenario daemon died on EADDRINUSE on a port its helper had probed and released. The rows below run a second
// test process for real (a child node process using the same helper); the OS's offer is steered through the helper's probe seam, since the
// OS cannot be made to repeat a port on demand. The census row keeps every new probe-then-release site on the helper.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { claimPort, claimTestPort, probeFreePort, releasePort, TEST_PORT_CLAIMS_DIR } from "./helpers/test-ports.js";

const HELPER = resolve(import.meta.dirname, "helpers/test-ports.ts");
const DAEMON_PKG = resolve(import.meta.dirname, "..");
const REPO = resolve(DAEMON_PKG, "../..");

/** Another test process: imports the same helper and runs `body` (an async function body with `h` bound to the helper module). */
function otherProcess(body: string, opts: { keepAlive?: boolean } = {}): Promise<{ out: string; pid: number; code: number | null }> {
  const code = `const h = await import(${JSON.stringify(pathToFileURL(HELPER).href)});\n(async () => { ${body} })().then(` +
    `(v) => { process.stdout.write(JSON.stringify(v ?? null) + "\\n"); ${opts.keepAlive ? "setInterval(() => {}, 1 << 30);" : "process.exit(0);"} }, ` +
    `(e) => { process.stdout.write(JSON.stringify({ error: String(e && e.message || e) }) + "\\n"); process.exit(0); });`;
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { cwd: DAEMON_PKG, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (c) => {
      out += c;
      if (opts.keepAlive && out.includes("\n")) done({ out: out.trim(), pid: child.pid!, code: null });
    });
    child.on("error", fail);
    child.on("close", (exit) => done({ out: out.trim(), pid: child.pid!, code: exit }));
  });
}

describe("workspaces-o9o.81: a test port is claimed, not probed and released", () => {
  it("RED: a port this process holds is not handed to another test process, even when the OS offers it there", async () => {
    const port = await claimTestPort();
    try {
      const other = await otherProcess(`return await h.claimTestPort({ probe: async () => ${port}, attempts: 3 });`);
      expect(JSON.parse(other.out)).toEqual({ error: expect.stringMatching(/no unclaimed loopback port after 3 offers/) });
    } finally { releasePort(port); }
  });

  it("RED: offered a claimed port and then a free one, the other process takes the free one", async () => {
    const held = await claimTestPort();
    const spare = await probeFreePort();
    try {
      const other = await otherProcess(`const offers = [${held}, ${spare}]; return await h.claimTestPort({ probe: async () => offers.shift() });`);
      expect(JSON.parse(other.out)).toBe(spare);
    } finally { releasePort(held); }
  });

  it("RED: a claim held by another live test process keeps this process off the port", async () => {
    const port = await probeFreePort();
    const holder = await otherProcess(`return h.claimPort(${port});`, { keepAlive: true });
    try {
      expect(JSON.parse(holder.out)).toBe(true);
      await expect(claimTestPort({ probe: async () => port, attempts: 2 })).rejects.toThrow(/no unclaimed loopback port/);
    } finally { process.kill(holder.pid, "SIGKILL"); }
  });

  it("a claim whose process is gone is reclaimed", async () => {
    const port = await probeFreePort();
    const gone = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
    writeFileSync(join(TEST_PORT_CLAIMS_DIR, String(port)), gone.stdout);
    try {
      expect(claimPort(port)).toBe(true);
      expect(readFileSync(join(TEST_PORT_CLAIMS_DIR, String(port)), "utf8")).toBe(String(process.pid));
    } finally { releasePort(port); }
  });

  it("a process's claims are dropped when it exits", async () => {
    const other = await otherProcess(`return await h.claimTestPort();`);
    const port = JSON.parse(other.out) as number;
    expect(Number.isInteger(port)).toBe(true);
    expect(existsSync(join(TEST_PORT_CLAIMS_DIR, String(port)))).toBe(false);
  });

  it("this process never takes its own claimed port twice", async () => {
    const port = await claimTestPort();
    try { expect(claimPort(port)).toBe(false); } finally { releasePort(port); }
  });
});

// The census: every place a test reads a port from a server it then closes (so the number goes on to something else, or must stay refused)
// goes through helpers/test-ports.ts. A server closed in teardown (afterAll, afterEach, a cleanup list, a returned close()) kept its socket
// while in use and is not counted.
const LISTEN0 = /listen\(\s*0\b|listen\(\s*\{\s*port:\s*0\b/;
/** What may sit between the listen and the close of a probe: reading the port, waiting for "listening", checking the address. */
const PROBE_ONLY = /^\s*$|address\(\)|\.port\b|await once\(\s*\w+,\s*"listening"\)|missing fixture address|^\s*\}\)?\)?;?\s*$|^\s*(srv|server|probe|listener|vacant)\.(once|on)\("error"/;
/** Lines of `source` (1-based) where a listen(0) server is closed with nothing using it in between: its port number is all it gave. */
export function probeThenRelease(source: string): number[] {
  const lines = source.split("\n");
  const hits: number[] = [];
  lines.forEach((line, i) => {
    if (!LISTEN0.test(line)) return;
    if (/\.close\(/.test(line)) { hits.push(i + 1); return; }   // closed in the listen callback itself
    for (let j = i + 1; j < Math.min(lines.length, i + 8); j += 1) {
      if (/\.close\(/.test(lines[j]!)) { if (/^\s*(await\s+new Promise<void>\(\(\w+\)\s*=>\s*)?\w+\.close\(|^\s*srv\.close\(|^\s*if \(mode === "stopped"\)/.test(lines[j]!)) hits.push(i + 1); return; }
      if (!PROBE_ONLY.test(lines[j]!)) return;   // the server is used before it closes: it kept its socket while in use
    }
  });
  return hits;
}

/** Sites that close a listen(0) server early on purpose and do not hand the number on, each with why. */
const ALLOWED: Record<string, string> = {
  "packages/daemon/test/helpers/test-ports.ts": "the helper itself: it probes, then claims before the number leaves",
  "packages/daemon/test/test-port-claims.test.ts": "this census's own controls: the probe-then-release shape, as text",
};

describe("census: no probe-then-release site outside helpers/test-ports.ts", () => {
  const files = spawnSync("git", ["-C", REPO, "ls-files", "packages/*/test/**", "packages/*/test/*"], { encoding: "utf8" }).stdout
    .split("\n").filter((f) => /\.(ts|mts|cts|js|mjs|cjs)$/.test(f));

  it("the detector sees the shape it is meant to catch (positive control) and leaves a kept server alone (negative control)", () => {
    const released = ["const srv = createServer();", "srv.listen(0, \"127.0.0.1\", () => {", "  const port = (srv.address() as any).port;", "  srv.close(() => resolve(port));", "});"].join("\n");
    const kept = ["await new Promise((r) => server.listen(0, \"127.0.0.1\", r));", "port = (server.address() as any).port;", "});", "afterAll(() => {", "  server.close();", "});"].join("\n");
    expect(probeThenRelease(released)).toEqual([2]);
    expect(probeThenRelease(kept)).toEqual([]);
  });

  it("every early-closed listen(0) server is the helper's or allow-listed with a reason", () => {
    const sites = files.flatMap((f) => probeThenRelease(readFileSync(join(REPO, f), "utf8")).map((line) => ({ f, line })));
    const listening = files.filter((f) => LISTEN0.test(readFileSync(join(REPO, f), "utf8"))).length;
    expect(files.length, "test files read").toBeGreaterThan(1000);
    expect(listening, "files that listen on port 0 (the population checked)").toBeGreaterThan(100);
    const stray = sites.filter((s) => !(s.f in ALLOWED)).map((s) => `${s.f}:${s.line}`);
    expect(stray, `probe-then-release outside helpers/test-ports.ts: use claimTestPort() (${relative(REPO, HELPER)})`).toEqual([]);
  });
});
