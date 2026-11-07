// OF-270: a Pi seat's spec `model_overrides` are merged by the pane runner into the seat's own agent-dir models.json at
// every launch. These tests use real files in a private temp directory (never a live seat's agent dir, never auth.json)
// and no tmux, pi, daemon or hc. Pins restate the Pi file shape independently of the code under test.
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyPiModelOverrides, realPiModelOverridesFs, type PiModelOverridesFs } from "../src/adapters/pi-model-overrides.js";
import { main, parseRunnerArgs } from "../src/adapters/pi-runner.js";
import { buildPiRunnerCommand, piModelOverridesErrors, piSeatPaths, type PiRunnerLaunchOpts } from "../src/adapters/pi-runner-protocol.js";

const LUNA = { "openai-codex": { "gpt-6-luna": { contextWindow: 820000 } } };
let dir: string;
let agentDir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "of270-"));
  agentDir = nodePath.join(dir, "agent");
  fs.mkdirSync(agentDir);
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });
const models = () => nodePath.join(agentDir, "models.json");
const put = (text: string, mode = 0o600) => { fs.writeFileSync(models(), text, { mode }); fs.chmodSync(models(), mode); };
const read = () => JSON.parse(fs.readFileSync(models(), "utf8"));

describe("merge without clobbering", () => {
  it("creates models.json holding only the override when the seat has none (mode 600)", () => {
    const r = applyPiModelOverrides({ agentDir, overrides: LUNA });
    expect(r).toEqual({ ok: true, wrote: true, changes: ["providers.openai-codex.modelOverrides.gpt-6-luna.contextWindow unset -> 820000"] });
    expect(read()).toEqual({ providers: { "openai-codex": { modelOverrides: { "gpt-6-luna": { contextWindow: 820000 } } } } });
    expect(fs.statSync(models()).mode & 0o777).toBe(0o600);
  });

  it("keeps every other key at every level and changes only the spec's path, reporting the old and new value", () => {
    put(JSON.stringify({
      $schema: "x", extra: { keep: [1, 2] },
      providers: {
        ollama: { baseUrl: "http://h", models: [{ id: "m" }] },
        "openai-codex": { name: "n", modelOverrides: { "gpt-6-luna": { contextWindow: 128000, maxTokens: 9, name: "L" }, other: { contextWindow: 5 } } },
      },
    }));
    const r = applyPiModelOverrides({ agentDir, overrides: LUNA });
    expect(r).toEqual({ ok: true, wrote: true, changes: ["providers.openai-codex.modelOverrides.gpt-6-luna.contextWindow 128000 -> 820000"] });
    expect(read()).toEqual({
      $schema: "x", extra: { keep: [1, 2] },
      providers: {
        ollama: { baseUrl: "http://h", models: [{ id: "m" }] },
        "openai-codex": { name: "n", modelOverrides: { "gpt-6-luna": { contextWindow: 820000, maxTokens: 9, name: "L" }, other: { contextWindow: 5 } } },
      },
    });
  });

  it("adds a provider and a model beside existing ones", () => {
    put(JSON.stringify({ providers: { "openai-codex": { modelOverrides: { a: { contextWindow: 1 } } } } }));
    applyPiModelOverrides({ agentDir, overrides: { "openai-codex": { b: { contextWindow: 2 } }, zed: { c: { contextWindow: 3 } } } });
    expect(read()).toEqual({ providers: { "openai-codex": { modelOverrides: { a: { contextWindow: 1 }, b: { contextWindow: 2 } } }, zed: { modelOverrides: { c: { contextWindow: 3 } } } } });
  });

  it("is idempotent: a second launch with the same values reports no change and leaves the file byte-identical", () => {
    applyPiModelOverrides({ agentDir, overrides: LUNA });
    const before = fs.readFileSync(models());
    const mtime = fs.statSync(models()).mtimeMs;
    const r = applyPiModelOverrides({ agentDir, overrides: LUNA });
    expect(r).toEqual({ ok: true, wrote: false, changes: [] });
    expect(fs.readFileSync(models()).equals(before)).toBe(true);
    expect(fs.statSync(models()).mtimeMs).toBe(mtime);
  });
});

