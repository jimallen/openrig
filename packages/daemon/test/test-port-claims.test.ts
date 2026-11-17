// workspaces-o9o.81: a port a test hands to something that binds it later is claimed, so two test processes are never handed the same one.
// Measured on release 4's suites: two copies of delivery-review.real (two heavy-run slots) took one port (/api/health answered from the
// other run's daemon), and a scenario daemon died on EADDRINUSE on a port its helper had probed and released. The rows below run a second
// test process for real (a child node process using the same helper); the OS's offer is steered through the helper's probe seam, since the
// OS cannot be made to repeat a port on demand. The census row keeps every new probe-then-release site on the helper.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { claimPort, claimTestPort, probeFreePort, releasePort, TEST_PORT_CLAIMS_DIR } from "./helpers/test-ports.js";

const HELPER = resolve(import.meta.dirname, "helpers/test-ports.ts");
const DAEMON_PKG = resolve(import.meta.dirname, "..");
const REPO = resolve(DAEMON_PKG, "../..");

/** A free port with a claim file of `content` staged on it: only a port no other test process has claimed (a free port can be claimed and
 *  not yet bound), retried when the exclusive create finds one there. */
function stagedClaim(content: string): Promise<{ p: number; file: string }> {
  return (async () => {
    for (let i = 0; i < 50; i += 1) {
      const p = await probeFreePort();
      const file = join(TEST_PORT_CLAIMS_DIR, String(p));
      try { writeFileSync(file, content, { flag: "wx" }); return { p, file }; } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
    }
    throw new Error("no unclaimed free port to stage a claim on");
  })();
}

/** A free port nobody has claimed, claimed now by this process through claimPort (the "absent" state), retried if another took it first. */
async function claimFromAbsent(): Promise<number> {
  for (let i = 0; i < 50; i += 1) {
    const p = await probeFreePort();
    if (existsSync(join(TEST_PORT_CLAIMS_DIR, String(p)))) continue;
    if (claimPort(p)) return p;
  }
  throw new Error("no absent claim to take");
}

