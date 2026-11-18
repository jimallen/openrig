// workspaces-o9o.130 — twin:a11y: an axe-core scan of every twin surface (a11y-report.ts SURFACES) in light and dark.
//
// For each surface: `twin:build` with TWIN_ROUTE, open twin-out/intent.html in headless Chrome, wait until the page is
// still, open the surface's dialog if it has one, inject axe-core's own axe.min.js and run it with its DEFAULT rules (none
// disabled, none filtered). Chrome is driven over the DevTools protocol with Node's built-in WebSocket (Node 22+), so no
// client library is added. Writes a11y-report.json and a11y-report.md to --out.
//
// Usage: tsx twin/capture/a11y-scan.ts --out <dir> [--chrome <binary>] [--no-sandbox] [--only <surface id>[,<id>...]]
//   --no-sandbox: pass it where Chrome cannot use its sandbox (a host with unprivileged user namespaces disabled, e.g.
//   Ubuntu 23.10+). The page is the twin's own file:// build.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NOT_SCANNED, SURFACES, crashMessage, renderMarkdown, summarizeByRule, type ScanRecord, type Surface, type Theme, type Violation } from "./a11y-report.js";

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
  return { out: path.resolve(out["out"]), chrome: out["chrome"] || undefined, noSandbox: "no-sandbox" in out, only: out["only"] ? out["only"].split(",") : null };
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
  static async connect(url: string): Promise<Cdp> {
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => { ws.addEventListener("open", () => resolve()); ws.addEventListener("error", () => reject(new Error(`cannot connect to ${url}`))); });
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

async function launch(chrome: string, noSandbox: boolean): Promise<{ proc: ChildProcess; url: string; profile: string }> {
  const profile = mkdtempSync(path.join(os.tmpdir(), "twin-a11y-"));
  const args = ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", ...(noSandbox ? ["--no-sandbox"] : []), "about:blank"];
  const proc = spawn(chrome, args, { stdio: ["ignore", "ignore", "pipe"] });
  const url = await new Promise<string>((resolve, reject) => {
    let buf = "";
    proc.stderr!.on("data", (d: Buffer) => { buf += d.toString(); const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf); if (m) resolve(m[1]!); });
    proc.on("exit", (code) => reject(new Error(`chrome exited (${code}) before listening: ${buf.trim().split("\n").slice(-1)[0] ?? ""}`)));
    setTimeout(() => reject(new Error("chrome did not start within 20 s")), 20_000);
  });
  return { proc, url, profile };
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
  const { proc, url, profile } = await launch(chrome, args.noSandbox);
  const cdp = await Cdp.connect(url);
  const records: ScanRecord[] = [];
  try {
    let built = "";
    for (const surface of surfaces) {
      if (surface.route !== built) {
        const b = spawnSync("npm", ["run", "twin:build"], { cwd: UI_DIR, env: { ...process.env, TWIN_ROUTE: surface.route }, encoding: "utf8" });
        if (b.status !== 0) { for (const theme of THEMES) records.push({ surface: surface.id, theme, ok: false, error: `twin:build failed (${b.status})` }); built = ""; continue; }
        built = surface.route;
      }
      for (const theme of THEMES) {
        const r = await scanOne(cdp, surface, theme, axeSource);
        records.push(r);
        process.stdout.write(`${r.ok ? `${r.violations.length} rule(s)` : `FAILED: ${r.error}`}  ${surface.id} [${theme}]\n`);
      }
    }
  } finally {
    // The report first: a cleanup failure must not lose the scan.
    writeFileSync(path.join(args.out, "a11y-report.json"), JSON.stringify({ axeVersion, commit, records, rules: summarizeByRule(records), notScanned: NOT_SCANNED }, null, 1));
    writeFileSync(path.join(args.out, "a11y-report.md"), renderMarkdown(records, NOT_SCANNED, { axeVersion, commit }));
    process.stdout.write(`report: ${path.join(args.out, "a11y-report.md")}\n`);
    cdp.close();
    // Chrome writes to its profile until it exits, so the profile is removed after the exit (bounded), with retries.
    await new Promise<void>((resolve) => { proc.once("exit", () => resolve()); proc.kill("SIGTERM"); setTimeout(() => { proc.kill("SIGKILL"); resolve(); }, 5000); });
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

void main();
