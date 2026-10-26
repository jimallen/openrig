import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { prepareHermeticEnv, type HermeticScaffold } from "./helpers/hermetic-env.js";
import { runRig, spawnScenarioDaemon, type ScenarioDaemon } from "./helpers/scenario-daemon.js";

// OF-102, typed through the shipped CLI against a scratch daemon (own OPENRIG_HOME, ephemeral port, private tmux
// socket; never port 7433 or ~/.openrig), on the stub runtime. The situation it repairs: a rig created before OpenRig
// recorded a spec source, whose seat's saved startup files are pinned to an old release's real folder while the
// library link has moved on. `rig spec-source set` must make `rig seat launch --fresh --startup-from spec` rewrite
// the seat's saved files through the link as typed, and a later move of the link must be followed on replay.
const here = dirname(fileURLToPath(import.meta.url));
const rigBin = resolve(here, "../../cli/dist/bin-wrapper.js");
const rigName = "spec-source-stub";
const seat = `dev-impl@${rigName}`;
const TOKEN = "of102-e2e-operator-token";

const RIG = (agentRef: string) => `version: "0.2"
name: ${rigName}
pods:
  - id: dev
    label: Dev
    members:
      - {id: impl, agent_ref: "${agentRef}", profile: default, runtime: stub, cwd: .}
    edges: []
edges: []
`;
const AGENT = `name: impl
version: "1.0.0"
profiles:
  default: {}
startup:
  files:
    - path: guidance/role.md
      delivery_hint: guidance_merge
      required: true
  actions: []
`;

