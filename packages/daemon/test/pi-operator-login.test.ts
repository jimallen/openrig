// OF-279: a Pi seat gets the operator's login by a declared symlink, and a launch with no credential is refused.
// Real files in a private temp directory, dummy values only. No test here reads, creates or changes any real
// auth.json or models.json, ~/.pi, a seat dir, tmux, a daemon or hc. The "operator" folder is a temp folder.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { linkPiOperatorLogin, realPiOperatorLoginFs, type PiOperatorLoginFs } from "../src/adapters/pi-operator-login.js";
import { PI_FULLY_DEFINED_CREDENTIAL_ENV, piCredentialLaunchGate, piCredentialSource } from "../src/adapters/pi-readiness.js";
import { main, parseRunnerArgs } from "../src/adapters/pi-runner.js";
import { buildPiRunnerCommand, PI_PROVIDER_ENV_VARS, type PiRunnerLaunchOpts } from "../src/adapters/pi-runner-protocol.js";

const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));
const RUNNER = nodePath.join(PACKAGE_DIR, "src", "adapters", "pi-runner.ts");
const OAUTH = { "openai-codex": { type: "oauth", access: "dummy-access", refresh: "dummy-refresh", expires: 4102444800000 } };

let dir: string;
let state: string;
let operator: string;
let seat: string;
let agentDir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "of279-"));
  state = nodePath.join(dir, "state");
  operator = nodePath.join(dir, "operator");
  seat = nodePath.join(state, "verify-qa@t");
  agentDir = nodePath.join(seat, "agent");
  fs.mkdirSync(operator);
  fs.mkdirSync(agentDir, { recursive: true });
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const opAuth = () => nodePath.join(operator, "auth.json");
const opModels = () => nodePath.join(operator, "models.json");
const seatAuth = () => nodePath.join(agentDir, "auth.json");
const seatModels = () => nodePath.join(agentDir, "models.json");
const OPERATOR_AUTH_TEXT = JSON.stringify(OAUTH);
const putOperator = () => { fs.writeFileSync(opAuth(), OPERATOR_AUTH_TEXT, { mode: 0o600 }); };
const link = (over: Partial<Parameters<typeof linkPiOperatorLogin>[0]> = {}) =>
  linkPiOperatorLogin({ stateRoot: state, agentDir, sessionName: "verify-qa@t", operatorDir: operator, linkModels: false, ...over });
const target = (p: string) => fs.readlinkSync(p);
const err = (r: ReturnType<typeof link>) => (r as { error: string }).error;
const lines = (r: ReturnType<typeof link>) => (r as { lines: string[] }).lines;

