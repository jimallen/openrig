// workspaces-o9o.161, ports 2 and 3: the last two domain modules that reached the file system themselves. Crash-cart's probes keep
// their rules in the domain (how a fetch rejection is classified, how daemon.json is parsed) and their I/O moves to an adapter
// (src/adapters/node-crash-cart-probes.ts: the daemon.json read under the credential rule, and the process-liveness signal). The
// hexagonal import census (fork-hexagonal-boundary) sees the imports; this file also pins the process calls it cannot see, and
// drives the domain's rules with no file at all.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseDaemonState } from "../src/domain/crash-cart-probes.js";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const IO_IN_DOMAIN = [/from\s+["']node:/, /\bprocess\.(kill|getuid|env|cwd)\b/, /from\s+["'][^"']*adapters\//];

/** Each non-comment line of a scanned file that does I/O itself, as "file:line". */
export function ioInDomain(files: Record<string, string>): string[] {
  return Object.entries(files).flatMap(([file, text]) => text.split("\n").flatMap((line, i) =>
    /^\s*(\/\/|\*|\/\*)/.test(line) ? [] : IO_IN_DOMAIN.some((re) => re.test(line)) ? [`${file}:${i + 1}`] : []));
}

describe("workspaces-o9o.161: crash-cart's probes keep their rules in the domain and their I/O in an adapter", () => {
  it("the scanner finds a node: import, a process call and an adapter import, and skips comment lines (its own control)", () => {
    expect(ioInDomain({
      "a.ts": "import { readFileSync } from \"node:fs\";\n// process.kill(pid, 0) in a comment\nprocess.kill(pid, 0);",
      "b.ts": "import { x } from '../adapters/tmux.js';\nimport type { DaemonStateFile } from \"./crash-cart-detect.js\";",
    })).toEqual(["a.ts:1", "a.ts:3", "b.ts:1"]);
  });

  it("the domain's crash-cart probes import no node: module and make no process call", () => {
    const file = "domain/crash-cart-probes.ts";
    expect(ioInDomain({ [file]: readFileSync(SRC + file, "utf8") })).toEqual([]);
  });

  it("daemon.json is parsed by the domain: pid and port must be numbers, host is kept only as a string", () => {
    expect(parseDaemonState(JSON.stringify({ pid: 4242, port: 41111, host: "127.0.0.1" }))).toEqual({ pid: 4242, port: 41111, host: "127.0.0.1" });
    expect(parseDaemonState(JSON.stringify({ pid: 4242, port: 41111, host: 7 }))).toEqual({ pid: 4242, port: 41111, host: undefined });
    expect(parseDaemonState(JSON.stringify({ pid: "4242", port: 41111 }))).toBeUndefined();
    expect(parseDaemonState(JSON.stringify({ pid: 4242 }))).toBeUndefined();
    expect(parseDaemonState("{not json")).toBeUndefined();
  });
});
