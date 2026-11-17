// workspaces-o9o.11: host readiness, the checks `rig doctor` asks the daemon for before a host's first launch.
//
// A seat runs in its own login shell (`env -u ... $SHELL -l` in a terminal, the launch then typed into it), not in the
// daemon's environment. Sparky's first launch failed in that shell: an oh-my-zsh "update? [Y/n]" question swallowed the
// typed launch, and Pi was on the daemon's PATH but not the seat's. A spec folder writable by group refused the spec
// source. Each of those is visible before any launch, from one probe terminal shaped like a seat's and from the same
// judges a launch applies. This module is the domain core: what a probe found becomes rows, with no I/O. The probe
// runs through `SeatShellProbeTerminal` and the daemon-side reads through `HostReadinessIo`, both ports declared here.
import nodePath from "node:path";
import { untrustedPathProblem, type PathJudgeIo, type UntrustedRule } from "./codex-mcp-servers.js";
import type { SpecSourceTrust } from "./recorded-spec-source-judge.js";
import type { SeatRuntimeProbe } from "./rigspec-preflight.js";

/** One row, in `rig doctor`'s shape. */
export interface HostReadinessRow {
  name: string;
  status: "pass" | "warn" | "fail" | "skipped";
  message: string;
  reason?: string;
  fix?: string;
}

/** The program each runtime launches. One home: spec preflight builds its `--version` probes from this. */
export const RUNTIME_BINARIES: Readonly<Record<string, string>> = {
  "claude-code": "claude",
  codex: "codex",
  pi: "pi",
  omp: "omp",
};

/** Where one shell found one runtime's program. `found` is what `command -v` printed: a path, an alias or function
 *  description, or "" when it found nothing. `version` is the first line of `<path> --version`, or "" when not run. */
export interface RuntimeSighting {
  runtime: string;
  found: string;
  version: string;
  /** Set when the program could not be looked up at all (the PATH was unreadable, or --version failed): neither found nor absent. */
  unknown?: string;
}

/** What one run of the probe script reported. */
export interface ShellFacts {
  shell: string;
  path: string;
  runtimes: RuntimeSighting[];
}

/** The seat-shell probe's outcome: it ran (and here is what the shell saw), or the shell never ran the typed command. */
export type SeatShellOutcome =
  | { kind: "ran"; shell: string; facts: ShellFacts }
  | { kind: "did_not_run"; shell: string; waitedMs: number; paneTail: string }
  | { kind: "unavailable"; reason: string };


function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The POSIX script both probes run: in a seat-shaped login shell (sourced there, so the shell's aliases and functions
 * count for `command -v`), and directly by the daemon (its own PATH). It writes `started` as its first act, so "the shell
 * ran the typed command" is a file and not a reading of the screen. The facts go to a file, never the screen, framed by
 * markers carrying this run's nonce, and are renamed into place only when complete. Every utility is called through
 * `command`, so an rc alias or function of the same name cannot write into the result.
 */
export function probeScript(resultDir: string, nonce: string): string {
  if (!/^[0-9a-f]{16,64}$/.test(nonce)) throw new Error("probe nonce must be 16-64 lowercase hex characters");
  const dir = shQuote(resultDir);
  const names = Object.values(RUNTIME_BINARIES).join(" ");
  return [
    `_or_d=${dir}`,
    `: > "$_or_d/started"`,
    `{`,
    `  command printf '%s\\n' '${FRAME_BEGIN} ${nonce}'`,
    `  command printf 'shell\\t%s\\n' "\${SHELL:-}"`,
    `  command printf 'path\\t%s\\n' "$PATH"`,
    `  for _or_c in ${names}; do`,
    `    _or_w=$(command -v "$_or_c" 2>/dev/null | command head -n 1) || _or_w=""`,
    `    command printf 'runtime\\t%s\\t%s\\t\\n' "$_or_c" "$(command printf '%s' "$_or_w" | command tr -d '\\t\\n')"`,
    `  done`,
    `  command printf '%s\\n' '${FRAME_END} ${nonce}'`,
    `} > "$_or_d/facts.tmp" && command mv "$_or_d/facts.tmp" "$_or_d/facts"`,
  ].join("\n");
}

