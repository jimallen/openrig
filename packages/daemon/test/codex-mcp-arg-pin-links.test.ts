// OF-55: a pinned MCP config file with more than one hard link is refused, as a spec file is. A link elsewhere
// could change the bytes after the sha256 pin was taken. Rows restate the rule; none imports the pin helper's internals.
import { afterAll, describe, expect, it } from "vitest";
import { linkSync, mkdtempSync, realpathSync, rmSync, writeFileSync, type Stats } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_PATH_JUDGE_IO, mcpArgFileProblem, mcpArgFilePins, type PathJudgeIo } from "../src/domain/codex-mcp-servers.js";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "mcp-pin-links-")));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const file = (links = 1) => {
  const f = join(dir, `cfg-${n++}.toml`);
  writeFileSync(f, "x = 1\n");
  for (let i = 1; i < links; i++) linkSync(f, `${f}.other${i}`);
  return f;
};

describe("pinned MCP argument files must have exactly one link (OF-55)", () => {
  it("control: a single-link config file after --config is pinned", () => {
    const f = file();
    const r = mcpArgFilePins(["--config", f]);
    expect(r.ok && r.pins.map((p) => p.arg)).toEqual([f]);
  });
  it("refuses a hard-linked config file after --config, naming the link count", () => {
    const r = mcpArgFilePins(["--config", file(2)]);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain("2 hard links");
  });
  it("refuses a hard-linked file given as --config=<path>", () => {
    expect(mcpArgFilePins([`--config=${file(2)}`]).ok).toBe(false);
  });
  it("refuses a hard-linked file given as -c<path>", () => {
    expect(mcpArgFilePins([`-c${file(2)}`]).ok).toBe(false);
  });
  it("refuses a hard-linked file named by a plain absolute path argument", () => {
    expect(mcpArgFilePins(["--flag", file(2)]).ok).toBe(false);
  });
  // N4 (lead decision): the rule exists so a pinned file's bytes cannot change after the pin. Where only root can write
  // either name, a link count says nothing (a system binary such as /usr/bin/<tool> can have 78 links).
  const asRoot = (over: { uid?: number; mode?: number } = {}): PathJudgeIo => {
    const view = (st: Stats): Stats => Object.assign(Object.create(Object.getPrototypeOf(st)), st, { uid: over.uid ?? 0, mode: (st.mode & ~0o7777) | (over.mode ?? 0o755) });
    return { ...DEFAULT_PATH_JUDGE_IO, tempRoots: () => [], stat: (p) => view(DEFAULT_PATH_JUDGE_IO.stat(p)), lstat: (p) => view(DEFAULT_PATH_JUDGE_IO.lstat(p)) };
  };
  it("allows a multi-link file owned by root in a root-owned, root-only-writable chain", () => {
    const r = mcpArgFilePins(["--config", file(3)], { seatCwd: null, io: asRoot() });
    expect(r.ok).toBe(true);
  });
  it("refuses the same multi-link file when it is not owned by root", () => {
    const r = mcpArgFilePins(["--config", file(3)], { seatCwd: null, io: asRoot({ uid: 501 }) });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain("3 hard links");
  });
  it("refuses a root-owned multi-link file that group or other can write", () => {
    const r = mcpArgFilePins(["--config", file(2)], { seatCwd: null, io: asRoot({ mode: 0o775 }) });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain("2 hard links");
  });
  it("refuses a root-owned multi-link file whose directory chain is writable by others", () => {
    const f = file(2);
    const base = asRoot();
    const io: PathJudgeIo = { ...base, stat: (p) => (p === f ? base.stat(p) : Object.assign(Object.create(Object.getPrototypeOf(base.stat(p))), base.stat(p), { mode: (base.stat(p).mode & ~0o7777) | 0o777 })) };
    const r = mcpArgFilePins(["--config", f], { seatCwd: null, io });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain("2 hard links");
  });
  it("a link made AFTER the pin is caught by the launch re-check", () => {
    const f = file();
    const first = mcpArgFilePins(["--config", f]);
    if (!first.ok) throw new Error("setup");
    expect(mcpArgFileProblem(["--config", f], first.pins)).toBeNull();
    linkSync(f, `${f}.late`);
    expect(mcpArgFileProblem(["--config", f], first.pins)).toContain("hard links");
  });
});
