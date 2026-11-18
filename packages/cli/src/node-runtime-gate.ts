// workspaces-o9o.180: the Node-major and native-SQLite check runs in the CLI itself. npm 11 (bundled with Node 24 and 26) skips
// third-party install scripts on a global registry install, so `npm install -g @openrig/cli` no longer runs the postinstall
// (scripts/check-abi.mjs), and a person on Node 20 or an odd major got no refusal until a database open crashed. The postinstall
// stays where npm runs it; this gate uses the same check and prints the same messages.
//
// Every run: the version phase alone (no native code, no disk). An unsupported major (below the range, or odd) is refused with
// exit 1, naming the Node version and the supported range; `rig doctor`, `--version` and `--help` still run after the message, so
// a person can see the report. The first run per (CLI version, Node version) also loads the binding and opens an in-memory
// database in a child process, and an untested even major is warned about then; success is recorded in
// <OPENRIG_HOME>/cli-runtime-check.json. A record that cannot be read or written only means the check runs again next time.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { checkAbi, openInChildProcess, type NativeOpenResult } from "../scripts/check-abi.mjs";

export const RUNTIME_CHECK_RECORD = "cli-runtime-check.json";

export interface NodeRuntimeGateDeps {
  /** process.version */
  nodeVersion: string;
  cliVersion: string;
  /** process.argv: [node, script, ...args] */
  argv: readonly string[];
  /** The recorded (cli version, Node version) of the last run that passed, or null. */
  readRecord: () => string | null;
  writeRecord: (text: string) => void;
  loadNativeAddon: () => void;
  openNativeDatabase: () => NativeOpenResult;
  err: (text: string) => void;
}

export type NodeRuntimeGateResult = { proceed: true } | { proceed: false; exitCode: 1 };

/** Commands that run even on an unsupported Node, after the message: they report, they do not open a database. */
function reportsOnly(argv: readonly string[]): boolean {
  const args = argv.slice(2);
  if (args.some((a) => a === "--version" || a === "-V" || a === "--help" || a === "-h")) return true;
  const first = args.find((a) => !a.startsWith("-"));
  return first === "doctor" || first === "help";
}

function recordKey(cliVersion: string, nodeVersion: string): string {
  return `${cliVersion} ${nodeVersion}`;
}

export function nodeRuntimeGate(deps: NodeRuntimeGateDeps): NodeRuntimeGateResult {
  const report = reportsOnly(deps.argv);
  // Phase 1 only: the version range. A no-op loader keeps native code out of every run.
  const range = checkAbi({ nodeVersion: deps.nodeVersion, loadNativeAddon: () => {} });
  if (!range.ok) {
    deps.err(range.message);
    return report ? { proceed: true } : { proceed: false, exitCode: 1 };
  }
  const key = recordKey(deps.cliVersion, deps.nodeVersion);
  let recorded: unknown = null;
  try {
    const text = deps.readRecord();
    recorded = text === null ? null : (JSON.parse(text) as { passed?: unknown }).passed;
  } catch { /* unreadable: check again */ }
  if (recorded === key) return { proceed: true };

  // First run with this CLI and this Node: the binding loads and opens a database (in a child, so a native crash is reported).
  const native = checkAbi({ nodeVersion: deps.nodeVersion, loadNativeAddon: deps.loadNativeAddon, openNativeDatabase: deps.openNativeDatabase });
  if (!native.ok) {
    deps.err(native.message);
    return report ? { proceed: true } : { proceed: false, exitCode: 1 };
  }
  if (native.warning) deps.err(native.warning);
  try {
    deps.writeRecord(`${JSON.stringify({ passed: key })}\n`);
  } catch { /* not recorded: the check runs again next time */ }
  return { proceed: true };
}

/** The gate with this process's Node, this CLI's version and the real binding, recorded under the given OpenRig home. */
export function runNodeRuntimeGate(argv: readonly string[], cliVersion: string, openrigHome: string): NodeRuntimeGateResult {
  const require = createRequire(import.meta.url);
  const file = join(openrigHome, RUNTIME_CHECK_RECORD);
  return nodeRuntimeGate({
    nodeVersion: process.version,
    cliVersion,
    argv,
    readRecord: () => { try { return readFileSync(file, "utf8"); } catch { return null; } },
    writeRecord: (text) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); },
    loadNativeAddon: () => { require("better-sqlite3"); },
    openNativeDatabase: () => openInChildProcess(require.resolve("better-sqlite3"), spawnSync),
    err: (text) => process.stderr.write(text.endsWith("\n") ? text : `${text}\n`),
  });
}
