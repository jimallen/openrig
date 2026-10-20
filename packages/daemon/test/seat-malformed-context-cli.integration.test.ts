import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { prepareHermeticEnv, type HermeticScaffold } from "./helpers/hermetic-env.js";
import { runRig, spawnScenarioDaemon, type ScenarioDaemon } from "./helpers/scenario-daemon.js";

// N-C2 (review of f55023a1): every command the refusal's guidance names is typed through a real POSIX shell against a
// scratch daemon (own OPENRIG_HOME, ephemeral port, private tmux socket; never port 7433 or ~/.openrig), on the stub
// runtime. The command line is taken from the refusal's own output, not restated here.
const here = dirname(fileURLToPath(import.meta.url));
const rigBin = resolve(here, "../../cli/dist/bin-wrapper.js");
const topology = resolve(here, "../../test-system/scenarios/dev-pair-stub.yaml");
const rigName = "dev-pair-stub";
const impl = `dev-impl@${rigName}`;
const qa = "dev.qa";

/** A command line through `sh -c`, with `rig` bound to the built CLI, so quoting is exercised. */
function sh(line: string, env: Record<string, string | undefined>): Promise<{ code: number; stdout: string; stderr: string }> {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) clean[k] = v;
  const script = `rig() { node ${JSON.stringify(rigBin)} "$@"; }\n${line}`;
  return new Promise((res) => execFile("sh", ["-c", script], { env: clean, timeout: 180_000, maxBuffer: 16 << 20 }, (err, stdout, stderr) => {
    res({ code: err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1) : 0, stdout, stderr });
  }));
}

function useRig(opts: { recordSpec: boolean }) {
  const ctx: { scaffold?: HermeticScaffold; daemon?: ScenarioDaemon } = {};
  const rig = (args: string[], t = 180_000) => runRig(args, ctx.daemon!.readEnv, rigBin, t);
  const db = () => new Database(join(ctx.scaffold!.stateDir, "scenario.db"));
  const sql = (statement: string, ...params: unknown[]) => { const d = db(); try { return d.prepare(statement).run(...params); } finally { d.close(); } };
  const implNode = "(SELECT id FROM nodes WHERE logical_id = 'dev.impl')";
  const corrupt = (column: string, value: string) => sql(`UPDATE node_startup_context SET ${column} = ? WHERE node_id = ${implNode}`, value);
  const refuse = async () => {
    const r = await rig(["seat", "launch", impl, "--fresh", "--startup-from", "stored", "--reason", "probe"]);
    return { ...r, text: `${r.stderr}\n${r.stdout}` };
  };
  const seatStatuses = async () => {
    const ps = await rig(["ps", "--nodes", "--rig", rigName, "--json"]);
    return Object.fromEntries((JSON.parse(ps.stdout) as Array<{ logicalId: string; sessionStatus: string }>).map((s) => [s.logicalId, s.sessionStatus]));
  };
  const rigId = async () => (JSON.parse((await rig(["ps", "--json"])).stdout) as Array<{ rigId: string; rigName: string }>).find((r) => r.rigName === rigName)!.rigId;
  beforeAll(async () => {
    ctx.scaffold = prepareHermeticEnv({ baseEnv: { PATH: process.env.PATH, TERM: "xterm-256color", SHELL: "/bin/bash" } });
    ctx.daemon = await spawnScenarioDaemon(ctx.scaffold, { rigBin });
    const cwd = join(ctx.scaffold.root, "project");
    mkdirSync(cwd);
    const up = await rig(["up", topology, "--cwd", cwd, "--json", "--yes"]);
    expect(up.code, JSON.stringify(up)).toBe(0);
    if (!opts.recordSpec) sql("UPDATE rigs SET spec_source_path = NULL WHERE name = ?", rigName);
  }, 200_000);
  afterAll(async () => {
    try { await rig(["down", rigName, "--json", "--force"]); } finally { await ctx.daemon?.stop(); ctx.scaffold?.cleanup(); }
  }, 60_000);
  return { ctx, rig, sql, corrupt, refuse, seatStatuses, rigId, db };
}

/** The operator's goal: the stored launch (replacing the occupant) is no longer refused. */
const STORED_READS_OK = async (t: ReturnType<typeof useRig>) =>
  (await t.rig(["seat", "launch", impl, "--fresh", "--stop", "--startup-from", "stored", "--reason", "again", "--json"])).code === 0;

