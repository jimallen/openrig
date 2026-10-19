// Executes a command that the CLI PRINTED as advice, through the real command tree, against a capturing client.
// A pin on the wording of advice proves nothing about whether the advice works; this runs it.
import { vi } from "vitest";
import { Command } from "commander";
import { seatCommand } from "../../src/commands/seat.js";
import { STATE_FILE, type DaemonState, type LifecycleDeps } from "../../src/daemon-lifecycle.js";
import type { StatusDeps } from "../../src/commands/status.js";

/** Split `rig seat launch 'a@b' --fresh --reason "x"` into argv: single quotes (with the `'"'"'` splice), double quotes, bare words. */
export function shellWords(command: string): string[] {
  const words: string[] = [];
  let current = "";
  let started = false;
  let quote: "'" | '"' | null = null;
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = null; else current += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch; started = true;
    } else if (/\s/.test(ch)) {
      if (started || current) { words.push(current); current = ""; started = false; }
    } else {
      current += ch; started = true;
    }
  }
  if (started || current) words.push(current);
  return words;
}

/** The first `rig seat launch ...` command in printed output, to the end of its line. */
export function printedSeatLaunchCommands(output: string): string[] {
  return output.split("\n").map((line) => /rig seat launch .*/.exec(line)?.[0]).filter((c): c is string => !!c);
}

/** Run a printed `rig <args>` command through the real seat command tree. Returns what the CLI would POST. */
export async function runPrintedSeatCommand(command: string, reasonForWhy = "advice executed by test"): Promise<{ path: string; body: Record<string, unknown> }> {
  const words = shellWords(command);
  if (words[0] !== "rig" || words[1] !== "seat") throw new Error(`advised command is not a rig seat command: ${command}`);
  const argv = words.map((w) => (w === "<why>" ? reasonForWhy : w));
  const lifecycleDeps: LifecycleDeps = {
    spawn: vi.fn(() => ({ pid: 1, unref: vi.fn() }) as never),
    fetch: vi.fn(async () => ({ ok: true })),
    kill: vi.fn(() => true),
    readFile: vi.fn((p: string) => p === STATE_FILE ? JSON.stringify({ pid: 123, port: 7433, db: "t.sqlite", startedAt: "2026-10-19T00:00:00Z" } as DaemonState) : null),
    writeFile: vi.fn(), removeFile: vi.fn(),
    exists: vi.fn((p: string) => p === STATE_FILE),
    mkdirp: vi.fn(), openForAppend: vi.fn(() => 3), isProcessAlive: vi.fn(() => true),
  };
  const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
  const deps: StatusDeps = {
    lifecycleDeps,
    clientFactory: () => ({
      get: vi.fn(),
      post: vi.fn(async (path: string, body?: unknown) => {
        posts.push({ path, body: (body ?? {}) as Record<string, unknown> });
        return { status: 200, data: { ok: true, status: "ready", sessionName: "x", seat: { logicalId: "x", rigName: "y" }, supersededSessionIds: [] } };
      }),
    }) as unknown as StatusDeps["clientFactory"] extends (url: string) => infer T ? T : never,
  };
  const program = new Command();
  program.exitOverride();
  program.addCommand(seatCommand(deps));
  const originalLog = console.log;
  console.log = () => undefined;
  try { await program.parseAsync(["node", ...argv]); } finally { console.log = originalLog; }
  if (posts.length !== 1) throw new Error(`advised command made ${posts.length} daemon calls: ${command}`);
  return posts[0]!;
}
