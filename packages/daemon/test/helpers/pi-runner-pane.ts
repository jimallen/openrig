// OF-213 (widened): the real Pi runner as the program of a terminal on a PRIVATE hc core, against an offline fake `pi`, and the reads the
// pane tests share. The fake logs every message it is given (prompt, steer, follow-up) to a file, so a test can count what REACHED Pi.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { HcScratch } from "./hc-scratch.js";
import { seedPiFixtureCredential } from "./pi-fixture-credential.js";

const PACKAGE_DIR = fileURLToPath(new URL("../..", import.meta.url));
const RUNNERS = fileURLToPath(new URL("../../src/adapters/", import.meta.url));

export async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, what: string, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}; last: ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

export interface PanePi {
  /** Start the runner as terminal `terminal` for seat `session`. */
  start(terminal: string, session: string, options?: { noPi?: boolean; keep?: boolean }): Promise<void>;
  /** What the pane shows now (the screen only). */
  screen(terminal: string): Promise<string[]>;
  /** The screen and `lines` of scrollback above it. */
  history(terminal: string, lines?: number): Promise<string[]>;
  /** The messages the fake Pi was given, in order: [command type, message]. */
  received(): Array<[string, string]>;
  /** Press keys / type text without Enter (hc `terminal.keys`). */
  keys(terminal: string, keys: string[]): Promise<void>;
}

/** `slow` in a prompt makes the fake's turn last 6 s (a busy seat); `flood` makes it write 300 lines to stderr first, `hostile` one stderr line full of region, cursor and erase sequences. */
export function panePi(scratch: HcScratch, temp: string): PanePi {
  const bin = path.join(temp, "bin");
  const receivedLog = path.join(temp, "received.log");
  fs.mkdirSync(bin, { recursive: true });
  const sessionFile = path.join(temp, "session.jsonl");
  fs.writeFileSync(sessionFile, "fixture\n");
  fs.writeFileSync(path.join(bin, "pi"), `#!${process.execPath}
const fs = require("node:fs");
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const cmd = JSON.parse(line);
  if (cmd.type === "get_state") out({ type: "response", id: cmd.id, success: true, data: { sessionFile: ${JSON.stringify(sessionFile)}, sessionId: "offline" } });
  if (cmd.type === "prompt" || cmd.type === "steer" || cmd.type === "follow_up") {
    fs.appendFileSync(${JSON.stringify(receivedLog)}, JSON.stringify([cmd.type, cmd.message]) + "\\n");
    if (cmd.id) out({ type: "response", id: cmd.id, success: true });
  }
  if (cmd.type === "prompt") {
    if (String(cmd.message).includes("hostile")) process.stderr.write("\\x1b[1;3r\\x1b7\\x1b8\\x1b[?7h\\x1b[2J\\x1b[H\\x1b[5;5H\\x1b[r hostile-visible\\n");
    if (String(cmd.message).includes("flood")) for (let i = 0; i < 300; i++) process.stderr.write("flood line " + i + "\\n");
    out({ type: "agent_start" });
    setTimeout(() => out({ type: "agent_end", messages: [], willRetry: false }), String(cmd.message).includes("slow") ? 6000 : 300);
  }
});\n`, { mode: 0o700 });
  const lines = async (terminal: string, n: number) => (await scratch.client().call<{ text: string }>("terminal.read", { terminal, lines: n })).text.split("\n");
  return {
    async start(terminal, session, options = {}) {
      seedPiFixtureCredential(path.join(temp, "state"), session, "openai-codex");
      await scratch.client().call("terminal.run", {
        argv: [process.execPath, "--import", "tsx", path.join(RUNNERS, "pi-runner.ts"), "--session-name", session, "--state-root", path.join(temp, "state"),
          "--cwd", temp, "--launch-id", "of213", "--no-approve", "--model", "openai-codex/gpt-6-luna:medium"],
        name: terminal, cwd: PACKAGE_DIR, env: { PATH: options.noPi ? path.dirname(process.execPath) : `${bin}${path.delimiter}${path.dirname(process.execPath)}`, OPENRIG_HOME: path.join(temp, "home") },
        labels: { "openrig.seat": terminal }, ...(options.keep ? { keep: true } : {}), no_parent: true, no_notify: true, outlive_parent: true,
      });
    },
    screen: (terminal) => lines(terminal, 0),
    history: (terminal, n = 2000) => lines(terminal, n),
    received: () => (fs.existsSync(receivedLog) ? fs.readFileSync(receivedLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as [string, string]) : []),
    keys: async (terminal, keys) => { await scratch.client().call("terminal.keys", { terminal, keys }); },
  };
}
