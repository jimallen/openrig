import { createConnection, type Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

/** The protocol generation this build speaks. A core on any other refuses `hello`, and the daemon must stop there. */
export const HC_GENERATION = 1;

const DEFAULT_TIMEOUT_MS = 10_000;

/** Nothing reached the core: no socket, refused, or `hello` never answered. The core may be fine or gone; a caller
 *  must read this as "unknown", never as "the terminal is gone". */
export class HcUnavailableError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "HcUnavailableError";
  }
}

/** The request was written and no reply came. It may still take effect: a queued send outlives its client (spike
 *  1+2), so a caller must verify before it retries. */
export class HcOutcomeUnknownError extends Error {
  constructor(message: string, readonly method: string) {
    super(message);
    this.name = "HcOutcomeUnknownError";
  }
}

/** The core answered with a refusal. `kind` is hc's stable word: not_found, finished, blocked, status_mismatch,
 *  name_taken, unsupported_generation, ... */
export class HcError extends Error {
  constructor(message: string, readonly kind: string, readonly code: number, readonly hint?: string) {
    super(message);
    this.name = "HcError";
  }
}

export interface HcHello {
  generation: number;
  version: string;
  core: { id: string; name: string };
  framed: boolean;
  methods: string[];
  features: string[];
}

export interface HcTerminal {
  address: string;
  name?: string | null;
  labels: Record<string, string>;
  argv: string[];
  cwd: string;
  state: string;
  created_ms: number;
  screen: string;
  cols: number;
  rows: number;
  pid?: number | null;
  reason?: string | null;
  keep?: boolean;
  status_ms?: number | null;
  finished_ms?: number | null;
  reported?: boolean;
  exit_code?: number | null;
  turn?: number;
  status?: { state: string; kind?: string | null } | null;
  foreground?: { pid: number; name: string; argv: string[]; cwd: string } | null;
}

/** The core's socket, as hc itself finds it: HC_SOCKET, else the runtime dir (Linux), else the state dir (macOS, read
 *  from the live core's open files; `<state>/herdr-core/<session>/<session>.sock`). */
export function resolveHcSocket(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  if (env.HC_SOCKET) return env.HC_SOCKET;
  const session = env.HC_SESSION || "default";
  if (env.XDG_RUNTIME_DIR) return join(env.XDG_RUNTIME_DIR, "herdr-core", `${session}.sock`);
  const state = env.XDG_STATE_HOME || join(home, ".local", "state");
  return join(state, "herdr-core", session, `${session}.sock`);
}

interface RpcReply { id?: number; result?: unknown; error?: { code: number; message: string; data?: { kind?: string; hint?: string } } }

/** One short-lived connection per call: a queued send can block for as long as a person types, and must never hold up
 *  a liveness read. Reaching the core and hearing it are kept apart: see the two error classes. */
export class HcClient {
  constructor(readonly socketPath: string = resolveHcSocket(), private readonly defaultTimeoutMs = DEFAULT_TIMEOUT_MS) {}

  async hello(): Promise<HcHello> {
    const conn = await this.open();
    try {
      return await this.greet(conn);
    } finally {
      conn.close();
    }
  }

  async call<T>(method: string, params: Record<string, unknown> = {}, options: { timeoutMs?: number } = {}): Promise<T> {
    const conn = await this.open();
    try {
      await this.greet(conn);
      return await conn.request<T>(method, params, options.timeoutMs ?? this.defaultTimeoutMs);
    } finally {
      conn.close();
    }
  }

  private async greet(conn: Connection): Promise<HcHello> {
    let hello: HcHello;
    try {
      hello = await conn.request<HcHello>("hello", { generation: HC_GENERATION, framed: false }, this.defaultTimeoutMs);
    } catch (err) {
      if (err instanceof HcOutcomeUnknownError) throw new HcUnavailableError(err.message, err);  // hello changes nothing
      throw err;
    }
    if (hello.generation !== HC_GENERATION) {
      throw new HcError(`core speaks generation ${hello.generation}, this build ${HC_GENERATION}`, "unsupported_generation", -32000);
    }
    return hello;
  }

  private open(): Promise<Connection> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.socketPath);
      socket.once("connect", () => {
        socket.removeAllListeners("error");
        resolve(new Connection(socket));
      });
      socket.once("error", (err) => reject(new HcUnavailableError(`hc core not reachable at ${this.socketPath}: ${err.message}`, err)));
    });
  }
}

class Connection {
  private buffer = "";
  private nextId = 1;
  private pending: { id: number; method: string; resolve: (value: unknown) => void; reject: (err: Error) => void; timer: NodeJS.Timeout } | null = null;

  constructor(private readonly socket: Socket) {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.onData(chunk));
    socket.on("error", (err) => this.fail(err.message));
    socket.on("close", () => this.fail("the core closed the connection"));
  }

  request<T>(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => this.fail(`no reply in ${timeoutMs} ms`), timeoutMs);
      this.pending = { id, method, resolve: resolve as (value: unknown) => void, reject, timer };
      this.socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  close(): void {
    this.socket.destroy();
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    for (let end = this.buffer.indexOf("\n"); end >= 0; end = this.buffer.indexOf("\n")) {
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      if (line.trim()) this.onLine(line);
    }
  }

  private onLine(line: string): void {
    const pending = this.pending;
    if (!pending) return;
    let reply: RpcReply;
    try {
      reply = JSON.parse(line) as RpcReply;
    } catch {
      this.fail("the core sent a line that is not JSON");
      return;
    }
    if (reply.id !== pending.id) return;  // a notification, not this reply
    this.pending = null;
    clearTimeout(pending.timer);
    if (reply.error) {
      const { code, message, data } = reply.error;
      pending.reject(new HcError(message, data?.kind ?? "unknown", code, data?.hint));
    } else {
      pending.resolve(reply.result);
    }
  }

  private fail(reason: string): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    clearTimeout(pending.timer);
    pending.reject(new HcOutcomeUnknownError(`${pending.method}: ${reason}`, pending.method));
  }
}
