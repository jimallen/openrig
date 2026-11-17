// workspaces-o9o.76: on a Codex seat that also has the openrig-core plugin INSTALLED, every relay event ran twice: once from the managed copy
// OpenRig writes into CODEX_HOME/config.toml (the sentinel block of upsertCodexActivityHooks, `node "<daemon's relay>"`), once from the
// plugin's hooks/codex.json. Measured on Codex 0.166.0 (private CODEX_HOME, bead note): a plugin only projected into .codex/plugins/<id> is
// not loaded; one installed from a marketplace runs its hooks beside the config hooks for every event; the plugin hook's environment has
// PLUGIN_ROOT and CLAUDE_PLUGIN_ROOT (the installed plugin root) and CODEX_HOME, and no CLAUDE_PROJECT_DIR, so the Claude-side rule of
// workspaces-o9o.33 never applied. The rows run the REAL relay as two processes against a counting endpoint; the env is built from nothing.
import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { upsertCodexActivityHooks } from "../src/adapters/codex-runtime-adapter.js";

const RELAY_ASSET = resolve(import.meta.dirname, "../assets/plugins/openrig-core/hooks/scripts/activity-relay.cjs");
const SEAT = "dev-codex@relayrig";
const TOKEN = ["hook", "o9o76"].join("-");   // built at runtime: no token-shaped literal in source

interface Arrival { route: string; body: Record<string, unknown> }
let root: string; let server: Server; let arrivals: Arrival[]; let baseUrl: string;
let home: string; let codexHome: string; let project: string; let pluginRoot: string; let daemonRelay: string;
const pluginRelay = () => join(pluginRoot, "hooks", "scripts", "activity-relay.cjs");

/** CODEX_HOME/config.toml as the adapter writes it, around whatever else `extra` holds. */
const writeConfig = (relayPath: string, extra = "") => writeFileSync(join(codexHome, "config.toml"), upsertCodexActivityHooks(extra, relayPath));

function runRelay(path: string, payload: Record<string, unknown>, asPlugin: boolean): Promise<string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: join(root, "user-home"),
    OPENRIG_URL: baseUrl, OPENRIG_ACTIVITY_HOOK_TOKEN: TOKEN, OPENRIG_SESSION_NAME: SEAT, OPENRIG_RUNTIME: "codex", OPENRIG_HOME: home,
    CODEX_HOME: codexHome,
    ...(asPlugin ? { PLUGIN_ROOT: pluginRoot, CLAUDE_PLUGIN_ROOT: pluginRoot, PLUGIN_DATA: join(root, "pdata"), CLAUDE_PLUGIN_DATA: join(root, "pdata") } : {}),
  };
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [path], { env, cwd: project, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (c) => { out += c; });
    child.on("error", fail);
    child.on("close", () => done(out));
    child.stdin.end(JSON.stringify({ session_id: "codex-session-o9o76", cwd: project, ...payload }));
  });
}
/** Both copies run for one hook, as Codex runs the config hook and the installed plugin's hook. */
const both = (payload: Record<string, unknown>) => Promise.all([runRelay(daemonRelay, payload, false), runRelay(pluginRelay(), payload, true)]);
const routes = () => arrivals.map((a) => `${a.route} ${String(a.body.hookEvent ?? "")}`);
const posts = (event: string) => arrivals.filter((a) => a.route === "/api/activity/hooks" && a.body.hookEvent === event);

