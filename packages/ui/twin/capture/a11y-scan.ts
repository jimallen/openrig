// workspaces-o9o.130 — twin:a11y: an axe-core scan of every twin surface (a11y-report.ts SURFACES) in light and dark.
//
// For each surface: `twin:build` with TWIN_ROUTE, open twin-out/intent.html in headless Chrome, wait until the page is
// still, open the surface's dialog if it has one, inject axe-core's own axe.min.js and run it with its DEFAULT rules (none
// disabled, none filtered). Chrome is driven over the DevTools protocol with Node's built-in WebSocket (Node 22+), so no
// client library is added. Writes a11y-report.json and a11y-report.md to --out.
//
// Usage: tsx twin/capture/a11y-scan.ts --out <dir> [--chrome <binary>] [--no-sandbox] [--only <surface id>[,<id>...]]
//   [--start-timeout-ms <ms>]  how long Chrome has to start and answer the DevTools protocol (default 20000).
//   [--surface-timeout-ms <ms>]  how long one surface's scan in one theme may take (default 120000); past it, that scan is a
//   named failure and the run goes on (workspaces-o9o.184: a hang now names its surface instead of stalling the run).
//   [--build-timeout-ms <ms>]  how long one twin:build may take (default 600000), the same way.
//   --no-sandbox: pass it where Chrome cannot use its sandbox (a host with unprivileged user namespaces disabled, e.g.
//   Ubuntu 23.10+). The page is the twin's own file:// build.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DIALOGS_NOT_SCANNED, NOT_SCANNED, SURFACES, crashMessage, renderMarkdown, summarizeByRule, type ScanRecord, type Surface, type Theme, type Violation } from "./a11y-report.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR = path.resolve(__dirname, "..", "..");
const INTENT = path.join(UI_DIR, "twin-out", "intent.html");
const THEMES: Theme[] = ["light", "dark"];
const SETTLE_QUIET_MS = 1500;
const SETTLE_MAX_MS = 20_000;
const OPEN_MAX_MS = 10_000;

function fail(msg: string): never {
  process.stderr.write(`twin:a11y FAILED — ${msg}\n`);
  process.exit(1);
}

function parseArgs(argv: string[]) {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined || !a.startsWith("--")) continue;
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) { out[a.slice(2)] = next; i++; } else { out[a.slice(2)] = ""; }
  }
  if (!out["out"]) fail("missing required flag --out <dir>");
  const ms = (flag: string, fallback: number): number => {
    const v = out[flag] ? Number(out[flag]) : fallback;
    if (!Number.isInteger(v) || v <= 0) fail(`--${flag} must be a positive integer`);
    return v;
  };
  return {
    out: path.resolve(out["out"]), chrome: out["chrome"] || undefined, noSandbox: "no-sandbox" in out, only: out["only"] ? out["only"].split(",") : null,
    startTimeoutMs: ms("start-timeout-ms", 20_000), surfaceTimeoutMs: ms("surface-timeout-ms", 120_000), buildTimeoutMs: ms("build-timeout-ms", 600_000),
  };
}

/** The same lookup as twin-capture.ts: --chrome, CHROME_BIN, the macOS apps, then PATH. */
function resolveChrome(override?: string): string {
  for (const c of [override, process.env.CHROME_BIN, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"]) {
    if (c && existsSync(c)) return c;
  }
  const found = spawnSync("bash", ["-lc", "command -v google-chrome chromium chrome 2>/dev/null | head -1"], { encoding: "utf8" }).stdout.trim().split("\n")[0];
  return found || fail("no headless Chrome found (set --chrome or CHROME_BIN)");
}

/** A minimal DevTools-protocol client over Node's built-in WebSocket. */
class Cdp {
  private id = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private constructor(private ws: WebSocket) {
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data)) as { id?: number; result?: unknown; error?: { message: string } };
      const p = msg.id === undefined ? undefined : this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id!);
      if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result);
    });
  }
  static async connect(url: string, timeoutMs: number): Promise<Cdp> {
    const ws = new WebSocket(url);
    try {
      await withTimeout(new Promise<void>((resolve, reject) => {
        ws.addEventListener("open", () => resolve());
        ws.addEventListener("error", () => reject(new Error(`cannot connect to ${url}`)));
      }), timeoutMs, `Chrome did not answer the DevTools protocol within ${timeoutMs} ms`);
    } catch (e) { ws.close(); throw e; }
    return new Cdp(ws);
  }
  send<T = unknown>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    const id = ++this.id;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  close() { this.ws.close(); }
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([p, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })])
    .finally(() => clearTimeout(timer));
}

