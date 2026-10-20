// OPR.0.4.3.33 hook-trust-autoclear — reproduce Codex's own `[hooks.state."<key>"] trusted_hash`
// record for the daemon's 4 authored activity hooks, pre-written on the provisioning seam so the
// unmanaged inline hooks are trusted on every path (launch/adopt/reconcile) without a manual
// `/hooks` "Trust all" keystroke.
//
// GROUND-TRUTH CAVEAT: Codex's key/hash is a private impl. The HASH is reproduced deterministically
// from the open source (canonical-JSON sha256 of NormalizedHookIdentity → version_for_toml; see the
// block comment in codex-runtime-adapter.ts). The fixtures below are marked PIN-TO-VM: they are the
// values THIS reproduction emits and the perturbation tests prove the identity fields are folded in
// — but the DEFINITIVE correctness check is a byte-for-byte read-back of a real Codex `[hooks.state]`
// after `/hooks`→"Trust all" (the QA VM proof). Until that read-back confirms them, the exact
// key_source (canonicalized config path) and positional indices are PROVISIONAL. A mismatch is
// fail-safe (gate reappears + Layer-2 keystroke floor), never a false-trusted run.
import { describe, it, expect, vi } from "vitest";
import nodeFs from "node:fs";
import { parse as parseToml } from "smol-toml";
import {
  CodexRuntimeAdapter,
  codexHookTrustEditAccepted,
  codexManagedHookGroupIndex,
  computeCodexHookTrust,
  lineStartsAtDocumentLevel,
  upsertCodexHookTrust,
  type CodexAdapterFsOps,
} from "../src/adapters/codex-runtime-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

const RELAY = "/daemon/assets/plugins/openrig-core/hooks/scripts/activity-relay.cjs";
const CONFIG = "/home/test/.codex/config.toml";
const COMMAND = `node "${RELAY}"`;
const EVENTS = ["SessionStart", "UserPromptSubmit", "Stop", "PermissionRequest"] as const;

// PIN TO VM READ-BACK (qa gate) — PROVISIONAL from open-source reproduction (PR #20321 / commits
// 0452dca, ffcc9cc; codex-rs fingerprint.rs version_for_toml). keySource here is the NON-canonical
// mock path `/home/test/.codex/config.toml`; the real key_source is std::fs::canonicalize(config.toml).
const PROVISIONAL_FIXTURE: Record<(typeof EVENTS)[number], { key: string; hash: string }> = {
  SessionStart: {
    key: "/home/test/.codex/config.toml:session_start:0:0",
    hash: "sha256:bbe395fdcffc4448b019a7621ff4c4ca57c43107e775ea286394724944fd4fe1",
  },
  UserPromptSubmit: {
    key: "/home/test/.codex/config.toml:user_prompt_submit:0:0",
    hash: "sha256:88a4916f162eb0fb90e90ebfe5844c4d552efb7e9b70f4616ea497026f6b61d4",
  },
  Stop: {
    key: "/home/test/.codex/config.toml:stop:0:0",
    hash: "sha256:7349b4836f7c53f7fbe92917a5a598b25a0e699b98a91cf5909bb40dc60da822",
  },
  PermissionRequest: {
    key: "/home/test/.codex/config.toml:permission_request:0:0",
    hash: "sha256:f3e7b08eef7376efd47d8cd066a2d7284d5ee12b54c7bac2d484b8bbe6ab803c",
  },
};

function mockCodexFs(files?: Record<string, string>): CodexAdapterFsOps & { _store: Record<string, string> } {
  const store: Record<string, string> = { ...files };
  return {
    readFile: (p: string) => { if (p in store) return store[p]!; throw new Error(`Not found: ${p}`); },
    writeFile: (p: string, c: string) => { store[p] = c; },
    exists: (p: string) => p in store,
    mkdirp: () => {},
    homedir: "/home/test",
    _store: store,
  } as CodexAdapterFsOps & { _store: Record<string, string> };
}

function mockTmux(): TmuxAdapter {
  return { sendText: vi.fn(async () => ({ ok: true as const })) } as unknown as TmuxAdapter;
}

