// workspaces-o9o.151: the activity-hook token and the activity-endpoint.json snapshot are secrets. The snapshot's baseUrl decides
// where a seat's relay sends its token, so every reader of it (the daemon, the Pi and stub runners, the plugin's .cjs relay) takes
// it only from a plain file of ours with no group/other bits, and they agree, fixture by fixture. Every fixture sets its own mode.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureActivityHookToken, readActivityEndpointFile, writeActivityEndpointFile } from "../src/adapters/activity-endpoint-file.js";
import { resolveActivityEndpoint } from "../src/adapters/runner-pane-io.js";
import { resolveStubActivityEndpoint } from "../src/adapters/stub-runner.js";

const require = createRequire(import.meta.url);
const relay = require("../assets/plugins/openrig-core/hooks/scripts/activity-relay.cjs") as {
  resolveEndpoint: (env: Record<string, string | undefined>) => { baseUrl?: string; token?: string };
};

let dir: string;
beforeEach(() => { dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "act-cred-"))); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const FILE_TOKEN = "f" + "0".repeat(15);
const ENDPOINT = JSON.stringify({ baseUrl: "http://127.0.0.1:17433", token: FILE_TOKEN });

describe("ensureActivityHookToken (o9o.151, the o9o.78 precedent)", () => {
  it("refuses a token file that is a symlink, naming it, and never writes through the link", () => {
    const target = path.join(dir, "target");
    fs.writeFileSync(target, "", { mode: 0o600 });
    fs.symlinkSync(target, path.join(dir, "activity-hook-token"));
    expect(() => ensureActivityHookToken(dir)).toThrow(/activity-hook-token.*symbolic link/);
    expect(fs.readFileSync(target, "utf8")).toBe("");
  });

  it("refuses a token path that is a directory", () => {
    fs.mkdirSync(path.join(dir, "activity-hook-token"), { mode: 0o700 });
    expect(() => ensureActivityHookToken(dir)).toThrow(/activity-hook-token.*not a regular file/);
  });

  it("narrows a token file of ours that others can read to 0600, and keeps the token", () => {
    const p = path.join(dir, "activity-hook-token");
    fs.writeFileSync(p, FILE_TOKEN);
    fs.chmodSync(p, 0o644);
    expect(ensureActivityHookToken(dir)).toBe(FILE_TOKEN);
    expect(fs.statSync(p).mode & 0o777).toBe(0o600);
  });
});

describe("writeActivityEndpointFile never writes through a planted link (o9o.151)", () => {
  it("replaces a symlink at activity-endpoint.json with a plain 0600 file and leaves the link's target alone", () => {
    const target = path.join(dir, "elsewhere");
    fs.writeFileSync(target, "untouched", { mode: 0o600 });
    fs.symlinkSync(target, path.join(dir, "activity-endpoint.json"));
    writeActivityEndpointFile(dir, { baseUrl: "http://127.0.0.1:7433", token: FILE_TOKEN });
    expect(fs.readFileSync(target, "utf8")).toBe("untouched");
    const st = fs.lstatSync(path.join(dir, "activity-endpoint.json"));
    expect(st.isFile()).toBe(true);
    expect(st.mode & 0o777).toBe(0o600);
    expect(readActivityEndpointFile(dir)).toEqual({ baseUrl: "http://127.0.0.1:7433", token: FILE_TOKEN });
  });
});

describe("every reader of activity-endpoint.json takes its token only from a plain file of ours, and they agree (o9o.151)", () => {
  type Fixture = { name: string; make: (p: string) => void; accepted: boolean };
  const plain = (mode: number) => (p: string) => { fs.writeFileSync(p, ENDPOINT); fs.chmodSync(p, mode); };
  const FIXTURES: Fixture[] = [
    { name: "0600, ours", make: plain(0o600), accepted: true },
    { name: "0400, ours", make: plain(0o400), accepted: true },
    { name: "0640 (group can read)", make: plain(0o640), accepted: false },
    { name: "0604 (others can read)", make: plain(0o604), accepted: false },
    { name: "0620 (group can write)", make: plain(0o620), accepted: false },
    { name: "a symlink to a 0600 file", make: (p) => { const t = p + ".real"; plain(0o600)(t); fs.symlinkSync(t, p); }, accepted: false },
    { name: "a directory", make: (p) => fs.mkdirSync(p, { mode: 0o700 }), accepted: false },
    { name: "a hard link (a second name reaches the same 0600 file)", make: (p) => { plain(0o600)(p); fs.linkSync(p, p + ".second-name"); }, accepted: false },
    { name: "a FIFO (the open must not hang)", make: (p) => execFileSync("mkfifo", ["-m", "600", p]), accepted: false },
    { name: "over the 16 KiB cap", make: (p) => { fs.writeFileSync(p, JSON.stringify({ baseUrl: "http://127.0.0.1:1", token: FILE_TOKEN, pad: "x".repeat(17 * 1024) })); fs.chmodSync(p, 0o600); }, accepted: false },
  ];
  const env = (home: string) => ({ OPENRIG_HOME: home, HOME: home });

  for (const f of FIXTURES) {
    it(`${f.name}: ${f.accepted ? "taken" : "refused"} by all four readers`, () => {
      f.make(path.join(dir, "activity-endpoint.json"));
      const verdicts = {
        daemon: readActivityEndpointFile(dir)?.token === FILE_TOKEN,
        runner: resolveActivityEndpoint(env(dir))?.token === FILE_TOKEN,
        stub: resolveStubActivityEndpoint(env(dir))?.token === FILE_TOKEN,
        relay: relay.resolveEndpoint(env(dir)).token === FILE_TOKEN,
      };
      expect(verdicts).toEqual({ daemon: f.accepted, runner: f.accepted, stub: f.accepted, relay: f.accepted });
    });
  }

  it("CONTROL: a token in the environment is still used when the file is refused (only the file is distrusted)", () => {
    plain(0o644)(path.join(dir, "activity-endpoint.json"));
    const e = { ...env(dir), OPENRIG_URL: "http://127.0.0.1:7433", OPENRIG_ACTIVITY_HOOK_TOKEN: "env-token" };
    expect(relay.resolveEndpoint(e)).toEqual({ baseUrl: "http://127.0.0.1:7433", token: "env-token" });
    expect(resolveActivityEndpoint(e)).toEqual({ baseUrl: "http://127.0.0.1:7433", token: "env-token" });
  });
});
