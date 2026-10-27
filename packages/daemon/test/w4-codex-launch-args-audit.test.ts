// OF-132 typed-name audit remainder: the two Codex launch-argument builders that were not in the typed-input census.
//   codexNetworkDefaultArg (domain/codex-network-default.ts): its text is a constant; the seat name and cwd reach only a log line.
//   codexTeamWorkspaceArg  (domain/codex-team-workspace.ts):  ` --add-dir <shellQuote(root)>` for roots that are absolute
//   paths, the pod root being built only from names that pass [A-Za-z0-9][A-Za-z0-9._-]*.
// Both strings are appended to a launch line a pane shell parses, so the property pinned is: whatever the names are, the shell
// reads back exactly the fixed words, and a root that is not a plain absolute path is not added.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CODEX_NETWORK_DEFAULT_OVERRIDE, codexNetworkDefaultArg } from "../src/domain/codex-network-default.js";
import { codexQueueStateRoot, codexTeamWorkspaceArg, prepareCodexTeamWorkspace } from "../src/domain/codex-team-workspace.js";
import { observeCodexSandbox } from "../src/domain/permission-drift.js";

/** The words a POSIX shell reads from `segment`, one per line (printf prints each argument it is given). */
function shellWords(segment: string): string[] {
  const out = execFileSync("/bin/sh", ["-c", `printf '%s\\n' ${segment}`], { encoding: "utf8" });
  return out.split("\n").slice(0, -1);
}

const HOSTILE = ["x; touch /tmp/w4-owned", "$(touch /tmp/w4-owned)", "`touch /tmp/w4-owned`", "a b", "it's", 'q"q', "-x", "--add-dir", "a\nb", "=ls", "*"];

describe("codexNetworkDefaultArg: the segment is a constant whatever the seat name and cwd are", () => {
  const floor = observeCodexSandbox(" -s workspace-write");
  const apply = async () => ({ apply: true as const, elapsedMs: 1 });
  beforeEach(() => { vi.spyOn(console, "log").mockImplementation(() => undefined); });
  afterEach(() => { vi.restoreAllMocks(); });

  it.each(HOSTILE)("session and cwd %j: the same segment, read by a shell as -c <override>", async (hostile) => {
    const segment = await codexNetworkDefaultArg(apply, floor, hostile, hostile);
    expect(segment).toBe(` -c '${CODEX_NETWORK_DEFAULT_OVERRIDE}'`);
    expect(shellWords(segment)).toEqual(["-c", CODEX_NETWORK_DEFAULT_OVERRIDE]);
  });
  it("control: the reader's refusal adds nothing", async () => {
    expect(await codexNetworkDefaultArg(async () => ({ apply: false, reason: "no", elapsedMs: 1 }), floor, "/p", "s")).toBe("");
  });
});

describe("codexTeamWorkspaceArg: every root is one quoted word after --add-dir", () => {
  beforeEach(() => { vi.spyOn(console, "warn").mockImplementation(() => undefined); });
  afterEach(() => { vi.restoreAllMocks(); });

  it.each(HOSTILE.filter((h) => !h.includes("\n")))("a root holding %j reaches the shell as exactly that path", (hostile) => {
    const root = `/work/${hostile}`;
    expect(shellWords(codexTeamWorkspaceArg(() => [root], "s@r"))).toEqual(["--add-dir", root]);
  });
  it("two roots are two --add-dir pairs, in order", () => {
    expect(shellWords(codexTeamWorkspaceArg(() => ["/a b", "/c'd"], "s@r"))).toEqual(["--add-dir", "/a b", "--add-dir", "/c'd"]);
  });
  it("a preparer that throws adds nothing (and does not fail the launch)", () => {
    expect(codexTeamWorkspaceArg(() => { throw new Error("boom"); }, "s@r")).toBe("");
    expect(codexTeamWorkspaceArg(undefined, "s@r")).toBe("");
  });
});

describe("prepareCodexTeamWorkspace / codexQueueStateRoot: roots come from validated names and absolute paths only", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "w4-team-")));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => { vi.restoreAllMocks(); fs.rmSync(dir, { recursive: true, force: true }); });

  it.each(["dev-x;touch@r", "dev-$(x)@r", "dev-x@r y", "dev-x@..", "..-x@r", "dev-x@r/../..", "dev-x y@r", "-dev-x@r", "dev--@r", "dev@r"])(
    "a session name %j contributes no pod root", (name) => {
      expect(codexQueueStateRoot(name, "/shared")).toBeUndefined();
    });
  it("a canonical name contributes exactly <shared>/rigs/<rig>/state/<pod>, which stays inside the shared root", () => {
    expect(codexQueueStateRoot("dev-impl@my-rig", "/shared")).toBe("/shared/rigs/my-rig/state/dev");
    const dotted = codexQueueStateRoot("a..-b@r.1", "/shared")!;
    expect(path.relative("/shared", dotted).startsWith("..")).toBe(false);
  });
  it("a relative workspace root is not added", () => {
    const home = path.join(dir, "home"); fs.mkdirSync(home);
    expect(prepareCodexTeamWorkspace("x;y@r", "relative/work", path.join(dir, "shared"), home)).toEqual([]);
  });
  it("an absolute workspace root that is created and does not hold the home directory is added; the home directory itself is not", () => {
    const home = path.join(dir, "home"); fs.mkdirSync(home);
    const work = path.join(dir, "work dir's");
    expect(prepareCodexTeamWorkspace("x;y@r", work, path.join(dir, "shared"), home)).toEqual([work]);
    expect(prepareCodexTeamWorkspace("x;y@r", dir, path.join(dir, "shared"), home)).toEqual([]);
  });
});
