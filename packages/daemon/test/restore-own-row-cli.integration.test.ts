import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { prepareHermeticEnv, type HermeticScaffold } from "./helpers/hermetic-env.js";
import { runRig, spawnScenarioDaemon, type ScenarioDaemon } from "./helpers/scenario-daemon.js";

// OF-36: every command a message about an unusable saved startup context names is typed through a real POSIX shell
// against a scratch daemon (own OPENRIG_HOME, ephemeral port, private tmux socket; never port 7433 or ~/.openrig), on
// the stub runtime, and the command line is taken from the message's own output. Messages covered: restore's pre-restore
// refusal and restore-check's blocker (saved_startup_context_unusable, both scopes of spec), a listed seat's refusal
// (seat scope, spec route), `rig seat launch`'s wrong-shape advice (N-C2 rewritten), and the N6 spec-gone refusal.
const here = dirname(fileURLToPath(import.meta.url));
const rigBin = resolve(here, "../../cli/dist/bin-wrapper.js");
const topology = resolve(here, "../../test-system/scenarios/dev-pair-stub.yaml");
const rigName = "dev-pair-stub";
const impl = `dev-impl@${rigName}`;

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
  const run = (line: string) => sh(line, ctx.daemon!.readEnv);
  const sql = <T = unknown>(statement: string, ...params: unknown[]): T[] => {
    const d = new Database(join(ctx.scaffold!.stateDir, "scenario.db"));
    try {
      const st = d.prepare(statement);
      return st.reader ? st.all(...params) as T[] : (st.run(...params), []);
    } finally { d.close(); }
  };
  const node = (logicalId: string) => `(SELECT id FROM nodes WHERE logical_id = '${logicalId}')`;
  const corrupt = (column: string, value: string) => sql(`UPDATE node_startup_context SET ${column} = ? WHERE node_id = ${node("dev.impl")}`, value);
  const policyFresh = (logicalId: string) => sql(`UPDATE sessions SET restore_policy = 'checkpoint_only' WHERE node_id = ${node(logicalId)}`);
  const snapshotCount = () => sql<{ n: number }>("SELECT count(*) AS n FROM snapshots")[0]!.n;
  const storedReadsOk = async () => (await rig(["seat", "launch", impl, "--fresh", "--stop", "--startup-from", "stored", "--reason", "again", "--json"])).code === 0;
  const seatStatuses = async () => {
    const ps = await rig(["ps", "--nodes", "--rig", rigName, "--json"]);
    return Object.fromEntries((JSON.parse(ps.stdout) as Array<{ logicalId: string; sessionStatus: string }>).map((s) => [s.logicalId, s.sessionStatus]));
  };
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
  return { ctx, rig, run, sql, corrupt, policyFresh, snapshotCount, storedReadsOk, seatStatuses };
}

const BAD_ACTION = JSON.stringify([{ type: "x" }]);

describe("OF-36 rig seat launch's wrong-shape advice, no spec, with a snapshot taken before the break: the named rig down + rig up heals", () => {
  const t = useRig({ recordSpec: false });
  it("typed from the refusal", async () => {
    const before = await t.rig(["snapshot", (t.sql<{ id: string }>("SELECT id FROM rigs WHERE name = ?", rigName)[0]!).id]);
    expect(before.code, JSON.stringify(before)).toBe(0);
    expect(t.snapshotCount(), "positive control: a snapshot exists before the break").toBeGreaterThan(0);
    t.corrupt("startup_actions_json", BAD_ACTION);

    const refused = await t.rig(["seat", "launch", impl, "--fresh", "--stop", "--reason", "probe"]);
    const text = `${refused.stderr}\n${refused.stdout}`;
    expect(refused.code).not.toBe(0);
    const down = text.match(/rig down '[^']*'/);
    const up = text.match(/rig up '[^']*' --existing --fresh '[^']*' --startup-from stored/);
    expect(down && up, text).toBeTruthy();

    expect((await t.run(`${down![0]} --json`)).code).toBe(0);
    const ran = await t.run(`${up![0]} --json`);
    const nodes = (JSON.parse(ran.stdout) as { nodes: Array<{ logicalId: string; status: string; startupSource?: { snapshotId?: string } }> }).nodes;
    const seat = nodes.find((n) => n.logicalId === "dev.impl")!;
    expect(seat.status, ran.stdout).toBe("fresh-primed");
    expect(seat.startupSource, "replayed another snapshot's copy than rig down's").toMatchObject({ kind: "snapshot", reason: "saved_context_unreadable" });
    expect(seat.startupSource?.snapshotId, ran.stdout).toBeTruthy();
    expect(await t.storedReadsOk(), "the stored launch is no longer refused").toBe(true);
  }, 400_000);
});