const EVENTS: Array<[string, Record<string, unknown>]> = [
  ["SessionStart", { hook_event_name: "SessionStart", source: "startup" }],
  ["UserPromptSubmit", { hook_event_name: "UserPromptSubmit", prompt: "hello" }],
  ["Stop", { hook_event_name: "Stop" }],
  ["PermissionRequest", { hook_event_name: "PermissionRequest", tool_name: "Bash" }],
];

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "o9o76-"));
  home = join(root, "openrig-home"); codexHome = join(root, "codex-home"); project = join(root, "project");
  pluginRoot = join(root, "codex-home", "plugins", "cache", "market", "openrig-core", "0.1.9");
  daemonRelay = join(root, "daemon", "assets", "plugins", "openrig-core", "hooks", "scripts", "activity-relay.cjs");
  for (const dest of [daemonRelay, pluginRelay()]) { mkdirSync(dirname(dest), { recursive: true }); copyFileSync(RELAY_ASSET, dest); }
  mkdirSync(project, { recursive: true }); mkdirSync(home, { recursive: true });
  arrivals = [];
  server = createServer((req, res) => {
    let data = "";
    req.on("data", (c) => { data += c; });
    req.on("end", () => {
      let body: Record<string, unknown> = {};
      try { body = JSON.parse(data) as Record<string, unknown>; } catch { /* not JSON */ }
      arrivals.push({ route: req.url ?? "", body });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(root, { recursive: true, force: true });
});

describe("workspaces-o9o.76: on a Codex seat the relay runs once per hook when the openrig-core plugin is also installed", () => {
  it.each(EVENTS)("RED: %s, run by both copies, reaches the daemon exactly as the managed copy alone does", async (_event, payload) => {
    writeConfig(daemonRelay);
    await runRelay(daemonRelay, payload, false);
    const alone = routes();
    expect(alone.length).toBeGreaterThan(0);
    arrivals.length = 0;
    await both(payload);
    expect(routes()).toEqual(alone);
  });

  it("RED: a socket-delivered prompt run by both copies is not blocked as a repeat", async () => {
    writeConfig(daemonRelay);
    const prompt = `hello from a peer\n[openrig-msg msg-o9o76-0001:${"c3d4e5f6".repeat(4)}]`;
    const outputs = await both({ hook_event_name: "UserPromptSubmit", prompt });
    expect(outputs.join("")).not.toMatch(/"decision":"block"/);
  });

  it("no OpenRig block in config.toml (OpenRig's hooks off): the plugin copy relays", async () => {
    writeFileSync(join(codexHome, "config.toml"), "[features]\nhooks = true\n");
    await runRelay(pluginRelay(), { hook_event_name: "Stop" }, true);
    expect(posts("Stop")).toHaveLength(1);
  });

  it("no config.toml at all: the plugin copy relays", async () => {
    mkdirSync(codexHome, { recursive: true });
    await runRelay(pluginRelay(), { hook_event_name: "Stop" }, true);
    expect(posts("Stop")).toHaveLength(1);
  });

  it("the managed block names a relay that is not there: the plugin copy relays (the event is not lost)", async () => {
    writeConfig(daemonRelay);
    unlinkSync(daemonRelay);
    await runRelay(pluginRelay(), { hook_event_name: "Stop" }, true);
    expect(posts("Stop")).toHaveLength(1);
  });

  it("a user's own hook outside OpenRig's block that runs the same relay does not count: only the managed block does", async () => {
    const userHook = `[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ntype = "command"\ncommand = 'node "${daemonRelay}"'\n`;
    writeFileSync(join(codexHome, "config.toml"), userHook);
    await runRelay(pluginRelay(), { hook_event_name: "Stop" }, true);
    expect(posts("Stop")).toHaveLength(1);
  });

  it("OpenRig's block present for another event only, the user's own Stop hook outside it: the plugin copy relays Stop", async () => {
    const block = ["# BEGIN OPENRIG MANAGED ACTIVITY HOOKS", "[[hooks.SessionStart]]", "[[hooks.SessionStart.hooks]]", 'type = "command"',
      `command = 'node "${daemonRelay}"'`, "# END OPENRIG MANAGED ACTIVITY HOOKS"].join("\n");
    const user = ["[[hooks.Stop]]", "[[hooks.Stop.hooks]]", 'type = "command"', `command = 'node "${daemonRelay}"'`].join("\n");
    writeFileSync(join(codexHome, "config.toml"), `${block}\n\n${user}\n`);
    await runRelay(pluginRelay(), { hook_event_name: "Stop" }, true);
    expect(posts("Stop")).toHaveLength(1);
  });

  it("a managed block for an older relay path that is still readable counts: the plugin copy steps aside", async () => {
    const older = join(root, "older", "hooks", "scripts", "activity-relay.cjs");
    mkdirSync(dirname(older), { recursive: true }); copyFileSync(RELAY_ASSET, older);
    writeConfig(older);
    await runRelay(pluginRelay(), { hook_event_name: "Stop" }, true);
    expect(posts("Stop")).toHaveLength(0);
  });

  it("a table Codex appends inside OpenRig's block (its plugin registration, measured) ends the stanza: a command under it does not count", async () => {
    // `codex plugin add` (0.166.0) appended [marketplaces.*] and [plugins.*] inside the sentinels. A command line after such a table is not
    // the [[hooks.Stop]] stanza's, however close it sits.
    writeFileSync(join(codexHome, "config.toml"), ["# BEGIN OPENRIG MANAGED ACTIVITY HOOKS", "[[hooks.Stop]]", '[plugins."openrig-core@market"]',
      `command = 'node "${daemonRelay}"'`, "# END OPENRIG MANAGED ACTIVITY HOOKS", ""].join("\n"));
    await runRelay(pluginRelay(), { hook_event_name: "Stop" }, true);
    expect(posts("Stop")).toHaveLength(1);
  });

  it("the managed copy always relays, whatever the plugin is doing", async () => {
    writeConfig(daemonRelay);
    await runRelay(daemonRelay, { hook_event_name: "Stop" }, false);
    expect(posts("Stop")).toHaveLength(1);
  });

  it("the Claude rule is unchanged on a Claude seat: CLAUDE_PROJECT_DIR, not CODEX_HOME, decides there", async () => {
    // A Claude plugin hook with no settings.local.json in its project and a Codex config that does run the relay: Claude's rule reads the
    // project's settings, finds no managed copy, and the plugin copy relays.
    writeConfig(daemonRelay);
    const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: join(root, "user-home"), OPENRIG_URL: baseUrl, OPENRIG_ACTIVITY_HOOK_TOKEN: TOKEN,
      OPENRIG_SESSION_NAME: SEAT, OPENRIG_RUNTIME: "claude-code", OPENRIG_HOME: home, CLAUDE_PLUGIN_ROOT: pluginRoot, CLAUDE_PROJECT_DIR: project, CODEX_HOME: codexHome };
    await new Promise<void>((done, fail) => {
      const child = spawn(process.execPath, [pluginRelay()], { env, cwd: project, stdio: ["pipe", "ignore", "ignore"] });
      child.on("error", fail); child.on("close", () => done());
      child.stdin.end(JSON.stringify({ hook_event_name: "Stop" }));
    });
    expect(posts("Stop")).toHaveLength(1);
  });
});