describe("OF-102 rig spec-source set: a rig with no spec source re-reads the typed link on a fresh launch", () => {
  const ctx: { scaffold?: HermeticScaffold; daemon?: ScenarioDaemon } = {};
  let root = "";
  let project = "";
  let typedSpec = "";
  const rig = (args: string[], t = 180_000) => runRig(args, ctx.daemon!.readEnv, rigBin, t);
  const withDb = <T>(fn: (db: Database.Database) => T): T => { const d = new Database(join(ctx.scaffold!.stateDir, "scenario.db")); try { return fn(d); } finally { d.close(); } };
  const storedRole = () => withDb((d) => {
    const row = d.prepare("SELECT resolved_files_json FROM node_startup_context WHERE node_id = (SELECT id FROM nodes WHERE logical_id = 'dev.impl')").get() as { resolved_files_json: string };
    return (JSON.parse(row.resolved_files_json) as Array<{ path: string; absolutePath: string }>).find((f) => f.path === "guidance/role.md")!.absolutePath;
  });
  const recordedSource = () => withDb((d) => (d.prepare("SELECT spec_source_path AS p FROM rigs WHERE name = ?").get(rigName) as { p: string | null }).p);
  const seatRows = () => withDb((d) => JSON.stringify(["nodes", "sessions", "node_startup_context"].map((t) => d.prepare(`SELECT * FROM ${t} ORDER BY 1`).all())));
  const agents = () => readFileSync(join(project, "AGENTS.md"), "utf-8");
  const retarget = (release: string) => { unlinkSync(join(root, "current")); symlinkSync(join(root, "rel", release), join(root, "current")); };
  const launch = (from: "spec" | "stored") => rig(["seat", "launch", seat, "--fresh", "--stop", "--startup-from", from, "--reason", `of102 ${from}`, "--json"]);

  beforeAll(async () => {
    ctx.scaffold = prepareHermeticEnv({ baseEnv: { PATH: process.env.PATH, TERM: "xterm-256color", SHELL: "/bin/bash" } });
    root = realpathSync(ctx.scaffold.root);
    // The operator bearer: the daemon reads it from its environment at start, the CLI from the same variable. (The
    // harness scrubs it by default; this is a stand-in for the operator's own, not a secret.)
    ctx.scaffold.env.OPENRIG_AUTH_BEARER_TOKEN = TOKEN;
    ctx.daemon = await spawnScenarioDaemon(ctx.scaffold, { rigBin });
    for (const release of ["A", "B", "C"]) {
      mkdirSync(join(root, "rel", release, "agents", "impl", "guidance"), { recursive: true });
      writeFileSync(join(root, "rel", release, "agents", "impl", "agent.yaml"), AGENT);
      writeFileSync(join(root, "rel", release, "agents", "impl", "guidance", "role.md"), `ROLE-${release}\n`);
    }
    // The rig was created while `current` pointed at A.
    symlinkSync(join(root, "rel", "A"), join(root, "current"));
    mkdirSync(join(root, "orig"));
    writeFileSync(join(root, "orig", "rig.yaml"), RIG(`path:${join(root, "current", "agents", "impl")}`));
    project = join(root, "project");
    mkdirSync(project);
    const up = await rig(["up", join(root, "orig", "rig.yaml"), "--cwd", project, "--json", "--yes"]);
    expect(up.code, JSON.stringify(up)).toBe(0);
    // This rig predates the recorded spec source, and its saved files are pinned to A's real folder, as OpenRig stored
    // them before OF-99 (the code under test now stores the typed path, so the old row is written by hand). `current`
    // has since moved on to B.
    retarget("B");
    withDb((d) => {
      const files = (JSON.parse((d.prepare("SELECT resolved_files_json AS j FROM node_startup_context").get() as { j: string }).j) as Array<{ absolutePath: string }>)
        .map((f) => ({ ...f, absolutePath: f.absolutePath.replace(join(root, "current"), join(root, "rel", "A")) }));
      d.prepare("UPDATE node_startup_context SET resolved_files_json = ?").run(JSON.stringify(files));
      d.prepare("UPDATE rigs SET spec_source_path = NULL WHERE name = ?").run(rigName);
    });
    // The spec the operator will name lives behind a library link and reaches the agent through `current`.
    mkdirSync(join(root, "specs", "team"), { recursive: true });
    writeFileSync(join(root, "specs", "team", "rig.yaml"), RIG(`path:${join(root, "current", "agents", "impl")}`));
    mkdirSync(join(root, "lib"));
    symlinkSync(join(root, "specs", "team"), join(root, "lib", "team"));
    typedSpec = join(root, "lib", "team", "rig.yaml");
  }, 200_000);
  afterAll(async () => {
    try { await rig(["down", rigName, "--json", "--force"]); } finally { await ctx.daemon?.stop(); ctx.scaffold?.cleanup(); if (root) rmSync(join(root, "rel"), { recursive: true, force: true }); }
  }, 60_000);

  it("before `set`: the rig records nothing, so a spec launch can only replay the saved files, still pinned to A's real folder", async () => {
    expect(recordedSource()).toBeNull();
    expect(storedRole()).toBe(join(root, "rel", "A", "agents", "impl", "guidance", "role.md"));
    const shown = await rig(["spec-source", "show", rigName, "--json"]);
    expect(JSON.parse(shown.stdout)).toMatchObject({ ok: true, specSource: null });
    const replayed = await launch("spec");
    expect(replayed.code, JSON.stringify(replayed)).toBe(0);
    expect(JSON.parse(replayed.stdout).startupSource).toMatchObject({ kind: "stored" });
    expect(storedRole()).toBe(join(root, "rel", "A", "agents", "impl", "guidance", "role.md"));
    expect(agents()).toContain("ROLE-A");
  }, 300_000);

  it("without the operator token (what a seat has) the same command is refused, and nothing is recorded", async () => {
    const noToken = { ...ctx.daemon!.readEnv, OPENRIG_AUTH_BEARER_TOKEN: undefined };
    const none = await runRig(["spec-source", "set", rigName, typedSpec, "--operator", "dev-impl@x"], noToken, rigBin, 60_000);
    expect(none.code).not.toBe(0);
    expect(`${none.stderr}${none.stdout}`).toContain("Unauthorized");
    const wrong = await runRig(["spec-source", "set", rigName, typedSpec, "--operator", "dev-impl@x", "--bearer", "not-the-token"], noToken, rigBin, 60_000);
    expect(wrong.code).not.toBe(0);
    expect(`${wrong.stderr}${wrong.stdout}`).toContain("Unauthorized");
    expect(recordedSource()).toBeNull();
    expect(withDb((d) => d.prepare("SELECT count(*) AS n FROM events WHERE type = 'rig.spec_source_changed'").get() as { n: number }).n).toBe(0);
  }, 60_000);

  it("a spec for another rig is refused, and nothing is recorded", async () => {
    mkdirSync(join(root, "other"));
    writeFileSync(join(root, "other", "rig.yaml"), RIG(`path:${join(root, "current", "agents", "impl")}`).replace(`name: ${rigName}`, "name: not-this-rig"));
    const res = await rig(["spec-source", "set", rigName, join(root, "other", "rig.yaml"), "--operator", "jim@ops"]);
    expect(res.code).not.toBe(0);
    expect(`${res.stderr}${res.stdout}`).toContain("the spec is named 'not-this-rig'");
    expect(recordedSource()).toBeNull();
  }, 60_000);

  it("`set` then `rig seat launch --fresh --stop --startup-from spec` stores files through the typed link; a moved link is followed on replay", async () => {
    const before = seatRows();
    const set = await rig(["spec-source", "set", rigName, typedSpec, "--operator", "jim@ops", "--json"]);
    expect(set.code, JSON.stringify(set)).toBe(0);
    expect(JSON.parse(set.stdout)).toMatchObject({ ok: true, from: null, to: typedSpec, changed: true });
    expect(recordedSource()).toBe(typedSpec);                       // as typed: the link, not the real file
    expect(seatRows()).toBe(before);                                // set alone changed no node, session or saved context
    const event = withDb((d) => d.prepare("SELECT payload FROM events WHERE type = 'rig.spec_source_changed'").all() as Array<{ payload: string }>);
    expect(event.map((e) => JSON.parse(e.payload))).toMatchObject([{ from: null, to: typedSpec, operator: "jim@ops", operatorIdentity: "claimed:v1", authorizedBy: "operator_bearer" }]);
    expect(JSON.parse(set.stdout).effect).toContain("a plain `rig seat launch --fresh`");
    expect(JSON.parse((await rig(["spec-source", "show", rigName, "--json"])).stdout)).toMatchObject({ specSource: typedSpec, resolvedPath: join(root, "specs", "team", "rig.yaml") });

    const fresh = await launch("spec");
    expect(fresh.code, JSON.stringify(fresh)).toBe(0);
    // Stored through `current`, as typed in the spec's agent_ref: not A's folder (stale) and not B's real folder.
    expect(storedRole()).toBe(join(root, "current", "agents", "impl", "guidance", "role.md"));
    expect(agents()).toContain("ROLE-B");
    expect(agents()).not.toContain("ROLE-A");

    retarget("C");
    const replay = await launch("stored");
    expect(replay.code, JSON.stringify(replay)).toBe(0);
    expect(storedRole()).toBe(join(root, "current", "agents", "impl", "guidance", "role.md"));
    expect(agents()).toContain("ROLE-C");
    expect(agents()).not.toContain("ROLE-B");
  }, 400_000);
});
