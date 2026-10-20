import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { prepareHermeticEnv, type HermeticScaffold } from "./helpers/hermetic-env.js";

// Host-independence pins for the test harness (setup file + scaffold). Each fact below is
// a host property that made daemon tests fail on a Linux box (Ubuntu, sudo-group user,
// zsh login shell, umask 002) and pass on a Mac, for environmental reasons only.
// The "bash prints nothing but the command output" row is a real discriminator only on a
// host that prints the sudo hint (Ubuntu) and trivially true elsewhere; the file-level rows
// (.hushlogin exists, SHELL/umask values) discriminate on every host.
const scaffolds: HermeticScaffold[] = [];
afterEach(() => { for (const s of scaffolds.splice(0)) s.cleanup(); });
const make = (baseEnv: Record<string, string | undefined>) => {
  const s = prepareHermeticEnv({ baseEnv }); scaffolds.push(s); return s;
};
const bashOnly = it.skipIf(!existsSync("/bin/bash"));

describe("test setup pins process basics", () => {
  bashOnly("SHELL is a shell with no first-run wizard", () => {
    expect(process.env.SHELL).toBe("/bin/bash");
  });
  it("umask is 022, whatever the account default", () => {
    expect(process.umask()).toBe(0o022);
  });
  bashOnly("the fixture user HOME is quiet for interactive bash (no sudo hint on stdout)", () => {
    expect(existsSync(join(process.env.HOME!, ".hushlogin"))).toBe(true);
    const out = execFileSync("/bin/bash", ["--noprofile", "--rcfile", "/dev/null", "-ic", "echo only-this"], {
      env: { HOME: process.env.HOME, PATH: "/usr/bin:/bin" }, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000,
    });
    expect(out).toBe("only-this\n");
  });
});

describe("prepareHermeticEnv pins the child shell", () => {
  it("overrides an inherited login shell (zsh) with bash", () => {
    const s = make({ HOME: "/x", PATH: process.env.PATH, TERM: "xterm", SHELL: "/usr/bin/zsh" });
    expect(s.env.SHELL).toBe("/bin/bash");
  });
  it("sets SHELL even when the base env has none", () => {
    expect(make({ HOME: "/x", PATH: process.env.PATH }).env.SHELL).toBe("/bin/bash");
  });
  it("silences the sudo hint in the scratch HOME that seat panes use", () => {
    const s = make({ HOME: "/x", PATH: process.env.PATH });
    expect(existsSync(join(s.home, ".hushlogin"))).toBe(true);
  });
});
