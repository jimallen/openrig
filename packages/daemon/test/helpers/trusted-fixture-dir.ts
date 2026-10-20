import { chmodSync, mkdtempSync, realpathSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";

/**
 * A 0700 fixture directory for files the Codex MCP trust rule must ACCEPT (server binaries, operator-named
 * specs). The rule refuses anything under /tmp, $TMPDIR or /var/folders (a sandboxed seat can write those),
 * and the hermetic test HOME is itself created under the temp root (test/hermetic-env.setup.ts), so neither
 * can hold an accepted fixture. The account's real home (from the password database, not $HOME) is used
 * instead, under a uniquely named directory the caller removes.
 */
export function trustedFixtureDir(label: string): string {
  const dir = realpathSync(mkdtempSync(join(os.userInfo().homedir, `.openrig-mcp-test-${label}-`)));
  chmodSync(dir, 0o700);
  return dir;
}