describe("OF-36 rig seat launch's wrong-shape advice, no spec, no snapshot before the break: the named rig up refuses only this seat", () => {
  const t = useRig({ recordSpec: false });
  it("typed from the refusal", async () => {
    expect(t.snapshotCount(), "control: no snapshot was taken before the break").toBe(0);
    t.corrupt("startup_actions_json", BAD_ACTION);
    const refused = await t.rig(["seat", "launch", impl, "--fresh", "--stop", "--reason", "probe"]);
    const text = `${refused.stderr}\n${refused.stdout}`;
    const down = text.match(/rig down '[^']*'/);
    const up = text.match(/rig up '[^']*' --existing --fresh '[^']*' --startup-from stored/);
    expect(down && up, text).toBeTruthy();

    expect((await t.run(`${down![0]} --json`)).code).toBe(0);
    const ran = await t.run(`${up![0]} --json`);
    const seat = (JSON.parse(ran.stdout) as { nodes: Array<{ logicalId: string; status: string; error?: string }> }).nodes.find((n) => n.logicalId === "dev.impl")!;
    expect(seat.status, ran.stdout).toBe("failed");
    expect(seat.error).toMatch(/^Fresh start refused: dev\.impl: no snapshot of this rig holds a readable copy of its startup files/);
    expect((await t.seatStatuses())["dev.impl"], "nothing was started for the seat").not.toBe("running");
  }, 400_000);
});

