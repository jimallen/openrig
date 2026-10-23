// pda runtime L1b: a harness that runs the REAL `PdaRunner`, the REAL L1a client and outbox, and L1a's REAL
// loopback fake pda for everything the fake can do (health, agent, message POSTs with real dedupe), and puts a
// scripted layer in front of exactly the two things the fake cannot script:
//   - `GET .../events`: the test pushes raw SSE bytes, ends the stream, errors it, or takes pda "down";
//   - `GET .../transcript`: the test decides what the conversation holds.
// The runner cannot tell the difference: the client's `fetchImpl` seam is the only thing replaced, and every
// other request is a real HTTP request to the fake. The fake itself is L1a's and is not modified.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createPdaClient, readPdaTokenFile, type PdaTokenReadResult,
} from "../../src/adapters/pda-client.js";
import { PdaOutbox, nodeOutboxFs, type OutboxFs } from "../../src/adapters/pda-outbox.js";
import { PdaRunner, nodeRunnerFs, pdaClientRedactions, type PdaRunnerDeps, type PdaUsageSink } from "../../src/adapters/pda-runner.js";
import { HOOK_TOKEN_MARKER, PDA_TOKEN_MARKER } from "../../src/adapters/pda-render.js";
import {
  parsePdaRunnerState, pdaSeatPaths, type PdaRunnerState, type PdaSeatPaths,
} from "../../src/adapters/pda-runner-protocol.js";
import { startFakePda, type FakePda } from "./fake-pda.js";

/** A valid pda token (43 base64url characters) that is also a canary: nothing else contains it. */
export const BEARER = "CANARYbearer".padEnd(43, "A");
/** A DIFFERENT valid 43-character base64url string: the control that "nothing else is pattern-redacted". */
export const LOOKALIKE = "LOOKALIKEstring".padEnd(43, "B");
export const HOOK_TOKEN = "hook-token-canary-0123456789";
export { HOOK_TOKEN_MARKER, PDA_TOKEN_MARKER };

export const sse = (event: unknown): string => `data: ${JSON.stringify(event)}\n\n`;

