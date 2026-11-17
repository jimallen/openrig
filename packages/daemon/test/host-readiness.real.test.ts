// workspaces-o9o.11, on a real tmux server (a private socket directory, never the operator's; the session's TMUX is not
// passed on). Sparky's first launch failed in the seat's own login shell: an oh-my-zsh "update? [Y/n]" question read the
// typed launch as its answer, and Pi was on the daemon's PATH but not the seat's. Here the private HOME's .profile stands
// in for that shell. The doctor's probe must see both before any seat is launched.
import { execFile, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { HostReadinessService, type HostReadinessIo } from "../src/domain/host-readiness.js";
import { daemonRuntimeProbe, seatRuntimeProbe } from "../src/adapters/seat-runtime-probe.js";
import { redactPaneText } from "../src/domain/launch-failure-report.js";

const HAS_TMUX = (() => { try { execFileSync("tmux", ["-V"], { stdio: "ignore" }); return true; } catch { return false; } })();

describe.skipIf(!HAS_TMUX || process.platform === "win32")("rig doctor's seat-shell probe on a real login shell (real tmux)", () => {
  // Set only once each step succeeds, so cleanup never acts on a half-made fixture: with no private env, a bare
  // `tmux kill-server` would inherit this process's environment and could reach a LIVE server.
  let base: string | undefined;
  let env: NodeJS.ProcessEnv | undefined;
  let tmuxAdapter: TmuxAdapter;
  const tmux = (...args: string[]) => {
    if (!env) throw new Error("no private tmux environment: refusing to run tmux against an inherited server");
    return execFileSync("tmux", args, { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  };

  beforeAll(() => {
    const root = realpathSync(mkdtempSync("/tmp/o9o11-"));
    base = root;
    const privateEnv: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: root, TMUX_TMPDIR: root, TERM: "xterm-256color", SHELL: "/bin/sh" };
    env = privateEnv;
    tmuxAdapter = new TmuxAdapter((cmd) => new Promise((resolve, reject) => {
      execFile("/bin/sh", ["-c", cmd], { env: privateEnv, encoding: "utf8" }, (error, stdout, stderr) => (error ? reject(new Error(`${stderr}${error.message}`)) : resolve(stdout)));
    }));
  });
  afterEach(() => { if (base) rmSync(join(base, ".profile"), { force: true }); });
  afterAll(() => {
    if (env) { try { tmux("kill-server"); } catch { /* already gone */ } }
    if (base) rmSync(base, { recursive: true, force: true });
  });

  function service(): HostReadinessService {
    const io: HostReadinessIo = {
      makeResultDir: () => mkdtempSync(join(base!, "result-")),
      nonce: () => randomBytes(16).toString("hex"),
      readText: (p) => { try { return fs.readFileSync(p, "utf-8"); } catch { return null; } },
      removeDir: (p) => fs.rmSync(p, { recursive: true, force: true }),
      // The daemon's own run: this process's PATH, without the folder the seat's .profile adds.
      sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
      now: () => Date.now(),
      shell: () => "/bin/sh",
      redact: redactPaneText,
    };
    // The one runtime probe, real: the seat side on the PATH the probe terminal reports, the daemon side on this process's PATH
    // (without the folder the seat's .profile adds).
    const daemonEnv = { PATH: process.env.PATH, HOME: base! };
    return new HostReadinessService({
      terminal: tmuxAdapter, io, specSourceTrust: { roots: () => [] }, homeDir: base!, startMs: 3000, finishMs: 15000,
      seatRuntimeProbeOn: (path) => seatRuntimeProbe({ seatPath: async () => path, daemonEnv }),
      daemonRuntimeProbe: daemonRuntimeProbe({ daemonEnv }),
    });
  }

  const probeSessions = () => { try { return tmux("list-sessions", "-F", "#{session_name}").split("\n").filter((n) => n.startsWith("rigged-doctor-")); } catch { return []; } };

  it("a login profile that waits for an answer is reported as swallowing the typed command, and the probe is removed", async () => {
    writeFileSync(join(base!, ".profile"), "printf '[oh-my-zsh] Would you like to update? [Y/n] '\nread answer\nexec sleep 600\n");
    const outcome = await service().probeSeatShell();
    expect(outcome.kind).toBe("did_not_run");
    if (outcome.kind !== "did_not_run") return;
    expect(outcome.paneTail).toContain("Would you like to update? [Y/n]");
    expect(probeSessions()).toEqual([]);
  });

  it("a Pi the login profile puts on PATH is seen in the seat's shell and missing from the daemon's", async () => {
    const bin = join(base!, "seat-bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "pi"), "#!/bin/sh\necho 'pi 1.4.0'\n");
    chmodSync(join(bin, "pi"), 0o755);
    writeFileSync(join(base!, ".profile"), `PATH=${bin}:$PATH; export PATH\n`);
    const probe = service();
    const outcome = await probe.probeSeatShell();
    expect(outcome.kind).toBe("ran");
    if (outcome.kind !== "ran") return;
    expect(outcome.facts.runtimes.find((r) => r.runtime === "pi")?.found).toBe(join(bin, "pi"));
    expect(outcome.facts.path.split(":")[0]).toBe(bin);
    const { rows } = await probe.report({ seatShell: true, runtimes: ["pi"] });
    const pi = rows.find((r) => r.name === "seat_runtime_pi");
    expect(pi?.status).toBe("warn");
    expect(pi?.message).toContain(`${join(bin, "pi")} (pi 1.4.0)`);
    expect(probeSessions()).toEqual([]);
    // Spec preflight's port, through the same probe terminal, names the seat's Pi.
    const preflightProbe = seatRuntimeProbe({ seatPath: () => probe.seatPath(), daemonEnv: { PATH: process.env.PATH, HOME: base! } });
    expect(await preflightProbe("pi")).toEqual({ path: join(bin, "pi"), output: "pi 1.4.0\n" });
  });

  it("rc noise and an rc printf function cannot write into the result: it is read only between this run's markers", async () => {
    // A login profile that talks on stdout and replaces printf with a function that lies about every value.
    writeFileSync(join(base!, ".profile"), "echo 'Welcome! runtime\tpi\t/evil/pi\t6.6.6'\nprintf() { echo 'runtime\tpi\t/evil/pi\t6.6.6'; }\n");
    const outcome = await service().probeSeatShell();
    expect(outcome.kind).toBe("ran");
    if (outcome.kind !== "ran") return;
    expect(outcome.facts.runtimes.find((r) => r.runtime === "pi")?.found).not.toBe("/evil/pi");
    expect(outcome.facts.path).toContain("/");
    expect(probeSessions()).toEqual([]);
  });
});

const HAS_ZSH = (() => { try { execFileSync("zsh", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();

// workspaces-o9o.11 (the o9o.65 reconciliation): zsh reads .zshrc only in an interactive shell. A seat's terminal is one, so a PATH
// set only in .zshrc (oh-my-zsh, brew, mise lines) is the seat's PATH; `zsh -l -c` never sees it.
describe.skipIf(!HAS_TMUX || !HAS_ZSH || process.platform === "win32")("the seat PATH comes from an interactive login zsh, .zshrc included (real tmux)", () => {
  let base: string | undefined;
  let env: NodeJS.ProcessEnv | undefined;
  let zsh = "";
  const tmux = (...args: string[]) => {
    if (!env) throw new Error("no private tmux environment: refusing to run tmux against an inherited server");
    return execFileSync("tmux", args, { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  };
  beforeAll(() => {
    zsh = execFileSync("sh", ["-c", "command -v zsh"], { encoding: "utf8" }).trim();
    const root = realpathSync(mkdtempSync("/tmp/o9o11z-"));
    base = root;
    env = { PATH: process.env.PATH, HOME: root, TMUX_TMPDIR: root, TERM: "xterm-256color", SHELL: zsh };
  });
  afterAll(() => {
    if (env) { try { tmux("kill-server"); } catch { /* already gone */ } }
    if (base) rmSync(base, { recursive: true, force: true });
  });

  it("a Pi that only .zshrc puts on PATH is the seat's Pi through the probe terminal, and invisible to zsh -l -c", async () => {
    const root = base!;
    const privateEnv = env!;
    const bin = join(root, "zshrc-bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "pi"), "#!/bin/sh\necho 'pi 1.4.0'\n");
    chmodSync(join(bin, "pi"), 0o755);
    writeFileSync(join(root, ".zshrc"), `PATH=${bin}:$PATH; export PATH\n`);
    const adapter = new TmuxAdapter((cmd) => new Promise((resolve, reject) => {
      execFile("/bin/sh", ["-c", cmd], { env: privateEnv, encoding: "utf8" }, (error, stdout, stderr) => (error ? reject(new Error(`${stderr}${error.message}`)) : resolve(stdout)));
    }));
    const io: HostReadinessIo = {
      makeResultDir: () => mkdtempSync(join(root, "result-")),
      nonce: () => randomBytes(16).toString("hex"),
      readText: (p) => { try { return fs.readFileSync(p, "utf-8"); } catch { return null; } },
      removeDir: (p) => fs.rmSync(p, { recursive: true, force: true }),
      sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
      now: () => Date.now(),
      shell: () => zsh,
      redact: redactPaneText,
    };
    const daemonEnv = { PATH: process.env.PATH, HOME: root };
    const service = new HostReadinessService({
      terminal: adapter, io, specSourceTrust: { roots: () => [] }, homeDir: root, startMs: 5000, finishMs: 15000,
      seatRuntimeProbeOn: (path) => seatRuntimeProbe({ seatPath: async () => path, daemonEnv }),
      daemonRuntimeProbe: daemonRuntimeProbe({ daemonEnv }),
    });
    const probe = seatRuntimeProbe({ seatPath: () => service.seatPath(), daemonEnv });
    expect(await probe("pi")).toEqual({ path: join(bin, "pi"), output: "pi 1.4.0\n" });
    // Positive control for the reason this exists: a non-interactive login zsh, as o9o.65 asked, does not see that PATH.
    const nonInteractive = execFileSync(zsh, ["-l", "-c", 'printf "%s" "$PATH"'], { env: { PATH: process.env.PATH, HOME: root }, encoding: "utf8" });
    expect(nonInteractive.split(":")).not.toContain(bin);
  });
});
