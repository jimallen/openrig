import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { HcClient, resolveHcSocket } from "../src/adapters/hc-client.js";

const HC = spawnSync("sh", ["-c", "command -v hc"], { encoding: "utf8" }).stdout.trim();
const PANE_IO = resolve(__dirname, "../src/adapters/runner-pane-io.ts");
const DAEMON_DIR = resolve(__dirname, "..");

/** A private core only: its own HOME, session and XDG paths, so the host's core is never contacted. */
describe.skipIf(!HC)("the Pi and OMP runner's pane input under a private hc core", () => {
  const root = mkdtempSync(join(tmpdir(), "hcrq-"));
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, HOME: join(root, "h"), HC_SESSION: `q${process.pid}`,
    XDG_CONFIG_HOME: join(root, "c"), XDG_DATA_HOME: join(root, "d"), XDG_STATE_HOME: join(root, "s"), XDG_RUNTIME_DIR: join(root, "r"),
  };
  let client: HcClient;

  // The runner's real editor (runner-pane-io.ts createRunnerInput, the one wirePiRunnerInput calls), run by tsx on the
  // pty hc gives a terminal. It records each submitted block as one JSON line, so a message that was split in two shows
  // as two lines.
  const harness = join(root, "harness.ts");
  beforeAll(() => {
    for (const d of ["h", "c", "d", "s", "r"]) mkdirSync(join(root, d), { recursive: true, mode: 0o700 });
    writeFileSync(harness, [
      `import { appendFileSync, writeFileSync } from "node:fs";`,
      `import { createRunnerInput } from ${JSON.stringify(PANE_IO)};`,
      `const [out, ready] = process.argv.slice(2);`,
      `createRunnerInput(process.stdin, process.stdout, (block) => appendFileSync(out, JSON.stringify(block) + "\\n"), { interruptInsidePaste: "content" });`,
      `writeFileSync(ready, "");`,
      `setInterval(() => {}, 1000);`,
    ].join("\n"));
    execFileSync(HC, ["server", "start"], { env, stdio: "ignore" });
    client = new HcClient(resolveHcSocket(env, env.HOME));
  });

  afterAll(() => {
    spawnSync(HC, ["server", "stop"], { env, stdio: "ignore" });
    rmSync(root, { recursive: true, force: true });
  });

  function block(line: string): string {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== "string") throw new Error("the harness wrote a block that is not a string");
    return parsed;
  }

  async function runnerReading(name: string): Promise<{ out: string; submitted: () => string[] }> {
    const out = join(root, `${name}.out`);
    const ready = join(root, `${name}.ready`);
    await client.call("terminal.run", {
      argv: [process.execPath, "--import", "tsx", harness, out, ready], cwd: DAEMON_DIR, name,
      no_parent: true, no_notify: true, outlive_parent: true,
    });
    await expect.poll(() => existsSync(ready), { timeout: 15_000 }).toBe(true);
    const submitted = (): string[] => (existsSync(out) ? readFileSync(out, "utf8").split("\n").filter(Boolean).map(block) : []);
    return { out, submitted };
  }

  it("takes a multi-line message from `terminal.send` as ONE block, because the runner turns on mode 2004 and hc brackets it", async () => {
    const { submitted } = await runnerReading("multi");
    await client.call("terminal.send", { terminal: "multi", text: "first line\nsecond line\n\nfourth line" });
    await expect.poll(submitted, { timeout: 15_000 }).toEqual(["first line\nsecond line\n\nfourth line"]);
    // Give a wrong split time to show: a second, separate submit would arrive within the paste gap.
    await new Promise((done) => setTimeout(done, 1_000));
    expect(submitted()).toEqual(["first line\nsecond line\n\nfourth line"]);
  });

  it("takes a one-line message as one block", async () => {
    const { submitted } = await runnerReading("single");
    await client.call("terminal.send", { terminal: "single", text: "one line" });
    await expect.poll(submitted, { timeout: 15_000 }).toEqual(["one line"]);
  });
});
