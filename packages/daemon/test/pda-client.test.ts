// pda runtime L1a (pda-runtime-design-9l Rev 2): the loopback HTTP client. Rows T6, T10, T11, T12, T13, T22, plus
// the endpoint allowlist (R2), redirects, error-as-code discipline, the single 401 re-read, and the event stream.
// Every row runs against test/helpers/fake-pda.ts, a real loopback http server.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import {
  createPdaClient, readPdaTokenFile, pdaTokenSourceFromFile, serializePdaMessage,
  PDA_MAX_BODY_BYTES, PDA_BODY_HEADROOM_BYTES, type PdaCallResult, type PdaTokenReadResult,
} from "../src/adapters/pda-client.js";
import { fileURLToPath } from "node:url";
import { startFakePda, nonAllowlisted, type FakePda, type FakePdaRequest } from "./helpers/fake-pda.js";

// A valid pda token (43 base64url chars, like `randomBytes(32).toString("base64url")`) that is also a canary:
// no other text in this suite contains it, so its presence anywhere is a leak.
const CANARY = "CANARYtokenAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".slice(0, 43);
const OTHER = "OTHERtokenBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB".slice(0, 43);
const BODY_LIMIT = PDA_MAX_BODY_BYTES - PDA_BODY_HEADROOM_BYTES;
const msg = (id = "r1") => serializePdaMessage({ content: "hello", requestId: id });

let dir: string;
let fake: FakePda | null = null;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "pda-client-")); });
afterEach(async () => {
  await fake?.close();
  fake = null;
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

function tokenFile(content: string, mode = 0o600, name = "token"): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, content, { mode });
  fs.chmodSync(p, mode);
  return p;
}
const okToken = (token: string = CANARY) => (): PdaTokenReadResult => ({ ok: true, token });

async function rig(opts: { agent?: string; agents?: string[]; token?: string } = {}) {
  fake = await startFakePda({ token: CANARY, agents: opts.agents ?? ["research"] });
  const client = createPdaClient({
    binding: { agent: opts.agent ?? "research", baseUrl: fake.baseUrl },
    readToken: okToken(opts.token ?? CANARY),
    timeoutMs: 2000,
  });
  return { fake, client };
}

describe("pda-client: the five endpoints and nothing else (R2)", () => {
  it("the client object has exactly the five calls (plus its binding)", async () => {
    const { client } = await rig();
    expect(Object.keys(client).sort()).toEqual(["binding", "getAgent", "getTranscript", "health", "openEvents", "postMessage"]);
  });

  it("each call hits its one endpoint, and the pre-routing log holds no other route", async () => {
    const { fake, client } = await rig();
    expect((await client.health()).ok).toBe(true);
    expect((await client.getAgent()).ok).toBe(true);
    const events = await client.openEvents(0);
    expect(events.ok).toBe(true);
    if (events.ok) events.value.close();
    expect((await client.getTranscript(50)).ok).toBe(true);
    expect((await client.postMessage(serializePdaMessage({ content: "hi", requestId: "r1" }))).ok).toBe(true);
    expect(fake.requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      "GET /health",
      "GET /agents/research",
      "GET /agents/research/events?tail=0",
      "GET /agents/research/transcript?limit=50",
      "POST /agents/research/messages",
    ]);
    expect(nonAllowlisted(fake.requests)).toEqual([]);
  });

  it("positive control: the allowlist predicate does flag a create, an abort and a delete", () => {
    const stray: FakePdaRequest[] = [
      { method: "POST", path: "/agents", url: "/agents" },
      { method: "POST", path: "/agents/research/abort", url: "/agents/research/abort" },
      { method: "DELETE", path: "/agents/research", url: "/agents/research" },
      { method: "GET", path: "/health", url: "/health" },
    ];
    expect(nonAllowlisted(stray)).toHaveLength(3);
  });

  it("health sends no bearer; the authed calls send exactly the validated token", async () => {
    const { fake, client } = await rig();
    await client.health();
    expect(fake.authorizations).toEqual([]);
    await client.getAgent();
    expect(fake.authorizations).toEqual([`Bearer ${CANARY}`]);
  });

  it("T13: a 404 at attach is a status, the client never creates the agent, and no POST goes out", async () => {
    const { fake, client } = await rig({ agent: "ghost" });
    const r = await client.getAgent();
    expect(r).toMatchObject({ ok: false, kind: "http", status: 404 });
    expect(fake.requests.filter((q) => q.method !== "GET")).toEqual([]);
    expect(nonAllowlisted(fake.requests)).toEqual([]);
  });
});

