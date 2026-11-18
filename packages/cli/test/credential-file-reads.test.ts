// workspaces-o9o.151: the CLI reads the terminal token, a host's bearer file and hosts.yaml under the one credential rule
// (@openrig/daemon/credential-file): a symlink, a file others can read (a secret) or change (the registry) is refused, and the
// refusal names the file and the fix. Every fixture sets its own mode, so the rows hold under any umask.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadHostRegistry, resolveRemoteBearer, type HttpHostEntry } from "../src/host-registry.js";

let dir: string;
beforeEach(() => { dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cli-cred-"))); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

function file(name: string, content: string, mode: number): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  fs.chmodSync(p, mode);
  return p;
}

const TOKEN = "t" + "0".repeat(15);

describe("terminalAuthHeaders reads <OPENRIG_HOME>/terminal-token under the rule (o9o.151)", () => {
  async function headersWith(mode: number | "link"): Promise<{ headers: Record<string, string>; stderr: string }> {
    vi.stubEnv("OPENRIG_TERMINAL_BEARER_TOKEN", "");
    vi.stubEnv("OPENRIG_HOME", dir);
    if (mode === "link") {
      fs.symlinkSync(file("elsewhere", TOKEN, 0o600), path.join(dir, "terminal-token"));
    } else {
      file("terminal-token", TOKEN, mode);
    }
    let stderr = "";
    vi.spyOn(process.stderr, "write").mockImplementation((s: string | Uint8Array) => { stderr += String(s); return true; });
    vi.resetModules(); // the "said once" flag is per module instance
    const { terminalAuthHeaders } = await import("../src/client.js");
    return { headers: terminalAuthHeaders(), stderr };
  }

  it("sends a 0600 token of ours", async () => {
    expect((await headersWith(0o600)).headers).toEqual({ Authorization: `Bearer ${TOKEN}` });
  });

  it("does not send a token others can read, and says which file and the fix", async () => {
    const { headers, stderr } = await headersWith(0o644);
    expect(headers).toEqual({});
    expect(stderr).toContain(path.join(dir, "terminal-token"));
    expect(stderr).toContain("chmod 600");
    expect(stderr).not.toContain(TOKEN);
  });

  it("does not send a token reached through a symlink", async () => {
    const { headers, stderr } = await headersWith("link");
    expect(headers).toEqual({});
    expect(stderr).toContain("symbolic link");
  });
});

describe("resolveRemoteBearer reads a bearer_file under the rule (o9o.151)", () => {
  const host = (bearer_file: string): HttpHostEntry => ({ id: "vps", transport: "http", url: "http://vps:7433", bearer_file });

  it("resolves a 0600 bearer file of ours", () => {
    expect(resolveRemoteBearer(host(file("b", `${TOKEN}\n`, 0o600)))).toEqual({ ok: true, token: TOKEN });
  });

  it("refuses one others can read, naming the file and the fix, never the token", () => {
    const p = file("b", TOKEN, 0o644);
    const r = resolveRemoteBearer(host(p));
    expect(r).toMatchObject({ ok: false, failedStep: "permission-gate" });
    expect(JSON.stringify(r)).toContain(p);
    expect(JSON.stringify(r)).toContain("chmod 600");
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  it("refuses a symlinked bearer file", () => {
    fs.symlinkSync(file("real", TOKEN, 0o600), path.join(dir, "link"));
    expect(resolveRemoteBearer(host(path.join(dir, "link")))).toMatchObject({ ok: false, failedStep: "permission-gate" });
  });
});

describe("loadHostRegistry reads hosts.yaml under the registry rule (o9o.151)", () => {
  const YAML = "hosts:\n  - id: vps\n    transport: http\n    url: http://vps:7433\n";

  it("loads one others may read but not change", () => {
    expect(loadHostRegistry(file("hosts.yaml", YAML, 0o644))).toMatchObject({ ok: true });
  });

  it("refuses one group or others can change, naming the chmod go-w fix", () => {
    const r = loadHostRegistry(file("hosts.yaml", YAML, 0o664));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("chmod go-w");
  });

  it("refuses a symlinked registry (the live-host census decides whether links are allowed; until then, refused)", () => {
    fs.symlinkSync(file("real.yaml", YAML, 0o644), path.join(dir, "hosts.yaml"));
    const r = loadHostRegistry(path.join(dir, "hosts.yaml"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("symbolic link");
  });

  it("keeps the not-found message for a missing registry", () => {
    const r = loadHostRegistry(path.join(dir, "nope.yaml"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("host registry not found");
  });
});
