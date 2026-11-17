// workspaces-o9o.88: OpenRig's managed block in a Codex config.toml (# BEGIN/END OPENRIG MANAGED ACTIVITY HOOKS) owns OpenRig's four hook
// stanzas and nothing else. Measured on Codex 0.166.0 (workspaces-o9o.76 probe): `codex plugin add` appended its [marketplaces.*] and
// [plugins."<plugin>@<market>"] tables INSIDE the sentinels when the block was the last thing in the file, and the adapter's upsert and strip
// both replaced the whole BEGIN..END range, deleting the user's plugin registration (verify-qa reproduced it at release-6 391ddb647). Every
// row drives the real CodexRuntimeAdapter on a real config.toml under a temporary CODEX_HOME.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CodexRuntimeAdapter } from "../src/adapters/codex-runtime-adapter.js";

const RELAY_ASSET = path.resolve(import.meta.dirname, "../assets/plugins/openrig-core/hooks/scripts/activity-relay.cjs");
const BEGIN = "# BEGIN OPENRIG MANAGED ACTIVITY HOOKS";
const END = "# END OPENRIG MANAGED ACTIVITY HOOKS";
const PLUGIN_TABLES = ["[marketplaces.qa-market]", 'source = "https://example.invalid/qa-market.git"', "", '[plugins."openrig-core@qa-market"]', "enabled = true"].join("\n");

let codexHome: string;
let configPath: string;
const adapter = (relay = RELAY_ASSET) => new CodexRuntimeAdapter({
  tmux: {} as never, activityRelayPath: relay, codexHome,
  fsOps: {
    readFile: (f: string) => fs.readFileSync(f, "utf8"), writeFile: (f: string, c: string) => fs.writeFileSync(f, c),
    exists: (f: string) => fs.existsSync(f), mkdirp: (d: string) => fs.mkdirSync(d, { recursive: true }), homedir: codexHome,
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
});
