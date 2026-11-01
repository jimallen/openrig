import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startCoreWithCli } from "../src/adapters/hc-core-watch.js";
import { HC, PrivateCore, until } from "./hc-private-core.js";

// N2 on a real core: a terminal with no launch wrapper, as `rig chatroom --terminal` or a person's `hc run` starts. Fake values.
const OPERATOR_NAMES = ["OPENRIG_AUTH_BEARER_TOKEN", "OPENRIG_TERMINAL_BEARER_TOKEN", "SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"];
const secrets = { ...Object.fromEntries(OPERATOR_NAMES.map((n) => [n, "fake-operator-value"])), KEEP_ME: "kept" };

async function plainRunEnv(core: PrivateCore): Promise<string> {
  const out = join(core.root, "env.txt");
  await core.client.call("terminal.run", { argv: ["/bin/sh", "-c", `env > ${out}.tmp; mv ${out}.tmp ${out}; exec sleep 60`], name: "plain", no_parent: true, no_notify: true, outlive_parent: true });
  return until(() => { try { return readFileSync(out, "utf8"); } catch { return ""; } }, (text) => text.includes("KEEP_ME="), "the plain terminal's env");
}

describe.skipIf(!HC)("a core and its operator secrets, on a private hc core", () => {
  it("a core started through startCoreWithCli passes none of them to a terminal with no wrapper, and passes the rest", async () => {
    const core = new PrivateCore("hcs", secrets);
    try {
      await startCoreWithCli({ env: core.env, hcPath: HC })();
      const env = await plainRunEnv(core);
      for (const name of OPERATOR_NAMES) expect(env, name).not.toContain(`${name}=`);
      expect(env).toContain("KEEP_ME=kept");
    } finally {
      core.stop();
    }
  });

  it("control: a core started by hand with them does pass them on, which is why the daemon's start removes them", async () => {
    const core = new PrivateCore("hcu", secrets);
    try {
      core.start();
      const env = await plainRunEnv(core);
      for (const name of OPERATOR_NAMES) expect(env, name).toContain(`${name}=fake-operator-value`);
    } finally {
      core.stop();
    }
  });
});
