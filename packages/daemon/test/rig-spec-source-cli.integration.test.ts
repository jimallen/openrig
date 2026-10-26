import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { prepareHermeticEnv, type HermeticScaffold } from "./helpers/hermetic-env.js";
import { runRig, spawnScenarioDaemon, type ScenarioDaemon } from "./helpers/scenario-daemon.js";

// OF-102, typed through the shipped CLI against a scratch daemon (own OPENRIG_HOME, ephemeral port, private tmux
// socket; never port 7433 or ~/.openrig), on the stub runtime, with NO operator bearer configured (as the live
// daemon). The situation it repairs: a rig created before OpenRig recorded a spec source, whose seat's saved startup
// files are pinned to an old release's real folder while the release link has moved on. `rig spec-source set` must
// make `rig seat launch --fresh --startup-from spec` rewrite the seat's saved files through the link as typed, and a
// later move of the link must be followed on replay.
//
// The daemon judges the spec file with the production trust check (under a trusted root by its real location, owned
// and protected along its whole chain, not in a temp folder), so the scaffold is built under the runner's home
// folder, not /tmp, with the folders this test creates at mode 0755 whatever the umask.
const here = dirname(fileURLToPath(import.meta.url));
const rigBin = resolve(here, "../../cli/dist/bin-wrapper.js");
const rigName = "spec-source-stub";
const seat = `dev-impl@${rigName}`;

