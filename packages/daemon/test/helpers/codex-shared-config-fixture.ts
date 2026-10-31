import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { canonicalizeBestEffort, createCodexConfigWritePolicy, type CodexConfigWritePolicy } from "../../src/domain/codex-config-write-policy.js";

// OF-183 fixtures: a host-wide ~/.codex whose config.toml holds a user hook that a live seat trusted under the
// SHARED key (so a new seat home would normally mirror that trust into the shared file), and the policy of a daemon
// that is not the host's installed one.
const STOP_HASH = `sha256:${createHash("sha256").update('{"event_name":"stop","hooks":[{"async":false,"command":"/opt/stop-probe","timeout":9,"type":"command"}]}').digest("hex")}`;

export interface HostCodexFixture {
  root: string;
  hostHome: string;
  codexHome: string;
  config: string;
  /** The daemon-side OPENRIG_HOME of the scratch daemon under test. */
  scratchOpenrigHome: string;
  cleanup(): void;
}

export function hostCodexWithTrustedHook(prefix: string): HostCodexFixture {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const hostHome = path.join(root, "host");
  const codexHome = path.join(hostHome, ".codex");
  const config = path.join(codexHome, "config.toml");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(
    config,
    `[[hooks.Stop]]\n\n[[hooks.Stop.hooks]]\ntype = "command"\ncommand = "/opt/stop-probe"\ntimeout = 9\n\n`
      + `[hooks.state.${JSON.stringify(`${config}:stop:0:0`)}]\ntrusted_hash = ${JSON.stringify(STOP_HASH)}\n`,
  );
  return { root, hostHome, codexHome, config, scratchOpenrigHome: path.join(root, "scratch", ".openrig"), cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/** A checkout/dev build on its own OPENRIG_HOME that shares the real HOME: the measured incident. */
export function secondDaemonPolicyFor(fx: HostCodexFixture): CodexConfigWritePolicy {
  return createCodexConfigWritePolicy({
    codeRoot: path.join(fx.root, "worktree", "packages", "daemon"),
    openrigHome: fx.scratchOpenrigHome,
    hostHome: fx.hostHome,
    processHome: fx.hostHome,
    readPackageName: () => undefined,
    canonicalize: canonicalizeBestEffort,
  });
}