describe("with no spec override the file is left exactly as it is", () => {
  it("absent overrides: no create, no rewrite, odd content and a loose mode untouched", () => {
    expect(applyPiModelOverrides({ agentDir, overrides: undefined })).toEqual({ ok: true, wrote: false, changes: [] });
    expect(fs.existsSync(models())).toBe(false);
    const odd = '// a comment\n{ "providers": {}, }\n';
    put(odd, 0o644);
    applyPiModelOverrides({ agentDir, overrides: undefined });
    expect(fs.readFileSync(models(), "utf8")).toBe(odd);
    expect(fs.statSync(models()).mode & 0o777).toBe(0o644);
  });
});

describe("never write through a symlink", () => {
  it("refuses a symlinked models.json, names the file and its target, and writes nothing anywhere", () => {
    const real = nodePath.join(dir, "operator-models.json");
    const body = '{"providers":{"brick":{"apiKey":"SECRET-DO-NOT-ECHO"}}}';
    fs.writeFileSync(real, body, { mode: 0o600 });
    fs.symlinkSync(real, models());
    const r = applyPiModelOverrides({ agentDir, overrides: LUNA });
    expect(r.ok).toBe(false);
    const error = (r as { error: string }).error;
    expect(error).toContain(models());
    expect(error).toContain("symlink");
    expect(error).toContain(real);
    expect(error).not.toContain("SECRET-DO-NOT-ECHO");
    expect(fs.readFileSync(real, "utf8")).toBe(body);
    expect(fs.lstatSync(models()).isSymbolicLink()).toBe(true);
    expect(fs.readdirSync(agentDir).sort()).toEqual(["models.json"]);
  });

  it("refuses a dangling symlink too (nothing is created at the target)", () => {
    const missing = nodePath.join(dir, "nowhere.json");
    fs.symlinkSync(missing, models());
    expect(applyPiModelOverrides({ agentDir, overrides: LUNA }).ok).toBe(false);
    expect(fs.existsSync(missing)).toBe(false);
  });

  it("a symlink with no spec override is not an error (the launch is unchanged for build-arch)", () => {
    fs.symlinkSync(nodePath.join(dir, "x.json"), models());
    expect(applyPiModelOverrides({ agentDir, overrides: undefined })).toEqual({ ok: true, wrote: false, changes: [] });
  });
});

describe("a file the runner will not rewrite", () => {
  it.each([
    ["invalid JSON", "{ nope", /not valid JSON/],
    ["comments", '// hi\n{"providers":{}}', /comments/],
    ["trailing commas", '{"providers":{},}', /comments, a byte-order mark or trailing commas/],
    ["a non-object document", "[1]", /not a JSON object/],
    ["providers that is not an object", '{"providers":[1]}', /"providers" is not an object/],
    ["a provider that is not an object", '{"providers":{"openai-codex":7}}', /providers\.openai-codex is not an object/],
    ["modelOverrides that is not an object", '{"providers":{"openai-codex":{"modelOverrides":[]}}}', /modelOverrides is not an object/],
    ["a model entry that is not an object", '{"providers":{"openai-codex":{"modelOverrides":{"gpt-6-luna":3}}}}', /gpt-6-luna is not an object/],
  ])("refuses %s and leaves it byte-identical", (_n, text, message) => {
    put(text);
    const r = applyPiModelOverrides({ agentDir, overrides: LUNA });
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toMatch(message);
    expect(fs.readFileSync(models(), "utf8")).toBe(text);
  });

  it("refuses a directory in its place and an oversized file", () => {
    fs.mkdirSync(models());
    expect((applyPiModelOverrides({ agentDir, overrides: LUNA }) as { error: string }).error).toMatch(/not a regular file/);
    fs.rmdirSync(models());
    put(`{"x":"${"a".repeat(1024 * 1024)}"}`);
    expect((applyPiModelOverrides({ agentDir, overrides: LUNA }) as { error: string }).error).toMatch(/larger than/);
  });
});