describe("OPR.0.4.3.33 — computeCodexHookTrust (key + hash derivation)", () => {
  it("reproduces the PROVISIONAL (PIN-TO-VM) key + trusted_hash for all four authored hooks", () => {
    for (const ev of EVENTS) {
      const got = computeCodexHookTrust(ev, { keySource: CONFIG, command: COMMAND, timeoutSec: 5 });
      expect(got).toEqual(PROVISIONAL_FIXTURE[ev]);
      expect(got.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
  });

  it("folds the timeout into the hash (perturbation: timeout 5 -> 6 changes the hash, not the key)", () => {
    const base = computeCodexHookTrust("Stop", { keySource: CONFIG, command: COMMAND, timeoutSec: 5 });
    const perturbed = computeCodexHookTrust("Stop", { keySource: CONFIG, command: COMMAND, timeoutSec: 6 });
    expect(perturbed.key).toBe(base.key);
    expect(perturbed.hash).not.toBe(base.hash);
  });

  it("folds the command (relay path) into the hash (perturbation: different relay -> different hash)", () => {
    const base = computeCodexHookTrust("Stop", { keySource: CONFIG, command: COMMAND, timeoutSec: 5 });
    const perturbed = computeCodexHookTrust("Stop", {
      keySource: CONFIG,
      command: `node "/other/relay.cjs"`,
      timeoutSec: 5,
    });
    expect(perturbed.hash).not.toBe(base.hash);
  });

  it("folds a present matcher into the hash (proves matcher is part of the identity, not absent)", () => {
    const none = computeCodexHookTrust("Stop", { keySource: CONFIG, command: COMMAND, timeoutSec: 5 });
    const withMatcher = computeCodexHookTrust("Stop", {
      keySource: CONFIG,
      command: COMMAND,
      timeoutSec: 5,
      matcher: "Bash",
    });
    expect(withMatcher.hash).not.toBe(none.hash);
  });

  it("keys off the source path + event label + positional indices", () => {
    const got = computeCodexHookTrust("PermissionRequest", {
      keySource: "/x/config.toml",
      command: COMMAND,
      timeoutSec: 5,
    });
    expect(got.key).toBe("/x/config.toml:permission_request:0:0");
  });
});

describe("OPR.0.4.3.33 — upsertCodexHookTrust (idempotent, non-clobbering, section-scoped)", () => {
  const KEY = PROVISIONAL_FIXTURE.SessionStart.key;
  const HASH = PROVISIONAL_FIXTURE.SessionStart.hash;

  it("creates the [hooks.state.\"<key>\"] table with trusted_hash when absent", () => {
    const out = upsertCodexHookTrust("", KEY, HASH);
    expect(out).toBe(`[hooks.state.${JSON.stringify(KEY)}]\ntrusted_hash = ${JSON.stringify(HASH)}\n`);
  });

  it("is idempotent — same key+hash twice is byte-identical (no-op)", () => {
    const once = upsertCodexHookTrust("", KEY, HASH);
    const twice = upsertCodexHookTrust(once, KEY, HASH);
    expect(twice).toBe(once);
  });

  it("splices only the trusted_hash line when the hash changes (does not duplicate the table)", () => {
    const first = upsertCodexHookTrust("", KEY, "sha256:old");
    const updated = upsertCodexHookTrust(first, KEY, HASH);
    expect(updated.match(new RegExp(`\\[hooks\\.state\\.`, "g"))?.length).toBe(1);
    expect(updated).toContain(`trusted_hash = ${JSON.stringify(HASH)}`);
    expect(updated).not.toContain("sha256:old");
  });

  it("does NOT clobber an unrelated [hooks.state], a [projects] trust entry, or other content", () => {
    const existing =
      '[projects."/some/project"]\ntrust_level = "trusted"\n\n' +
      '[hooks.state."/other/config.toml:pre_tool_use:0:0"]\ntrusted_hash = "sha256:other"\n';
    const out = upsertCodexHookTrust(existing, KEY, HASH);
    // every pre-existing line preserved byte-identically
    expect(out).toContain('[projects."/some/project"]');
    expect(out).toContain('trust_level = "trusted"');
    expect(out).toContain('[hooks.state."/other/config.toml:pre_tool_use:0:0"]');
    expect(out).toContain('trusted_hash = "sha256:other"');
    // our new entry appended
    expect(out).toContain(`[hooks.state.${JSON.stringify(KEY)}]`);
    expect(out).toContain(`trusted_hash = ${JSON.stringify(HASH)}`);
    // the OTHER state entry's hash was NOT touched
    expect(out.match(/sha256:other/g)?.length).toBe(1);
  });
});

// OF-42 N10. The writer locates a record the way the reader does: by where the table really is, never
// by text that merely looks like its header. Each expected string below is spelled out, not derived
// from the code under test.
describe("OF-42 N10 — upsertCodexHookTrust edits the real table, never header-shaped string content", () => {
  const K = "/c/config.toml:pre_tool_use:0:0";
  const H = `[hooks.state.${JSON.stringify(K)}]`;

  it.each([
    ["basic", '"""'],
    ["literal", "\'\'\'"],
  ])("a header inside a multiline %s string is left byte-identical and the real table is the one edited", (_name, q) => {
    const fake = `# top comment\njunk = ${q}\n${H}\ntrusted_hash = "sha256:fake"\n${q}\n`;
    const real = `\n[other]\nkeep = 1\n\n${H}\ntrusted_hash = "sha256:old"\n\n[after]\nz = 2\n`;
    expect(upsertCodexHookTrust(fake + real, K, "sha256:new")).toBe(fake + real.replace("sha256:old", "sha256:new"));
  });

  it("a header-shaped string AFTER the real table does not capture the edit either (not 'the last textual header')", () => {
    const real = `${H}\ntrusted_hash = "sha256:old"\n\n`;
    const fake = `junk = """\n${H}\ntrusted_hash = "sha256:fake"\n"""\n`;
    expect(upsertCodexHookTrust(real + fake, K, "sha256:new")).toBe(real.replace("sha256:old", "sha256:new") + fake);
  });

  it("a header that exists only inside a string is not a table: a real one is appended after the untouched text", () => {
    const fake = `junk = """\n${H}\ntrusted_hash = "sha256:fake"\n"""\n`;
    expect(upsertCodexHookTrust(fake, K, "sha256:new")).toBe(`${fake}\n${H}\ntrusted_hash = "sha256:new"\n`);
  });

  it("string content inside the real table (a trusted_hash-looking line, a bracketed line) is not the record's field or its end", () => {
    const table = `${H}\nnote = """\ntrusted_hash = "sha256:decoy"\n[next]\n"""\ntrusted_hash = "sha256:old"\n`;
    expect(upsertCodexHookTrust(table, K, "sha256:new")).toBe(table.replace('"sha256:old"', '"sha256:new"'));
  });
});

// OF-42 N10 review B1. TOML lets a multiline string end with one or two quote characters directly before its
// closing delimiter (a literal string of three quotes, `a`, three quotes and one more quote holds `a'`). The scanner
// closed at the first three and read the extras as a new string, so every later line looked nested and no real
// header could be found.
describe("OF-42 N10 B1 — a multiline string closed by 4 or 5 quote characters does not desync the scanner", () => {
  it.each([
    ["'''a''''"], ["'''a'''''"], ['"""a""""'], ['"""a"""""'],
  ])("x = [%s] leaves every later line at document level", (value) => {
    const doc = `x = [${value}]\n[p]\nk = 1\n`;
    expect(lineStartsAtDocumentLevel(doc)).toEqual([true, true, true, true]);
  });

  it("the same holds inside an inline table", () => {
    expect(lineStartsAtDocumentLevel('x = {a = """b""""}\n[p]\n')).toEqual([true, true, true]);
  });

  it("a real record after such a line is edited in place, not duplicated", () => {
    const K = "/c/config.toml:stop:0:0";
    const doc = `x = ['''a'''']\n[hooks.state.${JSON.stringify(K)}]\ntrusted_hash = "sha256:old"\n`;
    expect(upsertCodexHookTrust(doc, K, "sha256:new")).toBe(doc.replace("sha256:old", "sha256:new"));
  });

  it("the managed-hook write is a byte no-op on the second run when the config holds such a line", () => {
    const fs = mockCodexFs({ [RELAY]: "// relay", [CONFIG]: "x = ['''a'''']\n" });
    const adapter = new CodexRuntimeAdapter({ tmux: mockTmux(), fsOps: fs, activityRelayPath: RELAY });
    adapter.ensureCodexActivityHooks();
    const first = fs._store[CONFIG]!;
    adapter.ensureCodexActivityHooks();
    expect(fs._store[CONFIG]).toBe(first);
    expect(first.match(/^\[hooks\.state\./gm)?.length).toBe(4);
  });
});

// The acceptance rule behind upsertVerifiedCodexHookTrust, pinned on the candidates a BROKEN line scanner would
// produce (a correct scanner never reaches these with a document that still parses, so no launch-level row can).
// Each rejection below is the only thing between such a candidate and Jim's config.
describe("OF-42 N10 — codexHookTrustEditAccepted (parsed acceptance of a trust edit)", () => {
  const K = "/c/config.toml:pre_tool_use:0:0";
  const H = `[hooks.state.${JSON.stringify(K)}]`;

  it("accepts an in-place hash edit and an appended record", () => {
    const before = `a = 1\n${H}\ntrusted_hash = "sha256:old"\n`;
    expect(codexHookTrustEditAccepted(before, before.replace("sha256:old", "sha256:new"), K, "sha256:new")).toBe(true);
    expect(codexHookTrustEditAccepted("a = 1\n", `a = 1\n\n${H}\ntrusted_hash = "sha256:new"\n`, K, "sha256:new")).toBe(true);
  });

  it("rejects a fake header edited inside a string outside the record, even though the real record already holds the hash", () => {
    const before = `junk = '''\n${H}\n'''\n\n${H}\ntrusted_hash = "sha256:new"\n`;
    const candidate = `junk = '''\n${H}\ntrusted_hash = "sha256:new"\n'''\n\n${H}\ntrusted_hash = "sha256:new"\n`;
    expect(() => parseToml(candidate)).not.toThrow(); // it parses: only the comparison with the original can refuse it
    expect(codexHookTrustEditAccepted(before, candidate, K, "sha256:new")).toBe(false);
  });

  it("rejects a hash-looking line edited inside a string of the record while the real hash stays stale", () => {
    const before = `${H}\nnote = '''\ntrusted_hash = "sha256:old"\n'''\ntrusted_hash = "sha256:old"\n`;
    const candidate = `${H}\nnote = '''\ntrusted_hash = "sha256:new"\n'''\ntrusted_hash = "sha256:old"\n`;
    expect(() => parseToml(candidate)).not.toThrow();
    expect(codexHookTrustEditAccepted(before, candidate, K, "sha256:new")).toBe(false);
  });

  it("rejects a candidate that does not parse", () => {
    const before = `${H}\ntrusted_hash = "sha256:old"\n`;
    expect(codexHookTrustEditAccepted(before, `${before}\n${H}\ntrusted_hash = "sha256:new"\n`, K, "sha256:new")).toBe(false);
  });
});

// The structures a line-local writer has to respect inside the real record.
describe("OF-42 N10 — table extent and nesting inside the record being edited", () => {
  const K = "/c/config.toml:pre_tool_use:0:0";
  const H = `[hooks.state.${JSON.stringify(K)}]`;

  it("a record with no trusted_hash gets one of its own: the next table's trusted_hash is not its field", () => {
    const doc = `${H}\nnote = 1\n\n[other]\ntrusted_hash = "sha256:other"\n`;
    expect(upsertCodexHookTrust(doc, K, "sha256:new")).toBe(`${H}\ntrusted_hash = "sha256:new"\nnote = 1\n\n[other]\ntrusted_hash = "sha256:other"\n`);
  });

  it("a multi-line array inside the record is part of it: its bracketed rows do not end the table", () => {
    const doc = `${H}\nnote = [\n  [1, 2],\n  [3],\n]\ntrusted_hash = "sha256:old"\n`;
    expect(upsertCodexHookTrust(doc, K, "sha256:new")).toBe(doc.replace("sha256:old", "sha256:new"));
  });

  // Defence in depth: the managed-hook write has no mirror-style planner around it, so the write itself
  // must refuse a result that does not parse to the intended record.
  it("a record spelled in a form the exact-header match cannot see is left alone, never duplicated (managed-hook write)", () => {
    const sessionKey = "/home/test/.codex/config.toml:session_start:0:0";
    const decoy = `[ hooks.state.${JSON.stringify(sessionKey)} ]\ntrusted_hash = "sha256:stale"\n`;
    const fs = mockCodexFs({ [RELAY]: "// relay", [CONFIG]: decoy });
    new CodexRuntimeAdapter({ tmux: mockTmux(), fsOps: fs, activityRelayPath: RELAY }).ensureCodexActivityHooks();
    const state = (parseToml(fs._store[CONFIG]!) as { hooks: { state: Record<string, { trusted_hash: string }> } }).hooks.state;
    expect(state[sessionKey]!.trusted_hash).toBe("sha256:stale");
    for (const ev of EVENTS.filter((e) => e !== "SessionStart")) {
      expect(state[PROVISIONAL_FIXTURE[ev].key]!.trusted_hash).toBe(PROVISIONAL_FIXTURE[ev].hash);
    }
  });
});

describe("OPR.0.4.3.33 — provisioning-seam coupling (ensureCodexActivityHooks pre-trusts our 4 hooks)", () => {
  function makeAdapter(fs: CodexAdapterFsOps): CodexRuntimeAdapter {
    return new CodexRuntimeAdapter({ tmux: mockTmux(), fsOps: fs, activityRelayPath: RELAY });
  }

  it("emits BOTH the managed hook block AND exactly the 4 [hooks.state] trust records", () => {
    const fs = mockCodexFs({ [RELAY]: "// relay" });
    makeAdapter(fs).ensureCodexActivityHooks();
    const cfg = fs._store[CONFIG]!;
    expect(cfg).toBeDefined();
    // the managed hook block is present
    expect(cfg).toContain("# BEGIN OPENRIG MANAGED ACTIVITY HOOKS");
    for (const ev of EVENTS) expect(cfg).toContain(`[[hooks.${ev}]]`);
    // and exactly the 4 trust state entries (keySource falls back to the plain config path
    // because the mock fs never lands the file on the real disk for realpathSync)
    for (const ev of EVENTS) {
      const { key, hash } = PROVISIONAL_FIXTURE[ev];
      expect(cfg).toContain(`[hooks.state.${JSON.stringify(key)}]`);
      expect(cfg).toContain(`trusted_hash = ${JSON.stringify(hash)}`);
    }
    // scope: exactly 4 hooks.state tables, no more, no wildcard/blanket entry
    expect(cfg.match(/^\[hooks\.state\./gm)?.length).toBe(4);
    expect(cfg).not.toContain('[hooks.state."*"]');
  });

  it("uses native canonical path casing for Codex hook trust keys", () => {
    const canonicalConfigPath = "C:\\Users\\Test\\.codex\\config.toml";
    const nativeRealpath = vi.spyOn(nodeFs.realpathSync, "native").mockReturnValue(canonicalConfigPath);
    try {
      const fakeFs = mockCodexFs({ [RELAY]: "// relay" });
      makeAdapter(fakeFs).ensureCodexActivityHooks();
      const configPath = Object.keys(fakeFs._store).find((path) => path.endsWith("config.toml"))!;
      const config = fakeFs._store[configPath]!;

      expect(nativeRealpath).toHaveBeenCalledWith(configPath);
      expect(config).toContain(`[hooks.state.${JSON.stringify(`${canonicalConfigPath}:session_start:0:0`)}]`);
    } finally {
      nativeRealpath.mockRestore();
    }
  });

  it("is idempotent — re-running produces byte-identical config (no duplicate trust tables)", () => {
    const fs = mockCodexFs({ [RELAY]: "// relay" });
    const adapter = makeAdapter(fs);
    adapter.ensureCodexActivityHooks();
    const first = fs._store[CONFIG]!;
    adapter.ensureCodexActivityHooks();
    const second = fs._store[CONFIG]!;
    expect(second).toBe(first);
    expect(second.match(/^\[hooks\.state\./gm)?.length).toBe(4);
  });

  it("preserves a pre-existing [projects] trust entry through the hook + trust write", () => {
    const fs = mockCodexFs({
      [RELAY]: "// relay",
      [CONFIG]: '[projects."/some/project"]\ntrust_level = "trusted"\n',
    });
    makeAdapter(fs).ensureCodexActivityHooks();
    const cfg = fs._store[CONFIG]!;
    expect(cfg).toContain('[projects."/some/project"]');
    expect(cfg).toContain('trust_level = "trusted"');
    expect(cfg).toContain("# BEGIN OPENRIG MANAGED ACTIVITY HOOKS");
    expect(cfg.match(/^\[hooks\.state\./gm)?.length).toBe(4);
  });
});

describe("hook trust keys follow the managed block's real position", () => {
  const USER_SESSION_START =
    '[[hooks.SessionStart]]\nmatcher = "startup"\n\n[[hooks.SessionStart.hooks]]\ntype = "command"\ncommand = \'echo user\'\n';
  const USER_TRUST = `[hooks.state.${JSON.stringify(`${CONFIG}:session_start:0:0`)}]\ntrusted_hash = "sha256:user-hook"\n`;

  it("a user's SessionStart hook ahead of ours puts ours at group 1; other events stay at 0", () => {
    const fs = mockCodexFs({ [RELAY]: "// relay", [CONFIG]: USER_SESSION_START });
    new CodexRuntimeAdapter({ tmux: mockTmux(), fsOps: fs, activityRelayPath: RELAY }).ensureCodexActivityHooks();
    const cfg = fs._store[CONFIG]!;
    expect(codexManagedHookGroupIndex(cfg, "SessionStart")).toBe(1);
    expect(codexManagedHookGroupIndex(cfg, "Stop")).toBe(0);
    const ours = computeCodexHookTrust("SessionStart", { keySource: CONFIG, command: COMMAND, timeoutSec: 5, groupIndex: 1 });
    expect(cfg).toContain(`[hooks.state.${JSON.stringify(ours.key)}]\ntrusted_hash = ${JSON.stringify(ours.hash)}`);
    expect(cfg).not.toContain(`[hooks.state.${JSON.stringify(`${CONFIG}:session_start:0:0`)}]`);
  });

  it("never overwrites the trust a user gave their own hook at the shifted position", () => {
    const fs = mockCodexFs({ [RELAY]: "// relay", [CONFIG]: `${USER_SESSION_START}\n${USER_TRUST}` });
    new CodexRuntimeAdapter({ tmux: mockTmux(), fsOps: fs, activityRelayPath: RELAY }).ensureCodexActivityHooks();
    const cfg = fs._store[CONFIG]!;
    expect(cfg).toContain(USER_TRUST.trimEnd());
    expect(cfg.match(/sha256:user-hook/g)?.length).toBe(1);
  });

  it("no managed block means no group index (nothing of ours to trust)", () => {
    expect(codexManagedHookGroupIndex(USER_SESSION_START, "SessionStart")).toBeNull();
  });
});

describe("managed group index counts every TOML spelling of a preceding header", () => {
  const block = "# BEGIN OPENRIG MANAGED ACTIVITY HOOKS\n[[hooks.SessionStart]]\n# END OPENRIG MANAGED ACTIVITY HOOKS\n";
  for (const spelling of ["[[hooks.SessionStart]] # mine", "[[ hooks.SessionStart ]]", '[[hooks."SessionStart"]]', "[[hooks.'SessionStart']]", "[[hooks.SessionStart]]\r"]) {
    it(`counts ${JSON.stringify(spelling)}`, () => {
      expect(codexManagedHookGroupIndex(`${spelling}\n${block}`, "SessionStart")).toBe(1);
    });
  }
  it("does not count a different event or a commented-out header", () => {
    expect(codexManagedHookGroupIndex(`[[hooks.Stop]]\n# [[hooks.SessionStart]]\n${block}`, "SessionStart")).toBe(0);
  });
});