/** Rewrites this process's own claim on `port` to a pid that is gone; throws for a claim it does not hold. */
function makeOwnClaimStale(port: number): void {
  const file = join(TEST_PORT_CLAIMS_DIR, String(port));
  const owner = existsSync(file) ? readFileSync(file, "utf8").trim() : "";
  if (owner !== String(process.pid)) throw new Error(`port ${port} is not this process's claim (owner ${owner || "none"})`);
  const gone = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }).stdout;
  writeFileSync(file, gone);
}

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
    try {
      // The second offer is any free port the OS gives: a fixed spare could be claimed by a third test process first (verify-qa, fix 2).
      const other = await otherProcess(`const offers = [${held}]; return await h.claimTestPort({ probe: async () => offers.shift() ?? h.probeFreePort() });`);
      const got = JSON.parse(other.out) as number;
      expect(Number.isInteger(got)).toBe(true);
      expect(got).not.toBe(held);
    } finally { releasePort(held); }
  });

  it("RED: a claim held by another live test process keeps this process off the port", async () => {
    const holder = await otherProcess(`return await h.claimTestPort();`, { keepAlive: true });   // the holder claims a port of its own
    try {
      const port = JSON.parse(holder.out) as number;
      expect(Number.isInteger(port)).toBe(true);
      await expect(claimTestPort({ probe: async () => port, attempts: 2 })).rejects.toThrow(/no unclaimed loopback port/);
    } finally { process.kill(holder.pid, "SIGKILL"); }
  });

  it("a claim whose process is gone is reclaimed", async () => {
    const port = await claimTestPort();   // this process's own claim, taken exclusively: no other process's claim is touched
    makeOwnClaimStale(port);
    try {
      expect(claimPort(port)).toBe(true);
      expect(readFileSync(join(TEST_PORT_CLAIMS_DIR, String(port)), "utf8")).toBe(String(process.pid));
    } finally { releasePort(port); }
  });

  // verify-qa FAIL of 33dcd26c0 (fix 1): the reclaim row overwrote <claims>/<port> for a port it had only probed, so it could rewrite a live
  // process's claim. It now makes only its OWN claim stale, and refuses anyone else's.
  it("RED (review): making a claim stale refuses a claim this process does not hold (a live process's claim is left alone)", async () => {
    const holder = await otherProcess(`return await h.claimTestPort();`, { keepAlive: true });   // the holder claims a port of its own
    try {
      const port = JSON.parse(holder.out) as number;
      expect(() => makeOwnClaimStale(port)).toThrow(/not this process's claim/);
      expect(readFileSync(join(TEST_PORT_CLAIMS_DIR, String(port)), "utf8")).toBe(String(holder.pid));
    } finally { process.kill(holder.pid, "SIGKILL"); }
  });

  // verify-qa FAIL of 49f186f65 (fix 1): a claim was an exclusive open plus a SEPARATE write, and an empty or unparseable claim read as dead.
  // A writer paused between the two left an empty file that a second claimer reclaimed, so both believed they held the port. What a paused
  // (or crashed) writer leaves is reproduced exactly: an empty claim file.
  it("RED (review): an empty claim (a writer between its open and its write) is held, not reclaimed", async () => {
    const { p: port, file } = await stagedClaim("");
    try {
      expect(claimPort(port)).toBe(false);
      expect(readFileSync(file, "utf8")).toBe("");
    } finally { rmSync(file, { force: true }); }
  });

  it("RED (review): claimPort refuses a port that is not a positive integer, and writes no file for it", () => {
    for (const bad of [undefined, null, Number.NaN, 1.5, -1, 0, "4242"] as unknown[]) {
      expect(claimPort(bad as number), String(bad)).toBe(false);
      expect(existsSync(join(TEST_PORT_CLAIMS_DIR, String(bad))), String(bad)).toBe(false);
    }
  });

  it("the census of claim states, each with its answer: absent, own, held-live, held-dead, writing, unparseable (fresh and old)", async () => {
    const aged = (file: string) => { const t = (Date.now() - 10 * 60_000) / 1000; utimesSync(file, t, t); };
    const gone = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }).stdout;
    const holder = await otherProcess(`return await h.claimTestPort();`, { keepAlive: true });
    const live = JSON.parse(holder.out) as number;
    try {
      const absent = await claimFromAbsent();   // absent, then claimed
      expect(claimPort(absent), "own").toBe(false);
      releasePort(absent);
      expect(claimPort(live), "held by a live process").toBe(false);
      const dead = await stagedClaim(gone);
      expect(claimPort(dead.p), "held by a process that is gone").toBe(true);
      releasePort(dead.p);
      const writing = await stagedClaim("");
      expect(claimPort(writing.p), "writing (empty, fresh)").toBe(false);
      const garbled = await stagedClaim("not a pid");
      expect(claimPort(garbled.p), "unparseable, fresh").toBe(false);
      const old = await stagedClaim(""); aged(old.file);
      expect(claimPort(old.p), "empty, older than the grace").toBe(true);
      releasePort(old.p);
      for (const f of [writing.file, garbled.file]) rmSync(f, { force: true });
    } finally { process.kill(holder.pid, "SIGKILL"); }
  });

  it("a claim leaves no temp file behind", async () => {
    const before = new Set(readdirSync(TEST_PORT_CLAIMS_DIR));
    const port = await claimTestPort();
    releasePort(port);
    const left = readdirSync(TEST_PORT_CLAIMS_DIR).filter((f) => !before.has(f) && f.includes(String(process.pid)));
    expect(left).toEqual([]);
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

// The census: every place a test (under packages/*/test or scripts/) reads a port from a server it then closes in the same block, so the
// number goes on to something else or must stay refused, goes through helpers/test-ports-core.mjs. Two shapes count (verify-qa review,
// fix 3): nothing but reading the port before the close, or handing the port to a child process (spawn, spawnSync, fork, exec*) before the
// close. A server closed in teardown (afterAll, afterEach, a cleanup list, a returned close()) kept its socket while in use. A server bound
// to a fixed port number is counted too. The census's own fixture text is assembled at runtime so it never matches here.
const LISTEN = "lis" + "ten";
const LISTEN0 = new RegExp(`${LISTEN}\\(\\s*0\\b|${LISTEN}\\(\\s*\\{\\s*port:\\s*0\\b`);
const LISTEN_FIXED = new RegExp(`\\.${LISTEN}\\(\\s*[1-9]\\d{3,4}\\b`);
/** What may sit between the listen and the close of a probe: reading the port, waiting for "listening", checking the address. */
const PROBE_ONLY = /^\s*$|address\(\)|\.port\b|await once\(\s*\w+,\s*"listening"\)|missing fixture address|^\s*\}\)?\)?;?\s*$|^\s*(srv|server|probe|listener|vacant|reservation)\.(once|on)\("error"/;
const HANDOFF = /\b(spawn|spawnSync|fork|execFile|execFileSync|exec|execSync)\(/;
const SAME_BLOCK_CLOSE = /^\s*(await\s+new Promise(<void>)?\(\(\w+\)\s*=>\s*)?\w+\.close\(|^\s*(srv|server|probe|listener|vacant|reservation)\.close\(|^\s*if \(mode === "stopped"\)/;
/** Lines of `source` (1-based) where a port leaves through a listen(0) server closed in the same block, or a server binds a fixed port. */
export function probeThenRelease(source: string): number[] {
  const lines = source.split("\n");
  const hits: number[] = [];
  lines.forEach((line, i) => {
    if (LISTEN_FIXED.test(line)) { hits.push(i + 1); return; }
    if (!LISTEN0.test(line)) return;
    if (/\.close\(/.test(line)) { hits.push(i + 1); return; }   // closed in the listen callback itself
    let handedOn = false;
    for (let j = i + 1; j < Math.min(lines.length, i + 30); j += 1) {
      const next = lines[j]!;
      if (/\.close\(/.test(next)) { if (SAME_BLOCK_CLOSE.test(next)) hits.push(i + 1); return; }
      if (HANDOFF.test(next)) { handedOn = true; continue; }
      if (handedOn) continue;                       // the rest of the child call, up to the close
      if (!PROBE_ONLY.test(next)) return;           // the server is used before it closes: it kept its socket while in use
    }
  });
  return hits;
}

/** The helper's own probe lines: the only listen(0) servers allowed to close before the number leaves (it claims first). */
const ALLOWED_LINES: Array<{ file: string; line: string; why: string }> = [
  { file: "packages/daemon/test/helpers/test-ports-core.mjs", line: `srv.${LISTEN}(0, "127.0.0.1"`, why: "probeFreePort: the claim is taken before the number leaves" },
  { file: "packages/daemon/test/helpers/test-ports-core.mjs", line: `s.${LISTEN}(0,'127.0.0.1'`, why: "claimTestPortSync's child probe: claimed before it leaves" },
];

describe("census: no probe-then-release site outside helpers/test-ports-core.mjs", () => {
  const files = spawnSync("git", ["-C", REPO, "ls-files", "packages/*/test/**", "packages/*/test/*", "scripts/**", "scripts/*"], { encoding: "utf8" }).stdout
    .split("\n").filter((f) => /\.(ts|mts|cts|js|mjs|cjs)$/.test(f));

  it("the detector sees the shapes it is meant to catch (positive controls) and leaves a kept server alone (negative control)", () => {
    const released = ["const srv = createServer();", `srv.${LISTEN}(0, "127.0.0.1", () => {`, "  const port = (srv.address() as AddressInfo).port;", "  srv.close(() => resolve(port));", "});"].join("\n");
    const oneLine = `const p = run("const s=require('node:net').createServer();s.${LISTEN}(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})");`;
    // verify-qa review fix 3: the port handed to a child while the server is still open, then closed in the same block.
    const handedOn = [`await new Promise((r) => server.${LISTEN}(0, "127.0.0.1", r));`, "const port = server.address().port;",
      "const out = spawnSync(process.execPath, [CHILD], {", "  env: { PORT: String(port) },", "});", "await new Promise((r) => server.close(r));"].join("\n");
    const fixed = `await new Promise((r) => foreign.${LISTEN}(45873, "127.0.0.1", r));`;
    const kept = [`await new Promise((r) => server.${LISTEN}(0, "127.0.0.1", r));`, "port = (server.address() as AddressInfo).port;", "});", "afterAll(() => {", "  server.close();", "});"].join("\n");
    const used = [`await new Promise((r) => server.${LISTEN}(0, "127.0.0.1", r));`, "const port = server.address().port;", "const result = await waitForKernelReady(url(port));", "server.close();"].join("\n");
    expect(probeThenRelease(released)).toEqual([2]);
    expect(probeThenRelease(oneLine)).toEqual([1]);
    expect(probeThenRelease(handedOn)).toEqual([1]);
    expect(probeThenRelease(fixed)).toEqual([1]);
    expect(probeThenRelease(kept)).toEqual([]);
    expect(probeThenRelease(used)).toEqual([]);
  });

  it("every early-closed listen(0) server, and every fixed-port server, is the helper's own probe", () => {
    const sites = files.flatMap((f) => {
      const lines = readFileSync(join(REPO, f), "utf8").split("\n");
      return probeThenRelease(lines.join("\n")).map((n) => ({ f, n, text: lines[n - 1]! }));
    });
    const listening = files.filter((f) => LISTEN0.test(readFileSync(join(REPO, f), "utf8"))).length;
    expect(files.length, "files read").toBeGreaterThan(1000);
    expect(files.filter((f) => f.startsWith("scripts/")).length, "scripts/ files read").toBeGreaterThan(20);
    expect(listening, "files that listen on port 0 (the population checked)").toBeGreaterThan(100);
    const stray = sites.filter((s) => !ALLOWED_LINES.some((a) => a.file === s.f && s.text.includes(a.line))).map((s) => `${s.f}:${s.n}`);
    expect(stray, `probe-then-release outside the helper: use claimTestPort() (${relative(REPO, HELPER)})`).toEqual([]);
  });
});
