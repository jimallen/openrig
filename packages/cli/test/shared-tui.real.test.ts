import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { attachSharedTui, resolveSharedTerminal } from "../src/shared-tui.js";

const HC = spawnSync("sh", ["-c", "command -v hc"], { encoding: "utf8" }).stdout.trim();

/**
 * A PRIVATE hc core only (own HOME, XDG paths and HC_SESSION under one temp root). The attach itself needs a tty and is
 * not run here: its argv is recorded by a stand-in `hc`, and its behaviour was measured by hand on a private core.
 */
describe.skipIf(!HC)("shared kernel terminal against a private hc core", () => {
  const root = mkdtempSync(join(tmpdir(), "stui-"));
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, HOME: join(root, "h"), HC_SESSION: `w6${process.pid}`,
    XDG_CONFIG_HOME: join(root, "c"), XDG_DATA_HOME: join(root, "d"), XDG_STATE_HOME: join(root, "s"), XDG_RUNTIME_DIR: join(root, "r"),
  };
  const saved = { ...process.env };
  let address = "";

  beforeAll(() => {
    for (const d of ["h", "c", "d", "s", "r", "bin"]) mkdirSync(join(root, d), { recursive: true, mode: 0o700 });
    expect(spawnSync(HC, ["server", "start"], { env }).status).toBe(0);
    // The code under test reads the core from process.env, as the real CLI does; point it at the private core only.
    for (const k of Object.keys(process.env)) if (/^(HC_|XDG_)/.test(k) || k === "HOME") delete process.env[k];
    Object.assign(process.env, env);
    const run = spawnSync(HC, ["run", "--bg", "--name", "kern", "--label", "openrig.seat=operator-human@kernel", "--json", "sh", "-c", "cat"], { env, encoding: "utf8" });
    expect(run.status).toBe(0);
    address = (JSON.parse(run.stdout.trim().split("\n").pop()!) as { address: string }).address;
    spawnSync(HC, ["run", "--bg", "--name", "other", "--label", "openrig.seat=someone@else", "sh", "-c", "cat"], { env });
  });

  afterAll(() => {
    spawnSync(HC, ["server", "stop"], { env, stdio: "ignore" });
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, saved);
    rmSync(root, { recursive: true, force: true });
  });

  it("finds the live terminal by the seat label, and only that one", async () => {
    expect(await resolveSharedTerminal("operator-human@kernel")).toBe(address);
    await expect(resolveSharedTerminal("nobody@nowhere")).rejects.toThrow("No live hc terminal carries");
  });

  it("spawns `hc attach -- <address>` on its own stdio, with the env unchanged, and returns hc's exit code", async () => {
    const out = join(root, "argv");
    const stub = join(root, "bin", "hc");
    writeFileSync(stub, `#!/bin/sh\nif [ "$1" = ls ]; then exec ${HC} "$@"; fi\nprintf '%s\\n' "$@" > ${out}\nenv | grep -c '^HC_SESSION=' >> ${out}\nenv | grep -c '^HC_TERMINAL_ID=t999$' >> ${out}\nexit 9\n`);
    chmodSync(stub, 0o700);
    process.env.HC_TERMINAL_ID = "t999"; // a person attaching from inside another hc terminal: hc must still see who they are
    expect(await attachSharedTui("operator-human@kernel", { hc: stub })).toBe(9);
    expect(existsSync(out)).toBe(true);
    expect(readFileSync(out, "utf8").trimEnd().split("\n")).toEqual(["attach", "--", address, "1", "1"]);
  });
});
