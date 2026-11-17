// workspaces-o9o.88: OpenRig's managed block in a Codex config.toml (# BEGIN/END OPENRIG MANAGED ACTIVITY HOOKS) owns OpenRig's four hook
// stanzas and nothing else. Measured on Codex 0.166.0 (workspaces-o9o.76 probe): `codex plugin add` appended its [marketplaces.*] and
// [plugins."<plugin>@<market>"] tables INSIDE the sentinels when the block was the last thing in the file, and the adapter's upsert and strip
// both replaced the whole BEGIN..END range, deleting the user's plugin registration (verify-qa reproduced it at release-6 391ddb647). Every
// row drives the real CodexRuntimeAdapter on a real config.toml under a temporary CODEX_HOME.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CodexRuntimeAdapter } from "../src/adapters/codex-runtime-adapter.js";

const RELAY_ASSET = path.resolve(import.meta.dirname, "../assets/plugins/openrig-core/hooks/scripts/activity-relay.cjs");
const BEGIN = "# BEGIN OPENRIG MANAGED ACTIVITY HOOKS";
const END = "# END OPENRIG MANAGED ACTIVITY HOOKS";
const PLUGIN_TABLES = ["[marketplaces.qa-market]", 'source = "https://example.invalid/qa-market.git"', "", '[plugins."openrig-core@qa-market"]', "enabled = true"].join("\n");

let codexHome: string;
let configPath: string;
let stateDir: string;
/** As the daemon builds it: with a state dir and atomic writes, so the exact relay path OpenRig wrote is recorded (workspaces-o9o.76). */
const adapter = (relay = RELAY_ASSET) => new CodexRuntimeAdapter({
  tmux: {} as never, activityRelayPath: relay, codexHome, stateDir,
  fsOps: {
    readFile: (f: string) => fs.readFileSync(f, "utf8"), writeFile: (f: string, c: string) => fs.writeFileSync(f, c),
    exists: (f: string) => fs.existsSync(f), mkdirp: (d: string) => fs.mkdirSync(d, { recursive: true }), homedir: codexHome,
    chmod: (f: string, m: number) => fs.chmodSync(f, m), removeFile: (f: string) => fs.unlinkSync(f),
    writeFileAtomic: (f: string, c: string, mode: number) => { const t = `${f}.tmp-${process.pid}`; fs.writeFileSync(t, c, { mode }); fs.renameSync(t, f); },
  } as never,
});
const config = () => fs.readFileSync(configPath, "utf8");
/** What sits between the sentinels, and what sits outside them. */
const split = (text: string) => {
  const b = text.indexOf(BEGIN); const e = text.indexOf(END);
  return { inside: b === -1 || e === -1 ? "" : text.slice(b, e), outside: b === -1 || e === -1 ? text : text.slice(0, b) + text.slice(e) };
};
/** As Codex left it on 0.166.0: its tables just before the closing sentinel of a block that was last in the file. */
const appendInsideBlock = (tables: string) => fs.writeFileSync(configPath, config().replace(`${END}\n`, `${tables}\n${END}\n`));
const managedCommands = (text: string) => (text.match(/^command = 'node ".*activity-relay\.cjs"'$/gm) ?? []).length;

beforeEach(() => {
  codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "o9o88-"));
  configPath = path.join(codexHome, "config.toml");
  stateDir = path.join(codexHome, "openrig-home");
  // The block last in the file: what happens when the trust records are not written after it (the case Codex appended into).
  fs.writeFileSync(configPath, "");
});
afterEach(() => fs.rmSync(codexHome, { recursive: true, force: true }));

/** The managed block written alone, last in the file (no trust records after it), as the probe and verify-qa's repro had it. */
function blockLast(): void {
  adapter().ensureCodexActivityHooks();
  const text = config();
  fs.writeFileSync(configPath, text.slice(0, text.indexOf(END) + END.length) + "\n");
}

