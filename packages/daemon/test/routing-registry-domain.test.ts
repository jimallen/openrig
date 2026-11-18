// workspaces-o9o.160: the two domain readers of the routing registries run the credential rule's procedure with the node:fs they
// already import (CoS 13:38Z option B): SettingsStore (config.json) and crash-cart's readDaemonJson (daemon.json). Every fixture
// sets its own mode.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SettingsStore, SETTINGS_VALID_KEYS } from "../src/domain/user-settings/settings-store.js";
import { readDaemonJson } from "../src/domain/crash-cart-probes.js";

let dir: string;
beforeEach(() => { dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "routing-domain-"))); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const put = (p: string, text: string, mode: number) => { fs.writeFileSync(p, text); fs.chmodSync(p, mode); };
const KEY = SETTINGS_VALID_KEYS[0]!;

describe("SettingsStore reads config.json under the rule (o9o.160)", () => {
  it("narrows a config.json of ours others can change, and reads it", () => {
    const p = path.join(dir, "config.json");
    put(p, "{}", 0o664);
    expect(() => new SettingsStore(p).resolveOne(KEY)).not.toThrow();
    expect(fs.statSync(p).mode & 0o777).toBe(0o644);
  });

  it("reads a symlinked config.json (dotfiles) and narrows its target, keeping the link", () => {
    const target = path.join(dir, "dotfiles.json");
    put(target, "{}", 0o664);
    fs.symlinkSync(target, path.join(dir, "config.json"));
    expect(() => new SettingsStore(path.join(dir, "config.json")).resolveOne(KEY)).not.toThrow();
    expect(fs.statSync(target).mode & 0o777).toBe(0o644);
    expect(fs.lstatSync(path.join(dir, "config.json")).isSymbolicLink()).toBe(true);
  });

  it("refuses a config.json that is not a plain file, naming it", () => {
    fs.mkdirSync(path.join(dir, "config.json"), { mode: 0o700 });
    expect(() => new SettingsStore(path.join(dir, "config.json")).resolveOne(KEY)).toThrow(/config\.json.*not a regular file/);
  });
});

describe("crash-cart's readDaemonJson reads daemon.json under the rule (o9o.160)", () => {
  const STATE = JSON.stringify({ pid: 4242, port: 41111 });

  it("CONTROL: a plain daemon.json of ours is read", () => {
    put(path.join(dir, "daemon.json"), STATE, 0o644);
    expect(readDaemonJson(dir)).toEqual({ pid: 4242, port: 41111, host: undefined });
  });

  it("does not read a daemon.json that is a link", () => {
    put(path.join(dir, "elsewhere.json"), STATE, 0o644);
    fs.symlinkSync(path.join(dir, "elsewhere.json"), path.join(dir, "daemon.json"));
    expect(readDaemonJson(dir)).toBeUndefined();
  });

  it("narrows a daemon.json of ours others can change (sparky's live one is 0664), and reads it", () => {
    put(path.join(dir, "daemon.json"), STATE, 0o664);
    expect(readDaemonJson(dir)).toMatchObject({ port: 41111 });
    expect(fs.statSync(path.join(dir, "daemon.json")).mode & 0o777).toBe(0o644);
  });
});
