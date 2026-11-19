// workspaces-o9o.151: `@openrig/daemon/credential-file` is how the CLI reads a credential, token or hosts registry file under the
// one rule. It must reach only the rule and its fs adapter, so the CLI never pulls daemon state in through it.
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as surface from "../src/credential-file-surface.js";
import * as rule from "../src/domain/credential-file.js";
import * as reader from "../src/adapters/node-credential-file-reader.js";
import * as writer from "../src/adapters/guarded-rewrite.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "../src");

describe("the credential-file surface", () => {
  it("exports exactly the reader, the policies and the rule's pure parts", () => {
    expect(Object.keys(surface).sort()).toEqual([
      "ACTIVITY_ENDPOINT_POLICY", "ACTIVITY_HOOK_TOKEN_POLICY", "BEARER_FILE_POLICY",
      // workspaces-o9o.182: Claude's files, the Codex profile and seat registry, and host-bindings.json.
      "CLAUDE_MCP_POLICY", "CLAUDE_SETTINGS_POLICY", "CLAUDE_STATE_POLICY",
      "CODEX_AUTH_POLICY", "CODEX_CONFIG_POLICY", "CODEX_PROFILE_POLICY", "CODEX_SEAT_REGISTRY_POLICY",
      "DAEMON_STATE_POLICY", "HOSTS_REGISTRY_POLICY", "HOST_BINDINGS_POLICY", "OPENRIG_CONFIG_POLICY", "PI_AUTH_POLICY", "PI_MODELS_POLICY", "SEAT_CREDENTIAL_LINKS",
      "SLACK_CONNECTOR_POLICY", "SLACK_SECRETS_POLICY", "TERMINAL_TOKEN_POLICY", "credentialFileRefusal", "inspectCredentialFile",
      "judgeOpenedCredentialFile", "nodeCredentialFileReader", "readCredentialFile", "readOwnFile",
      // workspaces-o9o.182: the rule's write half.
      "rewriteGuardedFile", "seatCredentialLinkPolicy",
    ]);
  });

  it("each name is the defining module's own value, not a copy", () => {
    expect(surface.readCredentialFile).toBe(reader.readCredentialFile);
    expect(surface.nodeCredentialFileReader).toBe(reader.nodeCredentialFileReader);
    expect(surface.inspectCredentialFile).toBe(reader.inspectCredentialFile);
    expect(surface.readOwnFile).toBe(reader.readOwnFile);
    expect(surface.rewriteGuardedFile).toBe(writer.rewriteGuardedFile);
    for (const name of ["TERMINAL_TOKEN_POLICY", "HOSTS_REGISTRY_POLICY", "HOST_BINDINGS_POLICY", "CLAUDE_SETTINGS_POLICY", "judgeOpenedCredentialFile", "credentialFileRefusal"] as const) {
      expect(surface[name], name).toBe(rule[name]);
    }
  });

  it("the rule and its procedure import nothing at all (o9o.160, CoS: the domain module is pure; I/O is injected)", () => {
    const text = readFileSync(join(SRC, "domain/credential-file.ts"), "utf8");
    expect(text.match(/^\s*import\b|\bimport\(|\brequire\(/gm) ?? []).toEqual([]);
  });

  it("reaches four files and only node:fs and node:crypto (the rule itself imports nothing)", () => {
    const seen = new Set<string>();
    const external = new Set<string>();
    const walk = (file: string): void => {
      if (seen.has(file)) return;
      seen.add(file);
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/(?:^|\n)\s*(?:import|export)\b[^;]*?\bfrom\s+"([^"]+)"|(?:^|\n)\s*import\s+"([^"]+)"|\bimport\(\s*"([^"]+)"\s*\)/g)) {
        const spec = m[1] ?? m[2] ?? m[3]!;
        if (spec.startsWith(".")) walk(resolve(dirname(file), spec.replace(/\.js$/, ".ts")));
        else external.add(spec);
      }
    };
    walk(join(SRC, "credential-file-surface.ts"));
    expect([...seen].map((f) => relative(SRC, f)).sort()).toEqual([
      // workspaces-o9o.182: and the write half's node:fs binding (node:crypto names its temp files).
      "adapters/guarded-rewrite.ts", "adapters/node-credential-file-reader.ts", "credential-file-surface.ts", "domain/credential-file.ts",
    ]);
    expect([...external].sort()).toEqual(["node:crypto", "node:fs"]);
  });
});
