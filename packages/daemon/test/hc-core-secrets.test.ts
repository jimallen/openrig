import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { startCoreWithCli } from "../src/adapters/hc-core-watch.js";

// A core's env is what every plain `hc run` on it inherits, with no launch wrapper between (security review N2). The names are
// restated, not imported, so a name dropped from the list fails here. The values are fake.
const OPERATOR_NAMES = ["OPENRIG_AUTH_BEARER_TOKEN", "OPENRIG_TERMINAL_BEARER_TOKEN", "SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"];
const dir = mkdtempSync(join(tmpdir(), "hc-core-secrets-"));
const out = join(dir, "env.txt");
const fakeHc = join(dir, "hc");
writeFileSync(fakeHc, `#!/bin/sh\necho "args=$*" > ${out}\nenv >> ${out}\n`);
chmodSync(fakeHc, 0o755);
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => vi.unstubAllEnvs());

const names = () => readFileSync(out, "utf8").split("\n").map((line) => line.split("=")[0]);

describe("startCoreWithCli", () => {
  it("starts a core without the operator secrets from an env it is given, and keeps the rest", async () => {
    const env = { PATH: process.env.PATH, KEEP_ME: "kept", ...Object.fromEntries(OPERATOR_NAMES.map((n) => [n, "fake"])) };
    await startCoreWithCli({ env, hcPath: fakeHc })();
    const seen = names();
    for (const name of OPERATOR_NAMES) expect(seen, name).not.toContain(name);
    expect(seen).toContain("KEEP_ME");  // positive control: the env given is the env used
    expect(readFileSync(out, "utf8")).toContain("args=server start");
  });
  it("does the same with the daemon's own env when given none", async () => {
    for (const name of OPERATOR_NAMES) vi.stubEnv(name, "fake");
    vi.stubEnv("KEEP_ME", "kept");
    await startCoreWithCli({ hcPath: fakeHc })();
    const seen = names();
    for (const name of OPERATOR_NAMES) expect(seen, name).not.toContain(name);
    expect(seen).toContain("KEEP_ME");
    expect(process.env.SLACK_BOT_TOKEN).toBe("fake");  // the daemon keeps its own
  });
  it("does not change the env object it was given", async () => {
    const env = { PATH: process.env.PATH, SLACK_APP_TOKEN: "fake" };
    await startCoreWithCli({ env, hcPath: fakeHc })();
    expect(env.SLACK_APP_TOKEN).toBe("fake");
  });
});
