import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLAUDE_SELF_UPDATE_OFF_ENV, CODEX_MINIMUM_VERSION, CODEX_OSC_7501_FIRST_RELEASE, REMOTE_CONTROL_ENV_NAMES,
  checkCodexVersion, codexArgvDisablesUpdateCheck, codexArgvUsesNoDaemon, codexCommandDisablesUpdateCheck,
  codexCommandUsesNoDaemon, codexHcLaunchRefusal, codexVersionProbe, compareSemVer, parseSemVer, probeCodexVersion,
  remoteControlEnvFindings, selfUpdateOffEnv, splitShellWords, type CodexVersionCheck,
} from "../src/adapters/hc-runtime-requirements.js";
import { seatEnvironment } from "../src/adapters/hc-host.js";
import { operationalLaunchArg } from "../src/adapters/kernel-authority.js";
import { buildCodexResumeCore } from "../src/domain/native-resume-probe.js";
import { claudeRemoteControlArgs } from "../src/adapters/claude-remote-control.js";
import { shellQuote } from "../src/adapters/shell-quote.js";

const semver = (text: string) => {
  const parsed = parseSemVer(text);
  if (!parsed) throw new Error(`not a version: ${text}`);
  return parsed;
};

describe("the Codex floor", () => {
  it("is the lowest version measured to report status, and not below the release that added the report", () => {
    // spike 4: 0.158 reported nothing, 0.166.0 did; the notes list OSC 7501 from 0.163.0.
    expect(CODEX_MINIMUM_VERSION).toBe("0.166.0");
    expect(compareSemVer(semver(CODEX_MINIMUM_VERSION), semver(CODEX_OSC_7501_FIRST_RELEASE))).toBeGreaterThanOrEqual(0);
  });
});

describe("parseSemVer and compareSemVer", () => {
  it("reads the first version in a tool's output, with its prerelease", () => {
    expect(parseSemVer("codex-cli 0.166.0\n")).toEqual({ major: 0, minor: 166, patch: 0, prerelease: null });
    expect(parseSemVer("codex 0.163.0-alpha.12.1 (abc)")).toEqual({ major: 0, minor: 163, patch: 0, prerelease: "alpha.12.1" });
    expect(parseSemVer("no version here")).toBeNull();
    expect(parseSemVer("0.166")).toBeNull();
  });

  it.each([
    ["0.9.0", "0.10.0", -1], ["0.166.0", "0.166.0", 0], ["0.166.1", "0.166.0", 1], ["1.0.0", "0.999.999", 1],
    ["0.163.0-alpha.1", "0.163.0", -1], ["0.163.0", "0.163.0-rc.1", 1], ["0.163.0-alpha.2", "0.163.0-alpha.10", -1],
    ["0.163.0-alpha", "0.163.0-alpha.1", -1], ["0.163.0-alpha.1", "0.163.0-beta.1", -1],
  ])("orders %s against %s as %i, in both directions", (a, b, expected) => {
    expect(Math.sign(compareSemVer(semver(a), semver(b)))).toBe(expected);
    expect(Math.sign(compareSemVer(semver(b), semver(a))) + 0).toBe(expected === 0 ? 0 : -expected);
  });
});

describe("checkCodexVersion", () => {
  it.each([
    ["codex-cli 0.158.0", "too_old"], ["codex-cli 0.165.9", "too_old"], ["codex-cli 0.166.0-alpha.1", "too_old"],
    ["codex-cli 0.166.0", "ok"], ["codex-cli 0.166.1", "ok"], ["codex-cli 0.170.0", "ok"], ["codex-cli 1.0.0", "ok"],
    ["", "unknown"], ["codex: command not found", "unknown"],
  ])("reads %j as %s", (output, kind) => {
    expect(checkCodexVersion(output).kind).toBe(kind);
  });

  it("names the version it read and the floor it compared against", () => {
    expect(checkCodexVersion("codex-cli 0.158.0")).toEqual({ kind: "too_old", version: "0.158.0", minimum: "0.166.0" });
    expect(checkCodexVersion("codex-cli 0.163.0", "0.163.0")).toEqual({ kind: "ok", version: "0.163.0" });
    expect(checkCodexVersion("codex-cli 0.163.0-alpha.1", "0.163.0")).toMatchObject({ kind: "too_old" });
  });

  it("refuses a floor that is not a version rather than passing every Codex", () => {
    expect(() => checkCodexVersion("codex-cli 0.166.0", "latest")).toThrow(/not a version/);
  });
});