describe("workspaces-o9o.88: OpenRig's Codex block keeps what is not its own", () => {
  it("RED (verify-qa): the upsert keeps Codex's marketplace and plugin tables that sit inside the sentinels, outside them now", () => {
    blockLast();
    appendInsideBlock(PLUGIN_TABLES);
    adapter().ensureCodexActivityHooks();
    const { inside, outside } = split(config());
    expect(outside).toContain(PLUGIN_TABLES);
    expect(inside).not.toContain("[marketplaces.");
    expect(inside).not.toContain("[plugins.");
    expect(managedCommands(inside)).toBe(4);
  });

  it("RED: the strip (OpenRig's hooks off) keeps them too, and removes only OpenRig's stanzas", () => {
    blockLast();
    appendInsideBlock(PLUGIN_TABLES);
    adapter().removeCodexActivityHooks();
    const text = config();
    expect(text).toContain(PLUGIN_TABLES);
    expect(text).not.toContain(BEGIN);
    expect(managedCommands(text)).toBe(0);
  });

  it("RED: a hook group inside the block that does not run the relay (not OpenRig's) is kept", () => {
    blockLast();
    const userHook = ["[[hooks.Stop]]", "[[hooks.Stop.hooks]]", 'type = "command"', "command = 'notify-send done'"].join("\n");
    appendInsideBlock(userHook);
    adapter().ensureCodexActivityHooks();
    const { inside, outside } = split(config());
    expect(outside).toContain(userHook);
    expect(inside).not.toContain("notify-send");
  });

  it("a person's own hooks group for another event that runs the same relay is theirs, not OpenRig's: kept", async () => {
    blockLast();
    const ownGroup = ["[[hooks.PreToolUse]]", "[[hooks.PreToolUse.hooks]]", 'type = "command"', `command = 'node "${RELAY_ASSET}"'`].join("\n");
    appendInsideBlock(ownGroup);
    adapter().ensureCodexActivityHooks();
    expect(split(config()).outside).toContain(ownGroup);
  });

  // From build-impl's rows for o9o.88: order matters. Codex keys a hook's trust by its group's position within its event (config.toml:stop:0:0),
  // so a person's group that sat before OpenRig's must stay before it. Content found before OpenRig's first stanza goes above BEGIN; after, below END.
  it("RED (order): content inside the block before OpenRig's stanzas moves above it, content after moves below it", () => {
    blockLast();
    fs.writeFileSync(configPath, config().replace(`${BEGIN}\n`, `${BEGIN}\n[marketplaces.first]\nsource = "a"\n\n`));
    appendInsideBlock('[plugins."p@first"]\nenabled = true');
    adapter().ensureCodexActivityHooks();
    const text = config();
    expect(text.indexOf("[marketplaces.first]")).toBeGreaterThan(-1);
    expect(text.indexOf("[marketplaces.first]")).toBeLessThan(text.indexOf(BEGIN));
    expect(text.indexOf('[plugins."p@first"]')).toBeGreaterThan(text.indexOf(END));
    expect(split(text).inside).not.toContain("[marketplaces.");
  });

  it("the strip keeps that order too: before stays before, after stays after", () => {
    blockLast();
    fs.writeFileSync(configPath, config().replace(`${BEGIN}\n`, `${BEGIN}\n[marketplaces.first]\nsource = "a"\n\n`));
    appendInsideBlock('[plugins."p@first"]\nenabled = true');
    adapter().removeCodexActivityHooks();
    const text = config();
    expect(text.indexOf("[marketplaces.first]")).toBeGreaterThan(-1);
    expect(text.indexOf("[marketplaces.first]")).toBeLessThan(text.indexOf('[plugins."p@first"]'));
    expect(text).not.toContain(BEGIN);
  });

  it("OpenRig's own stanzas are never kept as foreign: after an upsert the file has exactly its four, inside the block", () => {
    blockLast();
    appendInsideBlock(PLUGIN_TABLES);
    adapter().ensureCodexActivityHooks();
    expect(managedCommands(config())).toBe(4);
    expect(managedCommands(split(config()).outside)).toBe(0);
  });

  it("a changed relay path replaces OpenRig's stanzas (the old path is not kept as foreign)", () => {
    const older = path.join(codexHome, "older", "activity-relay.cjs");
    fs.mkdirSync(path.dirname(older), { recursive: true }); fs.copyFileSync(RELAY_ASSET, older);
    adapter(older).ensureCodexActivityHooks();
    adapter().ensureCodexActivityHooks();
    expect(config()).not.toContain(older);
    expect(managedCommands(config())).toBe(4);
  });

  it("after the relay path changed, the strip still removes the stanzas OpenRig wrote with the older path (the recorded one)", () => {
    const older = path.join(codexHome, "older", "activity-relay.cjs");
    fs.mkdirSync(path.dirname(older), { recursive: true }); fs.copyFileSync(RELAY_ASSET, older);
    adapter(older).ensureCodexActivityHooks();
    adapter().removeCodexActivityHooks();
    expect(config()).not.toContain(older);
    expect(managedCommands(config())).toBe(0);
  });

  it("after a relay path change, the recorded path finds OpenRig's older stanzas even when a person's table sits first in the block", () => {
    const older = path.join(codexHome, "older", "activity-relay.cjs");
    fs.mkdirSync(path.dirname(older), { recursive: true }); fs.copyFileSync(RELAY_ASSET, older);
    adapter(older).ensureCodexActivityHooks();
    const firstInside = () => fs.writeFileSync(configPath, config().replace(`${BEGIN}\n`, `${BEGIN}\n[marketplaces.first]\nsource = "a"\n\n`));
    firstInside();
    const before = config();
    adapter().ensureCodexActivityHooks();
    expect(config()).not.toContain(older);
    expect(managedCommands(config())).toBe(4);
    fs.writeFileSync(configPath, before);   // and the record as the older daemon left it: the upsert above moved it to the current path
    fs.writeFileSync(path.join(stateDir, "state", "codex-activity-hooks", "relay-path"), `${older}\n`);
    adapter().removeCodexActivityHooks();
    expect(config()).not.toContain(older);
    expect(config()).toContain("[marketplaces.first]");
  });

  it("the upsert is idempotent with foreign tables moved out: a second upsert changes nothing", () => {
    blockLast();
    appendInsideBlock(PLUGIN_TABLES);
    adapter().ensureCodexActivityHooks();
    const once = config();
    adapter().ensureCodexActivityHooks();
    expect(config()).toBe(once);
  });

  it("the trust records after the block are unchanged by moving foreign tables out", () => {
    adapter().ensureCodexActivityHooks();
    const trust = config().slice(config().indexOf(END) + END.length);
    expect(trust).toContain("[hooks.state.");
    appendInsideBlock(PLUGIN_TABLES);
    adapter().ensureCodexActivityHooks();
    for (const record of trust.match(/^\[hooks\.state\..*\]$/gm) ?? []) expect(config()).toContain(record);
    expect(config()).toContain(PLUGIN_TABLES);
  });

  // verify-qa's review of 2492700bd, finding 1: OpenRig's stanzas are the ones running the EXACT relay path OpenRig wrote, never any script
  // that happens to share the file name.
  const userRelay = () => path.join(codexHome, "my-hooks", "activity-relay.cjs");
  const userStopGroup = () => ["[[hooks.Stop]]", "[[hooks.Stop.hooks]]", 'type = "command"', `command = 'node "${userRelay()}"'`].join("\n");

  it("RED (verify-qa): a person's Stop hook running their own activity-relay.cjs at another path is kept by the upsert", () => {
    blockLast();
    appendInsideBlock(userStopGroup());
    adapter().ensureCodexActivityHooks();
    const { inside, outside } = split(config());
    expect(outside).toContain(userStopGroup());
    expect(inside).not.toContain(userRelay());
    expect(managedCommands(inside)).toBe(4);
  });

  it("RED (verify-qa): the strip keeps that hook too", () => {
    blockLast();
    appendInsideBlock(userStopGroup());
    adapter().removeCodexActivityHooks();
    expect(config()).toContain(userStopGroup());
    expect(config()).not.toContain(BEGIN);
    expect(config()).not.toContain(`node "${RELAY_ASSET}"`);
  });

  it("with no record (an older daemon wrote the block), the stanzas running the current relay are still OpenRig's: upsert and strip", () => {
    blockLast();
    appendInsideBlock(PLUGIN_TABLES);
    fs.rmSync(path.join(stateDir, "state"), { recursive: true, force: true });
    adapter().ensureCodexActivityHooks();
    expect(managedCommands(config())).toBe(4);
    expect(split(config()).outside).toContain(PLUGIN_TABLES);
    fs.rmSync(path.join(stateDir, "state"), { recursive: true, force: true });
    adapter().removeCodexActivityHooks();
    expect(managedCommands(config())).toBe(0);
    expect(config()).toContain(PLUGIN_TABLES);
  });

  it("no record and a changed relay path (an older daemon's block): its stanzas are replaced, and a person's same-named relay stays", () => {
    const older = path.join(codexHome, "older", "activity-relay.cjs");
    fs.mkdirSync(path.dirname(older), { recursive: true }); fs.copyFileSync(RELAY_ASSET, older);
    adapter(older).ensureCodexActivityHooks();
    const text = config();
    fs.writeFileSync(configPath, text.slice(0, text.indexOf(END) + END.length) + "\n");
    appendInsideBlock(userStopGroup());
    fs.rmSync(path.join(stateDir, "state"), { recursive: true, force: true });
    adapter().ensureCodexActivityHooks();
    expect(config()).not.toContain(older);
    expect(managedCommands(split(config()).inside)).toBe(4);
    expect(split(config()).outside).toContain(userStopGroup());
  });

  it("with a record, a person's SessionStart group placed first inside the block is theirs, not OpenRig's", () => {
    blockLast();
    const theirs = ["[[hooks.SessionStart]]", "[[hooks.SessionStart.hooks]]", 'type = "command"', `command = 'node "${userRelay()}"'`].join("\n");
    fs.writeFileSync(configPath, config().replace(`${BEGIN}\n`, `${BEGIN}\n${theirs}\n\n`));
    adapter().ensureCodexActivityHooks();
    const text = config();
    expect(text).toContain(theirs);
    expect(text.indexOf(theirs)).toBeLessThan(text.indexOf(BEGIN));
  });

  // verify-qa's review of 2492700bd, finding 2: a line that looks like a table header inside a multiline string is string content, not a
  // header (o9o.76's lesson: a header counts only at the top level, outside any string).
  const MCP_ARGS = 'one\n[not.a.header]\n[[nor.this]]\ntwo\n';
  const mcpTable = () => ["[mcp_servers.qa]", 'command = "qa-server"', `args = """\n${MCP_ARGS}"""`].join("\n");

  it("RED (verify-qa): a multiline string holding a header-like line keeps its value through the upsert", () => {
    blockLast();
    appendInsideBlock(mcpTable());
    adapter().ensureCodexActivityHooks();
    const parsed = parseToml(config()) as { mcp_servers?: { qa?: { args?: string } } };
    expect(parsed.mcp_servers?.qa?.args).toBe(MCP_ARGS);
    expect(split(config()).outside).toContain(mcpTable());
  });

  it("RED (verify-qa): and through the strip", () => {
    blockLast();
    appendInsideBlock(mcpTable());
    adapter().removeCodexActivityHooks();
    const parsed = parseToml(config()) as { mcp_servers?: { qa?: { args?: string } } };
    expect(parsed.mcp_servers?.qa?.args).toBe(MCP_ARGS);
    expect(config()).toContain(mcpTable());
  });

  it("a relay command line inside a multiline string of a foreign table is not taken for OpenRig's stanza", () => {
    blockLast();
    const table = ["[[hooks.Stop]]", "[[hooks.Stop.hooks]]", 'type = "command"', "command = 'notify-send'", `note = '''\ncommand = 'node "${RELAY_ASSET}"'\n'''`].join("\n");
    appendInsideBlock(table);
    adapter().ensureCodexActivityHooks();
    expect(split(config()).outside).toContain(table);
  });
});
