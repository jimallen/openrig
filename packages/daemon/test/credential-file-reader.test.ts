// workspaces-o9o.151: the one rule for reading a credential, token or hosts registry file (domain/credential-file.ts), as the
// fs adapter applies it. Every fixture sets its own mode, so the rows hold under any umask.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readCredentialFile, readOwnFile } from "../src/adapters/node-credential-file-reader.js";
import {
  CODEX_CONFIG_POLICY, DAEMON_STATE_POLICY, HOSTS_REGISTRY_POLICY, OPENRIG_CONFIG_POLICY, SEAT_CREDENTIAL_LINKS, TERMINAL_TOKEN_POLICY, seatCredentialLinkPolicy, type CredentialFilePolicy, type SeatCredentialLink,
} from "../src/domain/credential-file.js";

let dir: string;
beforeEach(() => { dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cred-file-"))); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function file(name: string, content: string, mode: number): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  fs.chmodSync(p, mode);
  return p;
}

const SECRET = TERMINAL_TOKEN_POLICY;
const REGISTRY = HOSTS_REGISTRY_POLICY;

describe("readCredentialFile: a secret file (o9o.151)", () => {
  it("reads a plain file of ours with no group or other bits", () => {
    expect(readCredentialFile(file("t", "abc\n", 0o600), SECRET)).toEqual({ ok: true, content: "abc\n" });
  });

  it("refuses group or other access, naming the file and the chmod fix, and never returns the content", () => {
    const p = file("t", "s3cret-value", 0o644);
    const r = readCredentialFile(p, SECRET);
    expect(r).toMatchObject({ ok: false, problem: "group_or_other_access" });
    if (r.ok) return;
    expect(r.message).toContain(p);
    expect(r.message).toContain("chmod 600");
    expect(JSON.stringify(r)).not.toContain("s3cret-value");
    expect(readCredentialFile(file("g", "x", 0o640), SECRET)).toMatchObject({ ok: false, problem: "group_or_other_access" });
    expect(readCredentialFile(file("o", "x", 0o604), SECRET)).toMatchObject({ ok: false, problem: "group_or_other_access" });
  });

  it("refuses a symlink at the file, even to a good file", () => {
    const target = file("real", "abc", 0o600);
    fs.symlinkSync(target, path.join(dir, "link"));
    expect(readCredentialFile(path.join(dir, "link"), SECRET)).toMatchObject({ ok: false, problem: "symlink" });
  });

  it("refuses a file owned by someone else", () => {
    const p = file("t", "abc", 0o600);
    expect(readCredentialFile(p, SECRET, { currentUid: fs.statSync(p).uid + 1 })).toMatchObject({ ok: false, problem: "wrong_owner" });
  });

  it("refuses a directory and a FIFO (the open does not hang on a FIFO with no writer)", () => {
    fs.mkdirSync(path.join(dir, "d"), { mode: 0o700 });
    expect(readCredentialFile(path.join(dir, "d"), SECRET)).toMatchObject({ ok: false, problem: "not_regular_file" });
    const fifo = path.join(dir, "fifo");
    execFileSync("mkfifo", ["-m", "600", fifo]);
    expect(readCredentialFile(fifo, SECRET)).toMatchObject({ ok: false, problem: "not_regular_file" });
  });

  it("refuses a file over the cap, and reads one exactly at it", () => {
    const small: CredentialFilePolicy = { label: "the small file", kind: "secret", maxBytes: 8 };
    expect(readCredentialFile(file("at", "12345678", 0o600), small)).toEqual({ ok: true, content: "12345678" });
    expect(readCredentialFile(file("over", "123456789", 0o600), small)).toMatchObject({ ok: false, problem: "too_large" });
  });

  it("reports a missing file as missing", () => {
    expect(readCredentialFile(path.join(dir, "nope"), SECRET)).toMatchObject({ ok: false, problem: "missing" });
  });
});

describe("readCredentialFile: a registry file (o9o.151)", () => {
  it("reads one others may read but not change", () => {
    expect(readCredentialFile(file("hosts.yaml", "hosts: {}\n", 0o644), REGISTRY)).toEqual({ ok: true, content: "hosts: {}\n" });
  });

  it("refuses one group or others can change, naming the chmod go-w fix", () => {
    const r = readCredentialFile(file("hosts.yaml", "hosts: {}\n", 0o664), REGISTRY);
    expect(r).toMatchObject({ ok: false, problem: "group_or_other_write" });
    if (!r.ok) expect(r.message).toContain("chmod go-w");
    expect(readCredentialFile(file("h2", "x", 0o646), REGISTRY)).toMatchObject({ ok: false, problem: "group_or_other_write" });
  });
});

describe("readCredentialFile: the seat credential links OpenRig makes, and no other link (o9o.151, CoS 11-18 11:34Z)", () => {
  // One row per named exception: a seat file linked to its runtime's shared file is followed, and the target held to the rule.
  for (const link of Object.keys(SEAT_CREDENTIAL_LINKS) as SeatCredentialLink[]) {
    it(`${link}: a seat ${SEAT_CREDENTIAL_LINKS[link].seatFile} linked to ${SEAT_CREDENTIAL_LINKS[link].sharedFile} is read through the link`, () => {
      const shared = file(`shared-${link}`, "abc", 0o600);
      fs.symlinkSync(shared, path.join(dir, "seat-file"));
      expect(readCredentialFile(path.join(dir, "seat-file"), seatCredentialLinkPolicy(link, shared))).toEqual({ ok: true, content: "abc" });
    });
  }

  it("refuses a link to a good file that is not the known shared file", () => {
    const shared = file("shared", "abc", 0o600);
    const other = file("other", "abc", 0o600);
    fs.symlinkSync(other, path.join(dir, "seat-file"));
    expect(readCredentialFile(path.join(dir, "seat-file"), seatCredentialLinkPolicy("pi-auth", shared))).toMatchObject({ ok: false, problem: "unexpected_link_target" });
  });

  it("holds the shared file to the whole rule: one others can read is refused through the link", () => {
    const shared = file("shared", "abc", 0o644);
    fs.symlinkSync(shared, path.join(dir, "seat-file"));
    expect(readCredentialFile(path.join(dir, "seat-file"), seatCredentialLinkPolicy("pi-auth", shared))).toMatchObject({ ok: false, problem: "group_or_other_access" });
  });

  it("refuses the link when the host declares no shared file", () => {
    const shared = file("shared", "abc", 0o600);
    fs.symlinkSync(shared, path.join(dir, "seat-file"));
    expect(readCredentialFile(path.join(dir, "seat-file"), seatCredentialLinkPolicy("pi-auth", undefined))).toMatchObject({ ok: false, problem: "symlink" });
  });

  it("CONTROL: without a seat link policy the same good link is refused", () => {
    const shared = file("shared", "abc", 0o600);
    fs.symlinkSync(shared, path.join(dir, "seat-file"));
    expect(readCredentialFile(path.join(dir, "seat-file"), SECRET)).toMatchObject({ ok: false, problem: "symlink" });
  });

  it("names exactly four exceptions: three secrets and the Codex seat config link (o9o.151 census; o9o.160)", () => {
    expect(Object.keys(SEAT_CREDENTIAL_LINKS).sort()).toEqual(["codex-auth", "codex-config", "pi-auth", "pi-models"]);
    expect(Object.entries(SEAT_CREDENTIAL_LINKS).map(([k, v]) => `${k}:${v.policy.kind}`).sort())
      .toEqual(["codex-auth:secret", "codex-config:registry", "pi-auth:secret", "pi-models:secret"]);
  });
});

describe("o9o.160: files OpenRig owns are narrowed, another program's registry is warned about (CoS 11-18 13:32Z)", () => {
  it("readOwnFile clears only the group/other WRITE bits of a registry of ours, and reads it", () => {
    const p = file("daemon.json", "{}", 0o664);
    expect(readOwnFile(p, DAEMON_STATE_POLICY)).toEqual({ ok: true, content: "{}" });
    expect(fs.statSync(p).mode & 0o777).toBe(0o644);
  });

  it("readOwnFile narrows a secret of ours to 0600", () => {
    const p = file("token", "abc", 0o644);
    expect(readOwnFile(p, SECRET)).toEqual({ ok: true, content: "abc" });
    expect(fs.statSync(p).mode & 0o777).toBe(0o600);
  });

  it("readOwnFile still refuses a link, and narrows nothing behind it", () => {
    const real = file("real.json", "{}", 0o664);
    fs.symlinkSync(real, path.join(dir, "daemon.json"));
    expect(readOwnFile(path.join(dir, "daemon.json"), DAEMON_STATE_POLICY)).toMatchObject({ ok: false, problem: "symlink" });
    expect(fs.statSync(real).mode & 0o777).toBe(0o664);
  });

  it("a Codex config others can change is read with a warning naming the chmod, and is never chmod-ed", () => {
    const p = file("config.toml", "model = 'x'\n", 0o664);
    const r = readCredentialFile(p, CODEX_CONFIG_POLICY);
    expect(r).toMatchObject({ ok: true, content: "model = 'x'\n", warning: { problem: "group_or_other_write" } });
    if (r.ok) expect(r.warning?.message).toContain("chmod go-w");
    expect(fs.statSync(p).mode & 0o777).toBe(0o664);
  });

  it("warn mode downgrades nothing else: a link is refused, and a clean file has no warning", () => {
    const real = file("real.toml", "a = 1\n", 0o644);
    fs.symlinkSync(real, path.join(dir, "config.toml"));
    expect(readCredentialFile(path.join(dir, "config.toml"), CODEX_CONFIG_POLICY)).toMatchObject({ ok: false, problem: "symlink" });
    expect(readCredentialFile(real, CODEX_CONFIG_POLICY)).toEqual({ ok: true, content: "a = 1\n" });
  });

  it("config.json may be a link (CoS 13:36Z): its real target is read, and narrowed, not the link", () => {
    const target = file("dotfiles-config.json", "{}", 0o664);
    fs.symlinkSync(target, path.join(dir, "config.json"));
    expect(readOwnFile(path.join(dir, "config.json"), OPENRIG_CONFIG_POLICY)).toEqual({ ok: true, content: "{}" });
    expect(fs.statSync(target).mode & 0o777).toBe(0o644);
    expect(fs.lstatSync(path.join(dir, "config.json")).isSymbolicLink()).toBe(true);
  });

  it("config.json's link target is still held to the rule: a directory is refused", () => {
    fs.mkdirSync(path.join(dir, "not-a-file"), { mode: 0o700 });
    fs.symlinkSync(path.join(dir, "not-a-file"), path.join(dir, "config.json"));
    expect(readOwnFile(path.join(dir, "config.json"), OPENRIG_CONFIG_POLICY)).toMatchObject({ ok: false, problem: "not_regular_file" });
  });

  it("CONTROL: daemon.json's policy does not follow the same link (the asymmetry is deliberate)", () => {
    const target = file("elsewhere.json", "{}", 0o644);
    fs.symlinkSync(target, path.join(dir, "daemon.json"));
    expect(readOwnFile(path.join(dir, "daemon.json"), DAEMON_STATE_POLICY)).toMatchObject({ ok: false, problem: "symlink" });
  });

  it("CONTROL: without warn mode a registry others can change is refused", () => {
    expect(readCredentialFile(file("hosts.yaml", "x", 0o664), REGISTRY)).toMatchObject({ ok: false, problem: "group_or_other_write" });
  });
});