describe("probeCodexVersion", () => {
  it("reads a failed or silent run as unknown, with one line of the cause", async () => {
    const failed = await probeCodexVersion(async () => { throw new Error("spawn codex ENOENT\nsecond line"); });
    expect(failed).toEqual({ kind: "unknown", detail: "codex --version failed: spawn codex ENOENT" });
    expect((await probeCodexVersion(async () => "")).kind).toBe("unknown");
  });
});

describe("codexVersionProbe against a stub codex", () => {
  let dir: string;
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "hcrr-")); });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  /** A directory holding a `codex` script with `body`, to use as the launch PATH. */
  const install = (name: string, body: string): string => {
    const where = join(dir, name);
    mkdirSync(where, { recursive: true });
    const file = join(where, "codex");
    writeFileSync(file, `#!/bin/sh\n${body}\n`);
    chmodSync(file, 0o755);
    return where;
  };

  it("runs `codex --version` on the launch PATH and classifies what it prints", async () => {
    const old = install("old", 'test "$1" = "--version" && echo "codex-cli 0.158.0"');
    const current = install("current", 'test "$1" = "--version" && echo "codex-cli 0.166.0"');
    await expect(codexVersionProbe(old)(dir)).resolves.toEqual({ kind: "too_old", version: "0.158.0", minimum: "0.166.0" });
    await expect(codexVersionProbe(current)(dir)).resolves.toEqual({ kind: "ok", version: "0.166.0" });
  });

  it("hands the seat's CODEX_HOME to the run", async () => {
    const where = install("home", 'if [ "$CODEX_HOME" = "/seat/home" ]; then echo "codex-cli 0.166.0"; else echo "codex-cli 0.1.0"; fi');
    await expect(codexVersionProbe(where, 10_000, "/seat/home")(dir)).resolves.toMatchObject({ kind: "ok" });
    await expect(codexVersionProbe(where)(dir)).resolves.toMatchObject({ kind: "too_old" });
  });

  it("reads a codex that is missing, fails or hangs as unknown, never as ok", async () => {
    const empty = install("empty", "exit 0");
    const failing = install("failing", "echo boom >&2; exit 3");
    const hanging = install("hanging", "exec /bin/sleep 30");
    await expect(codexVersionProbe(join(dir, "nowhere"))(dir)).resolves.toMatchObject({ kind: "unknown" });
    await expect(codexVersionProbe(empty)(dir)).resolves.toMatchObject({ kind: "unknown" });
    await expect(codexVersionProbe(failing)(dir)).resolves.toMatchObject({ kind: "unknown" });
    const started = Date.now();
    await expect(codexVersionProbe(hanging, 300)(dir)).resolves.toMatchObject({ kind: "unknown", detail: expect.stringContaining("timed out") });
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe("codexHcLaunchRefusal", () => {
  const ok: CodexVersionCheck = { kind: "ok", version: "0.166.0" };

  it("lets a current Codex that lists --no-daemon launch", () => {
    expect(codexHcLaunchRefusal(ok, { kind: "supported" })).toBeNull();
  });

  it("refuses a Codex below the floor, naming both versions", () => {
    const message = codexHcLaunchRefusal({ kind: "too_old", version: "0.158.0", minimum: "0.166.0" }, { kind: "supported" });
    expect(message).toContain("0.158.0");
    expect(message).toContain("0.166.0");
  });

  it("refuses a Codex it cannot read the version of", () => {
    expect(codexHcLaunchRefusal({ kind: "unknown", detail: "timed out after 10000 ms" }, { kind: "supported" })).toContain("timed out after 10000 ms");
  });

  it("refuses a current Codex without --no-daemon: it would run its commands outside hc", () => {
    const legacy = codexHcLaunchRefusal(ok, { kind: "legacy" });
    expect(legacy).toContain("--no-daemon");
    expect(legacy).toContain("outside hc");
    expect(codexHcLaunchRefusal(ok, { kind: "unknown", detail: "codex --help failed: x" })).toContain("codex --help failed: x");
  });

  it("checks the daemon flag whatever the floor says, so a lowered floor cannot reopen a seat outside hc", () => {
    expect(codexHcLaunchRefusal({ kind: "ok", version: "0.163.0" }, { kind: "legacy" })).not.toBeNull();
  });
});

describe("splitShellWords", () => {
  it("splits plain words, quotes and escapes as a shell does", () => {
    expect(splitShellWords(`codex  -c 'a b' "c d" e\\ f g"h"'i'`)).toEqual(["codex", "-c", "a b", "c d", "e f", "ghi"]);
    expect(splitShellWords(`  `)).toEqual([]);
    expect(splitShellWords(`'' x`)).toEqual(["", "x"]);
    expect(splitShellWords(String.raw`"a\"b\\c\d"`)).toEqual([String.raw`a"b\c\d`]);
  });

  it("gives back whatever shellQuote was given", () => {
    for (const text of ["plain", "it's", "a b", "$HOME `x`", "\"q\"", "--no-daemon", "x=y z", ""]) {
      expect(splitShellWords(`cmd ${shellQuote(text)}`)).toEqual(["cmd", text]);
    }
  });

  it("refuses an unterminated quote", () => {
    expect(() => splitShellWords("codex 'abc")).toThrow(/single quote/);
    expect(() => splitShellWords('codex "abc')).toThrow(/double quote/);
  });
});

describe("Codex's update check is off on every launch OpenRig builds", () => {
  const key = "check_for_update_on_startup";

  it("holds for the flags OpenRig's own launch builder adds to every Codex seat, fresh and resume", () => {
    const operational = operationalLaunchArg("codex", {});
    const resume = buildCodexResumeCore("019f-session", undefined, false, undefined, undefined, undefined, operational, true);
    expect(resume).toContain("--no-daemon");
    expect(codexCommandDisablesUpdateCheck(resume)).toBe(true);
    expect(codexCommandUsesNoDaemon(resume)).toBe(true);
    expect(codexCommandDisablesUpdateCheck(`codex --no-daemon${operational} -C '/work'`)).toBe(true);
  });

  it("is false for the same resume built without the operational flags, or without the daemon opt-out", () => {
    const bare = buildCodexResumeCore("019f-session", undefined, false, undefined, undefined, undefined, "", false);
    expect(codexCommandDisablesUpdateCheck(bare)).toBe(false);
    expect(codexCommandUsesNoDaemon(bare)).toBe(false);
  });

  it.each([
    [["codex", "-c", `${key}=false`], true],
    [["codex", "-c", ` ${key} = false `], true],
    [["codex", "--config", `${key}=false`], true],
    [["codex", `--config=${key}=false`], true],
    [["codex", "-c", `${key}=true`], false],
    [["codex", "-c", `${key}=maybe`], false],
    [["codex", "-c", `${key}=False`], false],
    [["codex", "-c", `${key}=`], false],
    [["codex", "-c", `${key}`], false],
    [["codex", "-c", `${key}=false`, "-c", `${key}=true`], false],
    [["codex", "-c", `${key}=true`, "-c", `${key}=false`], true],
    [["codex", "-c", "model=x"], false],
    [["codex", "-c", `${key}_x=false`], false],
    [["codex", `${key}=false`], false],
    [["codex", "-c"], false],
    [["codex", "--", "-c", `${key}=false`], false],
    [["codex"], false],
  ])("reads %j as %s", (argv, expected) => {
    expect(codexArgvDisablesUpdateCheck(argv)).toBe(expected);
  });

  it.each([
    [["codex", "--no-daemon", "resume", "id"], true],
    [["codex", "resume", "id", "--no-daemon"], true],
    [["codex", "-c", "x=--no-daemon", "resume", "id"], false],
    [["codex", "--", "--no-daemon"], false],
    [["codex", "resume", "id"], false],
  ])("reads %j as %s for --no-daemon", (argv, expected) => {
    expect(codexArgvUsesNoDaemon(argv)).toBe(expected);
  });

  it("reads a line it cannot split as neither", () => {
    expect(codexCommandDisablesUpdateCheck(`codex -c '${key}=false`)).toBe(false);
    expect(codexCommandUsesNoDaemon("codex --no-daemon 'x")).toBe(false);
  });
});

describe("Claude's self-update is off in a seat's env", () => {
  it("adds DISABLE_UPDATES for Claude and nothing for the others", () => {
    expect(selfUpdateOffEnv("claude-code")).toEqual({ DISABLE_UPDATES: "1" });
    for (const runtime of ["codex", "pi", "omp", "pda", "terminal", ""]) expect(selfUpdateOffEnv(runtime)).toEqual({});
  });

  it("hands out a copy, so a seat's env cannot rewrite the constant", () => {
    const env = selfUpdateOffEnv("claude-code");
    env.DISABLE_UPDATES = "0";
    expect(CLAUDE_SELF_UPDATE_OFF_ENV).toEqual({ DISABLE_UPDATES: "1" });
    expect(selfUpdateOffEnv("claude-code")).toEqual({ DISABLE_UPDATES: "1" });
  });

  it("never switches Remote Control off: it names no variable that Remote Control needs unset", () => {
    for (const name of Object.keys(selfUpdateOffEnv("claude-code"))) expect(REMOTE_CONTROL_ENV_NAMES).not.toContain(name);
  });

  it("passes seatEnvironment's name check and reaches the env hc is given", () => {
    const seat = seatEnvironment({ ...selfUpdateOffEnv("claude-code"), OTHER: "x" }, { PATH: "/bin" });
    expect(seat.env.DISABLE_UPDATES).toBe("1");
    expect(seat.env.OTHER).toBe("x");
  });
});

describe("what could switch Remote Control off in a seat's env", () => {
  it("names every variable the Remote Control page lists, once", () => {
    expect([...REMOTE_CONTROL_ENV_NAMES].sort()).toEqual(
      ["ANTHROPIC_BASE_URL", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "DISABLE_GROWTHBOOK", "DISABLE_TELEMETRY", "DO_NOT_TRACK"],
    );
  });

  it("finds nothing in an env without them, or with them empty or unset", () => {
    expect(remoteControlEnvFindings({ PATH: "/bin" })).toEqual({ blocking: [], conditional: [] });
    expect(remoteControlEnvFindings({ DISABLE_GROWTHBOOK: "", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: undefined })).toEqual({ blocking: [], conditional: [] });
  });

  it("separates names that always block from names that block only under a Trusted Devices policy", () => {
    expect(remoteControlEnvFindings({ CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_GROWTHBOOK: "true", DISABLE_TELEMETRY: "1", DO_NOT_TRACK: "1" }))
      .toEqual({ blocking: ["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "DISABLE_GROWTHBOOK"], conditional: ["DISABLE_TELEMETRY", "DO_NOT_TRACK"] });
    expect(remoteControlEnvFindings({ DISABLE_TELEMETRY: "1" })).toEqual({ blocking: [], conditional: ["DISABLE_TELEMETRY"] });
  });

  it("blocks on an endpoint other than api.anthropic.com only", () => {
    expect(remoteControlEnvFindings({ ANTHROPIC_BASE_URL: "https://gateway.example.com" }).blocking).toEqual(["ANTHROPIC_BASE_URL"]);
    expect(remoteControlEnvFindings({ ANTHROPIC_BASE_URL: "not a url" }).blocking).toEqual(["ANTHROPIC_BASE_URL"]);
    expect(remoteControlEnvFindings({ ANTHROPIC_BASE_URL: "https://api.anthropic.com/v1" }).blocking).toEqual([]);
    expect(remoteControlEnvFindings({ ANTHROPIC_BASE_URL: "https://api.anthropic.com.evil.test" }).blocking).toEqual(["ANTHROPIC_BASE_URL"]);
  });

  it("reports names, never values", () => {
    expect(JSON.stringify(remoteControlEnvFindings({ ANTHROPIC_BASE_URL: "https://secret-host.example", DISABLE_GROWTHBOOK: "1" }))).not.toContain("secret-host");
  });

  it("leaves the Remote Control argv alone: it is one argument built from the canonical seat name, not the hc name", () => {
    // The launch builders take the canonical name (`cos@rig`), which `hcTerminalName` replaces in hc; the flag must
    // keep it, because it is the session title on claude.ai.
    expect(claudeRemoteControlArgs(true, "cos@rig")).toEqual(["--remote-control=cos@rig"]);
  });
});
