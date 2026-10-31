import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { TmuxAdapter, type TmuxFileOps } from "../src/adapters/tmux.js";
import { stopOwnedTmuxServer } from "./helpers/orphan-reaper.js";

const run = promisify(execFile);
const q = (v: string) => "'" + v.replaceAll("'", "'\"'\"'") + "'";
let available = process.platform !== "win32";
for (const [bin, flag] of [["tmux", "-V"], ["zsh", "--version"]] as const) {
  try { execFileSync(bin, [flag], { stdio: "ignore" }); } catch { available = false; }
}
// A condition wait: it resolves the moment `f` holds. The ceiling only bounds a genuine hang (the old 5 s one was overrun on a loaded host).
async function until(f: () => boolean, what: string) {
  const deadline = Date.now() + 30_000;
  while (!f()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, 25));
  }
}

// OF-64: a zsh loading zsh-autopair rewrote the typed `( . '/tmp/x' )` launch line to
// `( . '/tmp/x' ) )`; zsh reported a parse error and the seat never started. This test stands in
// for ANY keystroke-rewriting widget with one that inserts a closing `)` after every typed `(`.
// The line is sent while .zshrc is still running (a pane whose zsh has not yet enabled bracketed
// paste, the state a seat launch races): tmux then delivers it as plain keystrokes that the line
// editor reads, widgets and all, once the prompt appears. .zshrc holds there until the test opens a
// gate file after its send returns (a fixed 1.5 s hold ended before a send on a loaded host).
describe.skipIf(!available)("launch line survives a keystroke-rewriting zsh widget", { timeout: 60_000 }, () => {
  async function pane() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "of64-widget-"));
    const socket = path.join(root, "sock"), zdot = path.join(root, "zdot");
    const started = path.join(root, "started"), ready = path.join(root, "ready"), marker = path.join(root, "marker"), gate = path.join(root, "gate");
    fs.mkdirSync(zdot);
    fs.writeFileSync(path.join(zdot, ".zshrc"), [
      `: > ${q(started)}`, "zmodload zsh/zselect", `until [[ -e ${q(gate)} ]]; do zselect -t 5; done`, "PS1='READY> '",
      "_open_pair() { LBUFFER+='('; RBUFFER=\")$RBUFFER\" }", "zle -N _open_pair", "bindkey '(' _open_pair",
      `: > ${q(ready)}`, "",
    ].join("\n"));
    const env = { HOME: root, PATH: process.env.PATH!, TERM: "xterm-256color", ZDOTDIR: zdot };
    const tm = async (args: string[]) => (await run("tmux", ["-S", socket, "-f", "/dev/null", ...args], { env, timeout: 8000 })).stdout;
    const ops: TmuxFileOps = {
      tmpName: () => path.join(root, `openrig-tmux-send-${process.pid}-${randomUUID()}.txt`),
      bufferName: () => "of64_" + randomUUID().replaceAll("-", ""),
      writeFile: (p, c, o) => fs.promises.writeFile(p, c, { encoding: "utf8", ...o }),
      unlink: p => fs.promises.unlink(p),
    };
    const adapter = new TmuxAdapter(async cmd => (await run("/bin/sh", ["-c", cmd.replace(/^tmux /, `tmux -S ${q(socket)} -f /dev/null `)], { env, timeout: 8000 })).stdout, ops);
    const zshPath = execFileSync("sh", ["-c", "command -v zsh"], { encoding: "utf8" }).trim();
    await tm(["new-session", "-d", "-s", "pane", "-x", "200", "-y", "50", `${q(zshPath)} -d -i`]);
    await until(() => fs.existsSync(started), "zsh startup");
    return { root, marker, ready, tm, adapter, release: () => fs.writeFileSync(gate, ""), close: async () => { await stopOwnedTmuxServer(socket, env); fs.rmSync(root, { recursive: true, force: true }); } };
  }

  it("control: the widget does break the old typed form `( . 'file' )`", async () => {
    const p = await pane();
    try {
      const script = path.join(p.root, "old.sh");
      fs.writeFileSync(script, `: > ${q(p.marker)}\n`);
      await p.adapter.sendText("pane", `( . ${q(script)} )`);
      await p.adapter.sendKeys("pane", ["Enter"]);
      p.release();
      await until(() => fs.existsSync(p.ready), "zsh prompt");
      await expect.poll(() => p.tm(["capture-pane", "-p", "-t", "pane"]), { timeout: 30_000 }).toContain("parse error");
      expect(fs.existsSync(p.marker)).toBe(false);
      expect(await p.tm(["capture-pane", "-p", "-t", "pane"])).toContain("parse error");
    } finally { await p.close(); }
  });

  it("sendShellCommand with sourceInPane starts the command and keeps it in a subshell", async () => {
    const p = await pane();
    try {
      expect(await p.adapter.sendShellCommand("pane", `LEAK=1; : > ${q(p.marker)}`, undefined, { sourceInPane: true })).toEqual({ ok: true });
      p.release();
      await until(() => fs.existsSync(p.marker), "launch marker");
      await until(() => fs.existsSync(p.ready), "zsh prompt");
      const leak = path.join(p.root, "leak");
      await p.adapter.sendText("pane", `print -r -- "[$LEAK]" > ${q(leak)}`);
      await p.adapter.sendKeys("pane", ["Enter"]);
      await until(() => fs.existsSync(leak), "leak probe");
      expect(fs.readFileSync(leak, "utf8").trim()).toBe("[]");
    } finally { await p.close(); }
  });

  it("sendShellCommand without sourceInPane (the /bin/sh form) starts the command", async () => {
    const p = await pane();
    try {
      expect(await p.adapter.sendShellCommand("pane", `: > ${q(p.marker)}`)).toEqual({ ok: true });
      p.release();
      await until(() => fs.existsSync(p.marker), "launch marker");
    } finally { await p.close(); }
  });
});