/** What the scan created outside itself: filled in as each is created, so cleanup sees it even when start-up fails. */
interface Held { proc?: ChildProcess; profile?: string; reaper?: ChildProcess }

/**
 * workspaces-o9o.184: the owner-death reaper. A detached shell that outlives this scanner (its own session, so a stop of the
 * scanner's process tree does not take it), watches the scanner's pid AND start time (a reused pid is not the scanner), and
 * when the scanner is gone stops Chrome itself (its pid and start time, recorded at launch) and every process whose arguments
 * hold the profile path (Chrome's helpers), TERM then KILL, and removes the profile. The path is a fresh mkdtemp, so it names this scan's Chrome only; it reaches the watchdog through
 * its environment, so the watchdog's own arguments never match it. ps and kill only: Linux and macOS alike.
 */
const REAPER = String.raw`owner=$1; chrome=$2; start=$(ps -o lstart= -p "$owner" 2>/dev/null); cstart=$(ps -o lstart= -p "$chrome" 2>/dev/null)
[ -n "$start" ] || exit 0
while [ "$(ps -o lstart= -p "$owner" 2>/dev/null)" = "$start" ]; do sleep 1; done
for sig in TERM KILL; do
  pids=$(ps -axo pid=,args= | while read -r pid args; do case $args in *"$TWIN_A11Y_PROFILE"*) echo "$pid" ;; esac; done)
  if [ -n "$cstart" ] && [ "$(ps -o lstart= -p "$chrome" 2>/dev/null)" = "$cstart" ]; then pids="$pids $chrome"; fi
  [ -n "$pids" ] || break
  kill -$sig $pids 2>/dev/null
  sleep 2
done
rm -rf "$TWIN_A11Y_PROFILE"`;

/** The pids of processes whose arguments hold `profile` (this scan's Chrome and its helpers), from ps. */
function holdersOf(profile: string): number[] {
  const out = spawnSync("ps", ["-axo", "pid=,args="], { encoding: "utf8" }).stdout ?? "";
  return out.split("\n").flatMap((line) => {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    return m && m[2]!.includes(profile) && Number(m[1]) !== process.pid ? [Number(m[1])] : [];
  });
}

