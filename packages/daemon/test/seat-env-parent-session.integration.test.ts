// Seats must not inherit the identity of the Claude Code session or Herdr pane that started the daemon. The daemon hands each seat's
// terminal its environment (hc's `terminal.run.env`, written over the core's own), so a daemon started inside Claude Code and Herdr
// must not pass its parent's identity on. This drives the real CLI, daemon and a private hc core with a stub seat, then reads what
// the seat's process was given.
//
// The second arrangement the tmux version drove, a tmux server that already carried the parent identity before the daemon started,
// is not converted: it needs a core whose OWN environment holds the identity, and startHcScratch builds a core's environment from PATH
// alone, by design. hc-host.real.test.ts (PrivateCore, CLAUDECODE and HERDR_PANE_ID in the core's env, removed by the launch wrapper)
// pins that half.
import { describe, it, expect, afterEach } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareHermeticEnv, type HermeticScaffold } from "./helpers/hermetic-env.js";
import { spawnScenarioDaemon, runRig } from "./helpers/scenario-daemon.js";
import { stageTopologyRoot } from "./helpers/scenario-stage.js";
import { findHc, startHcScratch, type HcScratch } from "./helpers/hc-scratch.js";
import { PARENT_SESSION_ENV_KEYS } from "../src/domain/parent-session-env.js";
import { SEAT_LABEL } from "../src/adapters/hc-host.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const rigBin = resolve(HERE, "../../cli/dist/bin-wrapper.js");

const PARENT_SESSION = Object.fromEntries([...PARENT_SESSION_ENV_KEYS, "CLAUDE_EFFORT"].map((k) => [k, `parent-${k}`]));
const CONFIGURATION = {
  CLAUDE_CONFIG_DIR: "/configured/claude",
  CODEX_HOME: "/configured/codex",
  CLAUDE_CODE_USE_BEDROCK: "1",
  ANTHROPIC_BASE_URL: "https://anthropic.example.test",
  OPENAI_BASE_URL: "https://openai.example.test",
};

function parseEnv(text: string, separator: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const entry of text.split(separator)) {
    const eq = entry.indexOf("=");
    if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return env;
}

describe.skipIf(!findHc())("seat environment from a daemon started inside Claude Code and Herdr", () => {
  const scaffolds: HermeticScaffold[] = [];
  const scratches: HcScratch[] = [];
  afterEach(() => {
    for (const s of scaffolds.splice(0)) s.cleanup();
    for (const s of scratches.splice(0)) s.cleanup();
  });

  it("seats receive none of the parent session's identity variables, and configuration passes through unchanged", async () => {
    const scaffold = prepareHermeticEnv({
      baseEnv: { HOME: process.env.HOME, PATH: process.env.PATH, TERM: "xterm", ...PARENT_SESSION, ...CONFIGURATION },
    });
    scaffolds.push(scaffold);
    const scratch = startHcScratch();
    scratches.push(scratch);
    const environOf = (pid: number): Record<string, string> | null => {
      const environ = `/proc/${pid}/environ`;
      return existsSync(environ) ? parseEnv(readFileSync(environ, "utf8"), "\0") : null;
    };
    const staged = stageTopologyRoot(join(HERE, "fixtures", "scenarios", "topo-stub-baton.yaml"), join(scaffold.root, "topology"));

    // The daemon's environment (the scaffold's) carries the parent identity; the core's does not, the daemon is the only way it gets in.
    const daemon = await spawnScenarioDaemon({ ...scaffold, env: { ...scaffold.env, HC_SOCKET: scratch.socketPath } }, { rigBin });
    try {
      const up = await runRig(["up", staged.topologyPath, "--json", "--yes"], daemon.readEnv, rigBin, 120_000);
      expect(up.code).toBe(0);

      // What each seat's process was actually given, where the OS exposes it.
      const { terminals } = await scratch.client().call<{ terminals: Array<{ pid?: number | null; labels: Record<string, string> }> }>("terminal.list", {});
      const seatTerminals = terminals.filter((t) => (t.labels[SEAT_LABEL] ?? "").includes("scn-baton"));
      expect(seatTerminals.length).toBeGreaterThan(0);
      const seen = seatTerminals.map((t) => (t.pid ? environOf(t.pid) : null)).filter((env): env is Record<string, string> => env !== null);
      if (process.platform === "linux") expect(seen.length).toBe(seatTerminals.length);

      for (const env of seen) {
        expect(Object.keys(env).filter((k) => k in PARENT_SESSION)).toEqual([]);
        expect(env).toMatchObject({
          ...CONFIGURATION,
          HOME: scaffold.home,
          OPENRIG_HOME: scaffold.openrigHome,
        });
        // The seat gets the daemon's own PATH: the scaffold's, behind the paired-CLI directory the daemon puts in front of it.
        expect(env.PATH).toBe(`${scaffold.openrigHome}/rig-bin:${scaffold.env.PATH}`);
        // The core's names are the core's own: a seat must not be told it is a terminal of some other core.
        expect(Object.keys(env).filter((k) => k === "HC_SOCKET")).toEqual([]);
      }
    } finally {
      await runRig(["down", "scn-baton", "--json", "--force"], daemon.readEnv, rigBin, 60_000).catch(() => {});
      await daemon.stop().catch(() => {});
    }
  }, 300_000);
});
