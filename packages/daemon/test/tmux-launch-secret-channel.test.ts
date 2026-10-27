import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { exec, execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TmuxAdapter, defaultTmuxFileOps, type TmuxFileOps } from "../src/adapters/tmux.js";
import { ARGV_SAFE_LAUNCH_ENV_KEYS, partitionLaunchEnv, renderSecretEnvScript } from "../src/adapters/tmux-launch-env-channel.js";

// OF-46. The activity-hook token (and every provider key) is a credential. A tmux
// command line is readable by every local user through `ps`, and the server that
// `new-session` starts keeps the client's argv. These tests pin the consequence:
// no tmux process the adapter starts ever has a credential in its argv, and the
// seat still receives it in its environment.
//
// All values are synthetic. No test prints one.

const run = promisify(exec);
const runFile = promisify(execFile);

const HOOK = "synthetic-hook-token-4f9a1c7e22";
const PROVIDER = "synthetic-provider-key-b83d5e0a91";
const LAUNCH_ENV = {
  OPENRIG_NODE_ID: "node-1",
  OPENRIG_SESSION_NAME: "dev-impl@rig",
  OPENRIG_RUNTIME: "claude-code",
  OPENRIG_HOME: "/state/instance",
  OPENRIG_URL: "http://127.0.0.1:7433",
  PATH: "/usr/bin:/bin",
  OPENRIG_ACTIVITY_HOOK_TOKEN: HOOK,
  ANTHROPIC_API_KEY: PROVIDER,
};

interface RecordedFiles { writes: Array<{ path: string; content: string; mode?: number; flag?: string }>; unlinked: string[] }

function recordingFileOps(): { ops: TmuxFileOps; seen: RecordedFiles } {
  const inner = defaultTmuxFileOps();
  const seen: RecordedFiles = { writes: [], unlinked: [] };
  return {
    seen,
    ops: {
      ...inner,
      writeFile: async (p, content, options) => { seen.writes.push({ path: p, content, mode: options?.mode, flag: options?.flag }); await inner.writeFile(p, content, options); },
      unlink: async p => { seen.unlinked.push(p); await inner.unlink(p); },
    },
  };
}

describe("OF-46 launch environment partition (the rule)", () => {
  it("argv carries only the explicit public allowlist; hook token, provider keys and unknown names take the file channel", () => {
    const { argv, file } = partitionLaunchEnv({ ...LAUNCH_ENV, SOME_FUTURE_SECRET: "x", OPENRIG_NEW_SECRET: "y" });
    expect(Object.keys(argv).sort()).toEqual(["OPENRIG_HOME", "OPENRIG_NODE_ID", "OPENRIG_RUNTIME", "OPENRIG_SESSION_NAME", "OPENRIG_URL", "PATH"]);
    expect(Object.keys(file).sort()).toEqual(["ANTHROPIC_API_KEY", "OPENRIG_ACTIVITY_HOOK_TOKEN", "OPENRIG_NEW_SECRET", "SOME_FUTURE_SECRET"]);
    expect(ARGV_SAFE_LAUNCH_ENV_KEYS.has("OPENRIG_ACTIVITY_HOOK_TOKEN")).toBe(false);
  });

  it("an OPENRIG_URL that carries userinfo, a query or a fragment is not argv-safe", () => {
    for (const url of ["http://user:pw@127.0.0.1:1", "http://127.0.0.1:1/?token=abc", "http://127.0.0.1:1/#frag", "not a url"]) {
      expect(partitionLaunchEnv({ OPENRIG_URL: url }).file).toEqual({ OPENRIG_URL: url });
    }
  });

  it("renders one set-environment per key, quoting the value literally and refusing line breaks without echoing them", () => {
    const script = renderSecretEnvScript("=s", { A_KEY: "it's $HOME #x ; \"q\" \\ ~" });
    expect(script).toBe(`set-environment -t '=s' A_KEY 'it'"'"'s $HOME #x ; "q" \\ ~'\n`);
    expect(() => renderSecretEnvScript("=s", { A_KEY: `${HOOK}\nkill-server` })).toThrow(/A_KEY/);
    try { renderSecretEnvScript("=s", { A_KEY: `${HOOK}\nkill-server` }); } catch (e) { expect((e as Error).message).not.toContain(HOOK); }
    expect(() => renderSecretEnvScript("=s", { "bad key": "v" })).toThrow(/variable name/);
  });
});

function argvAdapter(paneReply = "%1\n") {
  const calls: string[][] = [];
  const legacy: string[] = [];
  const { ops, seen } = recordingFileOps();
  const argvExec = async (argv: string[]) => {
    calls.push(argv);
    if (argv[1] === "new-session") return paneReply;
    return "";
  };
  const adapter = new TmuxAdapter(async cmd => { legacy.push(cmd); return cmd.includes("new-session") ? paneReply : ""; }, ops, argvExec);
  const legacyAdapter = new TmuxAdapter(async cmd => { legacy.push(cmd); return cmd.includes("new-session") ? paneReply : ""; }, recordingFileOps().ops);
  return { adapter, legacyAdapter, calls, legacy, seen };
}

