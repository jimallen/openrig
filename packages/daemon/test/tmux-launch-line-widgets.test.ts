import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { HcAdapter } from "../src/adapters/hc-adapter.js";
import { HcAttach } from "../src/adapters/hc-attach.js";
import { hcTerminalName, SEAT_LABEL } from "../src/adapters/hc-host.js";
import { HcInput } from "../src/adapters/hc-input.js";
import type { TmuxFileOps } from "../src/adapters/tmux.js";
import { findHc, startHcScratch, type HcScratch } from "./helpers/hc-scratch.js";

const q = (v: string) => "'" + v.replaceAll("'", "'\"'\"'") + "'";
let zshPath = "";
try { zshPath = execFileSync("sh", ["-c", "command -v zsh"], { encoding: "utf8" }).trim(); } catch { /* no zsh: the suite skips */ }
// A condition wait: it resolves the moment `f` holds. The ceiling only bounds a genuine hang (the old 5 s one was overrun on a loaded host).
async function until(f: () => boolean | Promise<boolean>, what: string) {
  const deadline = Date.now() + 30_000;
  while (!(await f())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, 25));
  }
}

// OF-64: a zsh loading zsh-autopair rewrote the typed `( . '/tmp/x' )` launch line to
// `( . '/tmp/x' ) )`; zsh reported a parse error and the seat never started. This test stands in
// for ANY keystroke-rewriting widget with one that inserts a closing `)` after every typed `(`.
// The line is sent while .zshrc is still running (a pane whose zsh has not yet enabled bracketed
// paste, the state a seat launch races): the text then reaches the program as plain keystrokes that
// the line editor reads, widgets and all, once the prompt appears. .zshrc holds there until the test opens a
// gate file after its send returns (a fixed 1.5 s hold ended before a send on a loaded host).
describe.skipIf(!findHc() || !zshPath)("launch line survives a keystroke-rewriting zsh widget, on an hc seat", { timeout: 60_000 }, () => {
  let scratch: HcScratch;
  beforeAll(() => { scratch = startHcScratch(); }, 60_000);
  afterAll(() => scratch?.cleanup());

  async function pane() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "of64-widget-"));
    const zdot = path.join(root, "zdot");
    const started = path.join(root, "started"), ready = path.join(root, "ready"), marker = path.join(root, "marker"), gate = path.join(root, "gate");
    fs.mkdirSync(zdot);
    fs.writeFileSync(path.join(zdot, ".zshrc"), [
      `: > ${q(started)}`, "zmodload zsh/zselect", `until [[ -e ${q(gate)} ]]; do zselect -t 5; done`, "PS1='READY> '",
      "_open_pair() { LBUFFER+='('; RBUFFER=\")$RBUFFER\" }", "zle -N _open_pair", "bindkey '(' _open_pair",
      `: > ${q(ready)}`, "",
    ].join("\n"));
    const ops: TmuxFileOps = {
      tmpName: () => path.join(root, `openrig-tmux-send-${process.pid}-${randomUUID()}.txt`),
      bufferName: () => "of64_" + randomUUID().replaceAll("-", ""),
      writeFile: (p, c, o) => fs.promises.writeFile(p, c, { encoding: "utf8", ...o }),
      unlink: p => fs.promises.unlink(p),
    };
    const input = new HcInput(scratch.client(), new HcAttach(scratch.socketPath), { fileOps: ops });
    const reader = new HcAdapter(scratch.client());
    await scratch.client().call("terminal.run", {
      argv: [zshPath, "-d", "-i"], env: { HOME: root, ZDOTDIR: zdot }, name: hcTerminalName("pane"), labels: { [SEAT_LABEL]: "pane" },
      cwd: root, no_parent: true, no_notify: true, outlive_parent: true,
    });
    await until(() => fs.existsSync(started), "zsh startup");
    // sendShellCommand chooses to source the launch in the pane shell from the foreground process hc reports, which it does on its next
    // sweep (about 0.4 s after the start; see the it.fails in claude-interactive-launch.test.ts). Sent earlier, the launch is typed as
    // `/bin/sh <script>` and the sourceInPane row below would not be testing sourcing at all (a mutation of the sourcing line did not
    // fail it until this wait was added).
    await until(async () => !!(await scratch.client().call<{ foreground?: { name?: string } | null }>("terminal.get", { terminal: hcTerminalName("pane") })).foreground?.name, "hc to report the pane's foreground");
    return {
      root, marker, ready, input, screen: () => reader.capturePaneContent("pane", 50),
      release: () => fs.writeFileSync(gate, ""),
      close: async () => { await reader.killSession("pane"); fs.rmSync(root, { recursive: true, force: true }); },
    };
  }

  it("control: the widget does break the old typed form `( . 'file' )`", async () => {
    const p = await pane();
    try {
      const script = path.join(p.root, "old.sh");
      fs.writeFileSync(script, `: > ${q(p.marker)}\n`);
      await p.input.sendText("pane", `( . ${q(script)} )`);
      await p.input.sendKeys("pane", ["Enter"]);
      p.release();
      await until(() => fs.existsSync(p.ready), "zsh prompt");
      await expect.poll(async () => (await p.screen()) ?? "", { timeout: 30_000 }).toContain("parse error");
      expect(fs.existsSync(p.marker)).toBe(false);
      expect(await p.screen()).toContain("parse error");
    } finally { await p.close(); }
  });

  it("sendShellCommand with sourceInPane starts the command and keeps it in a subshell", async () => {
    const p = await pane();
    try {
      expect(await p.input.sendShellCommand("pane", `LEAK=1; : > ${q(p.marker)}`, undefined, { sourceInPane: true })).toEqual({ ok: true });
      p.release();
      await until(() => fs.existsSync(p.marker), "launch marker");
      await until(() => fs.existsSync(p.ready), "zsh prompt");
      const leak = path.join(p.root, "leak");
      await p.input.sendText("pane", `print -r -- "[$LEAK]" > ${q(leak)}`);
      await p.input.sendKeys("pane", ["Enter"]);
      await until(() => fs.existsSync(leak), "leak probe");
      expect(fs.readFileSync(leak, "utf8").trim()).toBe("[]");
    } finally { await p.close(); }
  });

  it("sendShellCommand without sourceInPane (the /bin/sh form) starts the command", async () => {
    const p = await pane();
    try {
      expect(await p.input.sendShellCommand("pane", `: > ${q(p.marker)}`)).toEqual({ ok: true });
      p.release();
      await until(() => fs.existsSync(p.marker), "launch marker");
    } finally { await p.close(); }
  });
});
