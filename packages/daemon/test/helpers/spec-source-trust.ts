import fs from "node:fs";
import os from "node:os";
import type { PathJudgeIo } from "../../src/domain/codex-mcp-servers.js";
import type { SpecSourceTrust } from "../../src/domain/recorded-spec-source-judge.js";

/**
 * The real file system, judged without owner, temp-folder and writable-bit rules. Test fixtures live in the temp folder,
 * which the production judge refuses on purpose; rows that exist to pin a refusal pass their own io.
 */
export const PERMISSIVE_JUDGE_IO: PathJudgeIo = {
  lstat: (p) => fs.lstatSync(p), stat: (p) => fs.statSync(p), realpath: (p) => fs.realpathSync(p),
  uid: () => undefined, tempRoots: () => [],
};

/**
 * OF-103: the trust a test instantiator carries for a rig's recorded spec source (the daemon wires the released copies and
 * the spec library in startup.ts). Here the temp folder, where every fixture lives, is the one trusted root. The
 * instantiator refuses a recorded source when it carries none, so a test that records a fixture spec passes this.
 */
export const FIXTURE_SPEC_SOURCE_TRUST: SpecSourceTrust = {
  roots: () => [fs.realpathSync(os.tmpdir())],
  io: PERMISSIVE_JUDGE_IO,
};