describe("OF-46 production call sites: createSession and respawnPane", () => {
  it("createSession: no argv element and no shell string carries the hook token or a provider key", async () => {
    const { adapter, legacyAdapter, calls, legacy, seen } = argvAdapter();
    expect(await adapter.createSession("dev-impl@rig", "/w", LAUNCH_ENV)).toEqual({ ok: true });
    expect(await legacyAdapter.createSession("dev-impl@rig", "/w", LAUNCH_ENV)).toEqual({ ok: true });
    for (const secret of [HOOK, PROVIDER]) {
      expect(calls.flat().some(a => a.includes(secret))).toBe(false);
      expect(legacy.some(c => c.includes(secret))).toBe(false);
    }
    // The public identity still rides argv, exactly as before.
    expect(calls[0]).toEqual(expect.arrayContaining(["-e", "OPENRIG_NODE_ID=node-1"]));
    // The credentials went through ONE 0600 file the tmux server reads, removed afterwards.
    expect(seen.writes).toHaveLength(1);
    expect(seen.writes[0]!.mode).toBe(0o600);
    // Exclusive create: a file or symlink already at the path is refused, never followed or overwritten.
    expect(seen.writes[0]!.flag).toBe("wx");
    expect(seen.writes[0]!.content).toContain(HOOK);
    expect(calls.some(a => a[1] === "source-file" && a[2] === seen.writes[0]!.path)).toBe(true);
    expect(seen.unlinked).toEqual([seen.writes[0]!.path]);
    expect(fs.existsSync(seen.writes[0]!.path)).toBe(false);
    // Aimed at the exact session, never a prefix match on a neighbour.
    expect(seen.writes[0]!.content).toContain("set-environment -t '=dev-impl@rig' OPENRIG_ACTIVITY_HOOK_TOKEN ");
  });

  it("createSession: a tmux that printed no pane id still gets its first shell restarted, aimed at the session's own pane", async () => {
    const { adapter, calls } = argvAdapter("");
    expect(await adapter.createSession("dev-impl@rig", undefined, LAUNCH_ENV)).toEqual({ ok: true });
    expect(calls.find(a => a[1] === "respawn-pane")).toEqual(["tmux", "respawn-pane", "-k", "-t", "=dev-impl@rig:"]);
  });

  it("createSession: a first shell that could not be restarted with the credentials fails the launch and removes the session", async () => {
    const { ops } = recordingFileOps();
    const calls: string[][] = [];
    const adapter = new TmuxAdapter(async () => "", ops, async argv => {
      calls.push(argv);
      if (argv[1] === "new-session") return "%1\n";
      if (argv[1] === "respawn-pane") throw new Error("can't find pane: %1");
      return "";
    });
    const result = await adapter.createSession("dev-impl@rig", undefined, LAUNCH_ENV);
    expect(result.ok).toBe(false);
    expect(calls.some(a => a[1] === "kill-session" && a.includes("=dev-impl@rig"))).toBe(true);
  });

  it("createSession: the first shell started before the credentials existed is restarted after they are set", async () => {
    const { adapter, calls } = argvAdapter("%7\n");
    await adapter.createSession("dev-impl@rig", undefined, LAUNCH_ENV);
    const order = calls.map(a => a[1]);
    expect(order.indexOf("new-session")).toBeLessThan(order.indexOf("source-file"));
    expect(order.indexOf("source-file")).toBeLessThan(order.indexOf("respawn-pane"));
    expect(calls.find(a => a[1] === "respawn-pane")).toEqual(["tmux", "respawn-pane", "-k", "-t", "%7"]);
  });

  it("createSession: credentials that cannot be delivered fail the launch and remove the session, naming no value", async () => {
    const { adapter, calls } = argvAdapter();
    const result = await adapter.createSession("dev-impl@rig", undefined, { ...LAUNCH_ENV, OPENRIG_ACTIVITY_HOOK_TOKEN: `${HOOK}\nx` });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(HOOK);
    expect(calls.some(a => a[1] === "kill-session" && a.includes("=dev-impl@rig"))).toBe(true);
    expect(calls.some(a => a[1] === "respawn-pane")).toBe(false);
  });

  it("createSession: when tmux refuses the credential file, the failure it reports carries none of the file's content", async () => {
    const { ops } = recordingFileOps();
    // tmux can echo script text in a parse error: this fake does exactly that.
    const adapter = new TmuxAdapter(async () => "", ops, async argv => {
      if (argv[1] === "new-session") return "%1\n";
      if (argv[1] === "source-file") throw new Error(`${argv[2]}:1: unknown command: set-environment ${HOOK} ${PROVIDER}`);
      return "";
    });
    const result = await adapter.createSession("dev-impl@rig", undefined, LAUNCH_ENV);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(HOOK);
    expect(JSON.stringify(result)).not.toContain(PROVIDER);
  });

  it("createSession: a launch with no credential never touches the file channel", async () => {
    const { adapter, calls, seen } = argvAdapter();
    await adapter.createSession("dev-impl@rig", undefined, { OPENRIG_NODE_ID: "n" });
    expect(seen.writes).toEqual([]);
    expect(calls.some(a => a[1] === "source-file")).toBe(false);
  });

  it("respawnPane: no argv element and no shell string carries a credential; they are set before the respawn", async () => {
    const { adapter, legacyAdapter, calls, legacy, seen } = argvAdapter();
    expect(await adapter.respawnPane("%3", "/bin/sh", { cwd: "/w", env: LAUNCH_ENV })).toEqual({ ok: true });
    expect(await legacyAdapter.respawnPane("%3", "/bin/sh", { cwd: "/w", env: LAUNCH_ENV })).toEqual({ ok: true });
    for (const secret of [HOOK, PROVIDER]) {
      expect(calls.flat().some(a => a.includes(secret))).toBe(false);
      expect(legacy.some(c => c.includes(secret))).toBe(false);
    }
    expect(calls.find(a => a[1] === "respawn-pane")).toEqual(expect.arrayContaining(["-e", "OPENRIG_NODE_ID=node-1"]));
    const order = calls.map(a => a[1]);
    expect(order.indexOf("source-file")).toBeLessThan(order.indexOf("respawn-pane"));
    expect(seen.writes[0]!.mode).toBe(0o600);
    expect(seen.writes[0]!.flag).toBe("wx");
    expect(seen.unlinked).toEqual([seen.writes[0]!.path]);
  });

  it("respawnPane: credentials that cannot be delivered refuse the respawn and leave the pane alone", async () => {
    const { adapter, calls } = argvAdapter();
    const result = await adapter.respawnPane("%3", "/bin/sh", { env: { ANTHROPIC_API_KEY: `${PROVIDER}\r` } });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(PROVIDER);
    expect(calls.some(a => a[1] === "respawn-pane")).toBe(false);
  });
});

