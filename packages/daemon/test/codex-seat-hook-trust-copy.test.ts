import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parse as parseToml } from "smol-toml";
import { ensureCodexSeatHome } from "../src/domain/codex-seat-home.js";

// OF-42. A user-authored hook (bash-guard) in the shared ~/.codex/config.toml is trusted by
// Jim only under the shared path's key. A seat loads the same file through its own symlink,
// and Codex keys trust by the path it loaded, so every interactive seat launch stops at
// "Hooks need review" (and `codex exec` silently skips the hook) until the seat key is
// trusted. These rows pin WHEN the launch-time sync may copy that trust to the seat key.
//
// The expected hashes below restate Codex's recipe independently of the code under test:
// sha256 over the compact JSON of { event_name, hooks:[handler], matcher? } with keys sorted.
const sha = (json: string) => `sha256:${createHash("sha256").update(json, "utf8").digest("hex")}`;
const BASH_GUARD_HASH = sha('{"event_name":"pre_tool_use","hooks":[{"async":false,"command":"/opt/bash-guard","timeout":5,"type":"command"}],"matcher":"Bash"}');
const PROBE_STOP_HASH = sha('{"event_name":"stop","hooks":[{"async":false,"command":"/opt/stop-probe","timeout":9,"type":"command"}]}');
const STALE = sha("an older definition of the hook");

const HOOKS = `[[hooks.PreToolUse]]
matcher = "Bash"

[[hooks.PreToolUse.hooks]]
type = "command"
command = "/opt/bash-guard"
timeout = 5

[[hooks.Stop]]

[[hooks.Stop.hooks]]
type = "command"
command = "/opt/stop-probe"
timeout = 9

`;

const entry = (key: string, hash: string) => `[hooks.state.${JSON.stringify(key)}]\ntrusted_hash = ${JSON.stringify(hash)}\n`;

let tmp: string;
let openrigHome: string;
let shared: string;
let sharedConfig: string;
let logs: string[];
const log = (m: string) => { logs.push(m); };

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "of42-hook-trust-"));
  openrigHome = path.join(tmp, ".openrig");
  shared = path.join(tmp, ".codex");
  await fs.mkdir(shared, { recursive: true });
  await fs.writeFile(path.join(shared, "config.toml"), "");
  sharedConfig = await fs.realpath(path.join(shared, "config.toml"));
  logs = [];
});
afterEach(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

const launch = (session = "dev-impl@r") => ensureCodexSeatHome(session, { openrigHome, sharedCodexHome: shared, log } as never);
const seatKeyOf = async (home: { path: string }) => path.join(await fs.realpath(home.path), "config.toml");
const read = () => fs.readFile(sharedConfig, "utf-8");
/** The text of the `[hooks.state."<key>"]` table (header excluded), or undefined when absent. */
const blockAt = (content: string, key: string): string | undefined => {
  const lines = content.split("\n");
  const i = lines.findIndex((l) => l.trim() === `[hooks.state.${JSON.stringify(key)}]`);
  if (i < 0) return undefined;
  const body: string[] = [];
  for (let j = i + 1; j < lines.length && !lines[j]!.trim().startsWith("["); j++) body.push(lines[j]!);
  return body.join("\n");
};
const hashAt = (content: string, key: string) => /trusted_hash = "([^"]+)"/.exec(blockAt(content, key) ?? "")?.[1];
const enabledAt = (content: string, key: string) => /^enabled = (true|false)$/m.exec(blockAt(content, key) ?? "")?.[1];

/** The record as a TOML parser (and so Codex) sees it, whatever the text around it looks like. */
const parsedRecord = (content: string, key: string) =>
  ((parseToml(content) as { hooks?: { state?: Record<string, { trusted_hash?: string; enabled?: boolean }> } }).hooks?.state ?? {})[key];

