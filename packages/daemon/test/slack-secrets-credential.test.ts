// workspaces-o9o.151: the Slack secrets env file is read under the credential rule. A refused file is never read; the refusal
// disables the Slack subsystem only (an inert wire, the daemon starts), and it is reported with the file and the fix (CoS decision 3).
// The tokens here are fake and not credential-shaped. Every fixture sets its own mode.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { nodeCredentialFileReader } from "../src/adapters/node-credential-file-reader.js";
import { checkEnvFilePermissions, resolveSecret } from "../src/domain/gateway/slack/secrets.js";
import { DEFAULT_CONFIG, saveConfig } from "../src/domain/gateway/slack/config.js";
import { buildSlackGatewayWire } from "../src/domain/gateway/slack/slack-subsystem.js";
import { noSlackHttp } from "./helpers/no-slack-http.js";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { EventBus } from "../src/domain/event-bus.js";

let dir: string;
beforeEach(() => { dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "slack-cred-"))); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const BOT = "bot-" + "z".repeat(12);
const reader = nodeCredentialFileReader;

function envFile(mode: number | "link"): string {
  const p = path.join(dir, "slack.env");
  if (mode === "link") {
    const real = path.join(dir, "real.env");
    fs.writeFileSync(real, `SLACK_BOT_TOKEN=${BOT}\n`);
    fs.chmodSync(real, 0o600);
    fs.symlinkSync(real, p);
  } else {
    fs.writeFileSync(p, `SLACK_BOT_TOKEN=${BOT}\n`);
    fs.chmodSync(p, mode);
  }
  return p;
}

describe("resolveSecret reads the env file under the rule (o9o.151)", () => {
  it("reads a 0600 env file of ours", () => {
    expect(resolveSecret("SLACK_BOT_TOKEN", { env: {}, envFile: envFile(0o600), credentialFiles: reader })).toBe(BOT);
  });
  it("does not read one others can read", () => {
    expect(resolveSecret("SLACK_BOT_TOKEN", { env: {}, envFile: envFile(0o644), credentialFiles: reader })).toBeNull();
  });
  it("does not read one reached through a symlink", () => {
    expect(resolveSecret("SLACK_BOT_TOKEN", { env: {}, envFile: envFile("link"), credentialFiles: reader })).toBeNull();
  });
  it("CONTROL: an environment variable still wins over a refused file", () => {
    expect(resolveSecret("SLACK_BOT_TOKEN", { env: { SLACK_BOT_TOKEN: "from-env" }, envFile: envFile(0o644), credentialFiles: reader })).toBe("from-env");
  });
});

describe("checkEnvFilePermissions names every refusal with its fix (o9o.151)", () => {
  it("passes a 0600 file of ours and an absent one", () => {
    expect(checkEnvFilePermissions(envFile(0o600), reader)).toBeNull();
    expect(checkEnvFilePermissions(path.join(dir, "absent.env"), reader)).toBeNull();
  });
  it("names the file and chmod 600 for one others can read", () => {
    const p = envFile(0o644);
    expect(checkEnvFilePermissions(p, reader)).toMatch(new RegExp(`${p.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}.*chmod 600`));
  });
  it("refuses a symlink, which the old mode check followed and passed", () => {
    expect(checkEnvFilePermissions(envFile("link"), reader)).toMatch(/symbolic link/);
  });
});

describe("a refused secrets file disables Slack only (o9o.151, CoS decision 3)", () => {
  function wireWith(mode: number | "link") {
    const home = path.join(dir, "home");
    fs.mkdirSync(home);
    const secrets = envFile(mode);
    saveConfig({ ...DEFAULT_CONFIG, enabled: true, channel: "C-TEST", secretsEnvFile: secrets }, home);
    const db = createDb();
    migrate(db, ALL_MIGRATIONS);
    const lines: string[] = [];
    const wire = buildSlackGatewayWire({ home, queueRepo: new QueueRepository(db, new EventBus(db), { loadHumanRegistry: () => ({ ok: true as const, entities: [] }) }), credentialFiles: reader, fetchImpl: noSlackHttp, log: (l: string) => lines.push(l) });
    return { status: wire.status?.() ?? {}, log: lines.join("\n"), secrets };
  }

  it("CONTROL: a 0600 secrets file makes outbound ready", () => {
    expect(wireWith(0o600).status.outboundReady).toBe(true);
  });

  it("a secrets file others can read leaves the wire inert, and the log names the file and the fix (no throw)", () => {
    const { status, log, secrets } = wireWith(0o644);
    expect(status.outboundReady).toBe(false);
    expect(log).toContain(secrets);
    expect(log).toContain("chmod 600");
    expect(log).not.toContain(BOT);
  });
});
