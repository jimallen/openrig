// workspaces-o9o.151: the one rule for reading a credential, token or hosts registry file (domain/credential-file.ts), as the
// fs adapter applies it. Every fixture sets its own mode, so the rows hold under any umask.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readCredentialFile } from "../src/adapters/node-credential-file-reader.js";
import { HOSTS_REGISTRY_POLICY, TERMINAL_TOKEN_POLICY, type CredentialFilePolicy } from "../src/domain/credential-file.js";

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
const LINKED: CredentialFilePolicy = { label: "the linked file", kind: "secret", maxBytes: 4096, followLinkToCheckedTarget: true };

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

describe("readCredentialFile: the one named link exception (o9o.151 decision 5)", () => {
  it("follows a link to a good target", () => {
    const target = file("real", "abc", 0o600);
    fs.symlinkSync(target, path.join(dir, "link"));
    expect(readCredentialFile(path.join(dir, "link"), LINKED)).toEqual({ ok: true, content: "abc" });
  });

  it("holds the target to the whole rule: a target others can read is refused", () => {
    const target = file("real", "abc", 0o644);
    fs.symlinkSync(target, path.join(dir, "link"));
    expect(readCredentialFile(path.join(dir, "link"), LINKED)).toMatchObject({ ok: false, problem: "group_or_other_access" });
  });

  it("CONTROL: without the exception the same good link is refused", () => {
    const target = file("real", "abc", 0o600);
    fs.symlinkSync(target, path.join(dir, "link"));
    expect(readCredentialFile(path.join(dir, "link"), SECRET)).toMatchObject({ ok: false, problem: "symlink" });
  });
});
