import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findHc, startHcScratch, type HcScratch } from "../../daemon/test/helpers/hc-scratch.js";

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const HC = findHc();

/**
 * A seat learns who it is from inside a real terminal on a PRIVATE core: the resolver is bundled and run by the terminal's
 * own shell, so HC_TERMINAL_ID, HC_SESSION and HC_TERMINAL_SOCKET are the ones hc set, not ones this test wrote. The label
 * is written here as the literal key the daemon's HcHost writes (daemon/src/adapters/hc-host.ts `SEAT_LABEL`).
 */
describe.skipIf(!HC)("rig whoami identity inside a real hc terminal (private core)", () => {
  let hc: HcScratch;
  let probe: string;

  beforeAll(() => {
    hc = startHcScratch();
    const esbuild = require("esbuild") as typeof import("esbuild");
    const dir = join(hc.root, "probe");
    mkdirSync(dir);
    const entry = join(dir, "entry.ts");
    writeFileSync(entry, `import { resolveIdentitySource } from ${JSON.stringify(resolve(HERE, "../src/commands/whoami.ts"))};\n`
      + "console.log(JSON.stringify({ id: process.env.HC_TERMINAL_ID ?? null, source: resolveIdentitySource({}) }));\n");
    probe = join(dir, "probe.mjs");
    esbuild.buildSync({ entryPoints: [entry], bundle: true, platform: "node", format: "esm", outfile: probe, logLevel: "silent", banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" } });
  }, 60_000);

  afterAll(() => { hc?.cleanup(); });

  function runInTerminal(name: string, labels: string[]): { id: string | null; source: unknown } {
    const out = join(hc.root, `${name}.json`);
    const run = hc.run(["run", "--bg", "--no-parent", "--no-notify", "--name", name, ...labels.flatMap((l) => ["--label", l]), "--cwd", hc.root, "sh"]);
    expect(run.status, run.stderr).toBe(0);
    const send = hc.run(["send", name, `node ${JSON.stringify(probe)} > ${JSON.stringify(out)}`]);
    expect(send.status, send.stderr).toBe(0);
    const deadline = Date.now() + 20_000;
    for (;;) {
      try { return JSON.parse(readFileSync(out, "utf8")) as { id: string | null; source: unknown }; } catch { /* not written yet */ }
      if (Date.now() > deadline) throw new Error(`terminal ${name} wrote no identity`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }

  it("resolves the seat's session name from its openrig.seat label", () => {
    const seen = runInTerminal("seatq", ["openrig.seat=verify-qa@eztrack"]);
    expect(seen.id).toMatch(/^t[0-9a-z]+$/);
    expect(seen.source).toEqual({ sessionName: "verify-qa@eztrack" });
  });

  it("a terminal that is not an OpenRig seat has no identity", () => {
    const seen = runInTerminal("plain", ["herdr.space=elsewhere"]);
    expect(seen.id).toMatch(/^t[0-9a-z]+$/);
    expect(seen.source).toBeNull();
  });
});