describe("pda-client: loopback only, no redirects (T12)", () => {
  const binding = (baseUrl: string) => ({ agent: "research", baseUrl });
  it.each([
    "http://localhost:8150", "http://[::1]:8150", "https://127.0.0.1:8150", "http://127.0.0.1:8150/", "http://127.0.0.1:8150/x",
    "http://user:pw@127.0.0.1:8150", "http://0.0.0.0:8150", "http://127.0.0.2:8150", "http://127.0.0.1:0", "http://127.0.0.1:65536",
  ])("refuses %s", (baseUrl) => {
    expect(() => createPdaClient({ binding: binding(baseUrl), readToken: okToken() })).toThrow(RangeError);
  });

  it("positive control: the canonical loopback form constructs", () => {
    expect(() => createPdaClient({ binding: binding("http://127.0.0.1:8150"), readToken: okToken() })).not.toThrow();
  });

  it("refuses the root agent and a malformed agent name", () => {
    for (const agent of ["main", "Main", "a b", "../x", ""]) {
      expect(() => createPdaClient({ binding: { agent, baseUrl: "http://127.0.0.1:8150" }, readToken: okToken() })).toThrow(RangeError);
    }
  });

  it("a redirect is a protocol failure and its target is never requested", async () => {
    const { fake, client } = await rig();
    fake.script({ action: "redirect", to: "/agents/research/abort" });
    const r = await client.postMessage(serializePdaMessage({ content: "x", requestId: "r1" }));
    expect(r).toEqual({ ok: false, kind: "protocol", status: 302 });
    expect(fake.requests.map((q) => q.path)).toEqual(["/agents/research/messages"]);
  });
});

describe("pda-client: T6 body size, measured on the exact string that is sent", () => {
  const overhead = Buffer.byteLength(serializePdaMessage({ content: "", requestId: "r1" }));

  it("exactly at the limit is posted, one byte over is refused with no request at all", async () => {
    const { fake, client } = await rig();
    const fits = serializePdaMessage({ content: "a".repeat(BODY_LIMIT - overhead), requestId: "r1" });
    expect(Buffer.byteLength(fits)).toBe(BODY_LIMIT);
    expect((await client.postMessage(fits)).ok).toBe(true);
    const over = serializePdaMessage({ content: "a".repeat(BODY_LIMIT - overhead + 1), requestId: "r2" });
    expect(await client.postMessage(over)).toEqual({ ok: false, kind: "too_large" });
    expect(fake.postBodies).toHaveLength(1);
    expect(fake.requests.filter((q) => q.method === "POST")).toHaveLength(1);
  });

  it("bytes, not characters: multi-byte content under the limit by character count is still refused", async () => {
    const { fake, client } = await rig();
    // 2 bytes per char; chars < limit, bytes > limit, and still under the server's own 1 MiB cap.
    const body = serializePdaMessage({ content: "é".repeat(Math.ceil((BODY_LIMIT - overhead) / 2) + 1), requestId: "r1" });
    expect(body.length).toBeLessThan(BODY_LIMIT);
    expect(Buffer.byteLength(body)).toBeGreaterThan(BODY_LIMIT);
    expect(Buffer.byteLength(body)).toBeLessThan(PDA_MAX_BODY_BYTES);
    expect(await client.postMessage(body)).toEqual({ ok: false, kind: "too_large" });
    expect(fake.requests.filter((q) => q.method === "POST")).toEqual([]);
  });

  it("the string measured is the string sent, byte for byte", async () => {
    const { fake, client } = await rig();
    const body = serializePdaMessage({ content: "line one\nline two é   /abort", requestId: "r1" });
    await client.postMessage(body);
    expect(fake.postBodies).toEqual([body]);
    expect(JSON.parse(body)).toEqual({ content: "line one\nline two é   /abort", mode: "followUp", requestId: "r1" });
  });

  it("a reply without a submissionId is a protocol failure, not an ack", async () => {
    const { fake, client } = await rig();
    fake.script({ action: "status", status: 200, body: {} });
    expect(await client.postMessage(serializePdaMessage({ content: "x", requestId: "r1" }))).toMatchObject({ ok: false, kind: "protocol" });
  });
});