export const FRAME_BEGIN = "OPENRIG-DOCTOR-BEGIN";
export const FRAME_END = "OPENRIG-DOCTOR-END";

/**
 * Reads the facts file the probe script wrote: only the lines between this run's begin and end markers. Anything else
 * (rc noise, a line from another run) is ignored. No complete frame means the result is unknown (null), never "not
 * installed". Inside the frame, a runtime with no line reads as not found.
 */
export function parseShellFacts(text: string, nonce: string): ShellFacts | null {
  const lines = text.split("\n");
  const begin = lines.indexOf(`${FRAME_BEGIN} ${nonce}`);
  const end = lines.indexOf(`${FRAME_END} ${nonce}`);
  if (begin === -1 || end === -1 || end < begin) return null;
  const facts: ShellFacts = { shell: "", path: "", runtimes: [] };
  const byBinary = new Map<string, RuntimeSighting>();
  for (const line of lines.slice(begin + 1, end)) {
    const [kind, ...rest] = line.split("\t");
    if (kind === "shell") facts.shell = rest.join("\t");
    else if (kind === "path") facts.path = rest.join("\t");
    else if (kind === "runtime" && rest[0]) byBinary.set(rest[0], { runtime: "", found: rest[1] ?? "", version: rest[2] ?? "" });
  }
  for (const [runtime, binary] of Object.entries(RUNTIME_BINARIES)) {
    const seen = byBinary.get(binary);
    facts.runtimes.push({ runtime, found: seen?.found ?? "", version: seen?.version ?? "" });
  }
  return facts;
}

const SEAT_SHELL_FIX =
  "Open a new terminal, run `$SHELL -l` and see what it asks before the prompt; answer it or switch it off in your login profile " +
  "(oh-my-zsh: `zstyle ':omz:update' mode disabled` or DISABLE_AUTO_UPDATE=true), then run `rig doctor` again.";

export function judgeSeatShell(outcome: SeatShellOutcome): HostReadinessRow {
  const name = "seat_shell";
  if (outcome.kind === "unavailable") {
    return { name, status: "skipped", message: "The seat-shell probe could not start a probe terminal; a seat's shell was not checked.", reason: outcome.reason };
  }
  if (outcome.kind === "did_not_run") {
    return {
      name,
      status: "fail",
      message: `A login shell started the way a seat's is (${outcome.shell || "unknown shell"}) did not run a typed command within ${Math.round(outcome.waitedMs / 1000)} s. Something in the login profile waits for input before the prompt, and a seat's launch typed into it would be swallowed.`,
      reason: outcome.paneTail ? `The probe terminal showed (secrets redacted):\n${outcome.paneTail}` : "The probe terminal showed nothing.",
      fix: SEAT_SHELL_FIX,
    };
  }
  return { name, status: "pass", message: `A login shell started the way a seat's is (${outcome.shell || "unknown shell"}) ran a typed command.` };
}

function describe(sighting: RuntimeSighting): string {
  return sighting.version ? `${sighting.found} (${sighting.version})` : sighting.found;
}

/**
 * One row per runtime: is the program the seat's shell finds the one the daemon's checks see? `used` is the set of
 * runtimes the given spec launches, or null when no spec was given (then a missing program is only a warning, since
 * no seat may need it).
 */
