// workspaces-o9o.80: a private core's start or restart that hc refused only because its new core missed hc's 5 s start budget
// (exit 5, "core did not start within 5 s"; measured on a loaded host, see PrivateCore.serverUntilUp) is followed by
// `server start`, at most 3 times; every other failure throws, with hc's own message. Driven through a stand-in hc that plays
// a scripted sequence of exits and records each call, so no real core is involved.
import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { PrivateCore } from "./hc-private-core.js";

const BUDGET = '{"error":{"hint":"check the core log in the state directory","kind":"unavailable","message":"core did not start within 5 s"}}';
const roots: string[] = [];
const cores: PrivateCore[] = [];

/** A stand-in hc: each call takes the next "<exit> <stderr>" line of the plan and appends its arguments to the call log. */
function standIn(plan: string[]): { hc: string; calls: () => string[]; extraEnv: NodeJS.ProcessEnv } {
  const dir = mkdtempSync(join(tmpdir(), "hc-budget-"));
  roots.push(dir);
  const planFile = join(dir, "plan");
  const log = join(dir, "calls");
  writeFileSync(planFile, plan.map((line) => `${line}\n`).join(""));
  writeFileSync(log, "");
  const hc = join(dir, "hc");
  writeFileSync(hc, [
    "#!/bin/bash",
    `echo "$*" >> "$FAKE_HC_LOG"`,
    `line=$(head -n 1 "$FAKE_HC_PLAN"); tail -n +2 "$FAKE_HC_PLAN" > "$FAKE_HC_PLAN.next"; mv "$FAKE_HC_PLAN.next" "$FAKE_HC_PLAN"`,
    `code=\${line%% *}; msg=\${line#* }; [ "$msg" = "$line" ] && msg=""`,
    `[ -n "$msg" ] && echo "$msg" >&2`,
    `exit "\${code:-0}"`,
  ].join("\n"));
  chmodSync(hc, 0o755);
  return { hc, calls: () => readFileSync(log, "utf8").split("\n").filter(Boolean), extraEnv: { FAKE_HC_PLAN: planFile, FAKE_HC_LOG: log } };
}

function coreWith(plan: string[]) {
  const fake = standIn(plan);
  const core = new PrivateCore("bdg", fake.extraEnv, fake.hc);
  cores.push(core);
  return { core, calls: fake.calls };
}

