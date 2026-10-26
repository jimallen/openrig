import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { exec, execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
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

interface RecordedFiles { writes: Array<{ path: string; content: string; mode?: number }>; unlinked: string[] }

function recordingFileOps(): { ops: TmuxFileOps; seen: RecordedFiles } {
  const inner = defaultTmuxFileOps();
  const seen: RecordedFiles = { writes: [], unlinked: [] };
  return {
    seen,
    ops: {
      ...inner,
      writeFile: async (p, content, options) => { seen.writes.push({ path: p, content, mode: options?.mode }); await inner.writeFile(p, content, options); },
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
        // The pane's own shell (the process the seat launch types into).
        const out = path.join(home, `${label}.out`);
        await tmux(["send-keys", "-t", `=${name}:`, `printenv OPENRIG_ACTIVITY_HOOK_TOKEN ANTHROPIC_API_KEY > '${out}.tmp' && mv '${out}.tmp' '${out}'`, "Enter"]);
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
