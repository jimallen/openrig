// workspaces-o9o.151: the daemon reads hosts.yaml and a host's bearer file through the CredentialFileReader port, under the one
// credential rule. Real files through the production reader; every fixture sets its own mode, so the rows hold under any umask.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { nodeCredentialFileReader } from "../src/adapters/node-credential-file-reader.js";
import { loadHostRegistry, type HttpHostEntry } from "../src/domain/hosts/hosts-registry-reader.js";
import { resolveBearer } from "../src/domain/hosts/remote-daemon-http.js";

let dir: string;
beforeEach(() => { dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "daemon-cred-"))); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function file(name: string, content: string, mode: number): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  fs.chmodSync(p, mode);
  return p;
}

const TOKEN = "t" + "0".repeat(15);
const reader = nodeCredentialFileReader;

describe("resolveBearer reads a bearer_file under the rule (o9o.151)", () => {
  const host = (bearer_file: string): HttpHostEntry => ({ id: "vps", transport: "http", url: "http://vps:7433", bearer_file });

  it("resolves a 0600 bearer file of ours", () => {
    expect(resolveBearer(host(file("b", `${TOKEN}\n`, 0o600)), { credentialFiles: reader })).toEqual({ ok: true, token: TOKEN });
  });

  it("refuses one others can read, naming the file and the fix, never the token", () => {
    const p = file("b", TOKEN, 0o644);
    const r = resolveBearer(host(p), { credentialFiles: reader });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.detail).toContain(p);
    expect(r.detail).toContain("chmod 600");
    expect(r.detail).not.toContain(TOKEN);
  });

  it("refuses a symlinked bearer file", () => {
    fs.symlinkSync(file("real", TOKEN, 0o600), path.join(dir, "link"));
    const r = resolveBearer(host(path.join(dir, "link")), { credentialFiles: reader });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).toContain("symbolic link");
  });

  it("keeps the not-readable failure for a missing bearer file", () => {
    const r = resolveBearer(host(path.join(dir, "nope")), { credentialFiles: reader });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).toContain("not readable");
  });
});

describe("loadHostRegistry reads hosts.yaml under the registry rule (o9o.151)", () => {
  const YAML = "hosts:\n  - id: vps\n    transport: http\n    url: http://vps:7433\n";

  it("loads one others may read but not change", () => {
    expect(loadHostRegistry(reader, file("hosts.yaml", YAML, 0o644))).toMatchObject({ ok: true });
  });

  it("refuses one group or others can change, naming the chmod go-w fix", () => {
    const r = loadHostRegistry(reader, file("hosts.yaml", YAML, 0o664));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("chmod go-w");
  });

  it("refuses a symlinked registry (the live-host census decides whether links are allowed; until then, refused)", () => {
    fs.symlinkSync(file("real.yaml", YAML, 0o644), path.join(dir, "hosts.yaml"));
    const r = loadHostRegistry(reader, path.join(dir, "hosts.yaml"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("symbolic link");
  });

  it("keeps the not-found message for a missing registry", () => {
    const r = loadHostRegistry(reader, path.join(dir, "nope.yaml"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("host registry not found");
  });
});