export function judgeRuntimePaths(seat: RuntimeSighting[], daemon: RuntimeSighting[], used: ReadonlySet<string> | null, seatPath: string): HostReadinessRow[] {
  const rows: HostReadinessRow[] = [];
  for (const runtime of Object.keys(RUNTIME_BINARIES)) {
    if (used && !used.has(runtime)) continue;
    const binary = RUNTIME_BINARIES[runtime]!;
    const name = `seat_runtime_${runtime.replace(/-/g, "_")}`;
    const inSeat = seat.find((r) => r.runtime === runtime) ?? { runtime, found: "", version: "" };
    const inDaemon = daemon.find((r) => r.runtime === runtime) ?? { runtime, found: "", version: "" };
    const needed = used?.has(runtime) ?? false;
    const unknown = inSeat.unknown ?? inDaemon.unknown;
    if (unknown !== undefined) {
      rows.push({ name, status: "skipped", message: `Where ${binary} resolves could not be read, so it was not compared.`, reason: unknown });
      continue;
    }
    if (!inSeat.found && !inDaemon.found) {
      rows.push(needed
        ? { name, status: "fail", message: `${binary} is not installed where a seat's shell or the daemon can find it, and the spec has ${runtime} seats.`, fix: `Install ${binary}, then check \`command -v ${binary}\` in a new login shell.` }
        : { name, status: "skipped", message: `${binary} is not installed; only a ${runtime} seat needs it.` });
      continue;
    }
    if (!inSeat.found) {
      rows.push({
        name,
        status: needed ? "fail" : "warn",
        message: `${binary} is on the daemon's PATH (${describe(inDaemon)}) but a seat's login shell does not find it, so a ${runtime} seat would not start.`,
        reason: `The seat's shell PATH: ${seatPath || "(empty)"}`,
        fix: `Add ${nodePath.dirname(inDaemon.found)} to PATH in your login profile, then check \`command -v ${binary}\` in a new login shell.`,
      });
      continue;
    }
    if (!inSeat.found.startsWith("/")) {
      rows.push({ name, status: "pass", message: `A seat's login shell runs ${binary} as ${inSeat.found}.` });
      continue;
    }
    if (!inDaemon.found) {
      rows.push({
        name,
        status: "warn",
        message: `A seat's login shell finds ${describe(inSeat)}, but the daemon's PATH has no ${binary}, so spec preflight warns that ${binary} is missing and cannot read its version.`,
        fix: `Add ${nodePath.dirname(inSeat.found)} to the daemon's PATH (its service environment), or ignore the preflight warning.`,
      });
      continue;
    }
    if (inSeat.found !== inDaemon.found || inSeat.version !== inDaemon.version) {
      rows.push({
        name,
        status: "warn",
        message: `A seat runs ${describe(inSeat)}, but the daemon's checks see ${describe(inDaemon)}; version reports and preflight describe a ${binary} the seat does not run.`,
        fix: `Make both PATHs find the same ${binary}: remove the other copy, or put ${nodePath.dirname(inSeat.found)} first on the daemon's PATH.`,
      });
      continue;
    }
    rows.push({ name, status: "pass", message: `A seat and the daemon both run ${describe(inSeat)}.` });
  }
  return rows;
}

function firstLine(text: string): string {
  return (text.split("\n").find((line) => line.trim() !== "") ?? "").trim();
}

/**
 * Where each runtime resolves through one SeatRuntimeProbe (the port spec preflight uses too). A program the probe cannot find
 * is still a sighting when the seat's shell runs that name as an alias or function (`shell`'s `command -v`), since a typed
 * launch reaches it; any other failure is unknown, never "not installed".
 */
export async function sightRuntimes(probe: SeatRuntimeProbe, shell: RuntimeSighting[] = []): Promise<RuntimeSighting[]> {
  const out: RuntimeSighting[] = [];
  for (const [runtime, binary] of Object.entries(RUNTIME_BINARIES)) {
    try {
      const { path, output } = await probe(binary);
      out.push({ runtime, found: path, version: firstLine(output) });
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      if (code === "ENOENT") {
        const viaShell = shell.find((r) => r.runtime === runtime)?.found ?? "";
        out.push({ runtime, found: viaShell.startsWith("/") ? "" : viaShell, version: "" });
      } else {
        out.push({ runtime, found: "", version: "", unknown: (err as Error).message });
      }
    }
  }
  return out;
}

/**
 * Every folder a spec source may live in, judged by the rule a launch applies when it reads one (ownership, and no
 * component writable by group or others). A root that does not exist yet is not a problem.
 */