describe("pda-client: errors are codes, never messages (T10)", () => {
  function captureOutput() {
    const seen: string[] = [];
    const grab = (...args: unknown[]) => { seen.push(args.map(String).join(" ")); return true; };
    vi.spyOn(process.stdout, "write").mockImplementation(grab as never);
    vi.spyOn(process.stderr, "write").mockImplementation(grab as never);
    for (const level of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, level).mockImplementation(grab as never);
    return seen;
  }

  it("a fetch that throws with the token in its message leaks nothing through the result or any output", async () => {
    const seen = captureOutput();
    const client = createPdaClient({
      binding: { agent: "research", baseUrl: "http://127.0.0.1:8150" }, readToken: okToken(),
      fetchImpl: (async () => { throw Object.assign(new Error(`boom ${CANARY}`), { cause: new Error(CANARY) }); }) as unknown as typeof fetch,
    });
    const results = [await client.health(), await client.getAgent(), await client.getTranscript(1), await client.postMessage(msg()), await client.openEvents(0)];
    expect(results.every((r) => !r.ok && r.kind === "unreachable")).toBe(true);
    expect(JSON.stringify(results)).not.toContain(CANARY);
    expect(seen.join("")).not.toContain(CANARY);
  });

  it("pda's error text is sanitised, redacted on the exact bearer, and capped AFTER redaction", async () => {
    const { fake, client } = await rig();
    const hostile = `bad \u001b]52;c;QUJD\u0007\u001b[2J ${CANARY} x${"y".repeat(250)} \u202e${CANARY}`;
    fake.script({ action: "status", status: 500, body: { error: hostile } });
    const r = await client.postMessage(msg());
    expect(r).toMatchObject({ ok: false, kind: "http", status: 500 });
    const detail = (r as { detail?: string }).detail ?? "";
    expect(detail).toContain("[redacted]");
    expect(detail).not.toContain(CANARY);
    expect(detail).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e]/);
    expect(detail.length).toBeLessThanOrEqual(200);
  });

  it("a token straddling the 200-character cap is redacted before the cut, so no prefix of it survives", async () => {
    const { fake, client } = await rig();
    fake.script({ action: "status", status: 500, body: { error: `${"p".repeat(190)}${CANARY}` } });
    const r = await client.postMessage(msg());
    const detail = (r as { detail?: string }).detail ?? "";
    expect(detail.length).toBe(200);
    expect(detail).not.toContain(CANARY.slice(0, 8));
  });

  it("extra exact secrets passed in `redact` are redacted too (the runner's hook token)", async () => {
    fake = await startFakePda({ token: CANARY });
    const HOOK = "hook-secret-value-123456";
    const client = createPdaClient({ binding: { agent: "research", baseUrl: fake.baseUrl }, readToken: okToken(), redact: [HOOK] });
    fake.script({ action: "status", status: 500, body: { error: `leaked ${HOOK}` } });
    const r = await client.postMessage(msg());
    expect((r as { detail?: string }).detail).toBe("leaked [redacted]");
  });

  it("no detail when pda's body is not JSON, has no string `error`, or the status is bare", async () => {
    const { fake, client } = await rig();
    fake.script({ action: "status", status: 500, body: { error: 5 } }, { action: "status", status: 500, body: ["x"] });
    expect(await client.postMessage(msg())).toEqual({ ok: false, kind: "http", status: 500 });
    expect(await client.postMessage(msg())).toEqual({ ok: false, kind: "http", status: 500 });
  });

  it("T10: the canary reaches pda only as the bearer, and appears in no result across success, 4xx, 5xx and outage", async () => {
    const seen = captureOutput();
    const { fake, client } = await rig();
    const results: PdaCallResult<unknown>[] = [];
    fake.script({ action: "status", status: 500 }, { action: "status", status: 400, body: { error: `echo ${CANARY}` } });
    results.push(await client.getAgent(), await client.getTranscript(5), await client.postMessage(msg()), await client.postMessage(msg()),
      await client.postMessage(serializePdaMessage({ content: "ok", requestId: "r9" })));
    expect(fake.authorizations.length).toBeGreaterThan(0);
    expect(fake.authorizations.every((a) => a === `Bearer ${CANARY}`)).toBe(true); // positive control: pda saw the valid canary
    const down = createPdaClient({ binding: { agent: "research", baseUrl: "http://127.0.0.1:1" }, readToken: okToken(), timeoutMs: 500 });
    results.push(await down.getAgent());
    expect(JSON.stringify(results)).not.toContain(CANARY);
    expect(seen.join("")).not.toContain(CANARY);
  });

  it("T10: an interior-LF token file is refused with a code before any request, and the canary is in nothing returned", async () => {
    const { fake } = await rig();
    const file = tokenFile(`${CANARY}\ntail`);
    const client = createPdaClient({ binding: { agent: "research", baseUrl: fake.baseUrl }, readToken: pdaTokenSourceFromFile(file) });
    const results = [await client.getAgent(), await client.postMessage(msg()), await client.getTranscript(1), await client.openEvents(0)];
    for (const r of results) expect(r).toEqual({ ok: false, kind: "token", code: "pda_token_format", problem: "format" });
    expect(JSON.stringify(results)).not.toContain(CANARY);
    expect(fake.requests).toEqual([]);
  });

  it("premise: Node's Headers echoes a header value that holds an LF, which is why the format check must come first", () => {
    let message = "";
    try { new Headers({ Authorization: `Bearer ${CANARY}\ntail` }); } catch (e) { message = (e as Error).message; }
    expect(message).toContain(CANARY);
  });
});

