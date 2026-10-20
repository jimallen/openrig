import { chmodSync, mkdtempSync, realpathSync, type Stats } from "node:fs";
import { tmpdir } from "node:os";
import nodePath, { join } from "node:path";
import { DEFAULT_PATH_JUDGE_IO, type PathJudgeIo } from "../../src/domain/codex-mcp-servers.js";

/**
 * A 0700 fixture directory under the test temp root, plus the PathJudgeIo that anchors the Codex MCP trust rule
 * there. The production rule refuses every temp location and any group/other-writable ancestor (/tmp itself
 * is 1777), so a fixture the rule must ACCEPT cannot sit under the temp root with the real reads. The io:
 *  - reports no temp roots (the temp-root refusal is pinned by separate rows that use the real reads);
 *  - presents the directories ABOVE the fixture as root-owned 0755 (what a real install location looks like).
 * Everything at and below the fixture directory is read for real: owners, modes, links, link counts, dev/ino.
 * Production code never receives this io; it is passed through the test-only dependency seams.
 */
export function mcpTrustFixture(label: string): { dir: string; io: PathJudgeIo } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `mcp-${label}-`)));
  chmodSync(dir, 0o700);
  const above = (p: string) => {
    const rel = nodePath.relative(nodePath.resolve(p), dir);
    return rel !== "" && !rel.startsWith("..") && !nodePath.isAbsolute(rel);
  };
  const anchor = (st: Stats, p: string): Stats => (above(p)
    ? Object.assign(Object.create(Object.getPrototypeOf(st)), st, { uid: 0, mode: (st.mode & ~0o7777) | 0o755 })
    : st);
  return {
    dir,
    io: {
      ...DEFAULT_PATH_JUDGE_IO,
      tempRoots: () => [],
      stat: (p) => anchor(DEFAULT_PATH_JUDGE_IO.stat(p), p),
      lstat: (p) => anchor(DEFAULT_PATH_JUDGE_IO.lstat(p), p),
    },
  };
}