for (const recordSpec of [false, true]) {
  describe(`OF-36 a plain rig up --existing, ${recordSpec ? "spec recorded" : "no spec"}, no usable copy: refused before it starts anything; restore-check says the same; the named remedy`, () => {
    const t = useRig({ recordSpec });
    it("typed from the check and the refusal", async () => {
      t.policyFresh("dev.impl");
      t.policyFresh("dev.qa");
      t.corrupt("resolved_files_json", "{}");
      expect((await t.rig(["down", rigName, "--json"])).code).toBe(0);

      const check = await t.rig(["restore-check", "--rig", rigName, "--full", "--json"]);
      const pre = (JSON.parse(check.stdout) as { checks: Array<{ check: string; status: string; evidence: string; remediation: string }> }).checks
        .find((c) => c.check === `rig.${rigName}.restore-preconditions`)!;
      expect(pre.status, check.stdout).toBe("red");
      expect(pre.evidence).toContain("saved_startup_context_unusable: dev.impl: no snapshot of this rig holds a readable copy of its startup files");

      const up = await t.run(`rig up '${rigName}' --existing --json`);
      expect(up.code, "refused").not.toBe(0);
      const upText = `${up.stdout}\n${up.stderr}`;
      expect(upText).toContain("pre_restore_validation_failed");
      const message = /dev\.impl: no snapshot of this rig holds a readable copy[^"]*?Restore would start this seat fresh, so it starts nothing\./.exec(upText)?.[0];
      expect(message, upText).toBeTruthy();
      expect(pre.evidence, "the check prints restore's own refusal").toContain(message!);
      const statuses = await t.seatStatuses();
      expect([statuses["dev.impl"], statuses["dev.qa"]], "nothing was started").not.toContain("running");

      const remedy = pre.remediation.match(/rig up '[^']*' --existing --fresh '[^']*'/);
      expect(remedy, pre.remediation).toBeTruthy();
      const ran = await t.run(`${remedy![0]} --json`);
      const nodes = (JSON.parse(ran.stdout) as { nodes: Array<{ logicalId: string; status: string; error?: string }> }).nodes;
      const seat = nodes.find((n) => n.logicalId === "dev.impl")!;
      expect(nodes.find((n) => n.logicalId === "dev.qa")!.status, "the other seat is restored").toBe("fresh-primed");
      if (recordSpec) {
        expect(pre.remediation).toContain("Start this seat from the rig's recorded spec instead");
        expect(seat.status, ran.stdout).toBe("fresh-primed");
        expect(await t.storedReadsOk(), "the spec re-read saved a readable context").toBe(true);
      } else {
        expect(pre.remediation).toContain("This rig records no spec source");
        expect(seat.status, ran.stdout).toBe("failed");
        expect(seat.error).toMatch(/^Fresh start refused: /);
        expect((await t.seatStatuses())["dev.impl"]).not.toBe("running");
      }
    }, 400_000);
  });
}

describe("OF-36 a listed seat, spec recorded, --startup-from stored, no usable copy: the named rig seat launch --fresh heals", () => {
  const t = useRig({ recordSpec: true });
  it("typed from the seat's refusal", async () => {
    t.corrupt("resolved_files_json", "{}");
    expect((await t.rig(["down", rigName, "--json"])).code).toBe(0);
    const up = await t.run(`rig up '${rigName}' --existing --fresh dev.impl --startup-from stored --json`);
    const seat = (JSON.parse(up.stdout) as { nodes: Array<{ logicalId: string; status: string; error?: string }> }).nodes.find((n) => n.logicalId === "dev.impl")!;
    expect(seat.status, up.stdout).toBe("failed");
    const named = seat.error?.match(/rig seat launch '[^']*' --fresh --reason "<why>"/);
    expect(named, seat.error).toBeTruthy();

    const ran = await t.run(named![0].replace("<why>", "of36-probe") + " --json");
    expect(ran.code, JSON.stringify(ran)).toBe(0);
    expect(await t.storedReadsOk(), "the spec re-read saved a readable context").toBe(true);
  }, 400_000);
});

describe("OF-36 rig seat launch's not-JSON advice, no spec, checkpoint_only, no snapshot holds a valid copy: the named rig launch refuses the seat", () => {
  const t = useRig({ recordSpec: false });
  it("typed from the refusal", async () => {
    t.policyFresh("dev.impl");
    const snap = await t.rig(["snapshot", (t.sql<{ id: string }>("SELECT id FROM rigs WHERE name = ?", rigName)[0]!).id]);
    expect(snap.code, JSON.stringify(snap)).toBe(0);
    // The only snapshot's copy of the seat's context cannot be used either.
    for (const row of t.sql<{ id: string; data: string }>("SELECT id, data FROM snapshots")) {
      const data = JSON.parse(row.data);
      for (const key of Object.keys(data.nodeStartupContext ?? {})) if (data.nodeStartupContext[key]) data.nodeStartupContext[key].resolvedStartupFiles = {};
      t.sql("UPDATE snapshots SET data = ? WHERE id = ?", JSON.stringify(data), row.id);
    }
    t.corrupt("resolved_files_json", "{not json");

    const refused = await t.rig(["seat", "launch", impl, "--fresh", "--stop", "--reason", "probe"]);
    const text = `${refused.stderr}\n${refused.stdout}`;
    const stop = text.match(/rig seat stop '[^']*' --reason "<why>"/);
    const launch = text.match(/rig launch \S+ dev\.impl/);
    expect(stop && launch, text).toBeTruthy();

    expect((await t.run(stop![0].replace("<why>", "of36-probe") + " --json")).code).toBe(0);
    const launched = await t.run(`${launch![0]} --json`);
    expect(`${launched.stdout}\n${launched.stderr}`, JSON.stringify(launched)).toContain("Fresh start refused: dev.impl: no snapshot of this rig holds a readable copy of its startup files");
    expect((await t.seatStatuses())["dev.impl"], "nothing was started for the seat").not.toBe("running");
    expect((await t.seatStatuses())["dev.qa"], "the sibling kept running").toBe("running");
  }, 400_000);
});

describe("N-C2 N6: the recorded spec is gone and the saved row cannot be used: the refusal does not offer --startup-from stored", () => {
  const t = useRig({ recordSpec: true });
  it("typed", async () => {
    t.corrupt("startup_actions_json", BAD_ACTION);
    t.sql("UPDATE rigs SET spec_source_path = '/nonexistent-of36-n6/rig.yaml' WHERE name = ?", rigName);
    const refused = await t.rig(["seat", "launch", impl, "--fresh", "--stop", "--reason", "probe"]);
    const text = `${refused.stderr}\n${refused.stdout}`;
    expect(refused.code).not.toBe(0);
    expect(text).toContain("no longer exists");
    expect(text).toContain("so rig seat launch --fresh --startup-from stored is refused too.");
    expect(text).not.toContain("or run again with --startup-from stored");
    // The sentence is true: the stored launch is refused.
    const stored = await t.rig(["seat", "launch", impl, "--fresh", "--stop", "--startup-from", "stored", "--reason", "probe", "--json"]);
    expect(stored.code, JSON.stringify(stored)).not.toBe(0);
    expect((await t.seatStatuses())["dev.impl"], "the refusals stopped nothing").toBe("running");
  }, 400_000);
});