describe("pda-client: T11 the token file", () => {
  const refused = (problem: string) => ({ ok: false, kind: "token", code: "pda_token_format", problem });

  it("positive control: a 0600 file we own with a valid token, trailing newline trimmed", () => {
    expect(readPdaTokenFile(tokenFile(`${CANARY}\n`))).toEqual({ ok: true, token: CANARY });
  });

  it("refuses a symlink, even to a perfectly good file", () => {
    const good = tokenFile(CANARY, 0o600, "real");
    const link = path.join(dir, "link");
    fs.symlinkSync(good, link);
    expect(readPdaTokenFile(link)).toEqual(refused("symlink"));
  });

  it.each([0o644, 0o640, 0o604, 0o660, 0o666])("refuses mode %o (group or other access)", (mode) => {
    expect(readPdaTokenFile(tokenFile(CANARY, mode))).toEqual(refused("group_or_other_access"));
  });

  it("refuses a file owned by another uid", () => {
    const file = tokenFile(CANARY);
    const uid = process.getuid?.() ?? 0;
    expect(readPdaTokenFile(file, { expectedUid: uid + 1 })).toEqual(refused("wrong_owner"));
    expect(readPdaTokenFile(file, { expectedUid: uid })).toEqual({ ok: true, token: CANARY });
  });

  it("refuses a directory and a missing file", () => {
    expect(readPdaTokenFile(dir)).toEqual(refused("not_regular_file"));
    expect(readPdaTokenFile(path.join(dir, "absent"))).toEqual(refused("unreadable"));
  });

  it("refuses a FIFO without blocking in open(): run in a child so a hang is a clean failure, not a stuck worker", () => {
    const fifo = path.join(dir, "fifo");
    execFileSync("mkfifo", [fifo]);
    const here = path.dirname(fileURLToPath(import.meta.url));
    const tsx = path.resolve(here, "..", "..", "..", "node_modules", ".bin", "tsx");
    const clientSource = path.resolve(here, "..", "src", "adapters", "pda-client.ts");
    const probe = path.join(dir, "probe.mts");
    fs.writeFileSync(probe, `import { readPdaTokenFile } from ${JSON.stringify(clientSource)};\nconsole.log(JSON.stringify(readPdaTokenFile(process.argv[2]!)));\n`);
    const r = spawnSync(tsx, [probe, fifo], { timeout: 20_000, encoding: "utf8" });
    expect(r.error).toBeUndefined();
    expect(r.signal).toBeNull();
    expect(JSON.parse(r.stdout)).toEqual(refused("not_regular_file"));
  }, 40_000);

  it("refuses a file longer than 4 KiB without looking at its content", () => {
    expect(readPdaTokenFile(tokenFile("A".repeat(4097)))).toEqual(refused("too_long"));
    expect(readPdaTokenFile(tokenFile(`${"A".repeat(512)}\n`, 0o600, "edge"))).toEqual({ ok: true, token: "A".repeat(512) });
  });

  it.each([
    ["too short (15)", "A".repeat(15)], ["too long for the format (513)", "A".repeat(513)], ["empty", ""], ["only a newline", "\n"],
    ["not base64url", "not a token!!!!!!!!!"], ["standard base64 padding", `${"A".repeat(20)}==`], ["interior space", `${"A".repeat(20)} ${"B".repeat(20)}`],
    ["interior LF", `${"A".repeat(20)}\n${"B".repeat(20)}`], ["non-ASCII", `${"A".repeat(20)}é`],
  ])("refuses a value that is not pda's token format: %s", (_name, content) => {
    expect(readPdaTokenFile(tokenFile(content))).toEqual(refused("format"));
  });

  it("a refusal result holds no file content", () => {
    const secretish = "S3CRET-NOT-A-TOKEN-because-of-the-bang!";
    expect(JSON.stringify(readPdaTokenFile(tokenFile(secretish)))).not.toContain("S3CRET");
  });
});