describe("the write is atomic, 0600, and verified", () => {
  it("replaces a loose-mode file with a 0600 one (the mode is the file's, not the old one)", () => {
    put('{"providers":{}}', 0o644);
    applyPiModelOverrides({ agentDir, overrides: LUNA });
    expect(fs.statSync(models()).mode & 0o777).toBe(0o600);
  });

  it("writes a temp file in the SAME directory and renames it over models.json; no temp is left", () => {
    const calls: string[] = [];
    const spy: PiModelOverridesFs = {
      ...realPiModelOverridesFs,
      createExclusive: (p, d) => { calls.push(`create ${nodePath.dirname(p) === agentDir ? "same-dir" : "other-dir"} ${nodePath.basename(p)}`); realPiModelOverridesFs.createExclusive(p, d); },
      rename: (a, b) => { calls.push(`rename ${nodePath.dirname(a) === nodePath.dirname(b) ? "same-dir" : "cross-dir"} -> ${nodePath.basename(b)}`); realPiModelOverridesFs.rename(a, b); },
    };
    applyPiModelOverrides({ agentDir, overrides: LUNA, fsOps: spy, tempSuffix: () => "t1" });
    expect(calls).toEqual(["create same-dir .models.json.t1.tmp", "rename same-dir -> models.json"]);
    expect(fs.readdirSync(agentDir)).toEqual(["models.json"]);
  });

  it("a failure before the rename leaves the old file untouched and removes the temp", () => {
    const old = '{"providers":{"keep":{}}}';
    put(old);
    const failing: PiModelOverridesFs = { ...realPiModelOverridesFs, rename: () => { throw Object.assign(new Error("x"), { code: "EXDEV" }); } };
    const r = applyPiModelOverrides({ agentDir, overrides: LUNA, fsOps: failing, tempSuffix: () => "t2" });
    expect(r).toMatchObject({ ok: false });
    expect((r as { error: string }).error).toContain("the previous file is unchanged");
    expect(fs.readFileSync(models(), "utf8")).toBe(old);
    expect(fs.readdirSync(agentDir)).toEqual(["models.json"]);
  });

  it("a mode other than 600 read back after the write is a refusal", () => {
    const loose: PiModelOverridesFs = { ...realPiModelOverridesFs, rename: (a, b) => { fs.chmodSync(a, 0o644); realPiModelOverridesFs.rename(a, b); } };
    const r = applyPiModelOverrides({ agentDir, overrides: LUNA, fsOps: loose });
    expect((r as { error: string }).error).toMatch(/mode 644 after the write, not 600/);
  });

  it("never touches auth.json (an existing one is left byte-identical, and none is created)", () => {
    applyPiModelOverrides({ agentDir, overrides: LUNA });
    expect(fs.existsSync(nodePath.join(agentDir, "auth.json"))).toBe(false);
    fs.writeFileSync(nodePath.join(agentDir, "auth.json"), "A", { mode: 0o600 });
    applyPiModelOverrides({ agentDir, overrides: { "openai-codex": { "gpt-6-luna": { contextWindow: 900000 } } } });
    expect(fs.readFileSync(nodePath.join(agentDir, "auth.json"), "utf8")).toBe("A");
  });
});

