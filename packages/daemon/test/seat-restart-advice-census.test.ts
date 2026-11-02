import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { WEB_UI_OFF_MESSAGE } from "../src/server.js";

// A seat that is told to run `rig daemon stop` or `rig daemon restart` is told to do what the CLI now refuses (and what ended the
// host's terminals on 2026-11-02). The census is positional: every shipped source line of the three packages is read, so a string
// added later is judged too. `rig daemon start` is not here: a stopped daemon is started by `rig up` or by a person, and the CLI
// refuses it in a seat with a pointer to the operator. The one place that may name the restart is the status advice for a person
// outside a seat (packages/cli/src/commands/daemon.ts), which its own test (cli seat-daemon-guard.test.ts) pins to that branch.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ALLOWED = new Set(["cli/src/commands/daemon.ts"]);
const RESTART_ADVICE = /rig daemon (stop|restart)/;

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\./.test(name)) out.push(path);
  }
  return out;
}

describe("no shipped runtime string tells a seat to stop or restart the daemon", () => {
  const files = ["cli", "daemon", "tui"].flatMap((pkg) => sources(join(ROOT, pkg, "src")));
  it("reads the whole source of the three packages (positive control)", () => {
    expect(files.length).toBeGreaterThan(300);
    expect(files.map((f) => relative(ROOT, f))).toContain("cli/src/commands/daemon.ts");
  });
  it("names `rig daemon stop|restart` only in the allowed places", () => {
    const hits = files.filter((f) => RESTART_ADVICE.test(readFileSync(f, "utf8"))).map((f) => relative(ROOT, f)).filter((f) => !ALLOWED.has(f));
    expect(hits).toEqual([]);
  });
  it("the allowed place still names it (positive control for the pattern)", () => {
    expect(readFileSync(join(ROOT, "cli/src/commands/daemon.ts"), "utf8")).toMatch(RESTART_ADVICE);
  });
  it("the web UI's off message, served to anyone who asks, points to the operator", () => {
    expect(WEB_UI_OFF_MESSAGE).toContain("ask the operator to restart the daemon");
    expect(WEB_UI_OFF_MESSAGE).not.toMatch(RESTART_ADVICE);
  });
});
