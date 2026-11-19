// workspaces-o9o.182: the credential rule's write half (domain/credential-file.ts rewriteGuardedFileWith, bound to node:fs in
// adapters/guarded-rewrite.ts), and the Slack connector config's save through it (o9o.160's review: saveConfig wrote through a link).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rewriteGuardedFile } from "../src/adapters/guarded-rewrite.js";
import { CLAUDE_SETTINGS_POLICY, CODEX_CONFIG_POLICY, HOST_BINDINGS_POLICY, guardedFileOpsFrom, rewriteGuardedFileWith } from "../src/domain/credential-file.js";
import { RegistryHostDirectory } from "../src/adapters/registry-host-directory.js";
import { DEFAULT_CONFIG, saveConfig } from "../src/domain/gateway/slack/config.js";

let tmp: string;
beforeEach(() => { tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "o182-write-"))); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const append = (line: string) => (current: string | null) => `${current ?? ""}${line}\n`;

describe("rewriteGuardedFile (workspaces-o9o.182)", () => {
  it("refuses a link at a file whose policy does not follow one, and changes neither the link nor its target", () => {
    const target = path.join(tmp, "target.json");
    fs.writeFileSync(target, "{}\n", { mode: 0o600 });
    const link = path.join(tmp, "settings.json");
    fs.symlinkSync(target, link);
    const result = rewriteGuardedFile(link, CLAUDE_SETTINGS_POLICY, append("x"));
    expect(result).toMatchObject({ ok: false, problem: "symlink" });
    expect(fs.readFileSync(target, "utf-8")).toBe("{}\n");
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
  });

  it("refuses a dangling link and creates nothing at its far end", () => {
    const link = path.join(tmp, "config.toml");
    const far = path.join(tmp, "nowhere", "config.toml");
    fs.symlinkSync(far, link);
    expect(rewriteGuardedFile(link, CODEX_CONFIG_POLICY, append("x"))).toMatchObject({ ok: false });
    expect(fs.existsSync(far)).toBe(false);
  });

  it("a mutate that returns null, or the same text, writes nothing (the file's inode is unchanged)", () => {
    const file = path.join(tmp, "f.toml");
    fs.writeFileSync(file, "a\n", { mode: 0o600 });
    const ino = fs.statSync(file).ino;
    expect(rewriteGuardedFile(file, CODEX_CONFIG_POLICY, () => null)).toEqual({ ok: true, written: false, path: file });
    expect(rewriteGuardedFile(file, CODEX_CONFIG_POLICY, (c) => c)).toEqual({ ok: true, written: false, path: file });
    expect(fs.statSync(file).ino).toBe(ino);
  });

  it("rewriteUnchanged writes the same text again as a fresh file (a writer that has always rewritten keeps doing so); null still writes nothing", () => {
    const file = path.join(tmp, "f.toml");
    fs.writeFileSync(file, "a\n", { mode: 0o600 });
    const ino = fs.statSync(file).ino;
    expect(rewriteGuardedFile(file, CODEX_CONFIG_POLICY, () => null, { rewriteUnchanged: true })).toEqual({ ok: true, written: false, path: file });
    expect(fs.statSync(file).ino).toBe(ino);
    expect(rewriteGuardedFile(file, CODEX_CONFIG_POLICY, (c) => c, { rewriteUnchanged: true })).toEqual({ ok: true, written: true, path: file });
    expect(fs.statSync(file).ino).not.toBe(ino);
    expect(fs.readFileSync(file, "utf-8")).toBe("a\n");
  });

  it("a mutate that throws leaves the file as it was and no temp file beside it", () => {
    const file = path.join(tmp, "f.toml");
    fs.writeFileSync(file, "a\n", { mode: 0o600 });
    expect(() => rewriteGuardedFile(file, CODEX_CONFIG_POLICY, () => { throw new Error("bad fragment"); })).toThrow("bad fragment");
    expect(fs.readFileSync(file, "utf-8")).toBe("a\n");
    expect(fs.readdirSync(tmp)).toEqual(["f.toml"]);
  });

  it("an OpenRig file (own) others can change is narrowed before it is rewritten; a new one gets createMode", () => {
    const file = path.join(tmp, "host-bindings.json");
    fs.writeFileSync(file, "{}\n");
    fs.chmodSync(file, 0o666);
    expect(rewriteGuardedFile(file, HOST_BINDINGS_POLICY, append("x"), { own: true })).toMatchObject({ ok: true, written: true });
    expect(fs.statSync(file).mode & 0o777).toBe(0o644);
    const fresh = path.join(tmp, "fresh.json");
    expect(rewriteGuardedFile(fresh, HOST_BINDINGS_POLICY, append("x"), { own: true, createMode: 0o640 })).toMatchObject({ ok: true, written: true });
    expect(fs.statSync(fresh).mode & 0o777).toBe(0o640);
  });

  it("the temp file is created exclusively and never through a link at its name (a fixed temp name, planted)", () => {
    const file = path.join(tmp, "f.toml");
    fs.writeFileSync(file, "a\n", { mode: 0o600 });
    const victim = path.join(tmp, "victim.txt");
    fs.writeFileSync(victim, "keep me\n", { mode: 0o600 });
    // The procedure's temp name with this pid and suffix: `.<name>.openrig-<pid>-<suffix>.tmp` beside the file.
    fs.symlinkSync(victim, path.join(tmp, ".f.toml.openrig-7-fixed.tmp"));
    const ops = guardedFileOpsFrom(fs, () => process.getuid?.() ?? 0, () => "fixed", () => 7);
    expect(() => rewriteGuardedFileWith(ops, file, CODEX_CONFIG_POLICY, append("x"))).toThrow();
    expect(fs.readFileSync(victim, "utf-8")).toBe("keep me\n");
    expect(fs.readFileSync(file, "utf-8")).toBe("a\n");
  });

  it("a file of another owner is refused (the owner seam)", () => {
    const file = path.join(tmp, "f.toml");
    fs.writeFileSync(file, "a\n", { mode: 0o600 });
    expect(rewriteGuardedFile(file, CODEX_CONFIG_POLICY, append("x"), { currentUid: (process.getuid?.() ?? 0) + 1 })).toMatchObject({ ok: false, problem: "wrong_owner" });
    expect(fs.readFileSync(file, "utf-8")).toBe("a\n");
  });
});