describe("the validator (what `rig spec` accepts)", () => {
  it("accepts the verify-seat shape", () => { expect(piModelOverridesErrors(LUNA)).toEqual([]); });
  it.each([
    ["not a mapping", "x", /non-empty mapping/],
    ["empty", {}, /non-empty mapping/],
    ["a provider that is not a mapping", { p: 1 }, /p: must be a non-empty mapping/],
    ["a model that is not a mapping", { p: { m: 1 } }, /p\.m: must be a mapping/],
    ["an unknown key", { p: { m: { contextWindow: 1, maxTokens: 2 } } }, /unknown key "maxTokens"/],
    ["only an unknown key", { p: { m: { cost: {} } } }, /unknown key "cost"/],
    ["an empty entry", { p: { m: {} } }, /must be a mapping holding contextWindow/],
    ["a zero window", { p: { m: { contextWindow: 0 } } }, /positive integer/],
    ["a negative window", { p: { m: { contextWindow: -5 } } }, /positive integer/],
    ["a fractional window", { p: { m: { contextWindow: 1.5 } } }, /positive integer/],
    ["a string window", { p: { m: { contextWindow: "820000" } } }, /positive integer/],
    ["an absurd window", { p: { m: { contextWindow: 1e12 } } }, /at most/],
    ["NaN", { p: { m: { contextWindow: Number.NaN } } }, /positive integer/],
    ["a prototype key", JSON.parse('{"__proto__":{"m":{"contextWindow":1}}}'), /not allowed as a name/],
  ])("refuses %s", (_n, value, message) => { expect(piModelOverridesErrors(value).join("\n")).toMatch(message); });
});

describe("the runner command and arguments", () => {
  const opts: PiRunnerLaunchOpts = { runnerEntryPath: "/r.js", sessionName: "verify-qa@ez", stateRoot: "/s", cwd: "/w", trust: "approve", launchId: "l-1" };
  const argv = ["--session-name", "s", "--state-root", "/s", "--cwd", "/w", "--launch-id", "l", "--approve"];

  it("--model-overrides carries the canonical JSON; no flag without overrides; none for OMP", () => {
    expect(buildPiRunnerCommand({ ...opts, modelOverrides: LUNA })).toContain(`--model-overrides '{"openai-codex":{"gpt-6-luna":{"contextWindow":820000}}}'`);
    expect(buildPiRunnerCommand(opts)).not.toContain("--model-overrides");
    expect(buildPiRunnerCommand({ ...opts, runtime: "omp", modelOverrides: LUNA })).not.toContain("--model-overrides");
  });

  it("the runner parses the flag and refuses bad JSON, an unknown key and use with OMP", () => {
    expect(parseRunnerArgs([...argv, "--model-overrides", JSON.stringify(LUNA)]).modelOverrides).toEqual(LUNA);
    expect(() => parseRunnerArgs([...argv, "--model-overrides", "{"])).toThrow(/not JSON/);
    expect(() => parseRunnerArgs([...argv, "--model-overrides", '{"p":{"m":{"cost":1}}}'])).toThrow(/unknown key/);
    expect(() => parseRunnerArgs(["--session-name", "s", "--state-root", "/s", "--cwd", "/w", "--launch-id", "l", "--runtime", "omp", "--approval-mode", "yolo", "--model-overrides", JSON.stringify(LUNA)])).toThrow(/Pi seats only/);
  });
});

describe("the runner main(): a symlinked models.json ends the launch before pi starts", () => {
  afterEach(() => { process.exitCode = undefined; vi.restoreAllMocks(); });

  it("exits 78 with the reason on the pane, records the exit for this launch, and writes through nothing", async () => {
    const stateRoot = nodePath.join(dir, "state");
    const paths = piSeatPaths(stateRoot, "verify-qa@t");
    fs.mkdirSync(paths.agentDir, { recursive: true });
    const real = nodePath.join(dir, "operator-models.json");
    fs.writeFileSync(real, "{}", { mode: 0o600 });
    fs.symlinkSync(real, nodePath.join(paths.agentDir, "models.json"));
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a) => { errors.push(a.join(" ")); });
    await main(["--session-name", "verify-qa@t", "--state-root", stateRoot, "--cwd", dir, "--launch-id", "L9", "--approve", "--model-overrides", JSON.stringify(LUNA)]);
    expect(process.exitCode).toBe(78);
    expect(errors.join("\n")).toMatch(/\[pi-runner\] ERROR launch: model_overrides: .*symlink/);
    expect(JSON.parse(fs.readFileSync(paths.runnerStatePath, "utf8"))).toMatchObject({ ready: false, launchId: "L9", exited: { code: 78 } });
    expect(fs.readFileSync(real, "utf8")).toBe("{}");
  });
});