afterEach(() => {
  for (const core of cores.splice(0)) rmSync(core.root, { recursive: true, force: true });
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("PrivateCore: hc's 5 s start budget missed under load", () => {
  it("a restart refused for the start budget is followed by a start, and the restart succeeds", () => {
    const { core, calls } = coreWith([`5 ${BUDGET}`, "0"]);
    core.restart();
    expect(calls()).toEqual(["server restart", "server start"]);
  });

  it("a start refused for the start budget is started again", () => {
    const { core, calls } = coreWith([`5 ${BUDGET}`, `5 ${BUDGET}`, "0"]);
    core.start();
    expect(calls()).toEqual(["server start", "server start", "server start"]);
  });

  it("a budget missed on every try stops after 3 more starts and throws hc's message", () => {
    const { core, calls } = coreWith([`5 ${BUDGET}`, `5 ${BUDGET}`, `5 ${BUDGET}`, `5 ${BUDGET}`, "0"]);
    expect(() => core.restart()).toThrow(/hc server start failed \(exit 5, attempt 4\): .*core did not start within 5 s/);
    expect(calls()).toEqual(["server restart", "server start", "server start", "server start"]);
  });

  it("any other failure throws at once with hc's message, and nothing is retried", () => {
    const { core, calls } = coreWith(['2 {"error":{"kind":"usage","message":"the socket path for session x is too long here"}}']);
    expect(() => core.restart()).toThrow(/hc server restart failed \(exit 2, attempt 1\): .*too long here/);
    expect(calls()).toEqual(["server restart"]);
  });

  it("exit 5 for another reason is not the start budget, and is not retried", () => {
    const { core, calls } = coreWith(['5 {"error":{"kind":"unavailable","message":"no core is running"}}']);
    expect(() => core.restart()).toThrow(/exit 5, attempt 1\): .*no core is running/);
    expect(calls()).toEqual(["server restart"]);
  });

  it("control: a restart that succeeds is one call", () => {
    const { core, calls } = coreWith(["0"]);
    core.restart();
    expect(calls()).toEqual(["server restart"]);
  });
});

// workspaces-o9o.80 (CoS): the files that started or restarted their private core with a bare spawn now go through the harness, so a
// start budget missed under a release suite's load cannot take their core either. A text scan of each file: no bare spawn of the
// server's start or restart verb of its own, and the harness call that replaced it. Then one census over every test tree.
describe("private-core starts and restarts go through hcServerUntilUp", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const source = (file: string) => readFileSync(join(here, file), "utf8");
  const bareServerSpawn = /\[\s*"server",\s*"(?:start|restart)"\s*\]/;

  it.each([
    ["hc-viewer.real.test.ts", /\bcore\.restart\(\)/],
    ["message-pump-census.real.test.ts", /const restartCore = \(\) => core\.restart\(\);/],
    ["hc-input.real.test.ts", /hcServerUntilUp\(HC, env, "start"\)[\s\S]*hcServerUntilUp\(HC, env, "restart"\)/],
    ["helpers/hc-private-core.ts", /hcServerUntilUp\(HC, this\.env, "start"\)[\s\S]*hcServerUntilUp\(HC, this\.env, "restart"\)/],
  ])("%s spawns no hc server start or restart of its own, and calls the harness", (file, harnessCall) => {
    const text = source(file);
    expect(text).not.toMatch(bareServerSpawn);
    expect(text).toMatch(harnessCall);
  });

  it("control: the scan sees a bare spawn where one is (the harness itself spawns `server` through its argument list)", () => {
    expect(`execFileSync(HC, ["server", ${'"restart"'}], { env })`).toMatch(bareServerSpawn);
    expect(source("helpers/hc-scratch.ts")).toMatch(/const args = \["server", attempt === 1 \? verb : "start"\];/);
  });
});

// workspaces-o9o.80 (CoS): the whole tree, not a list of known files. Every test file in every package's test folder and in the
// repository's own test folder that spawns the hc server's start or restart verb itself is one of these, each for a reason; every
// other file goes through hcServerUntilUp (helpers/hc-scratch.ts). A file added with a bare spawn fails here, and so does an entry
// whose file no longer has one.
const BARE_SPAWN_ALLOWED: Record<string, string> = {
  "packages/daemon/test/hc-version-swap.real.test.ts": "runs another release's binary on purpose; a failed swap is the assertion",
  "packages/daemon/test/hc-launch-refusal.real.test.ts": "runs the restart an operator runs and asserts its exit status itself",
  "packages/daemon/test/hc-scratch.test.ts": "asserts hc's own refusal of a too-long socket path (exit 2), which a retry would hide",
};

describe("census: no test starts or restarts an hc core with a bare spawn outside the allowlist", () => {
  it("every match in packages/*/test and test/ is allowlisted, and every allowlisted file still matches", () => {
    const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
    const bareServerSpawn = /\[\s*"server",\s*"(?:start|restart)"\s*\]/;
    const roots = [join(repo, "test"), ...readdirSync(join(repo, "packages")).map((pkg) => join(repo, "packages", pkg, "test"))];
    const files: string[] = [];
    const walk = (dir: string): void => {
      if (!existsSync(dir)) return;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name === "dist") continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(?:ts|tsx|mts|js|mjs)$/.test(entry.name)) files.push(full);
      }
    };
    for (const root of roots) walk(root);
    expect(files.length, "the population the census ran over is the real tree").toBeGreaterThan(1000);
    const matched = files.filter((f) => bareServerSpawn.test(readFileSync(f, "utf8"))).map((f) => relative(repo, f)).sort();
    expect(matched).toEqual(Object.keys(BARE_SPAWN_ALLOWED).sort());
  });
});
