// Runs one lifecycle operation in helpers/lifecycle-ops-daemon.ts (a real daemon on a private hc core) and returns its report.
// Shared by lifecycle-ops.real.test.ts (the OF-241 lease rows) and lifecycle-ops-measure.opt-in.ts (the timing measurement).
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HC, type PrivateCore } from "../hc-private-core.js";

const here = dirname(fileURLToPath(import.meta.url));
const CHILD = resolve(here, "lifecycle-ops-daemon.ts");

export type LifecycleOpEvent = Record<string, unknown> & { kind: string };
export interface LifecycleOpReport { op: string; seat: string; result: { status: number; body: Record<string, unknown> } | null; events: LifecycleOpEvent[] }

export async function runLifecycleOp(core: PrivateCore, op: string, extraEnv?: NodeJS.ProcessEnv): Promise<LifecycleOpReport> {
  const dir = mkdtempSync(join(core.root, `${op}-`));
  mkdirSync(join(dir, "seen"));
  const env: NodeJS.ProcessEnv = {
    ...core.env, PATH: `${dirname(HC)}:/usr/bin:/bin`, TMPDIR: join(core.root, "h"), OPENRIG_HOME: join(core.root, "h", "openrig"), OPENRIG_TRANSPORT_MESSAGE_PUMP: "true",
    LOD_OP: op, ...(extraEnv ?? {}), ...(process.env.LOD_TRACE ? { LOD_TRACE: "1" } : {}), LOD_DB: join(dir, "d.sqlite"), LOD_DIR: dir,
  };
  const stderr: string[] = [];
  const child = spawn(process.execPath, ["--import", "tsx", CHILD], { cwd: resolve(here, "..", ".."), env, stdio: ["ignore", "ignore", "pipe"] });
  child.stderr?.on("data", (b: Buffer) => { stderr.push(b.toString()); if (stderr.length > 40) stderr.shift(); });
  const exited = new Promise<number | null>((done) => child.on("exit", (code) => done(code)));
  const code = await Promise.race([exited, new Promise<"timeout">((done) => setTimeout(() => done("timeout"), 100_000))]);
  if (code === "timeout") child.kill("SIGKILL");
  if (!existsSync(join(dir, "report.json"))) throw new Error(`no report (exit ${String(code)}): ${stderr.join("").slice(0, 800)} EVENTS ${existsSync(join(dir, "events.log")) ? readFileSync(join(dir, "events.log"), "utf8").slice(-3000) : "(none)"}`);
  return JSON.parse(readFileSync(join(dir, "report.json"), "utf8")) as LifecycleOpReport;
}

export const eventsOf = (r: LifecycleOpReport, kind: string): LifecycleOpEvent[] => r.events.filter((e) => e.kind === kind);