describe("the Slack connector config is saved under the rule (workspaces-o9o.182)", () => {
  it("saveConfig never writes through a symlinked slack-connector.json: it refuses, naming the file, and the target is untouched", () => {
    const victim = path.join(tmp, "victim.json");
    fs.writeFileSync(victim, "keep me\n", { mode: 0o600 });
    fs.symlinkSync(victim, path.join(tmp, "slack-connector.json"));
    expect(() => saveConfig({ ...DEFAULT_CONFIG }, tmp)).toThrow(/slack-connector\.json.*symbolic link/);
    expect(fs.readFileSync(victim, "utf-8")).toBe("keep me\n");
  });

  it("positive control: a first save creates the file 0644 with the config, and a second save replaces it", () => {
    const p = saveConfig({ ...DEFAULT_CONFIG }, tmp);
    expect(fs.statSync(p).mode & 0o777).toBe(0o644);
    expect(JSON.parse(fs.readFileSync(p, "utf-8"))).toMatchObject({ enabled: DEFAULT_CONFIG.enabled });
    saveConfig({ ...DEFAULT_CONFIG, enabled: !DEFAULT_CONFIG.enabled }, tmp);
    expect(JSON.parse(fs.readFileSync(p, "utf-8"))).toMatchObject({ enabled: !DEFAULT_CONFIG.enabled });
  });
});

describe("the daemon reads host-bindings.json under the rule (workspaces-o9o.182)", () => {
  const REGISTRY = "hosts:\n  - id: stu\n    transport: http\n    url: http://stu.example:7433\n";
  const BINDINGS = JSON.stringify({ version: 1, bindings: { stu: { hostId: "host-learned", firstObservedAt: "", lastObservedAt: "" } } });
  it("a symlinked host-bindings.json names no host by a learned id", () => {
    const registry = path.join(tmp, "hosts.yaml");
    fs.writeFileSync(registry, REGISTRY, { mode: 0o600 });
    const planted = path.join(tmp, "planted.json");
    fs.writeFileSync(planted, BINDINGS, { mode: 0o600 });
    const bindings = path.join(tmp, "host-bindings.json");
    fs.symlinkSync(planted, bindings);
    expect(new RegistryHostDirectory({ registry, bindings }).nameFor("host-learned")).toBeNull();
  });
  it("positive control: a plain host-bindings.json of ours names the host, and one others can change is narrowed first", () => {
    const registry = path.join(tmp, "hosts.yaml");
    fs.writeFileSync(registry, REGISTRY, { mode: 0o600 });
    const bindings = path.join(tmp, "host-bindings.json");
    fs.writeFileSync(bindings, BINDINGS);
    fs.chmodSync(bindings, 0o664);
    expect(new RegistryHostDirectory({ registry, bindings }).nameFor("host-learned")).toBe("stu");
    expect(fs.statSync(bindings).mode & 0o022).toBe(0);
  });
});
