import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readlinkSync, readdirSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { SeatLaunchEnvironment, publicSeatEnvironment } from "../src/domain/seat-launch-environment.js";
import { shellQuote } from "../src/adapters/shell-quote.js";
import { CodexRuntimeAdapter } from "../src/adapters/codex-runtime-adapter.js";
import { codexDaemonSupportProbe } from "../src/domain/codex-daemon-support.js";

const exec = promisify(execFile), roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(cliOverride?: string) {
  const root = mkdtempSync(path.join(tmpdir(), "seat-env-regression-")); roots.push(root);
  const shared = path.join(root, "shared bin's"), user = path.join(root, "user"), runtime = path.join(root, "runtime"), cwd = path.join(root, "workspace");
  for (const dir of [shared, user, runtime, cwd]) mkdirSync(dir);
  const exe = (file: string, text: string) => writeFileSync(file, text, { mode: 0o700 });
  const cli = path.join(root, "installed-cli"); exe(cli, "#!/bin/sh\nprintf installed-rig\\n\n");
  for (const name of ["rig", "node", "python", "git", "claude"]) {
    exe(path.join(shared, name), "#!/bin/sh\nprintf shared-tool\\n\n");
    exe(path.join(user, name), "#!/bin/sh\nprintf user-tool\\n\n");
  }
  const env = { PATH: `${shared}:/usr/bin:/bin`, OPENRIG_HOME: path.join(root, "instance"), OPENRIG_URL: "http://127.0.0.1:7433", HOME: root };
  const identity: Record<string, string> = { OPENRIG_NODE_ID: "node", OPENRIG_SESSION_NAME: "seat@rig", OPENRIG_RUNTIME: "claude-code", OPENRIG_OCCUPANT_GENERATION: "generation" };
  const tmux = { getSessionEnv: vi.fn(async (_s: string, key: string) => identity[key]), getPaneCommand: vi.fn(async (): Promise<string | null> => "bash"), sendShellCommand: vi.fn(async (_session: string, _command: string) => ({ ok: true })) };
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  // Fourth argument injects only a fake installed CLI path; production derives its paired CLI.
  // A short foreground wait keeps the unknown-foreground rows fast; production waits up to 3 s.
  const launch = new (SeatLaunchEnvironment as any)(tmux, env, root, cliOverride ?? cli, undefined, { timeoutMs: 300, pollMs: 20 }) as SeatLaunchEnvironment;
  const run = (command: string) => exec("/bin/bash", ["--noprofile", "--norc", "-c", command], { cwd, env: { ...env, PATH: `${user}:/usr/bin:/bin` }, timeout: 5000 });
  return { root, shared, user, runtime, cwd, cli, env, identity, tmux, warn, launch, run, exe };
}

