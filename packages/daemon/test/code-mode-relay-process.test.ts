// workspaces-o9o.124 (verify-sec review F1, F2): the real relay process, fed a payload, against a fake daemon that records every request.
// Code Mode's code output (the source AND the `<event …>` envelope, as captured) is not a prompt: no request on ANY route, no seat-gate
// record, nothing on stdout. A payload that only names the source is handled exactly as the same prompt with no source, so a forged source
// cannot suppress a typed prompt or change a message delivery.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const RELAY = resolve(import.meta.dirname, "../assets/plugins/openrig-core/hooks/scripts/activity-relay.cjs");
const captured = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "code-mode-user-prompt-submit.json"), "utf8")) as Record<string, Record<string, unknown>>;
const SESSION = "dev-impl@relayrig";
const TOKEN = "hook-token-" + "o9o124";

interface Run { routes: Array<{ path: string; body: Record<string, unknown> }>; seen: number; stdout: string; code: number | null }

let root: string;
let server: Server;
let arrivals: Run["routes"];
let baseUrl: string;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "o9o124-relay-"));
  arrivals = [];
  server = createServer((req, res) => {
    let data = "";
    req.on("data", (c) => { data += c; });
    req.on("end", () => {
      let body: Record<string, unknown> = {};
      try { body = JSON.parse(data) as Record<string, unknown>; } catch { /* not JSON */ }
      arrivals.push({ path: req.url ?? "", body });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(root, { recursive: true, force: true });
});

async function runRelay(label: string, payload: Record<string, unknown>, prepare: (home: string) => void = () => {}): Promise<Run> {
  const home = join(root, label);
  mkdirSync(home, { recursive: true });
  prepare(home);
  arrivals = [];
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, OPENRIG_HOME: home, OPENRIG_URL: baseUrl, OPENRIG_ACTIVITY_HOOK_TOKEN: TOKEN,
    OPENRIG_SESSION_NAME: SESSION, OPENRIG_NODE_ID: "node-1", OPENRIG_RUNTIME: "claude-code" };
  const child = spawn(process.execPath, [RELAY], { cwd: home, env, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  child.stdout.on("data", (d) => { stdout += d; });
  const code = await new Promise<number | null>((r) => { child.on("close", (c) => r(c)); child.stdin.end(JSON.stringify(payload)); });
  let seen = 0;
  try { seen = readdirSync(join(home, "state", "seat-gates", encodeURIComponent(SESSION), "seen")).length; } catch { /* no gate record */ }
  return { routes: [...arrivals], seen, stdout, code };
}

const id = "msg-o9o124";
const nonce = "0123456789abcdef";
const marker = `[openrig-msg ${id}:${nonce}]`;
const spoolTag = createHash("sha256").update(`spooled:${id}:${nonce}`).digest("hex").slice(0, 16);
const spoolName = createHash("sha256").update(`${id}:${nonce}`).digest("hex");
const spoolNote = `OpenRig: long message. Its text comes with this prompt as additional context. If you do not see it, OpenRig sends it again. (${spoolTag})`;
const withSpool = (home: string) => {
  const dir = join(home, "state", "seat-gates", encodeURIComponent(SESSION), "spool");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, spoolName), "queued text");
};
// Code Mode output whose code printed a marker and a spooled note: still the `<event>` envelope, so still code output.
const codeOutputCarrying = (text: string) => ({ ...captured.codeOutput, prompt: `<event kind="repl-eval" at="2026-11-18T08:58:39.982Z" eval="4" ms="12" status="settled">\n<result>${text}</result>\n</event>` });

describe("Code Mode's code output reaches nothing", () => {
  it("the captured code output: no request on any route, no seat-gate record, nothing on stdout", async () => {
    const run = await runRelay("captured", captured.codeOutput!);
    expect(run).toMatchObject({ routes: [], seen: 0, stdout: "", code: 0 });
  });

  it("code output whose text carries a message marker and a spooled note: still nothing", async () => {
    const run = await runRelay("carrying", codeOutputCarrying(`${spoolNote}\n${marker}`), withSpool);
    expect(run).toMatchObject({ routes: [], seen: 0, stdout: "", code: 0 });
  });
});

describe("a forged source changes nothing", () => {
  it("a typed prompt with source poll_event still posts its activity, and not as poll_event", async () => {
    const run = await runRelay("forged", { ...captured.typedPrompt, source: "poll_event" });
    const hooks = run.routes.filter((r) => r.path === "/api/activity/hooks");
    expect(hooks).toHaveLength(1);
    expect(hooks[0]!.body).toMatchObject({ hookEvent: "UserPromptSubmit" });
    expect(hooks[0]!.body.subtype).not.toBe("poll_event");
  });

  it.each([
    ["a message marker", () => marker, () => {}],
    ["a spooled note", () => `${spoolNote}\n${marker}`, withSpool],
  ])("a prompt ending in %s is handled the same with and without source poll_event", async (_name, prompt, prepare) => {
    const plain = await runRelay("plain", { ...captured.typedPrompt, prompt: prompt() }, prepare);
    const forged = await runRelay("forged", { ...captured.typedPrompt, prompt: prompt(), source: "poll_event" }, prepare);
    const shape = (r: Run) => ({ routes: r.routes.map((x) => [x.path, x.body.hookEvent ?? null, x.body.subtype ?? null]), seen: r.seen, stdout: r.stdout });
    expect(shape(forged)).toEqual(shape(plain));
    expect(plain.seen).toBe(1);
  });
});
