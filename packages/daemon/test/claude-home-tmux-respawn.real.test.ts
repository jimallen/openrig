// A real tmux server (a private socket directory; never the operator's): the session environment outlives
// respawn-pane, so a seat's Claude home the predecessor was launched with reaches its successor unless the respawn
// removes it. `rig seat set-claude-home --clear` then handover must give the successor the daemon's own home.
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TmuxAdapter } from "../src/adapters/tmux.js";

const HAS_TMUX = (() => { try { execFileSync("tmux", ["-V"], { stdio: "ignore" }); return true; } catch { return false; } })();

describe.skipIf(!HAS_TMUX || process.platform === "win32")("a respawned pane and the session's CLAUDE_CONFIG_DIR (real tmux)", () => {
  let base: string;
  let env: NodeJS.ProcessEnv;
  let adapter: TmuxAdapter;
  const tmux = (...args: string[]) => execFileSync("tmux", args, { env, encoding: "utf8" });

  beforeAll(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), "ccd-tmux-")));
    env = { PATH: process.env.PATH, HOME: base, TMUX_TMPDIR: base, TERM: "xterm-256color", SHELL: "/bin/sh" };
    adapter = new TmuxAdapter((cmd) => new Promise((resolve, reject) => {
      execFile("/bin/sh", ["-c", cmd], { env, encoding: "utf8" }, (error, stdout, stderr) => (error ? reject(new Error(`${stderr}${error.message}`)) : resolve(stdout)));
    }));
  });
  afterAll(() => {
    try { tmux("kill-server"); } catch { /* already gone */ }
    rmSync(base, { recursive: true, force: true });
  });

  /** Make a seat session launched with a home, end its program in place, respawn with `opts`, and say what the new program saw. */
  async function successorSees(session: string, opts: { unsetEnv?: string[] }): Promise<string> {
    const made = await adapter.createSession(session, base, { OPENRIG_NODE_ID: "n", CLAUDE_CONFIG_DIR: "/h/cel" });
    expect(made.ok).toBe(true);
    expect(tmux("show-environment", "-t", `=${session}`, "CLAUDE_CONFIG_DIR").trim()).toBe("CLAUDE_CONFIG_DIR=/h/cel");
    const pane = tmux("list-panes", "-t", `=${session}`, "-F", "#{pane_id}").trim();
    tmux("set-option", "-p", "-t", pane, "remain-on-exit", "on");
    tmux("send-keys", "-t", pane, "exit", "Enter");
    for (let i = 0; i < 100 && tmux("display-message", "-p", "-t", pane, "#{pane_dead}").trim() !== "1"; i++) await new Promise((r) => setTimeout(r, 50));
    const out = join(base, `${session}.out`);
    const respawned = await adapter.respawnPane(pane, `printf %s "\${CLAUDE_CONFIG_DIR-unset}" > ${out}`, { env: { OPENRIG_NODE_ID: "n" }, ...opts });
    expect(respawned.ok).toBe(true);
    for (let i = 0; i < 100 && !existsSync(out); i++) await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 100));
    return readFileSync(out, "utf8");
  }

  it("control: without the removal the successor inherits the predecessor's home (the defect)", async () => {
    expect(await successorSees("ctl@r", {})).toBe("/h/cel");
  });

  it("removing CLAUDE_CONFIG_DIR before the respawn gives the successor none (the daemon's own selection)", async () => {
    expect(await successorSees("cleared@r", { unsetEnv: ["CLAUDE_CONFIG_DIR"] })).toBe("unset");
    // Removed from the session (not marked -r), so a later process sees the server's global value: the daemon's own.
    expect(() => tmux("show-environment", "-t", "=cleared@r", "CLAUDE_CONFIG_DIR")).toThrow();
  });
});
