// workspaces-o9o.80: a private core's start or restart that hc refused only because its new core missed hc's 5 s start budget
// (exit 5, "core did not start within 5 s"; measured on a loaded host, see PrivateCore.serverUntilUp) is followed by
// `server start`, at most 3 times; every other failure throws, with hc's own message. Driven through a stand-in hc that plays
// a scripted sequence of exits and records each call, so no real core is involved.
import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