// OF-113: respawnPane sets the credentials in the SESSION environment before it respawns, and that environment outlives
// the call (a later window or respawn inherits it). A respawn that does not happen used to leave the new credentials
// there. It now puts the session environment back as it was: a key the session held is set to its old value again
// (through the credential file), a key it did not hold is unset.
describe("OF-113: a respawn that does not happen leaves the session environment as it was", () => {
  const OLD_HOOK = "synthetic-previous-hook-token-77aa01";

  function scripted(opts: { before?: string | Error; respawnFails?: boolean; failFirstSourceFile?: boolean }) {
    const { ops, seen } = recordingFileOps();
    const calls: string[][] = [];
    let sourceFiles = 0;
    const argvExec = async (argv: string[]) => {
      calls.push(argv);
      if (argv[1] === "show-environment" && !argv.includes("-g")) {
        if (opts.before instanceof Error) throw opts.before;
        return opts.before ?? "";
      }
      if (argv[1] === "source-file" && ++sourceFiles === 1 && opts.failFirstSourceFile) throw new Error("tmux: set-environment failed");
      if (argv[1] === "respawn-pane" && opts.respawnFails) throw new Error("pane %3 is not dead");
      return "";
    };
    const adapter = new TmuxAdapter(async () => "", ops, argvExec);
    return { adapter, calls, seen };
  }
  const NEW_ENV = { OPENRIG_NODE_ID: "node-1", OPENRIG_ACTIVITY_HOOK_TOKEN: HOOK, ANTHROPIC_API_KEY: PROVIDER };
  const unsets = (calls: string[][]) => calls.filter(a => a[1] === "set-environment").map(a => a.slice(2));

  it("a refused respawn restores the key the session held (through the file, 0600, exclusive) and unsets the one it did not", async () => {
    const { adapter, calls, seen } = scripted({ before: `PATH=/usr/bin\nOPENRIG_ACTIVITY_HOOK_TOKEN=${OLD_HOOK}\n`, respawnFails: true });
    const result = await adapter.respawnPane("%3", "/bin/sh", { env: NEW_ENV });
    expect(result.ok).toBe(false);
    // The new credentials were delivered, the respawn was attempted, then the old state came back.
    expect(seen.writes).toHaveLength(2);
    expect(seen.writes[0]!.content).toContain(HOOK);
    expect(seen.writes[1]!.content).toBe(`set-environment -t '%3' OPENRIG_ACTIVITY_HOOK_TOKEN '${OLD_HOOK}'\n`);
    expect(seen.writes[1]!.mode).toBe(0o600);
    expect(seen.writes[1]!.flag).toBe("wx");
    expect(unsets(calls)).toEqual([["-t", "%3", "-u", "ANTHROPIC_API_KEY"]]);
    const order = calls.map(a => a[1]);
    expect(order.indexOf("respawn-pane")).toBeLessThan(order.lastIndexOf("source-file"));
    // Neither the new nor the restored credential rode an argv, and the failure names none.
    for (const secret of [HOOK, PROVIDER, OLD_HOOK]) {
      expect(calls.flat().some(a => a.includes(secret))).toBe(false);
      expect(JSON.stringify(result)).not.toContain(secret);
    }
    expect(seen.unlinked).toEqual(seen.writes.map(w => w.path));
  });

  it("with the session environment unreadable, every credential key is unset (nothing is left behind)", async () => {
    const { adapter, calls, seen } = scripted({ before: new Error("no server"), respawnFails: true });
    expect((await adapter.respawnPane("%3", "/bin/sh", { env: NEW_ENV })).ok).toBe(false);
    expect(unsets(calls)).toEqual([["-t", "%3", "-u", "OPENRIG_ACTIVITY_HOOK_TOKEN"], ["-t", "%3", "-u", "ANTHROPIC_API_KEY"]]);
    expect(seen.writes).toHaveLength(1); // only the delivery of the new credentials
  });

  it("a delivery that fails part way is restored too, and the respawn is never attempted", async () => {
    const { adapter, calls } = scripted({ before: `OPENRIG_ACTIVITY_HOOK_TOKEN=${OLD_HOOK}\n`, failFirstSourceFile: true });
    const result = await adapter.respawnPane("%3", "/bin/sh", { env: NEW_ENV });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(HOOK);
    expect(calls.some(a => a[1] === "respawn-pane")).toBe(false);
    expect(unsets(calls)).toEqual([["-t", "%3", "-u", "ANTHROPIC_API_KEY"]]);
    expect(calls.filter(a => a[1] === "source-file")).toHaveLength(2); // the failed delivery, then the restore of the old token
  });

  it("control: a respawn that happens leaves the new credentials in place and restores nothing", async () => {
    const { adapter, calls, seen } = scripted({ before: `OPENRIG_ACTIVITY_HOOK_TOKEN=${OLD_HOOK}\n` });
    expect((await adapter.respawnPane("%3", "/bin/sh", { env: NEW_ENV })).ok).toBe(true);
    expect(seen.writes).toHaveLength(1);
    expect(unsets(calls)).toEqual([]);
  });

  it("control: a respawn with no credential reads and restores nothing", async () => {
    const { adapter, calls, seen } = scripted({ respawnFails: true });
    expect((await adapter.respawnPane("%3", "/bin/sh", { env: { OPENRIG_NODE_ID: "node-1" } })).ok).toBe(false);
    expect(seen.writes).toEqual([]);
    expect(calls.some(a => a[1] === "show-environment" && !a.includes("-g"))).toBe(false);
    expect(unsets(calls)).toEqual([]);
  });
});

