// workspaces-o9o.160: rig doctor and rig setup read Codex's config.toml (it chooses the provider credential) under the credential
// rule. A config the rule refuses is reported as a failed codex_auth check naming the file and the fix; it is never chmod-ed.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CODEX_CONFIG_POLICY, readCredentialFile } from "@openrig/daemon/credential-file";
import { checkCodexAuth } from "../src/provider-auth.js";

let home: string;
beforeEach(() => { home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codex-config-auth-"))); });
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

const CONFIG = 'model_provider = "local"\n[model_providers.local]\nenv_key = "LOCAL_PROVIDER_KEY"\n';
const deps = () => ({
  exec: () => "",
  readFile: (p: string) => { try { return fs.readFileSync(p, "utf8"); } catch { return null; } },
  readCodexConfig: (p: string) => readCredentialFile(p, CODEX_CONFIG_POLICY),
  env: { CODEX_HOME: home, LOCAL_PROVIDER_KEY: "set" },
});

describe("checkCodexAuth reads config.toml under the rule (o9o.160)", () => {
  it("CONTROL: a config others may read but not change chooses the provider as before", () => {
    const p = path.join(home, "config.toml");
    fs.writeFileSync(p, CONFIG); fs.chmodSync(p, 0o644);
    expect(checkCodexAuth(deps(), true).status).toBe("pass");
  });

  it("fails codex_auth on a config others can change, naming it and the fix, and never chmods it", () => {
    const p = path.join(home, "config.toml");
    fs.writeFileSync(p, CONFIG); fs.chmodSync(p, 0o664);
    const r = checkCodexAuth(deps(), true);
    expect(r.status).toBe("fail");
    expect(`${r.message} ${r.fix ?? ""}`).toContain(p);
    expect(`${r.message} ${r.fix ?? ""}`).toContain("chmod go-w");
    expect(fs.statSync(p).mode & 0o777).toBe(0o664);
  });

  it("follows a dotfiles-linked config.toml and judges its real target (CoS 18:50Z: config, not a login; OF-42's layout)", () => {
    const real = path.join(home, "elsewhere.toml");
    fs.writeFileSync(real, CONFIG); fs.chmodSync(real, 0o644);
    fs.symlinkSync(real, path.join(home, "config.toml"));
    expect(checkCodexAuth(deps(), true).status).toBe("pass");
  });

  it("fails codex_auth when the linked config's real target can be changed by others", () => {
    const real = path.join(home, "elsewhere.toml");
    fs.writeFileSync(real, CONFIG); fs.chmodSync(real, 0o664);
    fs.symlinkSync(real, path.join(home, "config.toml"));
    const r = checkCodexAuth(deps(), true);
    expect(r.status).toBe("fail");
    expect(r.fix ?? "").toContain("chmod go-w");
    expect(fs.statSync(real).mode & 0o777).toBe(0o664);
  });
});