it.each(["transport", "missing-node", "missing-session", "different-node"])("A: %s keeps the previous Claude command with one diagnostic", async kind => {
  const f = fixture();
  if (kind === "transport") f.tmux.getSessionEnv.mockRejectedValue(Error("unavailable"));
  if (kind === "missing-node") delete f.identity.OPENRIG_NODE_ID;
  if (kind === "missing-session") delete f.identity.OPENRIG_SESSION_NAME;
  const command = await f.launch.command("seat@rig", "claude --resume 'old'", { nodeId: kind === "different-node" ? "other" : "node" });
  expect(command).toBe("claude --resume 'old'"); expect(f.warn).toHaveBeenCalledTimes(1);
});
it("A: Codex metadata failure preserves its previous literal launch PATH", async () => {
  const f = fixture(); f.tmux.getSessionEnv.mockRejectedValue(Error("unavailable"));
  expect(await f.launch.command("seat@rig", "codex --no-daemon", { codexCwd: f.cwd })).toBe(`env PATH=${shellQuote(f.env.PATH)} codex --no-daemon`);
  expect(f.warn).toHaveBeenCalledTimes(1);
});
it.each(["not-a-url", "http://user:synthetic-secret@localhost:1234", "http://localhost:1234?token=synthetic-secret", "http://localhost:1234#synthetic-secret"])("A: unsafe URL is omitted without dropping other public metadata: %s", value => {
  const f = fixture();
  expect(publicSeatEnvironment({ OPENRIG_HOME: f.env.OPENRIG_HOME, OPENRIG_URL: value })).toEqual({ OPENRIG_HOME: f.env.OPENRIG_HOME });
  expect(f.warn).toHaveBeenCalledTimes(1); expect(JSON.stringify(f.warn.mock.calls)).not.toContain(value);
});
it("A/B: rig need not be on the daemon PATH; the linked CLI belongs to this install", async () => {
  const f = fixture(); f.env.PATH = "/usr/bin:/bin";
  const command = await f.launch.command("seat@rig", "/bin/sh -c 'command -v rig'");
  const rig = (await f.run(command)).stdout.trim();
  expect(rig.startsWith(path.join(f.env.OPENRIG_HOME, "run", "seat-bin") + path.sep)).toBe(true);
  expect(readlinkSync(rig)).toBe(realpathSync(f.cli)); expect(readdirSync(path.dirname(rig))).toEqual(["rig"]);
});
it("A: a missing paired CLI does not introduce a launch refusal", async () => {
  const f = fixture();
  const launch = new (SeatLaunchEnvironment as any)(f.tmux, f.env, f.root, path.join(f.root, "missing-cli")) as SeatLaunchEnvironment;
  expect(await launch.command("seat@rig", "claude")).toBe("claude"); expect(f.warn).toHaveBeenCalledTimes(1);
});
it("B: the owned rig-only directory leaves node/python/git/claude order intact", async () => {
  const f = fixture();
  const cmd = "/bin/sh -c 'for tool in rig node python git claude; do command -v \"$tool\"; done'";
  const paths = (await f.run(await f.launch.command("seat@rig", cmd))).stdout.trim().split("\n");
  expect(readlinkSync(paths[0]!)).toBe(realpathSync(f.cli)); expect(paths.slice(1)).toEqual(["node", "python", "git", "claude"].map(t => path.join(f.user, t)));
});
it.each(["claude", "codex"])("D: nushell retains the previous literal %s command", async runtime => {
  const f = fixture(); f.tmux.getPaneCommand.mockResolvedValue("nu");
  const command = await f.launch.command("seat@rig", `${runtime} --resume 'old'`, runtime === "codex" ? { codexCwd: f.cwd } : {});
  expect(command).toBe(runtime === "codex" ? `env PATH=${shellQuote(f.env.PATH)} codex --resume 'old'` : "claude --resume 'old'");
  expect(command).not.toContain('"$PATH"'); expect(f.warn).toHaveBeenCalledTimes(1);
});
it.each(["fresh", "resume", "fork"] as const)("C: %s uses the probe's separate Node interpreter while preserving user PATH", async kind => {
  // The "separate Node" must live in a directory that is NOT in the user PATH ("/usr/bin:/bin").
  // dirname(process.execPath) is /usr/bin on a distro-packaged Node (Linux), which would make
  // the precondition below false for environmental reasons; so give the pane a private
  // `node` that execs the real interpreter. process.execPath inside it is still the real binary.
  const f = fixture(), nodeBin = path.join(f.root, "separate-node-bin");
  mkdirSync(nodeBin); f.exe(path.join(nodeBin, "node"), `#!/bin/sh\nexec ${shellQuote(process.execPath)} "$@"\n`);
  expect(["/usr/bin", "/bin", f.shared, f.runtime]).not.toContain(nodeBin);
  f.exe(path.join(f.runtime, "codex"), `#!/usr/bin/env node\nif(process.argv.includes('--help'))console.log('Usage: codex [OPTIONS]\\n  --no-daemon');else console.log(JSON.stringify({started:true,node:process.execPath,path:process.env.PATH}));\n`);
  // There is no Node in the pane PATH. The capability query really executes this npm-style entry.
  f.env.PATH = [f.runtime, nodeBin, f.shared, "/usr/bin", "/bin"].join(":");
  const launch = new (SeatLaunchEnvironment as any)(f.tmux, f.env, f.root, f.cli) as SeatLaunchEnvironment;
  const adapter = new CodexRuntimeAdapter({ tmux: f.tmux as any, seatLaunchEnvironment: launch, launchPath: f.env.PATH,
    detectDaemonSupport: codexDaemonSupportProbe(f.env.PATH), resolveGitAddDirs: async () => [], listProcesses: () => [], sleep: async () => {},
    fsOps: { readFile: () => "", writeFile: () => {}, exists: () => false, mkdirp: () => {}, homedir: f.root } });
  vi.spyOn(adapter as any, "dismissSkippableCodexUpdatePrompt").mockResolvedValue(undefined);
  vi.spyOn(adapter as any, "verifyResumeLaunch").mockResolvedValue({ ok: true });
  vi.spyOn(adapter as any, "captureFreshThreadId").mockResolvedValue("new-thread");
  const binding: any = { id: "b", nodeId: "node", tmuxSession: "seat@rig", tmuxPane: "%1", cwd: f.cwd };
  const result = await adapter.launchHarness(binding, { name: "seat", ...(kind === "resume" ? { resumeToken: "old" } : kind === "fork" ? { forkSource: { kind: "native_id", value: "parent" } } : {}) });
  expect(result.ok).toBe(true);
  const command = (f.tmux.sendShellCommand.mock.calls.at(-1) as unknown as string[])[1]!;
  // The user's PATH carries a DECOY `node` ahead of any real one. On a host whose real Node lives in /usr/bin (distro
  // packages) the command would otherwise find it through `#!/usr/bin/env node` even if the launch did not pin the probe's
  // interpreter, and `observed.node === process.execPath` would hold either way. Here an unpinned launch runs the decoy.
  const decoyBin = path.join(f.root, "decoy-node-bin"); mkdirSync(decoyBin);
  f.exe(path.join(decoyBin, "node"), "#!/bin/sh\necho decoy-node-on-user-path\nexit 97\n");
  const userPath = `${decoyBin}:/usr/bin:/bin`;
  const { stdout } = await exec("/bin/bash", ["--noprofile", "--norc", "-c", command], { cwd: f.cwd, env: { ...f.env, PATH: userPath }, timeout: 5000 });
  const observed = JSON.parse(stdout); expect(observed.started).toBe(true); expect(observed.node).toBe(process.execPath);
  // Seat PATH head: the rig link, worktree shim) then the user PATH, unchanged.
  expect(observed.path.split(":").slice(2).join(":")).toBe(userPath);
  expect(observed.path.split(":")[1]).toBe(path.join(f.env.OPENRIG_HOME, "rig-bin"));
});