describe("pda-client: the single 401 re-read", () => {
  it("a rotated token is picked up: stale on the first request, re-read once, then it works", async () => {
    fake = await startFakePda({ token: CANARY });
    const reads: string[] = [];
    const tokens = [OTHER, CANARY];
    const client = createPdaClient({
      binding: { agent: "research", baseUrl: fake.baseUrl },
      readToken: () => { const t = tokens.shift() ?? CANARY; reads.push(t); return { ok: true, token: t }; },
    });
    expect((await client.getAgent()).ok).toBe(true);
    expect(reads).toEqual([OTHER, CANARY]);
    expect(fake.requests.map((r) => r.path)).toEqual(["/agents/research", "/agents/research"]);
  });

  it("a second 401 is returned as a 401: bounded at one re-read and one retry", async () => {
    fake = await startFakePda({ token: CANARY });
    let reads = 0;
    const client = createPdaClient({
      binding: { agent: "research", baseUrl: fake.baseUrl },
      readToken: () => { reads += 1; return { ok: true, token: OTHER }; },
    });
    const r = await client.postMessage(msg());
    expect(r).toMatchObject({ ok: false, kind: "http", status: 401 });
    expect(reads).toBe(2);
    expect(fake.requests.filter((q) => q.method === "POST")).toHaveLength(2);
    expect(JSON.stringify(r)).not.toContain(OTHER);
  });

  it("a re-read that finds a bad token file returns the token failure, not a retry", async () => {
    fake = await startFakePda({ token: CANARY });
    const answers: PdaTokenReadResult[] = [{ ok: true, token: OTHER }, { ok: false, kind: "token", code: "pda_token_format", problem: "format" }];
    const client = createPdaClient({ binding: { agent: "research", baseUrl: fake.baseUrl }, readToken: () => answers.shift()! });
    expect(await client.getAgent()).toEqual({ ok: false, kind: "token", code: "pda_token_format", problem: "format" });
    expect(fake.requests).toHaveLength(1);
  });

  it("health is not retried on 401 and never reads the token file", async () => {
    fake = await startFakePda({ token: CANARY });
    const readToken = vi.fn(okToken());
    const client = createPdaClient({ binding: { agent: "research", baseUrl: fake.baseUrl }, readToken });
    await client.health();
    expect(readToken).not.toHaveBeenCalled();
  });
});