describe("OF-42 seat hook-trust copy", () => {
  it("copies the canonical trust of a user hook to the seat key when the hash is the one Codex computes now, and logs it", async () => {
    await fs.writeFile(sharedConfig, HOOKS + entry(`${sharedConfig}:pre_tool_use:0:0`, BASH_GUARD_HASH));
    const home = await launch();
    const seatKey = await seatKeyOf(home);
    expect(hashAt(await read(), `${seatKey}:pre_tool_use:0:0`)).toBe(BASH_GUARD_HASH);
    expect(logs.filter((l) => l.includes(`${seatKey}:pre_tool_use:0:0`))).toHaveLength(1);
    expect(logs.join("\n")).toContain(BASH_GUARD_HASH);
  });

  it("copies nothing when the canonical hash differs from the hash Codex computes for the hook now (stale trust)", async () => {
    await fs.writeFile(sharedConfig, HOOKS + entry(`${sharedConfig}:pre_tool_use:0:0`, STALE));
    const home = await launch();
    const seatKey = await seatKeyOf(home);
    expect(await read()).not.toContain(`${seatKey}:pre_tool_use`);
    expect(logs).toEqual([]);
  });

  it("a stale canonical hash for a hook whose definition changed in one field (timeout) is not copied", async () => {
    const hashWithOldTimeout = sha('{"event_name":"pre_tool_use","hooks":[{"async":false,"command":"/opt/bash-guard","timeout":3,"type":"command"}],"matcher":"Bash"}');
    await fs.writeFile(sharedConfig, HOOKS + entry(`${sharedConfig}:pre_tool_use:0:0`, hashWithOldTimeout));
    const home = await launch();
    expect(await read()).not.toContain(`${await seatKeyOf(home)}:pre_tool_use`);
  });

  it("creates no trust when there is no canonical entry for the hook", async () => {
    await fs.writeFile(sharedConfig, HOOKS);
    const home = await launch();
    expect(await read()).toBe(HOOKS);
    expect(await seatKeyOf(home)).toContain("config.toml");
    expect(logs).toEqual([]);
  });

  it("copies nothing from a canonical entry whose hook is not in the file at that position", async () => {
    await fs.writeFile(sharedConfig, HOOKS + entry(`${sharedConfig}:pre_tool_use:1:0`, BASH_GUARD_HASH));
    const home = await launch();
    expect(await read()).not.toContain(`${await seatKeyOf(home)}:pre_tool_use`);
  });

  it("copies from the key of the file the seat symlink resolves to, not from the unresolved shared path", async () => {
    // ~/.codex/config.toml is itself a link to a real file elsewhere.
    const elsewhere = path.join(tmp, "dotfiles", "codex.toml");
    await fs.mkdir(path.dirname(elsewhere), { recursive: true });
    await fs.rm(path.join(shared, "config.toml"));
    await fs.symlink(elsewhere, path.join(shared, "config.toml"));
    const unresolved = path.join(shared, "config.toml");
    const real = await (async () => { await fs.writeFile(elsewhere, ""); return fs.realpath(elsewhere); })();
    // trust exists ONLY under the unresolved ~/.codex path, none under the file's own path
    await fs.writeFile(elsewhere, HOOKS + entry(`${unresolved}:pre_tool_use:0:0`, BASH_GUARD_HASH));
    const home = await launch();
    const seatKey = await seatKeyOf(home);
    expect(await fs.readFile(real, "utf-8")).not.toContain(`${seatKey}:pre_tool_use`);
    expect(logs).toEqual([]);

    // the same hook trusted under the resolved file's key IS copied
    await fs.writeFile(elsewhere, HOOKS + entry(`${real}:pre_tool_use:0:0`, BASH_GUARD_HASH));
    await launch();
    expect(hashAt(await fs.readFile(real, "utf-8"), `${seatKey}:pre_tool_use:0:0`)).toBe(BASH_GUARD_HASH);
  });

  it("each hook is decided on its own hash: the current one is copied, the stale one is not", async () => {
    await fs.writeFile(sharedConfig, HOOKS +
      entry(`${sharedConfig}:pre_tool_use:0:0`, BASH_GUARD_HASH) +
      entry(`${sharedConfig}:stop:0:0`, STALE));
    const home = await launch();
    const seatKey = await seatKeyOf(home);
    const after = await read();
    expect(hashAt(after, `${seatKey}:pre_tool_use:0:0`)).toBe(BASH_GUARD_HASH);
    expect(after).not.toContain(`${seatKey}:stop:0:0`);
    expect(logs).toHaveLength(1);
  });

  it("leaves an existing seat entry alone when it already equals the current hash", async () => {
    const home0 = await launch();
    const seatKey = await seatKeyOf(home0);
    // The stop hook is trusted canonically only, so this launch DOES write (stop is copied);
    // the already-current pre_tool_use entry must be neither rewritten nor logged.
    const seeded = HOOKS + entry(`${sharedConfig}:pre_tool_use:0:0`, BASH_GUARD_HASH) + entry(`${seatKey}:pre_tool_use:0:0`, BASH_GUARD_HASH) +
      entry(`${sharedConfig}:stop:0:0`, PROBE_STOP_HASH);
    await fs.writeFile(sharedConfig, seeded);
    await launch();
    expect(await read()).toBe(seeded + `\n${entry(`${seatKey}:stop:0:0`, PROBE_STOP_HASH)}`);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain(`${seatKey}:stop:0:0`);
  });

  it("replaces a stale seat entry with the current canonical trust, and logs the replacement", async () => {
    const home0 = await launch();
    const seatKey = await seatKeyOf(home0);
    await fs.writeFile(sharedConfig, HOOKS + entry(`${sharedConfig}:pre_tool_use:0:0`, BASH_GUARD_HASH) + entry(`${seatKey}:pre_tool_use:0:0`, STALE));
    await launch();
    expect(hashAt(await read(), `${seatKey}:pre_tool_use:0:0`)).toBe(BASH_GUARD_HASH);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("replaced");
  });

  it("leaves a stale seat entry alone when the canonical entry cannot vouch for the current hash", async () => {
    const home0 = await launch();
    const seatKey = await seatKeyOf(home0);
    const seeded = HOOKS + entry(`${sharedConfig}:pre_tool_use:0:0`, STALE) + entry(`${seatKey}:pre_tool_use:0:0`, STALE);
    await fs.writeFile(sharedConfig, seeded);
    await launch();
    expect(await read()).toBe(seeded);
    expect(logs).toEqual([]);
  });

  it("keeps trust given inside the seat for the current definition when the canonical entry is stale", async () => {
    const home0 = await launch();
    const seatKey = await seatKeyOf(home0);
    const seeded = HOOKS + entry(`${sharedConfig}:stop:0:0`, STALE) + entry(`${seatKey}:stop:0:0`, PROBE_STOP_HASH);
    await fs.writeFile(sharedConfig, seeded);
    await launch();
    expect(await read()).toBe(seeded);
  });

  it("after the hook is edited and re-trusted on the shared key, the next launch refreshes the seat's stale entry (the menu would otherwise return)", async () => {
    // bash-guard is edited: Jim re-trusts it canonically, every seat still holds the old hash.
    await fs.writeFile(sharedConfig, HOOKS + entry(`${sharedConfig}:pre_tool_use:0:0`, BASH_GUARD_HASH));
    const home = await launch();
    const seatKey = await seatKeyOf(home);
    expect(hashAt(await read(), `${seatKey}:pre_tool_use:0:0`)).toBe(BASH_GUARD_HASH);

    const edited = HOOKS.replace("/opt/bash-guard", "/opt/bash-guard-v2");
    const EDITED_HASH = sha('{"event_name":"pre_tool_use","hooks":[{"async":false,"command":"/opt/bash-guard-v2","timeout":5,"type":"command"}],"matcher":"Bash"}');
    // Jim edits the hook, then re-trusts it: Codex rewrites the shared key to the new hash and
    // leaves every seat key at the old one.
    await fs.writeFile(sharedConfig, edited + entry(`${sharedConfig}:pre_tool_use:0:0`, EDITED_HASH) + entry(`${seatKey}:pre_tool_use:0:0`, BASH_GUARD_HASH));
    logs.length = 0;
    await launch();
    expect(hashAt(await read(), `${seatKey}:pre_tool_use:0:0`)).toBe(EDITED_HASH);
    expect(logs.filter((l) => l.includes("replaced"))).toHaveLength(1);
  });

  // Hashes below were written by Codex 0.162.1 itself ("Trust all" in a scratch CODEX_HOME), for
  // [[hooks.PreToolUse]] matcher=Bash with handlers (/bin/true, timeout 5) and (/bin/echo, timeout 7,
  // statusMessage "second"), and [[hooks.Stop]] with /bin/false and NO timeout.
  const TWO_HANDLERS = `[[hooks.PreToolUse]]\nmatcher = "Bash"\n\n[[hooks.PreToolUse.hooks]]\ntype = "command"\ncommand = "/bin/true"\ntimeout = 5\n\n[[hooks.PreToolUse.hooks]]\ntype = "command"\ncommand = "/bin/echo"\ntimeout = 7\nstatusMessage = "second"\n\n`;
  const CODEX_H0 = "sha256:327d4d5c8268c5ed60e372c070095b2a02d849e830d70fa1f34916ff1c7cf3bd";
  const CODEX_H1 = "sha256:fb70a19b6f42e362d5916210f975da8f11a2abef056294642ead5d7394e86721";
  const CODEX_STOP_NO_TIMEOUT = "sha256:5cde819ee8866303693164854d02d8bfc2d76a0b837bb47a63777a72243e20db";

  it("copies each handler of a two-handler group on the hash Codex wrote for it, and not a handler trusted with the other's hash", async () => {
    await fs.writeFile(sharedConfig, TWO_HANDLERS +
      entry(`${sharedConfig}:pre_tool_use:0:0`, CODEX_H0) +
      entry(`${sharedConfig}:pre_tool_use:0:1`, CODEX_H0)); // 0:1 carries handler 0's hash: stale for 0:1
    const home = await launch();
    const seatKey = await seatKeyOf(home);
    const after = await read();
    expect(hashAt(after, `${seatKey}:pre_tool_use:0:0`)).toBe(CODEX_H0);
    expect(after).not.toContain(`${seatKey}:pre_tool_use:0:1`);

    await fs.writeFile(sharedConfig, TWO_HANDLERS + entry(`${sharedConfig}:pre_tool_use:0:1`, CODEX_H1));
    await launch();
    expect(hashAt(await read(), `${seatKey}:pre_tool_use:0:1`)).toBe(CODEX_H1);
  });

  it("a hook with no timeout hashes with Codex's default of 600", async () => {
    const STOP_NO_TIMEOUT = `[[hooks.Stop]]\n\n[[hooks.Stop.hooks]]\ntype = "command"\ncommand = "/bin/false"\n\n`;
    await fs.writeFile(sharedConfig, STOP_NO_TIMEOUT + entry(`${sharedConfig}:stop:0:0`, CODEX_STOP_NO_TIMEOUT));
    const home = await launch();
    expect(hashAt(await read(), `${await seatKeyOf(home)}:stop:0:0`)).toBe(CODEX_STOP_NO_TIMEOUT);
  });

  it("copies nothing for a hook carrying a field this reproduction does not model (Codex would re-ask)", async () => {
    const odd = `[[hooks.Stop]]\n\n[[hooks.Stop.hooks]]\ntype = "command"\ncommand = "/opt/stop-probe"\ntimeout = 9\nsomeFutureField = true\n\n`;
    await fs.writeFile(sharedConfig, odd + entry(`${sharedConfig}:stop:0:0`, PROBE_STOP_HASH));
    const home = await launch();
    expect(await read()).not.toContain(`${await seatKeyOf(home)}:stop`);
  });

  // N1 (security review): the seat record is the shared record's OWN hash. Even if the single
  // comparison against the recomputed hash were lost, an edited hook must still never read as
  // approved at the seat, because the seat would carry the stale hash that Codex rejects.
  it("an edited hook is never given a seat hash equal to the hash Codex computes for it now (command, timeout and matcher edits)", async () => {
    const variants: Array<[string, string]> = [
      [HOOKS.replace("/opt/bash-guard", "/opt/bash-guard-v2"), sha('{"event_name":"pre_tool_use","hooks":[{"async":false,"command":"/opt/bash-guard-v2","timeout":5,"type":"command"}],"matcher":"Bash"}')],
      [HOOKS.replace("timeout = 5", "timeout = 8"), sha('{"event_name":"pre_tool_use","hooks":[{"async":false,"command":"/opt/bash-guard","timeout":8,"type":"command"}],"matcher":"Bash"}')],
      [HOOKS.replace('matcher = "Bash"', 'matcher = "Write"'), sha('{"event_name":"pre_tool_use","hooks":[{"async":false,"command":"/opt/bash-guard","timeout":5,"type":"command"}],"matcher":"Write"}')],
    ];
    for (const [edited, currentHash] of variants) {
      expect(currentHash).not.toBe(BASH_GUARD_HASH);
      await fs.writeFile(sharedConfig, edited + entry(`${sharedConfig}:pre_tool_use:0:0`, BASH_GUARD_HASH));
      const home = await launch();
      const seatKey = await seatKeyOf(home);
      const seatHash = hashAt(await read(), `${seatKey}:pre_tool_use:0:0`);
      expect(seatHash).not.toBe(currentHash);
    }
  });

  // F1 (security review): shared records are read from the parsed document, not by scanning lines.
  it("a record-shaped text inside a multiline string is not a trust record and is never mirrored", async () => {
    const fake = `junk = '''\n[hooks.state."${sharedConfig}:pre_tool_use:0:0"]\ntrusted_hash = "${BASH_GUARD_HASH}"\n'''\n\n`;
    await fs.writeFile(sharedConfig, fake + HOOKS);
    const home = await launch();
    expect(await read()).not.toContain(`${await seatKeyOf(home)}:pre_tool_use`);
    expect(logs).toEqual([]);
  });

  // F2 (security review): a hook Jim approved and then switched off must stay off in the seats.
  it("a shared record with enabled = false is copied with enabled = false", async () => {
    await fs.writeFile(sharedConfig, HOOKS + `${entry(`${sharedConfig}:pre_tool_use:0:0`, BASH_GUARD_HASH)}enabled = false\n`);
    const home = await launch();
    const after = await read();
    const seatKey = `${await seatKeyOf(home)}:pre_tool_use:0:0`;
    expect(hashAt(after, seatKey)).toBe(BASH_GUARD_HASH);
    expect(enabledAt(after, seatKey)).toBe("false");
  });

  it("a seat record that is current in hash but enabled while the shared one is switched off is brought in line, and logged", async () => {
    const home0 = await launch();
    const seatKey = `${await seatKeyOf(home0)}:pre_tool_use:0:0`;
    await fs.writeFile(sharedConfig, HOOKS + `${entry(`${sharedConfig}:pre_tool_use:0:0`, BASH_GUARD_HASH)}enabled = false\n\n` + entry(seatKey, BASH_GUARD_HASH));
    await launch();
    expect(enabledAt(await read(), seatKey)).toBe("false");
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("replaced");
  });

  // Disabled wins (re-check of dd6dcb78): Codex supports switching a hook off for ONE seat. That
  // is Jim's setting; a sync must never turn the hook back on.
  it("a hook switched off only in this seat stays off across a sync (nothing rewritten, nothing logged)", async () => {
    const home0 = await launch();
    const seatKey = `${await seatKeyOf(home0)}:pre_tool_use:0:0`;
    const seeded = HOOKS + entry(`${sharedConfig}:pre_tool_use:0:0`, BASH_GUARD_HASH) + `\n${entry(seatKey, BASH_GUARD_HASH)}enabled = false\n`;
    await fs.writeFile(sharedConfig, seeded);
    await launch();
    expect(await read()).toBe(seeded);
    expect(enabledAt(await read(), seatKey)).toBe("false");
    expect(logs).toEqual([]);
  });

  it("refreshing a stale seat hash keeps a seat-local enabled = false", async () => {
    const home0 = await launch();
    const seatKey = `${await seatKeyOf(home0)}:pre_tool_use:0:0`;
    await fs.writeFile(sharedConfig, HOOKS + entry(`${sharedConfig}:pre_tool_use:0:0`, BASH_GUARD_HASH) + `\n${entry(seatKey, STALE)}enabled = false\n`);
    await launch();
    expect(hashAt(await read(), seatKey)).toBe(BASH_GUARD_HASH);
    expect(enabledAt(await read(), seatKey)).toBe("false");
    expect(logs).toHaveLength(1);
  });

  // (a) Codex 0.162.1 reads exactly trusted_hash and a boolean enabled; nothing else is copied.
  it("copies only trusted_hash and a boolean enabled: other fields and a non-boolean enabled stay out of the seat record", async () => {
    await fs.writeFile(sharedConfig, HOOKS + `${entry(`${sharedConfig}:pre_tool_use:0:0`, BASH_GUARD_HASH)}foo = 5\nenabled = "false"\n`);
    const home = await launch();
    const block = blockAt(await read(), `${await seatKeyOf(home)}:pre_tool_use:0:0`);
    expect(block).toBeDefined();
    expect(block).toContain(`trusted_hash = "${BASH_GUARD_HASH}"`);
    expect(block).not.toContain("foo");
    expect(block).not.toContain("enabled");
  });

  // (c) The post-write check: record-shaped text in a string must not be written into.
  it("a fake seat-record header inside a string gets no copy and no log (the post-write check)", async () => {
    const home0 = await launch();
    const seatKey = `${await seatKeyOf(home0)}:pre_tool_use:0:0`;
    const seeded = `junk = '''\n[hooks.state.${JSON.stringify(seatKey)}]\n'''\n\n` + HOOKS + entry(`${sharedConfig}:pre_tool_use:0:0`, BASH_GUARD_HASH);
    await fs.writeFile(sharedConfig, seeded);
    await launch();
    expect(await read()).toBe(seeded);
    expect(logs).toEqual([]);
  });
  // N10 (re-check of 64ddc376): the writer found the first TEXTUAL header, a fake in a string, so the
  // shared disable never reached the real seat record.
  it("N10: a shared enabled = false reaches the REAL seat record when a header-shaped string precedes it", async () => {
    const home0 = await launch();
    const seatKey = `${await seatKeyOf(home0)}:pre_tool_use:0:0`;
    const fake = `junk = '''\n[hooks.state.${JSON.stringify(seatKey)}]\n'''\n\n`;
    const rest = HOOKS + `${entry(`${sharedConfig}:pre_tool_use:0:0`, BASH_GUARD_HASH)}enabled = false\n\n` + entry(seatKey, BASH_GUARD_HASH);
    await fs.writeFile(sharedConfig, fake + rest);
    await launch();
    const after = await read();
    expect(parsedRecord(after, seatKey)).toEqual({ trusted_hash: BASH_GUARD_HASH, enabled: false });
    expect(after.startsWith(fake)).toBe(true); // the string is byte-identical
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("replaced");
  });

  it("N10: the same fake header with a stale real seat record gets its hash refreshed in the real record", async () => {
    const home0 = await launch();
    const seatKey = `${await seatKeyOf(home0)}:pre_tool_use:0:0`;
    const fake = `junk = '''\n[hooks.state.${JSON.stringify(seatKey)}]\n'''\n\n`;
    await fs.writeFile(sharedConfig, fake + HOOKS + entry(`${sharedConfig}:pre_tool_use:0:0`, BASH_GUARD_HASH) + "\n" + entry(seatKey, STALE));
    await launch();
    const after = await read();
    expect(parsedRecord(after, seatKey)).toEqual({ trusted_hash: BASH_GUARD_HASH });
    expect(after.startsWith(fake)).toBe(true);
  });

  it("N10: an enabled-looking line inside a string of the real seat record is not the record's enabled flag", async () => {
    const home0 = await launch();
    const seatKey = `${await seatKeyOf(home0)}:pre_tool_use:0:0`;
    const seatRecord = `[hooks.state.${JSON.stringify(seatKey)}]\nnote = """\nenabled = true\n"""\ntrusted_hash = "${BASH_GUARD_HASH}"\n`;
    await fs.writeFile(sharedConfig, HOOKS + `${entry(`${sharedConfig}:pre_tool_use:0:0`, BASH_GUARD_HASH)}enabled = false\n\n` + seatRecord);
    await launch();
    expect(parsedRecord(await read(), seatKey)).toMatchObject({ trusted_hash: BASH_GUARD_HASH, enabled: false });
  });

  // Everything outside the edited record survives byte for byte: comments, blank lines, order, the
  // neighbouring tables, and the other lines of the edited record itself.
  it("a sync changes only the seat record: the rest of Jim's file is byte-identical, comments and order included", async () => {
    const home0 = await launch();
    const seatKey = `${await seatKeyOf(home0)}:pre_tool_use:0:0`;
    const sharedKey = `${sharedConfig}:pre_tool_use:0:0`;
    const file = (seatBody: string) =>
      `# Jim's config -- keep this comment\nmodel = "gpt-5" # inline\n\n` + HOOKS +
      `# trusted by Jim\n[hooks.state.${JSON.stringify(sharedKey)}]\ntrusted_hash = "${BASH_GUARD_HASH}"\nenabled = false\n\n` +
      `[projects."/some/where"]\ntrust_level = "trusted"   # spacing kept\n\n` +
      `# the seat's own record\n[hooks.state.${JSON.stringify(seatKey)}]\n${seatBody}\n[tui]\ntheme = "dark"\n# last comment\n`;
    await fs.writeFile(sharedConfig, file(`# seat note\ntrusted_hash = "${STALE}"\nnote = "x"\n`));
    await launch();
    expect(await read()).toBe(file(`enabled = false\n# seat note\ntrusted_hash = "${BASH_GUARD_HASH}"\nnote = "x"\n`));
  });
});