export async function waitFor(cond: () => boolean, what: string, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

export interface ScriptedStream {
  /** Push one event as SSE. */
  push(event: unknown): void;
  /** Push raw bytes or text, exactly. */
  raw(chunk: string | Uint8Array): void;
  /** pda closed the stream cleanly. */
  end(): void;
  /** The socket died. */
  error(): void;
  /** True once the runner closed its side. */
  closedByClient: boolean;
}

/** The scripted `/events` and `/transcript`, in front of the real fake. */
export class ScriptedPda {
  readonly streams: ScriptedStream[] = [];
  readonly transcriptLimits: number[] = [];
  /** While true, every `/events` request fails like a refused connection. */
  eventsDown = false;
  /** The conversation. Entries are pda EntryRecords: `{id, model: [message]}`. */
  transcript: unknown[] = [];
  /** Make the next transcript answer this status instead. */
  transcriptStatus: number | null = null;
  /** Make /health, the agent and messages fail like a refused connection too (pda is down). */
  allDown = false;

  constructor(private readonly passThrough: typeof fetch = globalThis.fetch) {}

  readonly fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url);
    if (this.allDown) throw new TypeError("fetch failed");
    if (url.pathname.endsWith("/events")) {
      if (this.eventsDown) throw new TypeError("fetch failed");
      return this.openStream(init?.signal ?? undefined);
    }
    if (url.pathname.endsWith("/transcript")) {
      const limit = Number(url.searchParams.get("limit"));
      this.transcriptLimits.push(limit);
      if (this.transcriptStatus !== null) return new Response(JSON.stringify({ error: "scripted" }), { status: this.transcriptStatus });
      return new Response(JSON.stringify({ entries: this.transcript.slice(-limit) }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return this.passThrough(input, init);
  };

  private openStream(signal?: AbortSignal): Response {
    const enc = new TextEncoder();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let done = false;
    const body = new ReadableStream<Uint8Array>({ start: (c) => { controller = c; } });
    const stream: ScriptedStream = {
      closedByClient: false,
      push: (e) => { if (!done) controller.enqueue(enc.encode(sse(e))); },
      raw: (c) => { if (!done) controller.enqueue(typeof c === "string" ? enc.encode(c) : c); },
      end: () => { if (!done) { done = true; controller.close(); } },
      error: () => { if (!done) { done = true; controller.error(new TypeError("terminated")); } },
    };
    signal?.addEventListener("abort", () => {
      stream.closedByClient = true;
      if (!done) { done = true; controller.error(new DOMException("aborted", "AbortError")); }
    }, { once: true });
    this.streams.push(stream);
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  }
}

export interface RigOptions {
  /** Agent the runner binds. Default "research" (the fake's default agent). */
  agent?: string;
  agents?: string[];
  /** Use the fake's own /events and /transcript instead of the scripted ones. */
  realStreams?: boolean;
  tokenFileContent?: string;
  tokenMode?: number;
  /** Written to the outbox log before the runner starts (a function gets the fake's base URL). */
  preseedOutbox?: string | ((baseUrl: string) => string);
  /** Written to release.request before the runner starts. */
  preseedRelease?: boolean;
  /** The alive tick. Default 40 ms; a large value leaves the attach-time poll as the only one. */
  aliveIntervalMs?: number;
  /** Written to runner-state.json before the runner starts (a prior launch). */
  preseedSidecar?: PdaRunnerState;
  usage?: PdaUsageSink;
  usageFacts?: boolean;
  fakeDedupe?: boolean;
}

export interface Rig {
  dir: string;
  fake: FakePda;
  scripted: ScriptedPda;
  paths: PdaSeatPaths;
  runner: PdaRunner;
  /** Set `fault.failWhen` to make the outbox's next matching write throw (a full disk), after the first append. */
  fault: { failWhen: ((data: string) => boolean) | null };
  /** Everything the runner wrote to the pane, in order. */
  pane(): string;
  activity: Array<Record<string, unknown>>;
  /** Resolves with the exit code when run() returns. */
  done: Promise<number> | null;
  start(): Promise<number>;
  sidecar(): PdaRunnerState;
  sidecarRaw(): string;
  outboxRaw(): string;
  ownSubmissionsRaw(): string;
  /** The runner has a live event stream (the n-th). */
  stream(n?: number): Promise<ScriptedStream>;
  /** Stop the runner and wait for its exit code. */
  stop(): Promise<number>;
  cleanup(): Promise<void>;
  args: { sessionName: string; stateRoot: string; launchId: string; agent: string; baseUrl: string; tokenFile: string; nodeId: string };
}

export async function makeRig(options: RigOptions = {}): Promise<Rig> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pda-runner-"));
  const agent = options.agent ?? "research";
  const fake = await startFakePda({ token: BEARER, agents: options.agents ?? [agent, "research"], dedupe: options.fakeDedupe });
  const scripted = new ScriptedPda();
  const stateRoot = path.join(dir, "state");
  const sessionName = "seat-under-test";
  const paths = pdaSeatPaths(stateRoot, sessionName);
  fs.mkdirSync(paths.seatRoot, { recursive: true, mode: 0o700 });
  const tokenFile = path.join(dir, "token");
  fs.writeFileSync(tokenFile, options.tokenFileContent ?? BEARER, { mode: options.tokenMode ?? 0o600 });
  fs.chmodSync(tokenFile, options.tokenMode ?? 0o600);
  if (options.preseedOutbox !== undefined) {
    const text = typeof options.preseedOutbox === "function" ? options.preseedOutbox(fake.baseUrl) : options.preseedOutbox;
    fs.writeFileSync(paths.outboxPath, text, { mode: 0o600 });
  }
  if (options.preseedRelease) fs.writeFileSync(paths.releaseRequestPath, "", { mode: 0o600 });
  if (options.preseedSidecar) fs.writeFileSync(paths.runnerStatePath, JSON.stringify(options.preseedSidecar), { mode: 0o600 });

  const binding = { agent, baseUrl: fake.baseUrl };
  const bearers = new Set<string>();
  const readToken = (): PdaTokenReadResult => {
    // Same shape as main(): the real file reader, with every bearer read remembered for redaction.
    const res = readPdaTokenFile(tokenFile);
    if (res.ok) bearers.add(res.token);
    return res;
  };
  const client = createPdaClient({
    binding, readToken, timeoutMs: 3000, redact: pdaClientRedactions(HOOK_TOKEN),
    fetchImpl: options.realStreams ? globalThis.fetch : scripted.fetchImpl,
  });
  const fault: Rig["fault"] = { failWhen: null };
  const faultyFs: OutboxFs = {
    ...nodeOutboxFs,
    write: (fd, data) => {
      if (fault.failWhen?.(data)) throw Object.assign(new Error(`disk trouble, bearer ${BEARER}`), { code: "ENOSPC" });
      return nodeOutboxFs.write(fd, data);
    },
  };
  const outbox = PdaOutbox.open({ paths, binding, nodeId: "node-under-test", launchId: "launch-1", fs: faultyFs });
  let pane = "";
  const activity: Array<Record<string, unknown>> = [];
  const deps: PdaRunnerDeps = {
    args: {
      sessionName, stateRoot, launchId: "launch-1", binding, tokenFile,
      ...(options.usageFacts ? { usageFacts: true } : {}),
    },
    nodeId: "node-under-test",
    generation: "gen-7",
    client, outbox, readToken,
    secrets: () => [
      ...[...bearers].map((value) => ({ value, marker: PDA_TOKEN_MARKER })),
      { value: HOOK_TOKEN, marker: HOOK_TOKEN_MARKER },
    ],
    write: (text) => { pane += text; },
    postActivity: (payload) => { activity.push(payload); },
    fs: nodeRunnerFs,
    // Real time, but with every wait capped at 5 ms so six bounded retries and the reconnect loop are quick.
    sleep: (ms, signal) => new Promise<void>((resolve) => {
      if (signal?.aborted) return resolve();
      const t = setTimeout(resolve, Math.min(ms, 5));
      signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
    }),
    aliveIntervalMs: options.aliveIntervalMs ?? 40,
    userHoldMs: 25, // a user message waits this long for the submission that names it
    backoffStartMs: 5,
    backoffCapMs: 20,
    usage: options.usage,
  };
  const runner = new PdaRunner(deps);
  const rig: Rig = {
    dir, fake, scripted, paths, runner, fault, activity, done: null,
    args: { sessionName, stateRoot, launchId: "launch-1", agent, baseUrl: fake.baseUrl, tokenFile, nodeId: "node-under-test" },
    pane: () => pane,
    start() { rig.done = runner.run(); return rig.done; },
    sidecarRaw: () => fs.readFileSync(paths.runnerStatePath, "utf8"),
    sidecar() {
      const parsed = parsePdaRunnerState(fs.readFileSync(paths.runnerStatePath, "utf8"));
      if (!parsed) throw new Error("the sidecar does not parse");
      return parsed;
    },
    outboxRaw: () => (fs.existsSync(paths.outboxPath) ? fs.readFileSync(paths.outboxPath, "utf8") : ""),
    ownSubmissionsRaw: () => (fs.existsSync(paths.ownSubmissionsPath) ? fs.readFileSync(paths.ownSubmissionsPath, "utf8") : ""),
    async stream(n = 1) {
      await waitFor(() => scripted.streams.length >= n, `event stream #${n} to be opened`);
      return scripted.streams[n - 1]!;
    },
    async stop() {
      runner.stop();
      return rig.done ?? Promise.resolve(0);
    },
    async cleanup() {
      runner.stop();
      try { if (rig.done) await Promise.race([rig.done, new Promise((r) => setTimeout(r, 2000))]); } catch { /* already reported by the test */ }
      await fake.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
  return rig;
}

// The entry, event and submission builders are in ./pda-real-shapes.ts (pda's real wire shapes, each citing its declaration).
export * from "./pda-real-shapes.js";
