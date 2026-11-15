// Slice 15 (OPR.0.7.0.15) P6: characters per form of `rig queue show` / `rig queue transitions`, before (output.compact
// off) and after (on), on the fixed fixtures queue-read-compact.test.ts checks. A measurement, not a check: it writes the
// sizes to the file S15_MEASURE_OUT names. Not collected by `npm test`; run it with
//   cd packages/cli && S15_MEASURE_OUT=/path/to/sizes.json npx vitest run -c vitest.opt-in.config.ts test/queue-read-compact-measure.opt-in.ts
import { it, vi, afterEach } from "vitest";
import fs from "node:fs";
import { createProgram } from "../src/index.js";
import { ID, LOG, makeDeps, row } from "./helpers/queue-read-compact-fixtures.js";

vi.mock("../src/daemon-lifecycle.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../src/daemon-lifecycle.js");
  return {
    ...actual,
    getDaemonStatus: vi.fn(async () => ({ state: "running", healthy: true, pid: 1234, port: 7433 })),
    getDaemonUrl: vi.fn(() => "http://localhost:7433"),
  };
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it("P6 measurement", async () => {
  const outFile = process.env.S15_MEASURE_OUT;
  if (!outFile) throw new Error("set S15_MEASURE_OUT to the file the sizes are written to");
  vi.stubEnv("OPENRIG_SESSION_NAME", "worker@r");
  let logs: string[] = [];
  let errors: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...a) => { logs.push(a.join(" ")); });
  vi.spyOn(console, "error").mockImplementation((...a) => { errors.push(a.join(" ")); });
  const showRoute = () => ({ [`GET /api/queue/${ID}`]: { status: 200, data: row() } });
  const transitionsRoute = () => ({ [`GET /api/queue/${ID}/transitions`]: { status: 200, data: LOG } });
  const sizes: Record<string, number> = {};
  for (const [label, argv, routes] of [
    ["show plain", ["show", ID], showRoute()],
    ["show --json", ["show", ID, "--json"], showRoute()],
    ["show --full --json", ["show", ID, "--full", "--json"], showRoute()],
    ["transitions plain", ["transitions", ID], transitionsRoute()],
    ["transitions --json", ["transitions", ID, "--json"], transitionsRoute()],
  ] as const) {
    for (const sw of ["0", "1"]) {
      vi.stubEnv("OPENRIG_OUTPUT_COMPACT", sw);
      logs = []; errors = [];
      process.exitCode = undefined;
      const program = createProgram({ queueDeps: makeDeps(routes) });
      program.exitOverride();
      await program.parseAsync(["node", "rig", "queue", ...argv]);
      const out = logs.join("\n");
      sizes[`${label} | ${sw === "1" ? "after" : "before"} | stdout`] = out.length;
      sizes[`${label} | ${sw === "1" ? "after" : "before"} | stderr`] = errors.join("\n").length;
    }
  }
  fs.writeFileSync(outFile, JSON.stringify(sizes, null, 2));
});
