// hc cutover W37: the deployed wiring of `rig terminal open`. createDaemon builds the TerminalService whose `herdr` provider the
// route resolves; production consequence of the old wiring (HerdrAdapter on the old multiplexer's socket): against the Herdr app
// every open and every `rig terminal status` answered "herdr control socket is not answering ping". Here the daemon is built with
// an injected tmuxExec (so it never contacts an hc core) and a FAKE `herdr-app` first on PATH; no app is started.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDaemon } from "../src/startup.js";

describe("startup wires the herdr provider to the herdr-app channel", () => {
  const dirs: string[] = [];
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it("`rig terminal status` is alive when a herdr-app on PATH answers ls, and that ls is what was asked", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "w37-wiring-"));
    dirs.push(dir);
    const log = path.join(dir, "calls.log");
    fs.writeFileSync(path.join(dir, "herdr-app"), `#!${process.execPath}
require("node:fs").appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");
if (process.argv[2] === "ls") process.stdout.write('{"spaces":[]}'); else process.exit(1);
`, { mode: 0o700 });
    vi.stubEnv("PATH", `${dir}${path.delimiter}${process.env.PATH ?? ""}`);
    const { deps, db } = await createDaemon({ dbPath: ":memory:", tmuxExec: async () => "" });
    try {
      const status = await deps.terminalService!.status("herdr");
      expect(status.providers).toHaveLength(1);
      expect(status.providers[0]).toMatchObject({ name: "herdr", liveness: { alive: true }, status: { available: true } });
      expect(fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[])).toContainEqual(["ls"]);
    } finally {
      db.close();
    }
  });
});