/** Start Chrome and return its DevTools URL. The profile and the process are recorded in `held` the moment they exist. */
async function launch(chrome: string, noSandbox: boolean, timeoutMs: number, held: Held): Promise<string> {
  held.profile = mkdtempSync(path.join(os.tmpdir(), "twin-a11y-"));
  const args = ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${held.profile}`, "--no-first-run", ...(noSandbox ? ["--no-sandbox"] : []), "about:blank"];
  const proc = spawn(chrome, args, { stdio: ["ignore", "ignore", "pipe"] });
  held.proc = proc;
  // Armed in the same tick Chrome is spawned (nothing awaited in between), with Chrome's own pid: from here on, this scanner
  // dying cannot leave Chrome, its helpers or the profile behind, even a Chrome whose arguments no longer show the profile.
  const reaper = spawn("/bin/sh", ["-c", REAPER, "twin-a11y-reaper", String(process.pid), String(proc.pid ?? 0)], {
    detached: true, stdio: "ignore", env: { ...process.env, TWIN_A11Y_PROFILE: held.profile },
  });
  reaper.unref();
  held.reaper = reaper;
  return withTimeout(new Promise<string>((resolve, reject) => {
    let buf = "";
    proc.stderr!.on("data", (d: Buffer) => { buf += d.toString(); const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf); if (m) resolve(m[1]!); });
    proc.on("error", (e) => reject(new Error(`chrome could not start: ${e.message}`)));
    proc.on("exit", (code) => reject(new Error(`chrome exited (${code}) before listening: ${buf.trim().split("\n").slice(-1)[0] ?? ""}`)));
  }), timeoutMs, `chrome did not start within ${timeoutMs} ms`);
}

/**
 * Stop Chrome (TERM, then KILL after 5 s), then any helper still holding the profile (o9o.184: a helper can outlive the main
 * process and keep writing), and only then remove the profile. A profile that still cannot be removed is a warning naming
 * it, not a failure: the scan's result stands. Last, the reaper is stopped: nothing is left for it to do.
 */
async function release(held: Held): Promise<void> {
  const proc = held.proc;
  if (proc && proc.exitCode === null && proc.signalCode === null) {
    await new Promise<void>((resolve) => {
      const kill = setTimeout(() => proc.kill("SIGKILL"), 5000);
      proc.once("exit", () => { clearTimeout(kill); resolve(); });
      proc.kill("SIGTERM");
    });
  }
  if (held.profile) {
    for (const sig of ["SIGTERM", "SIGKILL"] as const) {
      const pids = holdersOf(held.profile);
      if (pids.length === 0) break;
      for (const pid of pids) { try { process.kill(pid, sig); } catch { /* gone */ } }
      await sleep(1000);
    }
    try {
      rmSync(held.profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch (e) {
      process.stderr.write(`twin:a11y warning — could not remove the Chrome profile ${held.profile}: ${(e as Error).message}\n`);
    }
  }
  if (held.reaper && held.reaper.exitCode === null) { try { held.reaper.kill("SIGKILL"); } catch { /* gone */ } }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function scanOne(cdp: Cdp, surface: Surface, theme: Theme, axeSource: string): Promise<ScanRecord> {
  const { targetId } = await cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
  const s = <T = unknown>(m: string, p: Record<string, unknown> = {}) => cdp.send<T>(m, p, sessionId);
  const ev = async <T>(expression: string): Promise<T> => {
    const r = await s<{ result: { value: T }; exceptionDetails?: { text: string; exception?: { description?: string } } }>("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  const settle = async () => {
    let last = "", since = Date.now();
    for (const t0 = Date.now(); Date.now() - t0 < SETTLE_MAX_MS; ) {
      await sleep(250);
      const t = await ev<string>("document.body ? document.body.innerText : ''");
      if (t !== last) { last = t; since = Date.now(); } else if (Date.now() - since > SETTLE_QUIET_MS) return;
    }
  };
  const crashed = async (): Promise<string | null> => {
    const text = await ev<string>("document.body ? document.body.innerText : ''");
    if (crashMessage(text) === null) return null;
    await ev("[...document.querySelectorAll('button')].find((b) => /show error/i.test(b.textContent || ''))?.click(); true");
    await sleep(300);
    return crashMessage(await ev<string>("document.body.innerText")) || "(no message shown)";
  };
  try {
    await s("Page.enable"); await s("Runtime.enable");
    await s("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await s("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] });
    await s("Page.navigate", { url: `file://${INTENT}` });
    await settle();
    const pageCrash = await crashed();
    if (pageCrash !== null) return { surface: surface.id, theme, ok: false, error: `the page crashed in the twin: ${pageCrash}` };
    if (surface.open) {
      const { click, expect } = surface.open;
      if (!(await ev<boolean>(`!!document.querySelector(${JSON.stringify(click)})`))) return { surface: surface.id, theme, ok: false, error: `trigger not found: ${click}` };
      await ev(`document.querySelector(${JSON.stringify(click)}).click()`);
      let opened = false;
      for (const t0 = Date.now(); !opened && Date.now() - t0 < OPEN_MAX_MS; ) { await sleep(200); opened = await ev<boolean>(`!!document.querySelector(${JSON.stringify(expect)})`); }
      if (!opened) return { surface: surface.id, theme, ok: false, error: `dialog did not open: ${expect}` };
      await settle();
      const dialogCrash = await crashed();
      if (dialogCrash !== null) return { surface: surface.id, theme, ok: false, error: `the page crashed after opening the dialog: ${dialogCrash}` };
    }
    await ev(axeSource + "\n;true");
    const raw = await ev<Array<{ id: string; impact: Violation["impact"]; help: string; helpUrl: string; nodes: Array<{ target: unknown[] }> }>>(
      "axe.run(document, { resultTypes: ['violations'] }).then(r => r.violations.map(v => ({ id: v.id, impact: v.impact, help: v.help, helpUrl: v.helpUrl, nodes: v.nodes.map(n => ({ target: n.target })) })))",
    );
    const violations: Violation[] = raw.map((v) => ({ id: v.id, impact: v.impact ?? null, help: v.help, helpUrl: v.helpUrl, targets: v.nodes.map((n) => n.target.map(String).join(" ")) }));
    return { surface: surface.id, theme, ok: true, violations };
  } catch (e) {
    return { surface: surface.id, theme, ok: false, error: (e as Error).message };
  } finally {
    await cdp.send("Target.closeTarget", { targetId }).catch(() => undefined);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const chrome = resolveChrome(args.chrome);
  const axePath = createRequire(import.meta.url).resolve("axe-core/axe.min.js");
  const axeSource = readFileSync(axePath, "utf8");
  const axeVersion = (JSON.parse(readFileSync(path.join(path.dirname(axePath), "package.json"), "utf8")) as { version: string }).version;
  const commit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: UI_DIR, encoding: "utf8" }).stdout.trim() || "unknown";
  const surfaces = args.only ? SURFACES.filter((s) => args.only!.includes(s.id)) : SURFACES;
  if (surfaces.length === 0) fail("--only matched no surface");
  mkdirSync(args.out, { recursive: true });
  const held: Held = {};
  let cdp: Cdp | undefined;
  let started = false;
  const records: ScanRecord[] = [];
  try {
    // Inside the cleanup scope: a Chrome that never answers is stopped and its profile removed like any other.
    cdp = await Cdp.connect(await launch(chrome, args.noSandbox, args.startTimeoutMs, held), args.startTimeoutMs);
    started = true;
    let built = "";
    for (const surface of surfaces) {
      if (surface.route !== built) {
        const b = spawnSync("npm", ["run", "twin:build"], { cwd: UI_DIR, env: { ...process.env, TWIN_ROUTE: surface.route }, encoding: "utf8", timeout: args.buildTimeoutMs, killSignal: "SIGKILL" });
        if (b.status !== 0) {
          const why = (b.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT" ? `twin:build timed out after ${args.buildTimeoutMs} ms` : `twin:build failed (${b.status})`;
          for (const theme of THEMES) {
            records.push({ surface: surface.id, theme, ok: false, error: why });
            process.stdout.write(`FAILED: ${why}  ${surface.id} [${theme}]\n`);
          }
          built = "";
          continue;
        }
        built = surface.route;
      }
      for (const theme of THEMES) {
        const r = await withTimeout(scanOne(cdp, surface, theme, axeSource), args.surfaceTimeoutMs, `timed out after ${args.surfaceTimeoutMs} ms`)
          .catch((e: Error): ScanRecord => ({ surface: surface.id, theme, ok: false, error: e.message }));
        records.push(r);
        process.stdout.write(`${r.ok ? `${r.violations.length} rule(s)` : `FAILED: ${r.error}`}  ${surface.id} [${theme}]\n`);
      }
    }
  } finally {
    // The report first (only for a scan that started): a cleanup failure must not lose it.
    if (started) {
      writeFileSync(path.join(args.out, "a11y-report.json"), JSON.stringify({ axeVersion, commit, records, rules: summarizeByRule(records), notScanned: NOT_SCANNED, dialogsNotScanned: DIALOGS_NOT_SCANNED }, null, 1));
      writeFileSync(path.join(args.out, "a11y-report.md"), renderMarkdown(records, NOT_SCANNED, { axeVersion, commit }, DIALOGS_NOT_SCANNED));
      process.stdout.write(`report: ${path.join(args.out, "a11y-report.md")}\n`);
    }
    cdp?.close();
    await release(held);
  }
}

// workspaces-o9o.184: exit once main is done (the report written, cleanup awaited). A DevTools peer that never completes the
// WebSocket close, or a scan still pending past its timeout, must not keep the scanner alive after its work.
main().then(() => process.exit(process.exitCode ?? 0), (e: unknown) => fail((e as Error).message));