it("B: the default resolver links this workspace's built CLI, not its PATH-first rig", async () => {
  const f = fixture();
  const launch = new SeatLaunchEnvironment(f.tmux as any, f.env, f.root);
  const rig = (await f.run(await launch.command("seat@rig", "/bin/sh -c 'command -v rig'"))).stdout.trim();
  expect(readlinkSync(rig)).toBe(realpathSync(path.resolve(import.meta.dirname, "../../cli/dist/bin-wrapper.js")));
  expect(f.warn).not.toHaveBeenCalled();
});
it("B: a reused link remains rig-only; unexpected contents are preserved and fall back", async () => {
  const f = fixture(), command = "/bin/sh -c 'command -v rig'";
  const rig = (await f.run(await f.launch.command("seat@rig", command))).stdout.trim();
  expect((await f.run(await f.launch.command("seat@rig", command))).stdout.trim()).toBe(rig);
  f.exe(path.join(path.dirname(rig), "node"), "#!/bin/sh\nexit 0\n");
  expect(await f.launch.command("seat@rig", "claude")).toBe("claude");
  expect(readdirSync(path.dirname(rig)).sort()).toEqual(["node", "rig"]);
  expect(readlinkSync(rig)).toBe(realpathSync(f.cli)); expect(f.warn).toHaveBeenCalledTimes(1);
});