describe("rule 1: a link, never a copy; unset means no link", () => {
  it("host unset: nothing is touched and no line is logged", () => {
    putOperator();
    expect(link({ operatorDir: undefined })).toEqual({ ok: true, lines: [] });
    expect(link({ operatorDir: "" })).toEqual({ ok: true, lines: [] });
    expect(fs.readdirSync(agentDir)).toEqual([]);
  });

  it("an absent seat auth.json becomes a symlink to the operator's, and the launch line says the login is shared", () => {
    putOperator();
    const r = link();
    expect(r.ok).toBe(true);
    expect(fs.lstatSync(seatAuth()).isSymbolicLink()).toBe(true);
    expect(target(seatAuth())).toBe(opAuth());
    expect(lines(r)).toHaveLength(1);
    expect(lines(r)[0]).toMatch(/linked to the operator's .*shared with the operator's own Pi and every other seat linked to it; concurrent token refresh across them is not proven safe \(docs\/reference\/pi-operator-login\.md\)/);
    expect(fs.readFileSync(opAuth(), "utf8")).toBe(OPERATOR_AUTH_TEXT);
  });

  it("running it again is a no-op that still says the login is shared (every launch that uses the link logs it)", () => {
    putOperator();
    link();
    const before = fs.lstatSync(seatAuth()).ino;
    const r = link();
    expect(lines(r)).toEqual([expect.stringMatching(/^auth\.json is linked to the operator's .*shared with the operator/)]);
    expect(fs.lstatSync(seatAuth()).ino).toBe(before);
  });
});

describe("rule 2: an existing credential is left alone; only the 2-byte {} stub is replaced", () => {
  it("the 2-byte {} stub Pi leaves is replaced by the link (atomically: no temp name is left)", () => {
    putOperator();
    fs.writeFileSync(seatAuth(), "{}", { mode: 0o600 });
    const r = link({ tempSuffix: () => "fixed" });
    expect(r.ok).toBe(true);
    expect(target(seatAuth())).toBe(opAuth());
    expect(lines(r)[0]).toMatch(/empty 2-byte stub/);
    expect(fs.readdirSync(agentDir)).toEqual(["auth.json"]);
  });

  it.each([
    ["a regular auth.json with a login", JSON.stringify(OAUTH)],
    ["two bytes that are not an empty object", "[]"],
    ["an empty object that is three bytes", "{ }"],
    ["an empty object that is 0x0a-terminated (three bytes)", "{}\n"],
    ["an empty file", ""],
  ])("%s is left alone, byte for byte, and not linked", (_n, text) => {
    putOperator();
    fs.writeFileSync(seatAuth(), text, { mode: 0o600 });
    const r = link();
    expect(r.ok).toBe(true);
    expect(fs.lstatSync(seatAuth()).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(seatAuth(), "utf8")).toBe(text);
    expect(lines(r)[0]).toMatch(/this seat's own file .*left alone/);
    expect(lines(r).join("")).not.toMatch(/shared with the operator/);
  });

  it("the only file ever read is a seat's own 2-byte auth.json: the operator's files and bigger files are never opened", () => {
    const reads: string[] = [];
    const spy: PiOperatorLoginFs = { ...realPiOperatorLoginFs, readFile: (p) => { reads.push(p); return realPiOperatorLoginFs.readFile(p); } };
    putOperator();
    fs.writeFileSync(opModels(), "{}");
    link({ fsOps: spy, linkModels: true });                              // absent seat files
    fs.rmSync(seatAuth()); fs.writeFileSync(seatAuth(), JSON.stringify(OAUTH));
    fs.rmSync(seatModels()); fs.writeFileSync(seatModels(), '{"providers":{}}');
    link({ fsOps: spy, linkModels: true });                              // seat's own bigger files
    fs.rmSync(seatAuth()); fs.writeFileSync(seatAuth(), "{}");
    link({ fsOps: spy, linkModels: true });                              // the stub: the one allowed read
    expect(reads).toEqual([seatAuth()]);
  });

  it("a symlink pointing elsewhere is left alone and the line names where it points", () => {
    putOperator();
    const elsewhere = nodePath.join(dir, "elsewhere.json");
    fs.writeFileSync(elsewhere, "{}");
    fs.symlinkSync(elsewhere, seatAuth());
    const r = link();
    expect(r.ok).toBe(true);
    expect(target(seatAuth())).toBe(elsewhere);
    expect(lines(r)[0]).toContain(elsewhere);
    expect(lines(r)[0]).toMatch(/NOT the operator's/);
    expect(lines(r)[0]).not.toMatch(/shared with the operator/);
  });
});

describe("rule 3: never a dangling link: a missing operator file refuses the launch", () => {
  it("no operator auth.json: refused, the seat dir is as found (no link, no stub)", () => {
    const r = link();
    expect(r.ok).toBe(false);
    expect(err(r)).toMatch(/operator's auth\.json .*cannot be inspected \(ENOENT\).*"\{\}" in the operator's folder/);
    expect(fs.readdirSync(agentDir)).toEqual([]);
  });

  it("an operator auth.json that is itself a dangling link is refused (stat follows it)", () => {
    fs.symlinkSync(nodePath.join(dir, "nowhere"), opAuth());
    expect(link().ok).toBe(false);
    expect(fs.readdirSync(agentDir)).toEqual([]);
  });

  it("an operator auth.json that is a directory is refused", () => {
    fs.mkdirSync(opAuth());
    expect(err(link())).toMatch(/not a regular file/);
  });

  it("an existing stub is NOT replaced when the operator file is missing (the seat keeps its stub)", () => {
    fs.writeFileSync(seatAuth(), "{}");
    expect(link().ok).toBe(false);
    expect(fs.lstatSync(seatAuth()).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(seatAuth(), "utf8")).toBe("{}");
  });

  it("models.json declared and the operator's missing: refused, and auth.json is not linked either", () => {
    putOperator();
    const r = link({ linkModels: true });
    expect(r.ok).toBe(false);
    expect(err(r)).toMatch(/operator's models\.json/);
    expect(fs.readdirSync(agentDir)).toEqual([]);
  });

  it("a relative operator dir is refused", () => {
    expect(err(link({ operatorDir: "operator" }))).toMatch(/not an absolute folder path/);
  });
});

describe("the models.json link (declared per member)", () => {
  it("with the declaration, models.json is linked beside auth.json; without it, models.json is never touched", () => {
    putOperator();
    fs.writeFileSync(opModels(), '{"providers":{}}');
    const without = link();
    expect(without.ok).toBe(true);
    expect(fs.existsSync(seatModels())).toBe(false);
    const withIt = link({ linkModels: true });
    expect(withIt.ok).toBe(true);
    expect(target(seatModels())).toBe(opModels());
    expect(lines(withIt)).toHaveLength(2);
  });

  it("a seat's own regular models.json is left alone and named (it may hold keys)", () => {
    putOperator();
    fs.writeFileSync(opModels(), "{}");
    fs.writeFileSync(seatModels(), '{"providers":{"x":{"apiKey":"dummy"}}}');
    const r = link({ linkModels: true });
    expect(r.ok).toBe(true);
    expect(fs.readFileSync(seatModels(), "utf8")).toBe('{"providers":{"x":{"apiKey":"dummy"}}}');
    expect(lines(r).find((l) => l.startsWith("models.json"))).toMatch(/this seat's own file .*left alone/);
  });

  it("the declaration without the host setting refuses (the member asked for something the host cannot give)", () => {
    const r = link({ operatorDir: undefined, linkModels: true });
    expect(r.ok).toBe(false);
    expect(err(r)).toMatch(/pi\.link_operator_models .*pi\.operator_login_dir is not set/);
  });
});

describe("the seat and agent directories are judged like the model_overrides writer judges them", () => {
  it("a symlinked seat dir refuses and writes nothing through it", () => {
    putOperator();
    const outside = nodePath.join(dir, "outside");
    fs.mkdirSync(nodePath.join(outside, "agent"), { recursive: true });
    const linkedSeat = nodePath.join(state, "linked@t");
    fs.symlinkSync(outside, linkedSeat);
    const r = link({ agentDir: nodePath.join(linkedSeat, "agent") });
    expect(err(r)).toMatch(/is a symlink; the runner never writes through a symlinked seat or agent directory, so the operator login cannot be linked into it/);
    expect(fs.readdirSync(nodePath.join(outside, "agent"))).toEqual([]);
  });

  it("an agent dir outside the state root refuses", () => {
    putOperator();
    expect(err(link({ agentDir: nodePath.join(dir, "elsewhere") }))).toMatch(/not below the Pi state root .*not writing the operator login link/);
  });
});

describe("review F2: the operator's file must resolve outside the Pi state root", () => {
  it("the operator folder equal to the seat's own agent dir (holding its stub) is refused: no looping link, the stub is kept", () => {
    fs.writeFileSync(seatAuth(), "{}");
    const r = link({ operatorDir: agentDir });
    expect(r.ok).toBe(false);
    expect(err(r)).toMatch(/inside the Pi state root .*a seat's own file, not the operator's login/);
    expect(fs.lstatSync(seatAuth()).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(seatAuth(), "utf8")).toBe("{}");
  });
  it("the operator folder set to ANOTHER seat's dir under the state root is refused, and nothing is linked", () => {
    const other = nodePath.join(state, "verify-ops@t", "agent");
    fs.mkdirSync(other, { recursive: true });
    fs.writeFileSync(nodePath.join(other, "auth.json"), JSON.stringify(OAUTH));
    const r = link({ operatorDir: other });
    expect(r.ok).toBe(false);
    expect(fs.readdirSync(agentDir)).toEqual([]);
  });
  it("a symlinked operator folder that leads into a seat dir is refused (judged on the real path)", () => {
    const via = nodePath.join(dir, "via"); fs.symlinkSync(agentDir, via);
    fs.writeFileSync(seatAuth(), "{}");
    expect(link({ operatorDir: via }).ok).toBe(false);
    expect(fs.readFileSync(seatAuth(), "utf8")).toBe("{}");
  });
  it("an operator auth.json that is a link into a seat's file is refused too", () => {
    const other = nodePath.join(state, "verify-ops@t", "agent");
    fs.mkdirSync(other, { recursive: true });
    fs.writeFileSync(nodePath.join(other, "auth.json"), JSON.stringify(OAUTH));
    fs.symlinkSync(nodePath.join(other, "auth.json"), opAuth());
    expect(link().ok).toBe(false);
    expect(fs.readdirSync(agentDir)).toEqual([]);
  });
});

describe("review F4: an operator auth.json that is a symlink to a regular file is accepted (a dotfile-manager layout)", () => {
  it("the seat is linked to the operator's path as given, and the file behind it is untouched", () => {
    const real = nodePath.join(dir, "dotfiles-auth.json");
    fs.writeFileSync(real, OPERATOR_AUTH_TEXT, { mode: 0o600 });
    fs.symlinkSync(real, opAuth());
    const r = link();
    expect(r.ok).toBe(true);
    expect(target(seatAuth())).toBe(opAuth());
    expect(fs.readFileSync(seatAuth(), "utf8")).toBe(OPERATOR_AUTH_TEXT);
    expect(fs.readFileSync(real, "utf8")).toBe(OPERATOR_AUTH_TEXT);
  });
});

describe("failure mid-replacement leaves the stub as it was", () => {
  it("a rename that fails removes the temp link and keeps the 2-byte file", () => {
    putOperator();
    fs.writeFileSync(seatAuth(), "{}");
    const failing: PiOperatorLoginFs = { ...realPiOperatorLoginFs, rename: () => { throw Object.assign(new Error("x"), { code: "EXDEV" }); } };
    const r = link({ fsOps: failing, tempSuffix: () => "fixed" });
    expect(err(r)).toMatch(/could not replace .* EXDEV|EXDEV/);
    expect(fs.readdirSync(agentDir)).toEqual(["auth.json"]);
    expect(fs.readFileSync(seatAuth(), "utf8")).toBe("{}");
  });
});

describe("rule 4: refuse a launch with no credential (the gate)", () => {
  const none = { kind: "none" as const, provider: "openai-codex", envVar: undefined };
  it("none with no extension: refused, naming the provider and both fixes in one line", () => {
    const g = piCredentialLaunchGate(none, "none", "/seat/agent");
    expect(g.action).toBe("refuse");
    const m = (g as { message: string }).message;
    expect(m).not.toContain("\n");
    expect(m).toContain("openai-codex");
    expect(m).toContain("pi.operator_login_dir");
    expect(m).toMatch(/sign in for this seat .*PI_CODING_AGENT_DIR=\/seat\/agent/);
  });
  it("a provider with a known key variable names it instead of the sign-in", () => {
    expect((piCredentialLaunchGate({ ...none, provider: "openrouter", envVar: "OPENROUTER_API_KEY" }, "none", "/a") as { message: string }).message).toMatch(/OPENROUTER_API_KEY .*recovery\.provider_auth_env_allowlist/);
  });
  it("review F1: a provider the table does not name is never refused (ollama and other custom providers, google-vertex, amazon-bedrock, a newer provider, prototype names)", () => {
    for (const provider of ["ollama", "google-vertex", "amazon-bedrock", "some-newer-provider", "constructor", "__proto__", "toString"]) {
      expect(piCredentialLaunchGate({ ...none, provider }, "none", "/a", {}), provider).toEqual({ action: "proceed" });
    }
  });
  it("review F1: a key Pi reads for the provider, present in the child environment (an env_passthrough name), is not refused and the note names it", () => {
    const g = piCredentialLaunchGate({ kind: "none", provider: "anthropic", envVar: undefined }, "none", "/a", { ANTHROPIC_API_KEY: "dummy" });
    expect(g.action).toBe("exempt");
    expect((g as { message: string }).message).toMatch(/ANTHROPIC_API_KEY is present in the seat's environment .*env_passthrough/);
    for (const name of ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN"]) {
      expect(piCredentialLaunchGate({ kind: "none", provider: "anthropic", envVar: undefined }, "none", "/a", { [name]: "dummy" }).action, name).toBe("exempt");
    }
  });
  it("review F1: the same anthropic seat with no such variable (or a blank one, or a variable for another provider) is still refused, and the message offers env_passthrough", () => {
    for (const env of [{}, { ANTHROPIC_API_KEY: "  " }, { ANTHROPIC_API_KEY: "" }, { OPENAI_API_KEY: "dummy" }]) {
      const g = piCredentialLaunchGate({ kind: "none", provider: "anthropic", envVar: undefined }, "none", "/a", env);
      expect(g.action, JSON.stringify(env)).toBe("refuse");
      expect((g as { message: string }).message).toMatch(/pass ANTHROPIC_AUTH_TOKEN or ANTHROPIC_OAUTH_TOKEN or ANTHROPIC_API_KEY through the member's env_passthrough/);
    }
  });
  it("review F1: openai-codex reads no environment: a stub with no passthrough is refused, and no variable rescues it", () => {
    expect(PI_FULLY_DEFINED_CREDENTIAL_ENV["openai-codex"]).toEqual([]);
    for (const env of [{}, { OPENAI_API_KEY: "dummy", OPENAI_CODEX_OAUTH_TOKEN: "dummy" }]) {
      const g = piCredentialLaunchGate(none, "none", "/a", env);
      expect(g.action).toBe("refuse");
      expect((g as { message: string }).message).not.toMatch(/env_passthrough/);
    }
  });
  it("review F1 census: the table agrees with OpenRig's own forwarded keys, and leaves out the ambient-credential providers", () => {
    for (const [provider, name] of Object.entries(PI_PROVIDER_ENV_VARS)) expect(PI_FULLY_DEFINED_CREDENTIAL_ENV[provider], provider).toContain(name);
    expect(Object.keys(PI_FULLY_DEFINED_CREDENTIAL_ENV)).not.toContain("google-vertex");
    expect(Object.keys(PI_FULLY_DEFINED_CREDENTIAL_ENV)).not.toContain("amazon-bedrock");
    expect(Object.keys(PI_FULLY_DEFINED_CREDENTIAL_ENV).length, "positive control: the table is the measured population").toBeGreaterThanOrEqual(40);
  });
  it.each([["present", /a Pi extension is configured/], ["unknown", /could not be read/]] as const)("none with extensions %s is exempt and says so", (ext, re) => {
    const g = piCredentialLaunchGate(none, ext, "/a");
    expect(g.action).toBe("exempt");
    expect((g as { message: string }).message).toMatch(re);
  });
  it.each([
    [{ kind: "unknown" as const }],
    [{ kind: "stored-sign-in" as const, provider: "p" }],
    [{ kind: "stored-key" as const, provider: "p" }],
    [{ kind: "models-key" as const, provider: "p" }],
    [{ kind: "managed-env" as const, provider: "p", envVar: "K" }],
  ])("%j proceeds (unknown keeps the advisory notice)", (source) => {
    expect(piCredentialLaunchGate(source, "none", "/a")).toEqual({ action: "proceed" });
  });

  it("measured classification: the {} stub is none, a dangling-link ENOENT is none, a malformed oauth entry is unknown, a valid one is stored-sign-in", () => {
    const at = (files: Record<string, string>, model = "openai-codex/x") => piCredentialSource({
      model, agentDir: "/a", env: {}, readFile: (f) => { const n = f.split("/").pop()!; if (n in files) return files[n]!; throw Object.assign(new Error("x"), { code: "ENOENT" }); },
    }).kind;
    expect(at({ "auth.json": "{}" })).toBe("none");
    expect(at({})).toBe("none");
    expect(at({ "auth.json": JSON.stringify(OAUTH) })).toBe("stored-sign-in");
    expect(at({ "auth.json": JSON.stringify({ "openai-codex": { type: "oauth", access: "a", refresh: "r" } }) })).toBe("unknown");
    expect(at({ "auth.json": "{" })).toBe("unknown");
    expect(at({ "auth.json": "{}" }, "no-slash")).toBe("unknown");
  });
});

describe("the runner command and arguments", () => {
  const opts: PiRunnerLaunchOpts = { runnerEntryPath: "/r.js", sessionName: "verify-qa@ez", stateRoot: "/s", cwd: "/w", trust: "approve", launchId: "l-1" };
  const argv = ["--session-name", "s", "--state-root", "/s", "--cwd", "/w", "--launch-id", "l", "--approve"];

  it("--operator-login-dir carries the folder, --link-operator-models the declaration; neither without; none for OMP", () => {
    expect(buildPiRunnerCommand({ ...opts, operatorLoginDir: "/home/me/.pi/agent", linkOperatorModels: true })).toContain("--operator-login-dir '/home/me/.pi/agent' --link-operator-models");
    expect(buildPiRunnerCommand(opts)).not.toMatch(/--operator-login-dir|--link-operator-models/);
    expect(buildPiRunnerCommand({ ...opts, operatorLoginDir: "  " })).not.toContain("--operator-login-dir");
    expect(buildPiRunnerCommand({ ...opts, runtime: "omp", operatorLoginDir: "/x", linkOperatorModels: true })).not.toMatch(/--operator-login-dir|--link-operator-models/);
  });

  it("the runner parses both and refuses a relative dir, `..`, OMP, and the models link beside model overrides", () => {
    expect(parseRunnerArgs([...argv, "--operator-login-dir", "/o", "--link-operator-models"])).toMatchObject({ operatorLoginDir: "/o", linkOperatorModels: true });
    expect(() => parseRunnerArgs([...argv, "--operator-login-dir", "o"])).toThrow(/absolute folder path/);
    expect(() => parseRunnerArgs([...argv, "--operator-login-dir", "/o/../p"])).toThrow(/absolute folder path/);
    expect(() => parseRunnerArgs(["--session-name", "s", "--state-root", "/s", "--cwd", "/w", "--launch-id", "l", "--runtime", "omp", "--approval-mode", "yolo", "--operator-login-dir", "/o"])).toThrow(/Pi seats only/);
    expect(() => parseRunnerArgs([...argv, "--link-operator-models", "--model-overrides", JSON.stringify({ p: { m: { contextWindow: 1 } } })])).toThrow(/cannot be combined/);
  });
});

describe("main(): the refusals end the launch with exit 78 and the exit recorded", () => {
  const baseArgs = (launch: string, ...more: string[]) => ["--session-name", "verify-qa@t", "--state-root", state, "--cwd", dir, "--launch-id", launch, "--approve", "--model", "openai-codex/gpt-6-luna:medium", ...more];
  async function run(args: string[]) {
    const errors: string[] = []; const logs: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a) => { errors.push(a.join(" ")); });
    vi.spyOn(console, "log").mockImplementation((...a) => { logs.push(a.join(" ")); });
    try { await main(args); return { code: process.exitCode, errors: errors.join("\n"), logs: logs.join("\n") }; }
    finally { process.exitCode = undefined; vi.restoreAllMocks(); }
  }
  const recorded = () => (JSON.parse(fs.readFileSync(nodePath.join(seat, "runner-state.json"), "utf8")) as { ready: boolean; exited?: { code: number } });

  it("no credential for the provider (the {} stub, no host setting): refused before Pi starts, one line naming provider and fix", async () => {
    fs.writeFileSync(seatAuth(), "{}");
    const r = await run(baseArgs("L1"));
    expect(r.code).toBe(78);
    expect(r.errors).toMatch(/launch: No Pi credential for provider openai-codex .*pi\.operator_login_dir/);
    expect(recorded().exited?.code).toBe(78);
    expect(r.logs).not.toMatch(/starting pi --mode rpc/);
  });

  it("the operator's auth.json is missing: refused, nothing linked", async () => {
    const r = await run(baseArgs("L2", "--operator-login-dir", operator));
    expect(r.code).toBe(78);
    expect(r.errors).toMatch(/launch: operator login: the operator's auth\.json/);
    expect(fs.existsSync(seatAuth())).toBe(false);
  });

  it("the models link without the host setting is refused", async () => {
    const r = await run(baseArgs("L3", "--link-operator-models"));
    expect(r.code).toBe(78);
    expect(r.errors).toMatch(/launch: operator login: this member declares pi\.link_operator_models/);
  });

  it("a seat with a configured extension and no credential is exempt: no refusal, and the log line says why", async () => {
    // The launch continues past the gate; a PATH with no pi makes it stop at spawn, which is all this row needs.
    fs.mkdirSync(nodePath.join(agentDir, "extensions"));
    fs.writeFileSync(nodePath.join(agentDir, "extensions", "x.js"), "");
    const savedPath = process.env.PATH; process.env.PATH = nodePath.dirname(process.execPath);
    try {
      const r = await run(baseArgs("L4"));
      expect(r.errors).not.toMatch(/No Pi credential/);
      expect(r.logs).toMatch(/a Pi extension is configured and may supply the credential/);
    } finally { process.env.PATH = savedPath; }
  });

  it("review F1: an anthropic seat whose key arrives through env_passthrough is NOT refused, and the log says the key is present", async () => {
    const saved = { PATH: process.env.PATH, K: process.env.ANTHROPIC_API_KEY };
    process.env.PATH = nodePath.dirname(process.execPath); process.env.ANTHROPIC_API_KEY = "dummy-not-a-key";
    try {
      const r = await run(["--session-name", "verify-qa@t", "--state-root", state, "--cwd", dir, "--launch-id", "L6", "--approve", "--model", "anthropic/claude-x", "--env-pass", "ANTHROPIC_API_KEY"]);
      expect(r.errors).not.toMatch(/No Pi credential/);
      expect(r.logs).toMatch(/ANTHROPIC_API_KEY is present in the seat's environment/);
      expect(r.logs + r.errors).not.toContain("dummy-not-a-key");
    } finally { process.env.PATH = saved.PATH; if (saved.K === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved.K; }
  });

  it("review F1: the same anthropic seat WITHOUT the passthrough (the variable is in the runner's environment but not named) is refused", async () => {
    const saved = { PATH: process.env.PATH, K: process.env.ANTHROPIC_API_KEY };
    process.env.PATH = nodePath.dirname(process.execPath); process.env.ANTHROPIC_API_KEY = "dummy-not-a-key";
    try {
      const r = await run(["--session-name", "verify-qa@t", "--state-root", state, "--cwd", dir, "--launch-id", "L7", "--approve", "--model", "anthropic/claude-x"]);
      expect(r.code).toBe(78);
      expect(r.errors).toMatch(/No Pi credential for provider anthropic/);
    } finally { process.env.PATH = saved.PATH; if (saved.K === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved.K; }
  });

  it("review F1: a provider the table does not name (ollama, no models.json) gets the notice only: launch continues", async () => {
    fs.writeFileSync(seatAuth(), "{}");
    const savedPath = process.env.PATH; process.env.PATH = nodePath.dirname(process.execPath);
    try {
      const r = await run(["--session-name", "verify-qa@t", "--state-root", state, "--cwd", dir, "--launch-id", "L8", "--approve", "--model", "ollama/kimi-k3.1-pro:cloud:high"]);
      expect(r.errors).not.toMatch(/No Pi credential/);
      expect(r.logs).toMatch(/No stored sign-in or provider key was found for Pi provider ollama/);
    } finally { process.env.PATH = savedPath; }
  });

  it("control: an unknown credential state (a malformed oauth entry) is NOT refused; the advisory notice is logged", async () => {
    fs.writeFileSync(seatAuth(), JSON.stringify({ "openai-codex": { type: "oauth", access: "a", refresh: "r" } }));
    const savedPath = process.env.PATH; process.env.PATH = nodePath.dirname(process.execPath);
    try {
      const r = await run(baseArgs("L5"));
      expect(r.errors).not.toMatch(/No Pi credential/);
      expect(r.logs).toMatch(/Pi credential status unknown; launch continues/);
    } finally { process.env.PATH = savedPath; }
  });
});

describe("the real runner process with a fake pi (dummy login, nothing real)", () => {
  async function runReal(launch: string, extra: string[], files: (bin: string) => void) {
    const bin = nodePath.join(dir, "bin"); fs.mkdirSync(bin);
    const argvFile = nodePath.join(dir, "argv.json");
    fs.writeFileSync(nodePath.join(bin, "pi"), `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(argvFile)}, "started");\nsetTimeout(() => process.exit(0), 300);\n`, { mode: 0o700 });
    files(bin);
    const env = { PATH: `${bin}${nodePath.delimiter}${nodePath.dirname(process.execPath)}${nodePath.delimiter}/usr/bin${nodePath.delimiter}/bin`, OPENRIG_HOME: nodePath.join(dir, "home"), HOME: dir };
    const out: string[] = [];
    const child = spawn(process.execPath, ["--import", "tsx", RUNNER, "--session-name", "verify-qa@t", "--state-root", state, "--cwd", dir, "--launch-id", launch, "--approve", "--model", "openai-codex/gpt-6-luna:medium", ...extra], { cwd: PACKAGE_DIR, env });
    child.stdout.on("data", (d) => out.push(String(d))); child.stderr.on("data", (d) => out.push(String(d)));
    const code = await new Promise<number | null>((resolve) => { child.on("exit", (c) => resolve(c)); setTimeout(() => { child.kill("SIGKILL"); resolve(null); }, 100_000); });
    return { code, out: out.join(""), started: fs.existsSync(argvFile) };
  }

  it("host setting + stub: the stub becomes a link to the operator's login, Pi starts, the log says the login is shared", async () => {
    const r = await runReal("R1", ["--operator-login-dir", operator], () => { putOperator(); fs.writeFileSync(seatAuth(), "{}"); });
    expect(r.out).toMatch(/Pi auth\.json was the empty 2-byte stub .*shared with the operator's own Pi/);
    expect(r.out).toMatch(/Pi stored sign-in present for openai-codex/);
    expect(target(seatAuth())).toBe(opAuth());
    expect(r.started).toBe(true);
    expect(fs.readFileSync(opAuth(), "utf8")).toBe(OPERATOR_AUTH_TEXT);
  }, 130_000);

  it("no host setting and the stub: exit 78 and Pi is never spawned", async () => {
    const r = await runReal("R2", [], () => { fs.writeFileSync(seatAuth(), "{}"); });
    expect(r.code).toBe(78);
    expect(r.out).toMatch(/No Pi credential for provider openai-codex/);
    expect(r.started).toBe(false);
  }, 130_000);
});