describe("N-C2 spec recorded: the named `rig seat launch --fresh --stop` heals every kind of unreadable row", () => {
  const t = useRig({ recordSpec: true });
  const variants: Array<[string, string, string]> = [
    ["bad projection entry", "projection_entries_json", JSON.stringify([{ category: "memory" }])],
    ["R1 not-array resolved files", "resolved_files_json", "{}"],
    ["R3 bad startup action (D5)", "startup_actions_json", JSON.stringify([{ type: "x" }])],
    ["not JSON", "resolved_files_json", "{not json"],
  ];
  for (const [name, column, value] of variants) {
    it(`${name}`, async () => {
      t.corrupt(column, value);
      const refused = await t.refuse();
      expect(refused.code).not.toBe(0);
      const named = refused.text.match(/rig seat launch '[^']*' --fresh --stop --reason "<why>"/);
      expect(named, refused.text).toBeTruthy();
      expect(refused.text).toContain("delivers the spec's current startup files, not the saved ones");

      const ran = await sh(`${named![0]} --json`, t.ctx.daemon!.readEnv);
      expect(ran.code, JSON.stringify(ran)).toBe(0);
      expect(await STORED_READS_OK(t), "the stored launch is no longer refused").toBe(true);
      expect((await t.seatStatuses())[qa], "the sibling kept running").toBe("running");
    }, 400_000);
  }
});

describe("N-C2 no spec recorded, not JSON, checkpoint_only: the named `rig launch` heals it from an earlier snapshot", () => {
  const t = useRig({ recordSpec: false });
  it("rig seat stop, then rig launch <rigId> <seat>", async () => {
    t.sql("UPDATE sessions SET restore_policy = 'checkpoint_only' WHERE node_id = (SELECT id FROM nodes WHERE logical_id = 'dev.impl')");
    const id = await t.rigId();
    const snap = await sh(`rig snapshot ${id}`, t.ctx.daemon!.readEnv);
    expect(snap.code, JSON.stringify(snap)).toBe(0);
    t.corrupt("resolved_files_json", "{not json");

    const refused = await t.refuse();
    expect(refused.code).not.toBe(0);
    const stop = refused.text.match(/rig seat stop \S+ --reason "<why>"/);
    const launch = refused.text.match(/rig launch \S+ dev\.impl/);
    expect(stop && launch, refused.text).toBeTruthy();
    expect(refused.text).not.toMatch(/rig seat launch '/);

    const stopped = await sh(`${stop![0]} --json`, t.ctx.daemon!.readEnv);
    expect(stopped.code, JSON.stringify(stopped)).toBe(0);
    const launched = await sh(`${launch![0]} --json`, t.ctx.daemon!.readEnv);
    expect(launched.code, JSON.stringify(launched)).toBe(0);
    expect(await STORED_READS_OK(t), "the stored launch is no longer refused").toBe(true);
  }, 400_000);
});

describe("N-C2 no spec recorded: why rig down + rig up --existing --fresh is not advised", () => {
  for (const [name, column, value, seatEnds] of [
    ["R3 bad startup action (D5): comes back and the same refusal is printed again", "startup_actions_json", JSON.stringify([{ type: "x" }]), "fresh-primed"],
    ["R1 not-array resolved files: the row is still unreadable", "resolved_files_json", "{}", "failed"],
  ] as const) {
    describe(name, () => {
      const t = useRig({ recordSpec: false });
      it("typed as a replay of that sequence", async () => {
        t.corrupt(column, value);
        const first = await t.refuse();
        expect(first.code).not.toBe(0);
        expect(first.text).toContain("No restore command reliably heals it");

        const downRan = await sh(`rig down '${rigName}' --json`, t.ctx.daemon!.readEnv);
        const upRan = await sh(`rig up '${rigName}' --existing --fresh dev.impl --startup-from stored --json`, t.ctx.daemon!.readEnv);
        // Positive controls: both commands really ran, and the seat ended as the guidance says it can.
        expect(downRan.code, downRan.stderr).toBe(0);
        const upNodes = (JSON.parse(upRan.stdout) as { nodes: Array<{ logicalId: string; status: string }> }).nodes;
        expect(upNodes.find((n) => n.logicalId === "dev.impl")?.status, upRan.stdout).toBe(seatEnds);

        const again = await t.refuse();
        expect(again.code, "still refused").not.toBe(0);
        expect(again.text).toContain("No restore command reliably heals it");
      }, 400_000);
    });
  }
});