it.each(["nu", "nu.exe", "fish", "csh", "", "unknown"])("Pi preserves its existing command on an unsupported pane: %s", async shell => {
  const f = fixture(); f.tmux.getPaneCommand.mockResolvedValue(shell);
  const command = "node '/runner.js' --session '/history.jsonl'";
  expect(await f.launch.command("seat@rig", command, { runtime: "pi" })).toBe(command);
  expect(f.tmux.getSessionEnv).not.toHaveBeenCalled();
  expect(f.warn).toHaveBeenCalledTimes(1);
});

// "Seat PATH head": the git worktree shim is prepended AFTER the pane rc, beside the rig link, so a user PATH that puts its own git
// first (linuxbrew on Sparky, /opt/homebrew on macOS) cannot bury it. Measured before the fix: rig-bin at PATH entry 13 (Sparky) and 18 (stu).
it.each(["claude-code", "pi", "codex"] as const)("E: %s launched through the seat launch environment resolves git to the worktree shim ahead of the user's own git", async runtime => {
  const f = fixture();
  const { ensureGitWorktreeShim } = await import("../src/domain/git-worktree-shim.js");
  const shimDir = await ensureGitWorktreeShim(f.env.OPENRIG_HOME);
  const probe = "/bin/sh -c 'command -v git; command -v rig'";
  // Codex: the probed executable (here a POSIX script on the daemon PATH) runs the same probe as its child tool would.
  if (runtime === "codex") f.exe(path.join(f.shared, "codex"), `#!/bin/sh\nexec ${probe}\n`);
  const command = runtime === "codex"
    ? await f.launch.command("seat@rig", "codex --no-daemon", { codexCwd: f.cwd, runtime })
    : await f.launch.command("seat@rig", probe, { runtime });
  // f.run is the post-rc pane: the user's dir (holding its own git and rig) is first on PATH.
  const [git, rig] = (await f.run(command)).stdout.trim().split("\n");
  expect(git).toBe(path.join(shimDir, "git"));
  expect(readlinkSync(rig!)).toBe(realpathSync(f.cli));
  expect(f.warn).not.toHaveBeenCalled();
});

it("E: pathHead is the rig link then the worktree shim under this instance's home", () => {
  const f = fixture();
  const [seatBin, shim, ...more] = f.launch.pathHead();
  expect(more).toEqual([]);
  expect(seatBin!.startsWith(path.join(f.env.OPENRIG_HOME, "run", "seat-bin") + path.sep)).toBe(true);
  expect(shim).toBe(path.join(f.env.OPENRIG_HOME, "rig-bin"));
});

// The fallback names WHY, by a fixed code and no value from the environment, so a fallback in the field can be diagnosed.
it.each([
  ["transport", "identity_read_failed"],
  ["missing-node", "identity_missing"],
  ["different-node", "identity_mismatch"],
  ["nushell", "non_posix_pane"],
  ["missing-cli", "seat_bin_unavailable"],
] as const)("F: a %s fallback names its reason %s", async (kind, reason) => {
  const f = fixture(kind === "missing-cli" ? path.join(tmpdir(), "openrig-no-such-cli", "missing-cli") : undefined);
  if (kind === "transport") f.tmux.getSessionEnv.mockRejectedValue(Error("synthetic-transport-secret"));
  if (kind === "missing-node") delete f.identity.OPENRIG_NODE_ID;
  if (kind === "nushell") f.tmux.getPaneCommand.mockResolvedValue("nu");
  expect(await f.launch.command("seat@rig", "claude", { nodeId: kind === "different-node" ? "other" : "node" })).toBe("claude");
  expect(f.warn).toHaveBeenCalledTimes(1);
  expect(String(f.warn.mock.calls[0]![0])).toBe(`[seat launch] Environment correction unavailable for seat@rig (${reason}); using the previous launch command.`);
  expect(JSON.stringify(f.warn.mock.calls)).not.toContain("synthetic-transport-secret");
});
it.each([
  ["fish", "pi_pane_shell: fish"],
  ["", "pi_pane_shell: none"],
  ["git", "pi_pane_shell: git"],
  ["weird name;rm", "pi_pane_shell: other"],
] as const)("F: a Pi fallback on pane foreground %j names the foreground it saw", async (shell, reason) => {
  const f = fixture(); f.tmux.getPaneCommand.mockResolvedValue(shell);
  expect(await f.launch.command("seat@rig", "node '/runner.js'", { runtime: "pi" })).toBe("node '/runner.js'");
  expect(String(f.warn.mock.calls[0]![0])).toBe(`[seat launch] Environment correction unavailable for seat@rig (${reason}); using the previous launch command.`);
});

