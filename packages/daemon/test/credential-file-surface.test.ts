// workspaces-o9o.151: `@openrig/daemon/credential-file` is how the CLI reads a credential, token or hosts registry file under the
// one rule. It must reach only the rule and its fs adapter, so the CLI never pulls daemon state in through it.
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as surface from "../src/credential-file-surface.js";
import * as rule from "../src/domain/credential-file.js";
import * as reader from "../src/adapters/node-credential-file-reader.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "../src");

describe("the credential-file surface", () => {
  it("exports exactly the reader, the policies and the rule's pure parts", () => {
    expect(Object.keys(surface).sort()).toEqual([
      "ACTIVITY_ENDPOINT_POLICY", "ACTIVITY_HOOK_TOKEN_POLICY", "BEARER_FILE_POLICY", "CODEX_AUTH_POLICY", "HOSTS_REGISTRY_POLICY",
      "PI_AUTH_POLICY", "PI_MODELS_POLICY", "SLACK_SECRETS_POLICY", "TERMINAL_TOKEN_POLICY", "credentialFileRefusal",
      "judgeOpenedCredentialFile", "nodeCredentialFileReader", "readCredentialFile",
    ]);
  });

  it("each name is the defining module's own value, not a copy", () => {
    expect(surface.readCredentialFile).toBe(reader.readCredentialFile);
    expect(surface.nodeCredentialFileReader).toBe(reader.nodeCredentialFileReader);
    for (const name of ["TERMINAL_TOKEN_POLICY", "HOSTS_REGISTRY_POLICY", "judgeOpenedCredentialFile", "credentialFileRefusal"] as const) {
      expect(surface[name], name).toBe(rule[name]);
    }
  });

  it("reaches three files and only node:fs (the rule itself imports nothing)", () => {
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
      "adapters/node-credential-file-reader.ts", "credential-file-surface.ts", "domain/credential-file.ts",
    ]);
    expect([...external].sort()).toEqual(["node:fs"]);
  });
});
