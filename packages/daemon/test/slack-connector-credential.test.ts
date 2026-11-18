// workspaces-o9o.160: slack-connector.json names the Slack secrets file, so it is read under the credential rule. OpenRig writes it:
// group/other write on a file of ours is narrowed; a link or another user's file is not used (Slack stays off, as with a refused
// secrets file). Every fixture sets its own mode.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { configPathFor, loadConfig } from "../src/domain/gateway/slack/config.js";
import { readConnectionConfiguration } from "../src/domain/gateway/connections-projection.js";
import { NO_CREDENTIAL_FILES } from "./helpers/credential-files.js";

let home: string;
beforeEach(() => { home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "slack-connector-"))); });
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

const ENABLED = JSON.stringify({ enabled: true, channel: "C-TEST" });
const put = (p: string, text: string, mode: number) => { fs.writeFileSync(p, text); fs.chmodSync(p, mode); };

describe("loadConfig reads slack-connector.json under the rule (o9o.160)", () => {
  it("CONTROL: a plain connector config of ours is used", () => {
    put(configPathFor(home), ENABLED, 0o644);
    expect(loadConfig(home).enabled).toBe(true);
  });

  it("a connector config that is a link is not used: Slack stays off", () => {
    put(path.join(home, "elsewhere.json"), ENABLED, 0o644);
    fs.symlinkSync(path.join(home, "elsewhere.json"), configPathFor(home));
    expect(loadConfig(home).enabled).toBe(false);
  });

  it("a connector config of ours others can change is narrowed and used", () => {
    put(configPathFor(home), ENABLED, 0o664);
    expect(loadConfig(home).enabled).toBe(true);
    expect(fs.statSync(configPathFor(home)).mode & 0o777).toBe(0o644);
  });
});

describe("the connections view reads it under the same rule (o9o.160)", () => {
  it("shows a refused connector config as unavailable, not as its contents", () => {
    put(path.join(home, "elsewhere.json"), ENABLED, 0o644);
    fs.symlinkSync(path.join(home, "elsewhere.json"), configPathFor(home));
    const read = readConnectionConfiguration(home, NO_CREDENTIAL_FILES);
    expect(read.sourceState).toBe("unavailable");
    expect(read.cfg).toBeNull();
  });
});