export function judgeSpecRoots(trust: SpecSourceTrust, io: PathJudgeIo): HostReadinessRow {
  const name = "spec_source_folders";
  const roots = [...new Set([...trust.roots(), ...(trust.exactDepthRoot ? [trust.exactDepthRoot()] : [])])];
  // The running install's own folder is judged as a launch judges it: an enclosing git tree does not count (o9o.91).
  const runningInstall = trust.runningInstall?.() ?? null;
  const problems: string[] = [];
  const rules = new Set<UntrustedRule>();
  let present = 0;
  for (const root of roots) {
    const judged = untrustedPathProblem(root, "the spec folder", { runningInstall }, io);
    if (judged === null) present += 1;
    else if (judged.kind === "untrusted") { present += 1; problems.push(judged.why); rules.add(judged.rule); }
  }
  if (problems.length > 0) {
    return {
      name,
      status: "fail",
      message: `${problems.length} of the ${roots.length} spec folders is not protected, so a launch refuses a spec source under it (startup_source_untrusted).`,
      reason: problems.join("\n"),
      fix: [...rules].map((rule) => SPEC_FOLDER_FIX[rule]).join(" ") + " Then run `rig doctor` again.",
    };
  }
  return { name, status: "pass", message: `${present} of the ${roots.length} spec folders exist, and none is writable by group or others.` };
}

/** The remedy for each kind of finding. A location finding (a git work tree, a seat workspaces folder, temp) is never answered
 *  with chmod or chown: modes are not the problem, and the folder may be another tool's (Homebrew's prefix, say). */
const SPEC_FOLDER_FIX: Record<UntrustedRule, string> = {
  location: "Keep spec folders outside git work trees, seat workspaces folders and temporary directories: move the folder named, or record a reviewed copy in ~/.agents-release or the spec library with `rig spec-source set`. (The running OpenRig install's own folder is exempt from the git work tree rule.)",
  mode: "Remove group and other write access from each folder named (chmod go-w <folder>). Folders under the OpenRig home are also tightened at each daemon start; one created since keeps the login umask, and folders outside the home (such as ~/.agents-release) never are.",
  owner: "Each folder named must be owned by you or root; a folder another user owns can be changed by that user.",
  inspect: "Each folder named must be readable by you, along its whole path.",
};

/** The probe terminal's port: a seat-shaped login shell, a typed command, the screen, and its removal. */
export interface SeatShellProbeTerminal {
  createProbeSession(name: string, cwd?: string): Promise<{ ok: true } | { ok: false; code: string; message: string }>;
  sendShellCommand(target: string, command: string, beforeInput?: () => void, options?: { sourceInPane?: boolean }): Promise<{ ok: true } | { ok: false; code: string; message: string }>;
  capturePaneContent(target: string, lines?: number): Promise<string | null>;
  killSession(name: string): Promise<unknown>;
}

/** The daemon-side reads the service needs. */
export interface HostReadinessIo {
  makeResultDir(): string;
  /** A fresh random nonce (16-64 lowercase hex) that frames one probe run's result. */
  nonce(): string;
  readText(path: string): string | null;
  removeDir(path: string): void;
  sleep(ms: number): Promise<void>;
  now(): number;
  shell(): string;
  redact(text: string): string;
}

export interface HostReadinessReport {
  rows: HostReadinessRow[];
}

/** Waits: how long the shell may take to run the typed command, and how long the whole script may take once it has. */
export const SEAT_SHELL_START_MS = 10_000;
export const SEAT_SHELL_FINISH_MS = 40_000;
const POLL_MS = 200;

export class HostReadinessService {
  constructor(
    private readonly deps: {
      terminal: SeatShellProbeTerminal;
      io: HostReadinessIo;
      specSourceTrust: SpecSourceTrust;
      /** The path judge's filesystem reads (the startup adapter passes the real ones). */
      pathJudgeIo: PathJudgeIo;
      homeDir: string;
      /** The one runtime probe (adapters/seat-runtime-probe.ts) on a given seat PATH, and on the daemon's own PATH. */
      seatRuntimeProbeOn: (path: string) => SeatRuntimeProbe;
      daemonRuntimeProbe: SeatRuntimeProbe;
      startMs?: number;
      finishMs?: number;
    },
  ) {}

