// workspaces-o9o.151 (CoS decision 3): a Slack secrets file the credential rule refuses turns Slack off, and `rig doctor` reports it
// as a WARN row naming the file and the fix. A warning, not a failure: the daemon and every other check are unaffected.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { doctorCommand, type DoctorDeps } from "../src/commands/doctor.js";
import { stubConfigStore } from "./helpers/stub-config-store.js";

let dir: string;
beforeEach(() => { dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "doctor-slack-"))); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const defaultConfig = {
  daemon: { port: 7433, host: "127.0.0.1" },
  db: { path: "/tmp/openrig-doctor-test/openrig.sqlite" },
  transcripts: { enabled: false, path: "/tmp/openrig-doctor-test/transcripts" },
};

function deps(slackSecretsEnvFile: string | null): DoctorDeps & { slackSecretsEnvFile: () => Promise<string | null> } {
  return {
    exists: () => true,
    baseDir: "/install/cli/dist",
    readFile: () => null,
    exec: (cmd: string) => (cmd === "hc --version" ? "hc 0.1.16\n" : ""),
    checkPort: async () => true,
    configStore: stubConfigStore(defaultConfig as never),
    platform: "darwin",
    mkdirp: () => {},
    checkWritable: () => {},
    readHcHello: async () => ({ kind: "no_core", detail: "fixture: no core" }),
    pluginsDir: path.join(dir, "plugins"),
    openrigHome: dir,
    readSeatProcesses: () => null,
    fetchHostRows: async () => null,
    localHostFacts: undefined,
    slackSecretsEnvFile: async () => slackSecretsEnvFile,
  };
}

async function doctorJson(d: DoctorDeps): Promise<{ healthy: boolean; checks: Array<{ name: string; status: string; message: string; reason?: string; fix?: string }> }> {
  const program = new Command();
  program.addCommand(doctorCommand(d));
  const logs: string[] = [];
  const origLog = console.log;
  const origExit = process.exitCode;
  console.log = (...args: unknown[]) => logs.push(args.join(" "));
  try { await program.parseAsync(["node", "rig", "doctor", "--json", "--no-seat-shell"]); } finally { console.log = origLog; process.exitCode = origExit; }
  return JSON.parse(logs.join("\n"));
}

describe("rig doctor reports a refused Slack secrets file (o9o.151)", () => {
  it("warns, naming the file and chmod 600, when others can read it", async () => {
    const f = path.join(dir, "slack.env");
    fs.writeFileSync(f, "SLACK_BOT_TOKEN=not-a-real-value\n");
    fs.chmodSync(f, 0o644);
    const row = (await doctorJson(deps(f))).checks.find((c) => c.name === "slack_secrets");
    expect(row?.status).toBe("warn");
    expect(`${row?.message} ${row?.fix}`).toContain(f);
    expect(row?.fix).toContain("chmod 600");
    expect(JSON.stringify(row)).not.toContain("not-a-real-value");
  });

  it("warns on a symlinked secrets file", async () => {
    const real = path.join(dir, "real.env");
    fs.writeFileSync(real, "SLACK_BOT_TOKEN=x\n");
    fs.chmodSync(real, 0o600);
    fs.symlinkSync(real, path.join(dir, "slack.env"));
    const row = (await doctorJson(deps(path.join(dir, "slack.env")))).checks.find((c) => c.name === "slack_secrets");
    expect(row?.status).toBe("warn");
    expect(row?.fix).toContain("symbolic link");
  });

  it("CONTROL: passes a 0600 file of ours, and a warning never makes doctor unhealthy", async () => {
    const f = path.join(dir, "slack.env");
    fs.writeFileSync(f, "SLACK_BOT_TOKEN=x\n");
    fs.chmodSync(f, 0o600);
    expect((await doctorJson(deps(f))).checks.find((c) => c.name === "slack_secrets")?.status).toBe("pass");
    fs.chmodSync(f, 0o644);
    const out = await doctorJson(deps(f));
    expect(out.checks.filter((c) => c.status === "fail").map((c) => c.name)).not.toContain("slack_secrets");
  });

  it("skips when no Slack secrets file is configured", async () => {
    expect((await doctorJson(deps(null))).checks.find((c) => c.name === "slack_secrets")?.status).toBe("skipped");
  });
});
