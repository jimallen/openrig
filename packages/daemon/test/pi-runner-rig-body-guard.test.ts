// OF-249: every Pi seat starts with the rig-body guard extension. Argv construction (pure), the missing-file
// refusal (pure, `exists` injected) and the REAL runner process against a fake `pi` that records the argv it was started with.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { buildPiChildArgs } from "../src/adapters/pi-runner-protocol.js";
import { piRigBodyGuardExtensionPath, resolvePiRigBodyGuard } from "../src/adapters/pi-runner.js";

const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));
const RUNNER = path.join(PACKAGE_DIR, "src", "adapters", "pi-runner.ts");
const GUARD = path.join(PACKAGE_DIR, "assets", "plugins", "openrig-core", "pi", "rig-body-guard.cjs");

describe("buildPiChildArgs extensions", () => {
  const base = { sessionsDir: "/s", sessionName: "seat@rig", trust: "approve" as const };
  it("passes each extension as --extension <file> after the trust flag, for Pi", () => {
    expect(buildPiChildArgs({ ...base, extensions: ["/g/one.cjs", "/g/two.cjs"] })).toEqual([
      "--mode", "rpc", "--session-dir", "/s", "--name", "seat@rig", "--approve", "--extension", "/g/one.cjs", "--extension", "/g/two.cjs",
    ]);
  });
  it("leaves the argv unchanged when none are given", () => {
    expect(buildPiChildArgs(base)).toEqual(["--mode", "rpc", "--session-dir", "/s", "--name", "seat@rig", "--approve"]);
  });
  it("does not pass them to OMP (a different runtime with its own extension scheme)", () => {
    expect(buildPiChildArgs({ ...base, runtime: "omp", extensions: ["/g/one.cjs"] })).not.toContain("--extension");
  });
});

describe("resolvePiRigBodyGuard", () => {
  it("points at the plugin asset beside the Claude hook, and the file is there", () => {
    expect(piRigBodyGuardExtensionPath()).toBe(GUARD);
    expect(fs.existsSync(GUARD)).toBe(true);
    expect(resolvePiRigBodyGuard((f) => fs.existsSync(f))).toEqual({ ok: true, path: GUARD });
  });
  it("is a dist-relative path too: src/adapters and dist/adapters sit at the same depth", () => {
    expect(piRigBodyGuardExtensionPath("/pkg/dist/adapters")).toBe("/pkg/assets/plugins/openrig-core/pi/rig-body-guard.cjs");
  });
  it("refuses (does not return a path) when the file is absent", () => {
    const r = resolvePiRigBodyGuard(() => false);
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.error).toContain("not starting Pi without it");
  });
});

describe("the real runner process", () => {
  const dirs: string[] = [];
  afterAll(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

  it("starts the (fake) pi child with --extension <the guard>", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "of249-runner-"));
    dirs.push(root);
    const bin = path.join(root, "bin");
    fs.mkdirSync(bin);
    const argvFile = path.join(root, "argv.json");
    fs.writeFileSync(path.join(bin, "pi"), `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));\nsetTimeout(() => process.exit(0), 300);\n`, { mode: 0o700 });
    const env = { PATH: `${bin}${path.delimiter}${path.dirname(process.execPath)}${path.delimiter}/usr/bin${path.delimiter}/bin`, OPENRIG_HOME: path.join(root, "home"), HOME: root };
    const child = spawn(process.execPath, ["--import", "tsx", RUNNER, "--session-name", "s1@r", "--state-root", path.join(root, "state"), "--cwd", root, "--launch-id", "l1", "--approve"], { cwd: PACKAGE_DIR, env, stdio: ["ignore", "ignore", "ignore"] });
    const exited = await new Promise<number | null>((resolve) => { child.on("exit", (code) => resolve(code)); setTimeout(() => { child.kill("SIGKILL"); resolve(null); }, 100_000); });
    expect(exited).toBe(0);
    const argv = JSON.parse(fs.readFileSync(argvFile, "utf8")) as string[];
    const at = argv.indexOf("--extension");
    expect(at).toBeGreaterThan(0);
    expect(argv[at + 1]).toBe(GUARD);
  }, 130_000);

  it("refuses to start Pi at all when the guard file is absent (exit 127, the exit recorded, the pi child never spawned)", async () => {
    // A copy of src/ sits where "../../assets" does not exist, inside the package so bare imports still resolve.
    const copy = fs.mkdtempSync(path.join(PACKAGE_DIR, "node_modules", ".cache-of249-"));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "of249-runner-missing-"));
    dirs.push(copy, root);
    fs.cpSync(path.join(PACKAGE_DIR, "src"), path.join(copy, "src"), { recursive: true });
    fs.writeFileSync(path.join(copy, "package.json"), JSON.stringify({ type: "module" })); // as in the real package: import.meta.dirname needs ESM
    expect(fs.existsSync(path.join(copy, "assets"))).toBe(false);
    const bin = path.join(root, "bin");
    fs.mkdirSync(bin);
    const argvFile = path.join(root, "argv.json");
    fs.writeFileSync(path.join(bin, "pi"), `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(argvFile)}, "started");\nsetTimeout(() => process.exit(0), 300);\n`, { mode: 0o700 });
    const env = { PATH: `${bin}${path.delimiter}${path.dirname(process.execPath)}${path.delimiter}/usr/bin${path.delimiter}/bin`, OPENRIG_HOME: path.join(root, "home"), HOME: root };
    const stateRoot = path.join(root, "state");
    const out: string[] = [];
    const child = spawn(process.execPath, ["--import", "tsx", path.join(copy, "src", "adapters", "pi-runner.ts"), "--session-name", "s1@r", "--state-root", stateRoot, "--cwd", root, "--launch-id", "l1", "--approve"], { cwd: PACKAGE_DIR, env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (d) => out.push(String(d)));
    child.stderr.on("data", (d) => out.push(String(d)));
    const exited = await new Promise<number | null>((resolve) => { child.on("exit", (code) => resolve(code)); setTimeout(() => { child.kill("SIGKILL"); resolve(null); }, 100_000); });
    expect(exited).toBe(127);
    expect(out.join("")).toContain("not starting Pi without it");
    expect(fs.existsSync(argvFile)).toBe(false);
    const state = JSON.parse(fs.readFileSync(path.join(stateRoot, "s1@r", "runner-state.json"), "utf8")) as { ready: boolean; exited?: { code: number } };
    expect(state.ready).toBe(false);
    expect(state.exited?.code).toBe(127);
  }, 130_000);
});