  async report(input: { seatShell: boolean; runtimes: string[] | null }): Promise<HostReadinessReport> {
    const rows: HostReadinessRow[] = [];
    const used = input.runtimes ? new Set(input.runtimes) : null;
    if (input.seatShell) {
      const outcome = await this.probeSeatShell();
      rows.push(judgeSeatShell(outcome));
      if (outcome.kind === "ran") {
        const seat = await sightRuntimes(this.deps.seatRuntimeProbeOn(outcome.facts.path), outcome.facts.runtimes);
        const daemon = await sightRuntimes(this.deps.daemonRuntimeProbe);
        rows.push(...judgeRuntimePaths(seat, daemon, used, outcome.facts.path));
      } else {
        rows.push({ name: "seat_runtimes", status: "skipped", message: "Runtime paths were not checked: the seat-shell probe did not run." });
      }
    } else {
      rows.push({ name: "seat_shell", status: "skipped", message: "Skipped (--no-seat-shell): a seat's login shell and its runtime paths were not checked." });
    }
    rows.push(judgeSpecRoots(this.deps.specSourceTrust, this.deps.pathJudgeIo));
    return { rows };
  }

  /** A seat's PATH, from one probe terminal: the SeatPathSource behind spec preflight's Pi notice. Rejects, never guesses. */
  async seatPath(): Promise<string> {
    const outcome = await this.probeSeatShell();
    if (outcome.kind === "ran") return outcome.facts.path;
    throw new Error(outcome.kind === "did_not_run"
      ? `a login shell started the way a seat's is did not run a typed command within ${Math.round(outcome.waitedMs / 1000)} s (see rig doctor)`
      : outcome.reason);
  }

  async probeSeatShell(): Promise<SeatShellOutcome> {
    const { terminal, io } = this.deps;
    const startMs = this.deps.startMs ?? SEAT_SHELL_START_MS;
    const finishMs = this.deps.finishMs ?? SEAT_SHELL_FINISH_MS;
    const nonce = io.nonce();
    // The per-run nonce names the terminal, so concurrent doctor runs never collide on a name (a clock can repeat).
    const name = `rigged-doctor-${nonce}`;
    const dir = io.makeResultDir();
    const shell = io.shell();
    try {
      const created = await terminal.createProbeSession(name, this.deps.homeDir);
      if (!created.ok) return { kind: "unavailable", reason: `${created.code}: ${created.message}` };
      try {
        // Typed the way a seat's launch is: a short invocation of a private script, sourced in a POSIX shell.
        const sent = await terminal.sendShellCommand(name, probeScript(dir, nonce), undefined, { sourceInPane: true });
        if (!sent.ok) return { kind: "unavailable", reason: `${sent.code}: ${sent.message}` };
        const began = io.now();
        while (io.readText(nodePath.join(dir, "started")) === null) {
          if (io.now() - began >= startMs) {
            const screen = (await terminal.capturePaneContent(name, 20)) ?? "";
            return { kind: "did_not_run", shell, waitedMs: io.now() - began, paneTail: io.redact(screen.trimEnd()) };
          }
          await io.sleep(POLL_MS);
        }
        let facts: string | null;
        while ((facts = io.readText(nodePath.join(dir, "facts"))) === null) {
          if (io.now() - began >= startMs + finishMs) return { kind: "unavailable", reason: "the probe started but did not finish writing what it found" };
          await io.sleep(POLL_MS);
        }
        const parsed = parseShellFacts(facts, nonce);
        if (parsed === null) return { kind: "unavailable", reason: "the probe's result had no complete frame for this run, so what the shell saw is unknown" };
        return { kind: "ran", shell, facts: parsed };
      } finally {
        await terminal.killSession(name);
      }
    } finally {
      io.removeDir(dir);
    }
  }
}