const RIG = (agentRef: string, name = rigName) => `version: "0.2"
name: ${name}
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
  const ctx: { scaffold?: HermeticScaffold; daemon?: ScenarioDaemon; base?: string } = {};
  let root = "";
  let project = "";
  let typedSpec = "";   // through ~/.agents-release/current (a link inside a trusted root)
  let realSpec = "";
  let exactSpec = "";   // <shared-docs rigs>/<rig name>/rig.yaml
  const rig = (args: string[], t = 180_000) => runRig(args, ctx.daemon!.readEnv, rigBin, t);
  const withDb = <T>(fn: (db: Database.Database) => T): T => { const d = new Database(join(ctx.scaffold!.stateDir, "scenario.db")); try { return fn(d); } finally { d.close(); } };
  const storedRole = () => withDb((d) => {
    const row = d.prepare("SELECT resolved_files_json FROM node_startup_context WHERE node_id = (SELECT id FROM nodes WHERE logical_id = 'dev.impl')").get() as { resolved_files_json: string };
    return (JSON.parse(row.resolved_files_json) as Array<{ path: string; absolutePath: string }>).find((f) => f.path === "guidance/role.md")!.absolutePath;
  });
  const recordedSource = () => withDb((d) => (d.prepare("SELECT spec_source_path AS p FROM rigs WHERE name = ?").get(rigName) as { p: string | null }).p);
  const changeEvents = () => withDb((d) => (d.prepare("SELECT payload FROM events WHERE type = 'rig.spec_source_changed'").all() as Array<{ payload: string }>).map((e) => JSON.parse(e.payload)));
  const seatRows = () => withDb((d) => JSON.stringify(["nodes", "sessions", "node_startup_context"].map((t) => d.prepare(`SELECT * FROM ${t} ORDER BY 1`).all())));
  const agents = () => readFileSync(join(project, "AGENTS.md"), "utf-8");
  const retarget = (release: string) => { unlinkSync(join(root, "current")); symlinkSync(join(root, "rel", release), join(root, "current")); };
  const launch = (from: "spec" | "stored") => rig(["seat", "launch", seat, "--fresh", "--stop", "--startup-from", from, "--reason", `of102 ${from}`, "--json"]);
  /** A folder this test makes, at 0755 whatever the umask: the trust check refuses group- or other-writable folders. */
  const dir = (...parts: string[]) => { const p = join(...parts); mkdirSync(p, { recursive: true }); for (let d = p; d.length > root.length; d = dirname(d)) chmodSync(d, 0o755); return p; };
  const file = (p: string, text: string) => { writeFileSync(p, text); chmodSync(p, 0o644); };

  beforeAll(async () => {
    // The scaffold root normally sits in the temp folder, which the trust check refuses; build it under the real home folder
    // (the test runner points HOME at a temp fixture, so ask the account database instead).
    ctx.base = mkdtempSync(join(userInfo().homedir, ".of102-e2e-"));
    const savedTmp = process.env.TMPDIR;
    process.env.TMPDIR = ctx.base;
    try { ctx.scaffold = prepareHermeticEnv({ baseEnv: { PATH: process.env.PATH, TERM: "xterm-256color", SHELL: "/bin/bash" } }); }
    finally { if (savedTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = savedTmp; }
    root = realpathSync(ctx.scaffold.root);
    for (const d of [root, ctx.scaffold.openrigHome]) chmodSync(d, 0o755);
    ctx.daemon = await spawnScenarioDaemon(ctx.scaffold, { rigBin });
    for (const release of ["A", "B", "C"]) {
      dir(root, "rel", release, "agents", "impl", "guidance");
      file(join(root, "rel", release, "agents", "impl", "agent.yaml"), AGENT);
      file(join(root, "rel", release, "agents", "impl", "guidance", "role.md"), `ROLE-${release}\n`);
    }
    // The rig was created while `current` pointed at A.
    symlinkSync(join(root, "rel", "A"), join(root, "current"));
    dir(root, "orig");
    file(join(root, "orig", "rig.yaml"), RIG(`path:${join(root, "current", "agents", "impl")}`));
    project = dir(root, "project");
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
    // Two places the operator may name a spec from. The daemon's own <OPENRIG_HOME>/shared-docs/rigs takes exactly
    // <rig name>/rig.yaml. The released copies under the daemon's home (~/.agents-release) may be reached through a
    // link kept in that protected folder, which is how the live kernel's agents are typed. Both reach the agent through `current`.
    const rigs = dir(ctx.scaffold.openrigHome, "shared-docs", "rigs");
    exactSpec = join(dir(rigs, rigName), "rig.yaml");
    file(exactSpec, RIG(`path:${join(root, "current", "agents", "impl")}`));
    const released = join(ctx.scaffold.env.HOME!, ".agents-release");
    realSpec = join(dir(released, "rel1", "rigs", "team"), "rig.yaml");
    file(realSpec, RIG(`path:${join(root, "current", "agents", "impl")}`));
    symlinkSync(join(released, "rel1"), join(released, "current"));
    typedSpec = join(released, "current", "rigs", "team", "rig.yaml");
  }, 200_000);
  afterAll(async () => {
    try { await rig(["down", rigName, "--json", "--force"]); } finally { await ctx.daemon?.stop(); ctx.scaffold?.cleanup(); if (ctx.base) rmSync(ctx.base, { recursive: true, force: true }); }
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

  it("a spec outside the trusted folders (one a seat could have written) is refused, and nothing is recorded", async () => {
    const outside = dir(root, "seat-wrote-this");
    file(join(outside, "rig.yaml"), RIG(`path:${join(root, "current", "agents", "impl")}`));
    const res = await rig(["spec-source", "set", rigName, join(outside, "rig.yaml"), "--operator", "dev-impl@x"]);
    expect(res.code).not.toBe(0);
    expect(`${res.stderr}${res.stdout}`).toContain("not under a trusted spec root");
    expect(recordedSource()).toBeNull();
    expect(changeEvents()).toEqual([]);
    // Codex seats get <shared-docs>/rigs/<rig>/state/<pod> as a writable folder: inside the trusted root, but never a place a spec may be recorded from.
    const state = dir(ctx.scaffold!.openrigHome, "shared-docs", "rigs", rigName, "state", "verify");
    file(join(state, "rig.yaml"), RIG(`path:${join(root, "current", "agents", "impl")}`));
    const inState = await rig(["spec-source", "set", rigName, join(state, "rig.yaml"), "--operator", "dev-impl@x"]);
    expect(inState.code).not.toBe(0);
    expect(`${inState.stderr}${inState.stdout}`).toContain("only <rig name>/rig.yaml qualifies");
    expect(recordedSource()).toBeNull();
    expect(changeEvents()).toEqual([]);
    // A link kept in that seat-writable state folder that leads to the real, trusted spec: the typed spelling must qualify too.
    symlinkSync(exactSpec, join(state, "link.yaml"));
    const viaLink = await rig(["spec-source", "set", rigName, join(state, "link.yaml"), "--operator", "dev-impl@x"]);
    expect(viaLink.code).not.toBe(0);
    expect(`${viaLink.stderr}${viaLink.stdout}`).toContain("as typed, is not itself under a trusted spec root");
    expect(recordedSource()).toBeNull();
    expect(changeEvents()).toEqual([]);
  }, 60_000);

  it("a spec for another rig is refused, and nothing is recorded", async () => {
    const other = dir(ctx.scaffold!.openrigHome, "shared-docs", "rigs", "not-this-rig");
    file(join(other, "rig.yaml"), RIG(`path:${join(root, "current", "agents", "impl")}`, "not-this-rig"));
    const res = await rig(["spec-source", "set", rigName, join(other, "rig.yaml"), "--operator", "jim@ops"]);
    expect(res.code).not.toBe(0);
    expect(`${res.stderr}${res.stdout}`).toContain("the spec is named 'not-this-rig'");
    expect(recordedSource()).toBeNull();
  }, 60_000);

  it("`set` then `rig seat launch --fresh --stop --startup-from spec` stores files through the typed link; a moved link is followed on replay", async () => {
    const before = seatRows();
    // First the exact shared-docs path (the kernel's shape) ...
    const first = await rig(["spec-source", "set", rigName, exactSpec, "--operator", "jim@ops", "--json"]);
    expect(first.code, JSON.stringify(first)).toBe(0);
    expect(JSON.parse(first.stdout)).toMatchObject({ ok: true, from: null, to: exactSpec, changed: true });
    expect(recordedSource()).toBe(exactSpec);
    // ... then replaced by the release link, whose spelling is kept.
    const set = await rig(["spec-source", "set", rigName, typedSpec, "--operator", "jim@ops", "--json"]);
    expect(set.code, JSON.stringify(set)).toBe(0);
    expect(JSON.parse(set.stdout)).toMatchObject({ ok: true, from: exactSpec, to: typedSpec, changed: true });
    expect(JSON.parse(set.stdout).effect).toContain("a plain `rig seat launch --fresh`");
    expect(recordedSource()).toBe(typedSpec);                       // as typed: the release link, not the real file
    expect(seatRows()).toBe(before);                                // set alone changed no node, session or saved context
    expect(changeEvents()).toMatchObject([
      { from: null, to: exactSpec, operator: "jim@ops", operatorIdentity: "claimed:v1", authorizedBy: "trusted_spec_root" },
      { from: exactSpec, to: typedSpec, operator: "jim@ops", operatorIdentity: "claimed:v1", authorizedBy: "trusted_spec_root" },
    ]);
    expect(JSON.parse((await rig(["spec-source", "show", rigName, "--json"])).stdout)).toMatchObject({ specSource: typedSpec, resolvedPath: realSpec });

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