// OF-113 / OF-132: some tmux builds (Ubuntu's 3.4-1ubuntu0.1, measured) print a `$` in a show-environment value with a
// backslash before it, depending on the character after it; others (3.7c, measured) print the value as it is. The version
// says nothing about it, and the rule is not known for every character, so getSessionEnv MEASURES each value that holds a
// `$`: every plausible original is put into a scratch variable of the same session (through the credential file, never an
// argv), read back, and kept only if tmux prints exactly the text that was shown. No match or more than one refuses.
describe("OF-132: getSessionEnv returns the value the session holds, on any tmux build (measured per value, not by version)", () => {
  // The builds, as `forward`: the text this build prints for a stored value.
  const BUILDS = {
    raw: (v: string) => v, // 3.7c, and what upstream 3.4 / 3.5a read as
    ubuntu: (v: string) => v.replace(/\$(?=[A-Za-z_{])/g, "\\$"), // measured on 3.4-1ubuntu0.1
    every: (v: string) => v.replace(/\$/g, "\\$"), // the rule the old version gate assumed
    doubling: (v: string) => v.replace(/\$/g, "\\\\$"), // a build nothing here knows how to undo
    twice: (v: string) => v.replace(/\$/g, () => "$$"), // prints a `$` as two, with no backslash to find
    ambiguous: (v: string) => v.replace(/(?<!\\)\$/g, "\\$"), // `a$b` and `a\$b` are both printed `a\$b`
  } as const;
  type Build = keyof typeof BUILDS;
  const unquote = (s: string) => s.replace(/'"'"'/g, "\u0000").replace(/^'|'$/g, "").replace(/\u0000/g, "'");

  /** A tmux with a session environment: source-file applies the set-environment lines of a file the adapter wrote. */
  function fakeTmux(build: Build, initial: Record<string, string>, options: { respawnFails?: boolean; failShow?: boolean; failSource?: boolean; failUnsetProbe?: boolean } = {}) {
    const env = new Map(Object.entries(initial));
    const calls: string[][] = [];
    const { ops, seen } = recordingFileOps();
    const adapter = new TmuxAdapter(async () => "", ops, async argv => {
      calls.push(argv);
      if (argv[1] === "source-file") {
        if (options.failSource) throw new Error("source-file failed");
        const file = [...seen.writes].reverse().find(w => w.path === argv[2])!;
        for (const line of file.content.split("\n")) {
          const m = /^set-environment -t (?:'[^']*'|\S+) (\S+) (.*)$/.exec(line);
          if (m) env.set(m[1]!, unquote(m[2]!));
        }
        return "";
      }
      if (argv[1] === "set-environment" && argv.includes("-u")) {
        if (options.failUnsetProbe && argv.at(-1)!.startsWith("OPENRIG_TMUX_ESCAPE_PROBE_")) throw new Error("set-environment failed");
        env.delete(argv.at(-1)!);
        return "";
      }
      if (argv[1] === "show-environment" && !argv.includes("-g")) {
        if (options.failShow && argv.length > 4) throw new Error("tmux gone");
        const key = argv[4];
        if (key === undefined) return [...env].map(([k, v]) => `${k}=${BUILDS[build](v)}`).join("\n") + "\n";
        return env.has(key) ? `${key}=${BUILDS[build](env.get(key)!)}\n` : `-${key}\n`;
      }
      if (argv[1] === "respawn-pane" && options.respawnFails) throw new Error("pane %3 is not dead");
      return "";
    });
    return { adapter, env, calls, seen };
  }
  const probeKeys = (env: Map<string, string>) => [...env.keys()].filter(k => k.startsWith("OPENRIG_TMUX_ESCAPE_PROBE_"));

  const VALUES = ["plain", "a$b", "$a", "a$", "a$1", "a${b}", "a$(b)", "a$$b", "a\\$b", "\\$e", "x\\$", "p\\$q \\\\$r \\$", "a\\\\$b", "$", "$$$", "tok$_en", "q'$a'z"];
  for (const build of ["raw", "ubuntu", "every"] as const) {
    // The title carries the value with its `$` written as \u0024: vitest reads `$name` in a title as a placeholder.
    it.each(VALUES.map(v => [JSON.stringify(v).replace(/\$/g, "\\u0024"), v] as const))(`build ${build}: the value %s comes back exactly as it was stored`, async (_label, value) => {
      const { adapter, env } = fakeTmux(build, { K_VAR: value });
      expect(await adapter.getSessionEnv("s", "K_VAR")).toBe(value);
      expect(probeKeys(env)).toEqual([]); // the scratch variable is gone
      expect(env.get("K_VAR")).toBe(value); // and the real one untouched
    });
  }

  it("a value with no $ is returned as shown, with no scratch variable written", async () => {
    const { adapter, calls } = fakeTmux("ubuntu", { K_VAR: "plain \\ \" ` value" });
    expect(await adapter.getSessionEnv("s", "K_VAR")).toBe("plain \\ \" ` value");
    expect(calls.map(a => a[1])).toEqual(["show-environment"]);
  });

  it("the version is never asked for", async () => {
    const { adapter, calls } = fakeTmux("ubuntu", { K_VAR: "a$b" });
    await adapter.getSessionEnv("s", "K_VAR");
    expect(calls.some(a => a[1] === "-V")).toBe(false);
  });

  it("the candidate values reach tmux through the credential file only: no argv holds any part of the value", async () => {
    const secret = "s3cr3tvalue$tail";
    const { adapter, calls, seen } = fakeTmux("ubuntu", { K_VAR: secret });
    expect(await adapter.getSessionEnv("s", "K_VAR")).toBe(secret);
    expect(calls.flat().some(a => a.includes("s3cr3t"))).toBe(false);
    expect(seen.writes.length).toBeGreaterThan(0);
    for (const w of seen.writes) { expect(w.mode).toBe(0o600); expect(w.flag).toBe("wx"); }
  });

  // N1 (review of 1c4a649e): the scratch variable holds a credential candidate and sits outside every key list the restore manages,
  // so a failed unset is named (key only) and a leftover is swept the next time the session is probed or restored.
  describe("a scratch variable that outlives its probe", () => {
    const LEFT = "OPENRIG_TMUX_ESCAPE_PROBE_0123456789abcdef0123456789abcdef";
    const SECRET = "cand1date$s3cr3t";
    const logs: string[] = [];
    beforeEach(() => { logs.length = 0; vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => { logs.push(args.join(" ")); }); });
    afterEach(() => { vi.restoreAllMocks(); });
    const warned = () => logs;

    it("a failing unset is named by key (never a value), does not fail the read, and the leftover is swept by the next read before anything new is written", async () => {
      const options = { failUnsetProbe: true };
      const { adapter, env, calls } = fakeTmux("ubuntu", { K_VAR: SECRET }, options);
      expect(await adapter.getSessionEnv("s", "K_VAR")).toBe(SECRET);
      expect(probeKeys(env)).toHaveLength(1); // left behind
      const [left] = probeKeys(env);
      expect(warned().some(m => m.includes(left!) && m.includes("could not remove"))).toBe(true);
      expect(warned().join("\n")).not.toContain("s3cr3t");
      options.failUnsetProbe = false;
      const before = calls.length;
      expect(await adapter.getSessionEnv("s", "K_VAR")).toBe(SECRET);
      expect(probeKeys(env)).toEqual([]);
      const second = calls.slice(before);
      const sweep = second.findIndex(a => a[1] === "set-environment" && a.includes("-u") && a.at(-1) === left);
      const firstWrite = second.findIndex(a => a[1] === "source-file");
      expect(sweep).toBeGreaterThanOrEqual(0);
      expect(sweep).toBeLessThan(firstWrite);
    });

    it("a leftover from a crashed probe is removed by the next probe, and only probe keys are touched", async () => {
      const { adapter, env } = fakeTmux("ubuntu", { K_VAR: SECRET, [LEFT]: "old$candidate", OPENRIG_PROBE_LOOKALIKE: "keep", ANTHROPIC_API_KEY: "keep" });
      expect(await adapter.getSessionEnv("s", "K_VAR")).toBe(SECRET);
      expect(env.has(LEFT)).toBe(false);
      expect([...env.keys()].sort()).toEqual(["ANTHROPIC_API_KEY", "K_VAR", "OPENRIG_PROBE_LOOKALIKE"]);
    });

    it("a leftover is removed by a respawn restore too (the refused respawn of a credentialed seat)", async () => {
      const { adapter, env } = fakeTmux("raw", { OPENRIG_ACTIVITY_HOOK_TOKEN: "old-token", [LEFT]: "old$candidate" }, { respawnFails: true });
      expect((await adapter.respawnPane("%3", "/bin/sh", { env: { OPENRIG_ACTIVITY_HOOK_TOKEN: HOOK } })).ok).toBe(false);
      expect(env.has(LEFT)).toBe(false);
      expect(env.get("OPENRIG_ACTIVITY_HOOK_TOKEN")).toBe("old-token");
    });

    it("control: a read of a value with no $ neither probes nor sweeps", async () => {
      const { adapter, env } = fakeTmux("raw", { K_VAR: "plain", [LEFT]: "x" });
      expect(await adapter.getSessionEnv("s", "K_VAR")).toBe("plain");
      expect(env.has(LEFT)).toBe(true);
    });
  });

  it("a build whose rule nothing can undo refuses (no guess), and leaves no scratch variable", async () => {
    const { adapter, env } = fakeTmux("doubling", { K_VAR: "a$b" });
    await expect(adapter.getSessionEnv("s", "K_VAR")).rejects.toThrow("Cannot read the session's launch environment.");
    expect(probeKeys(env)).toEqual([]);
  });

  it.each([["twice", "a$b"], ["twice", "$"], ["ambiguous", "a$b"], ["ambiguous", "a\\$b"]] as const)(
    "build %s, value %j: a shown text that two different values would print (or none would) refuses rather than choosing", async (build, value) => {
      const { adapter, env } = fakeTmux(build, { K_VAR: value });
      await expect(adapter.getSessionEnv("s", "K_VAR")).rejects.toThrow("Cannot read the session's launch environment.");
      expect(probeKeys(env)).toEqual([]);
    });

  it.each([["the scratch variable cannot be written", { failSource: true }], ["it cannot be read back", { failShow: true }]] as const)(
    "when %s the read refuses, with no scratch variable left", async (_name, options) => {
      const { adapter, env } = fakeTmux("ubuntu", { K_VAR: "a$b" }, options);
      await expect(adapter.getSessionEnv("s", "K_VAR")).rejects.toThrow("Cannot read the session's launch environment.");
      expect(probeKeys(env)).toEqual([]);
    });

  it("the value a refused respawn restores is the one the session held, on a build that escapes", async () => {
    for (const build of ["raw", "ubuntu", "every"] as const) {
      const old = "old$token \\$x";
      const { adapter, env } = fakeTmux(build, { OPENRIG_ACTIVITY_HOOK_TOKEN: old }, { respawnFails: true });
      expect((await adapter.respawnPane("%3", "/bin/sh", { env: { OPENRIG_ACTIVITY_HOOK_TOKEN: HOOK } })).ok).toBe(false);
      expect(env.get("OPENRIG_ACTIVITY_HOOK_TOKEN")).toBe(old);
      expect(probeKeys(env)).toEqual([]);
    }
  });

  it("when the old value cannot be known, a refused respawn unsets the key instead of restoring a guess", async () => {
    const { adapter, env } = fakeTmux("doubling", { OPENRIG_ACTIVITY_HOOK_TOKEN: "old$token" }, { respawnFails: true });
    expect((await adapter.respawnPane("%3", "/bin/sh", { env: { OPENRIG_ACTIVITY_HOOK_TOKEN: HOOK } })).ok).toBe(false);
    expect(env.has("OPENRIG_ACTIVITY_HOOK_TOKEN")).toBe(false);
    expect(probeKeys(env)).toEqual([]);
  });
});

// Real tmux on an owned socket. A `tmux` shim on PATH records the argv of EVERY
// invocation the adapter makes (that is what `ps` could have shown), then runs
// the real tmux against the private socket.
async function withShim(check: (ctx: { adapters: Array<[string, TmuxAdapter]>; home: string; credDir: string; tmux: (a: string[]) => Promise<string>; argvLog: () => string }) => Promise<void>) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tmux-secret-"));
  const socket = path.join(home, "owned.sock");
  const log = path.join(home, "argv.log");
  const realTmux = execFileSync("sh", ["-c", "command -v tmux"], { encoding: "utf8" }).trim();
  const shimDir = path.join(home, "shim");
  fs.mkdirSync(shimDir);
  fs.writeFileSync(path.join(shimDir, "tmux"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexec '${realTmux}' -S '${socket}' "$@"\n`, { mode: 0o755 });
  const env = { ...process.env, HOME: home, SHELL: "/bin/sh", PATH: `${shimDir}:${process.env.PATH}` };
  delete env.TMUX; delete env.TMUX_TMPDIR;
  const tmux = async (args: string[]) => (await runFile(realTmux, ["-S", socket, ...args], { env })).stdout;
  // Credential files land in this test's own directory, so "gone afterwards" is measured on a population only this test writes.
  const credDir = path.join(home, "cred");
  fs.mkdirSync(credDir);
  const fileOps: TmuxFileOps = { ...defaultTmuxFileOps(), tmpName: () => path.join(credDir, `cred-${randomUUID()}`) };
  const shell = new TmuxAdapter(async cmd => (await run(cmd, { env })).stdout, fileOps);
  const argv = new TmuxAdapter(async c => (await run(c, { env })).stdout, fileOps, async a => (await runFile(a[0]!, a.slice(1), { env })).stdout);
  try {
    await check({ adapters: [["shell", shell], ["argv", argv]], home, credDir, tmux, argvLog: () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "") });
  } finally {
    await tmux(["kill-server"]).catch(() => {});
    fs.rmSync(home, { recursive: true, force: true });
  }
}

async function until(read: () => string | undefined, ms = 8000): Promise<string> {
  const end = Date.now() + ms;
  for (;;) {
    const v = read();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out waiting for the pane");
    await new Promise(r => setTimeout(r, 50));
  }
}

describe.skipIf(process.platform === "win32")("OF-46 native tmux: the credential reaches the seat and never an argv", () => {
  for (const mode of [0, 1]) {
    it(`${mode === 0 ? "shell" : "argv"} exec: pane shell and session environment hold the token; no tmux argv, no process on the host does`, async () => {
      await withShim(async ({ adapters, home, credDir, tmux, argvLog }) => {
        const [label, adapter] = adapters[mode]!;
        const name = `of46-${label}`;
        const result = await adapter.createSession(name, home, { ...LAUNCH_ENV, OPENRIG_HOME: home });
        expect(result.ok).toBe(true);
        // Session environment (what later panes and respawns inherit).
        expect(await adapter.getSessionEnv(name, "OPENRIG_ACTIVITY_HOOK_TOKEN")).toBe(HOOK);
        expect(await adapter.getSessionEnv(name, "OPENRIG_NODE_ID")).toBe("node-1");
        // The pane's own shell (the process the seat launch types into). One printenv per name: BSD printenv (macOS)
        // prints only the first name it is given.
        const out = path.join(home, `${label}.out`);
        await tmux(["send-keys", "-t", `=${name}:`, `{ printenv OPENRIG_ACTIVITY_HOOK_TOKEN; printenv ANTHROPIC_API_KEY; } > '${out}.tmp' && mv '${out}.tmp' '${out}'`, "Enter"]);
        expect((await until(() => (fs.existsSync(out) ? fs.readFileSync(out, "utf8") : undefined))).split("\n").filter(Boolean)).toEqual([HOOK, PROVIDER]);
        // What `ps` could ever have shown: every tmux invocation, and the live process table.
        const seen = argvLog();
        expect(seen).toContain("new-session");
        for (const secret of [HOOK, PROVIDER]) {
          expect(seen).not.toContain(secret);
          expect((await run("ps -axo args=")).stdout).not.toContain(secret);
        }
        // The credential file was written (positive control: tmux was told to read one) and is gone.
        expect(seen).toContain("source-file");
        expect(fs.readdirSync(credDir)).toEqual([]);
      });
    });
  }

  it("values with quotes, dollars, hashes, semicolons, backslashes and spaces arrive byte-exact", async () => {
    await withShim(async ({ adapters, home, tmux }) => {
      const adapter = adapters[1]![1];
      const awkward = "a'b\"c $HOME #d ; e\\f ~ %g {h} \tz";
      expect((await adapter.createSession("of46-quote", home, { OPENRIG_NODE_ID: "n", ANTHROPIC_API_KEY: awkward })).ok).toBe(true);
      // Read it where the seat does: in the pane shell (show-environment escapes `$` on its own).
      const out = path.join(home, "quote.out");
      await tmux(["send-keys", "-t", "=of46-quote:", `printenv ANTHROPIC_API_KEY > '${out}.tmp' && mv '${out}.tmp' '${out}'`, "Enter"]);
      expect(await until(() => (fs.existsSync(out) ? fs.readFileSync(out, "utf8") : undefined))).toBe(`${awkward}\n`);
    });
  });

  it("getSessionEnv returns a value exactly as set: dollars, quotes, backticks and backslashes are not escaped (OF-113)", async () => {
    // The seat reads the session environment back with getSessionEnv (launch generation, home). `show-environment`
    // escapes these characters only with -s; a version that escaped them without it would hand a seat a wrong value.
    await withShim(async ({ adapters, home }) => {
      for (const [label, adapter] of adapters) {
        const awkward = "a$b ${c} \"q\" `t` \\d \\$e #f";
        expect((await adapter.createSession(`of113-${label}`, home, { OPENRIG_NODE_ID: "n", ANTHROPIC_API_KEY: awkward })).ok).toBe(true);
        expect(await adapter.getSessionEnv(`of113-${label}`, "ANTHROPIC_API_KEY")).toBe(awkward);
        expect(await adapter.getSessionEnv(`of113-${label}`, "OPENRIG_NODE_ID")).toBe("n");
      }
    });
  });

  it("OF-132 native: a value holding a literal backslash-dollar round-trips on THIS tmux build, whichever way it prints $, and the probe leaves no canary behind", async () => {
    // This is the case a version gate got wrong on a stock 3.4: every `$` in the shown value has a backslash before it
    // either way (escaped by the build, or the value's own), so only a measurement can tell the two apart.
    await withShim(async ({ adapters, home, tmux }) => {
      for (const [label, adapter] of adapters) {
        const tricky = "p\\$q \\\\$r \\$";
        const name = `of132-${label}`;
        expect((await adapter.createSession(name, home, { OPENRIG_NODE_ID: "n", ANTHROPIC_API_KEY: tricky })).ok).toBe(true);
        expect(await adapter.getSessionEnv(name, "ANTHROPIC_API_KEY")).toBe(tricky);
        expect(await tmux(["show-environment", "-t", `=${name}`])).not.toContain("OPENRIG_TMUX_ESCAPE_PROBE");
      }
    });
  });

  it("a respawn tmux refuses leaves the session environment as it was: the old credential back, a new key gone (OF-113)", async () => {
    await withShim(async ({ adapters, home, tmux }) => {
      const adapter = adapters[1]![1];
      expect((await adapter.createSession("of113-resp", home, { OPENRIG_NODE_ID: "n", OPENRIG_ACTIVITY_HOOK_TOKEN: HOOK })).ok).toBe(true);
      const pane = (await tmux(["display-message", "-p", "-t", "=of113-resp", "#{pane_id}"])).trim();
      // The pane is alive, and respawn-pane without -k refuses a live pane: the respawn does not happen.
      const result = await adapter.respawnPane(pane, "sleep 5", { env: { OPENRIG_NODE_ID: "n", OPENRIG_ACTIVITY_HOOK_TOKEN: "synthetic-other-token-0d4e", OPENRIG_NEW_SECRET: PROVIDER } });
      expect(result.ok).toBe(false);
      expect(await adapter.getSessionEnv("of113-resp", "OPENRIG_ACTIVITY_HOOK_TOKEN")).toBe(HOOK);
      expect(await adapter.getSessionEnv("of113-resp", "OPENRIG_NEW_SECRET")).toBeUndefined();
    });
  });

  it("respawnPane in place: the successor shell receives the credential and no argv carries it", async () => {
    await withShim(async ({ adapters, home, tmux, argvLog }) => {
      const adapter = adapters[1]![1];
      expect((await adapter.createSession("of46-resp", home, { OPENRIG_NODE_ID: "n" })).ok).toBe(true);
      const pane = (await tmux(["display-message", "-p", "-t", "=of46-resp", "#{pane_id}"])).trim();
      const out = path.join(home, "resp.out");
      // Handover respawns a pane whose retiree has exited (no -k): do the same.
      await tmux(["set-option", "-w", "-t", pane, "remain-on-exit", "on"]);
      await tmux(["send-keys", "-t", pane, "exit", "Enter"]);
      const deadBy = Date.now() + 8000;
      while ((await tmux(["display-message", "-p", "-t", pane, "#{pane_dead}"])).trim() !== "1") {
        if (Date.now() > deadBy) throw new Error("pane never exited");
        await new Promise(r => setTimeout(r, 50));
      }
      const result = await adapter.respawnPane(pane, `printenv OPENRIG_ACTIVITY_HOOK_TOKEN > '${out}'; sleep 5`, { env: { OPENRIG_NODE_ID: "n", OPENRIG_ACTIVITY_HOOK_TOKEN: HOOK } });
      expect(result.ok).toBe(true);
      expect((await until(() => (fs.existsSync(out) ? fs.readFileSync(out, "utf8") : undefined))).trim()).toBe(HOOK);
      expect(argvLog()).not.toContain(HOOK);
    });
  });

  it("an undeliverable credential fails the launch and leaves no half-credentialed session", async () => {
    await withShim(async ({ adapters, home, tmux, argvLog }) => {
      const adapter = adapters[1]![1];
      const result = await adapter.createSession("of46-bad", home, { OPENRIG_NODE_ID: "n", OPENRIG_ACTIVITY_HOOK_TOKEN: `${HOOK}\nkill-server` });
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain(HOOK);
      expect(await tmux(["list-sessions", "-F", "#{session_name}"]).catch(() => "")).not.toContain("of46-bad");
      expect(argvLog()).not.toContain(HOOK);
    });
  });
});