describe("pda-client: transport failures, transcript limit, event stream", () => {
  it("a closed port and a request that never answers are both unreachable", async () => {
    const { fake: f, client } = await rig();
    const gone = f.baseUrl;
    await f.close();
    fake = null;
    expect(await createPdaClient({ binding: { agent: "research", baseUrl: gone }, readToken: okToken(), timeoutMs: 500 }).getAgent())
      .toEqual({ ok: false, kind: "unreachable" });
    void client;
    const hang = createPdaClient({
      binding: { agent: "research", baseUrl: "http://127.0.0.1:8150" }, readToken: okToken(), timeoutMs: 30,
      fetchImpl: ((_url: unknown, init: RequestInit) => new Promise((_res, rej) => {
        init.signal?.addEventListener("abort", () => rej(new Error("aborted")));
      })) as unknown as typeof fetch,
    });
    expect(await hang.getAgent()).toEqual({ ok: false, kind: "unreachable" });
  });

  it("transcript limit is an integer from 1 to 500", async () => {
    const { fake, client } = await rig();
    for (const bad of [0, 501, 1.5, -1, Number.NaN]) await expect(client.getTranscript(bad)).rejects.toThrow(RangeError);
    expect((await client.getTranscript(500)).ok).toBe(true);
    expect((await client.getTranscript(1)).ok).toBe(true);
    expect(fake.requests.map((r) => r.url)).toEqual(["/agents/research/transcript?limit=500", "/agents/research/transcript?limit=1"]);
  });

  it("the event stream yields raw bytes, close() ends it, and a bad tail is refused", async () => {
    const { fake, client } = await rig();
    await expect(client.openEvents(-1)).rejects.toThrow(RangeError);
    await expect(client.openEvents(1.5)).rejects.toThrow(RangeError);
    const r = await client.openEvents(0);
    if (!r.ok) throw new Error("expected a stream");
    const reader = r.value.body.getReader();
    const first = await reader.read();
    expect(Buffer.from(first.value ?? new Uint8Array()).toString()).toContain('"type":"snapshot"');
    expect(fake.openStreams()).toBe(1);
    r.value.close();
    await vi.waitFor(() => expect(fake.openStreams()).toBe(0));
  });

  it("an event stream for a rejected token is a status, with no stream opened", async () => {
    fake = await startFakePda({ token: CANARY });
    const client = createPdaClient({ binding: { agent: "research", baseUrl: fake.baseUrl }, readToken: okToken(OTHER) });
    expect(await client.openEvents(0)).toMatchObject({ ok: false, kind: "http", status: 401 });
    expect(fake.openStreams()).toBe(0);
  });
});

describe("T22: OpenRig never imports or depends on pda's own packages", () => {
  const PKG = "@earendil-works/";
  // An import, a require, a dynamic import, or a manifest key. Prose that merely names the package is not a dependency.
  const DEPENDS = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*["']@earendil-works\/|["']@earendil-works\/[^"']+["']\s*:/;
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  function offenders(files: Array<{ file: string; text: string }>): string[] {
    return files.filter((f) => DEPENDS.test(f.text)).map((f) => f.file);
  }
  function walk(d: string, out: string[]): void {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === "dist" || e.name === ".git") continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, out);
      else if (/\.(ts|tsx|mts|cts|js|mjs|cjs|json)$/.test(e.name)) out.push(p);
    }
  }
  const files: string[] = [];
  for (const pkg of fs.readdirSync(root)) {
    const srcDir = path.join(root, pkg, "src");
    if (fs.existsSync(srcDir)) walk(srcDir, files);
    const manifest = path.join(root, pkg, "package.json");
    if (fs.existsSync(manifest)) files.push(manifest);
  }

  it("no source file or manifest under packages/ names it", () => {
    expect(files.length).toBeGreaterThan(200); // the census is of a real population
    expect(files.some((f) => f.endsWith(path.join("adapters", "pda-client.ts")))).toBe(true);
    expect(offenders(files.map((file) => ({ file, text: fs.readFileSync(file, "utf8") })))).toEqual([]);
  });

  it("positive control: the scan does flag an import and a dependency", () => {
    expect(offenders([
      { file: "a.ts", text: `import { x } from "${PKG}pi-durable";` },
      { file: "package.json", text: `{"dependencies":{"${PKG}pi-durable":"1.3.0"}}` },
      { file: "clean.ts", text: "import fs from 'node:fs';" },
    ])).toEqual(["a.ts", "package.json"]);
  });
});