// Jim, 2026-11-16, "Non-login shells": Codex runs a tool command in a LOGIN shell by default (allow_login_shell, default true), and a login
// profile reorders PATH (macOS path_helper + brew shellenv buried a launch-time head at entry 15-16 on stu and mbp). Every Codex seat launch says no.
it.each([
  ["a team seat", { kernelAuthority: false }],
  ["a kernel seat", { kernelAuthority: true }],
  ["a full-bypass seat", { kernelAuthority: false, launchPosture: "full_bypass", nonInterruptive: true }],
] as const)("G: %s's Codex launch args turn login shells off, exactly once", async (_kind, choice: Parameters<typeof import("../src/adapters/kernel-authority.js").operationalLaunchArgs>[1]) => {
  const { operationalLaunchArgs } = await import("../src/adapters/kernel-authority.js");
  const args = operationalLaunchArgs("codex", choice);
  const at = args.indexOf("allow_login_shell=false");
  expect(at).toBeGreaterThan(0); expect(args[at - 1]).toBe("-c");
  expect(args.filter(a => a.startsWith("allow_login_shell"))).toEqual(["allow_login_shell=false"]);
  expect(operationalLaunchArgs("claude-code", choice).join(" ")).not.toContain("allow_login_shell");
  expect(operationalLaunchArgs("pi", choice).join(" ")).not.toContain("allow_login_shell");
});

// Measured in a scratch daemon on Sparky (hc, the real login zsh): the Pi launch fell back with `pi_pane_shell: none`. A fresh hc terminal
// reports no foreground process for its first ~0.5 s (a private-core probe read null, then zsh, 3 runs of 3), and the launch read it inside
// that window. The fix waits for the foreground to be known; the gate itself is unchanged.
it("H: a Pi launch whose pane foreground is not known yet waits for it, then applies the same POSIX-shell gate", async () => {
  const f = fixture();
  f.tmux.getPaneCommand.mockResolvedValueOnce(null).mockResolvedValueOnce("").mockResolvedValue("zsh");
  const command = await f.launch.command("seat@rig", "/bin/sh -c 'command -v rig'", { runtime: "pi" });
  expect(f.warn).not.toHaveBeenCalled();
  expect(readlinkSync((await f.run(command)).stdout.trim())).toBe(realpathSync(f.cli));
  expect(f.tmux.getPaneCommand).toHaveBeenCalledTimes(3);
});
it("H: a foreground that never becomes known still falls back, after a bounded wait, naming it", async () => {
  const f = fixture(); f.tmux.getPaneCommand.mockResolvedValue(null);
  const started = Date.now();
  expect(await f.launch.command("seat@rig", "node '/runner.js'", { runtime: "pi" })).toBe("node '/runner.js'");
  expect(Date.now() - started).toBeLessThan(2000);
  expect(String(f.warn.mock.calls[0]![0])).toContain("(pi_pane_shell: none)");
  expect(f.tmux.getPaneCommand.mock.calls.length).toBeGreaterThan(1);
});
it("H: a known non-POSIX foreground is refused at once, without waiting", async () => {
  const f = fixture(); f.tmux.getPaneCommand.mockResolvedValue("fish");
  expect(await f.launch.command("seat@rig", "node '/runner.js'", { runtime: "pi" })).toBe("node '/runner.js'");
  expect(f.tmux.getPaneCommand).toHaveBeenCalledTimes(1);
});
