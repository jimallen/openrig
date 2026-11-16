import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { prepareHermeticEnv, type HermeticScaffold } from "./helpers/hermetic-env.js";

// workspaces-o9o.66. prepareHermeticEnv copied its base env (process.env by default) and deleted a list: the daemon target,
// credentials, the clock, HC_* and XDG_RUNTIME_DIR. Everything else a seat carries reached the scenario daemon, the rig CLI and
// the TUI through scaffold.env, and the tmux wrapper through tmuxEnv: where transcripts are written, the shared-docs tree, the
// database, the skills root, a harness's own config home. The standalone runners pass a minimal baseEnv; a caller that does not
// (tonight's o9o.61 incident was such a caller of another helper) handed it all over. Every value here names a fake under a temp
// dir; nothing live is read or touched.

const scaffolds: HermeticScaffold[] = [];
const temps: string[] = [];
let restoreEnv: (() => void) | null = null;
afterEach(() => {
  restoreEnv?.();
  restoreEnv = null;
  for (const s of scaffolds.splice(0)) s.cleanup();
  for (const d of temps.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** A seat's names that name live state, minus the ones the scaffold refuses outright (daemon target, tmux attachment, clock). */
function seatNames(root: string): Record<string, string> {
  return {
    OPENRIG_TRANSCRIPTS_PATH: path.join(root, "transcripts"),
    OPENRIG_SHARED_DOCS_ROOT: path.join(root, "shared-docs"),
    OPENRIG_DB: path.join(root, "openrig.sqlite"),
    OPENRIG_SKILLS_ROOT: path.join(root, "skills"),
    OPENRIG_WORKSPACE_ROOT: path.join(root, "workspace"),
    OPENRIG_SESSION_NAME: "impl@seat",
    OPENRIG_NODE_ID: "01SEATNODE",
    RIGGED_HOME: path.join(root, "rigged-home"),
    CODEX_HOME: path.join(root, "codex-home"),
    CLAUDE_CONFIG_DIR: path.join(root, "claude-config"),
    HC_TERMINAL_SOCKET: path.join(root, "hc-terminal.sock"),
    XDG_RUNTIME_DIR: path.join(root, "run"),
    TMUX_PANE: "%0",
  };
}

function leaks(env: Record<string, string | undefined>, seat: Record<string, string>, root: string): string[] {
  const carried = Object.entries(seat).filter(([k, v]) => env[k] === v).map(([k]) => k);
  const naming = Object.entries(env).filter(([, v]) => typeof v === "string" && v.includes(root)).map(([k]) => `${k} (names the seat's root)`);
  return [...new Set([...carried, ...naming])].sort();
}

describe("o9o.66: the scenario scaffold's env is an allow-list", () => {
  it("a base env carrying a seat's names hands none of them to the scenario daemon, CLI, TUI or tmux, and keeps PATH and TERM", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "o9o66-"));
    temps.push(root);
    const seat = seatNames(root);
    const scaffold = prepareHermeticEnv({ baseEnv: { PATH: process.env["PATH"], TERM: "xterm-256color", HOME: path.join(root, "home"), ...seat } });
    scaffolds.push(scaffold);
    expect(leaks(scaffold.env, seat, root)).toEqual([]);
    expect(leaks(scaffold.tmuxEnv, seat, root)).toEqual([]);
    expect(scaffold.env["TERM"]).toBe("xterm-256color");
    expect(scaffold.env["PATH"]?.endsWith(process.env["PATH"] ?? "")).toBe(true);
    expect(scaffold.env["HOME"]).toBe(scaffold.home);
  });

  it("with no base env given it reads process.env the same way: a caller outside vitest leaks nothing", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "o9o66-"));
    temps.push(root);
    const seat = seatNames(root);
    const saved = new Map(Object.keys(seat).map((k) => [k, process.env[k]]));
    Object.assign(process.env, seat);
    restoreEnv = () => { for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
    const scaffold = prepareHermeticEnv();
    scaffolds.push(scaffold);
    expect(leaks(scaffold.env, seat, root)).toEqual([]);
    expect(leaks(scaffold.tmuxEnv, seat, root)).toEqual([]);
  });

  it("childEnv hands names to the children on purpose, after the allow-list, and the scaffold's own paths still win", () => {
    const scaffold = prepareHermeticEnv({
      baseEnv: { PATH: process.env["PATH"] },
      childEnv: { CODEX_HOME: "/configured/codex", ANTHROPIC_BASE_URL: "https://anthropic.example.test", HOME: "/not/the/scaffold", OPENRIG_HOME: "/not/it/either" },
    });
    scaffolds.push(scaffold);
    expect(scaffold.env).toMatchObject({ CODEX_HOME: "/configured/codex", ANTHROPIC_BASE_URL: "https://anthropic.example.test" });
    expect(scaffold.env["HOME"]).toBe(scaffold.home);
    expect(scaffold.env["OPENRIG_HOME"]).toBe(scaffold.openrigHome);
  });

  it.each([
    ["a daemon target", { OPENRIG_URL: "http://127.0.0.1:1" }],
    ["a tmux attachment", { TMUX: "/tmp/x,1,0" }],
  ])("childEnv naming %s is refused, like the base env (the refusals run before the scaffold makes anything)", (_what, childEnv) => {
    expect(() => prepareHermeticEnv({ baseEnv: { PATH: process.env["PATH"] }, childEnv })).toThrow(/refus|hazard|foreign|attach/i);
  });
});
