import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveLegacyTopologyRigsRoot } from "../src/domain/user-settings/settings-store.js";
import { specSourceTrustOf } from "../src/domain/recorded-spec-source-judge.js";
import { legacySharedDocsNotice } from "../src/shared-docs-root.js";

// workspaces-o9o.46. A scratch daemon started with its own OPENRIG_HOME created ~/.openrig/shared-docs/rigs/<rig>/state/<pod> in
// the operator's LIVE home and handed it to a Codex seat as --add-dir: five builders took the shared-docs tree from the account's
// home, two from OPENRIG_HOME. The rule is now one (packages/daemon/src/shared-docs-root.ts): OPENRIG_SHARED_DOCS_ROOT, else
// <OPENRIG_HOME>/shared-docs. Every "home" here is a temp dir; the operator's real one is never read or written.

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const temps: string[] = [];
const temp = (prefix: string) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
};
afterEach(() => {
  vi.unstubAllEnvs();
  for (const d of temps.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** An operator account (HOME, with a live-looking ~/.openrig/shared-docs) and an instance with its own OPENRIG_HOME. */
function scratchInstance(): { operatorHome: string; instanceHome: string } {
  const operatorHome = temp("o9o46-op-");
  fs.mkdirSync(path.join(operatorHome, ".openrig", "shared-docs", "rigs"), { recursive: true });
  const instanceHome = temp("o9o46-inst-");
  vi.stubEnv("HOME", operatorHome);
  vi.stubEnv("OPENRIG_HOME", instanceHome);
  vi.stubEnv("RIGGED_HOME", undefined);
  vi.stubEnv("OPENRIG_SHARED_DOCS_ROOT", undefined);
  return { operatorHome, instanceHome };
}

describe("o9o.46: every shared-docs builder follows OPENRIG_HOME, and OPENRIG_SHARED_DOCS_ROOT names another", () => {
  it("the legacy topology rigs root of an instance with its own home is under that home, not the operator's", () => {
    const { instanceHome } = scratchInstance();
    expect(resolveLegacyTopologyRigsRoot()).toBe(path.join(instanceHome, "shared-docs", "rigs"));
  });

  it("the trusted spec-source rigs root honours OPENRIG_SHARED_DOCS_ROOT, as the Codex state folders under it do", () => {
    scratchInstance();
    const named = temp("o9o46-named-");
    vi.stubEnv("OPENRIG_SHARED_DOCS_ROOT", named);
    expect(specSourceTrustOf(undefined).exactDepthRoot?.()).toBe(path.join(named, "rigs"));
    expect(resolveLegacyTopologyRigsRoot()).toBe(path.join(named, "rigs"));
  });

  it("no source file outside shared-docs-root.ts builds a shared-docs path (the rule lives in one place)", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === "node_modules" || e.name === "dist") continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(ts|tsx|mts|cts|js|mjs)$/.test(e.name)) files.push(p);
      }
    };
    for (const pkg of fs.readdirSync(path.join(repoRoot, "packages"))) {
      const src = path.join(repoRoot, "packages", pkg, "src");
      if (fs.existsSync(src)) walk(src);
    }
    expect(files.length).toBeGreaterThan(500); // the population scanned is every package's source
    // A path segment: the quoted literal on its own, as path.join takes it. Prose that mentions the folder is not a builder.
    const segment = /["'`]shared-docs["'`]/;
    const builders = files.filter((f) => segment.test(fs.readFileSync(f, "utf8"))).map((f) => path.relative(repoRoot, f)).sort();
    expect(builders).toEqual(["packages/daemon/src/shared-docs-root.ts"]);
  });
});

describe("o9o.46: a box with a non-default home and its tree still at ~/.openrig/shared-docs is told how to keep it", () => {
  const exists = (present: string[]) => (p: string) => present.includes(p);
  const base = { env: {}, openrigHome: "/srv/openrig", accountHome: "/home/op" };
  const legacy = "/home/op/.openrig/shared-docs";

  it("says so when the new tree is absent and the old one exists, naming OPENRIG_SHARED_DOCS_ROOT", () => {
    const notice = legacySharedDocsNotice(base, exists([legacy]));
    expect(notice).toContain(`OPENRIG_SHARED_DOCS_ROOT=${legacy}`);
    expect(notice).toContain("/srv/openrig/shared-docs");
    expect(notice).toContain("Nothing was moved");
  });

  it.each([
    ["OPENRIG_SHARED_DOCS_ROOT is set", { ...base, env: { OPENRIG_SHARED_DOCS_ROOT: "/elsewhere" } }, [legacy]],
    ["the home is the default (the same path as before)", { ...base, openrigHome: "/home/op/.openrig" }, [legacy]],
    ["the new tree exists", base, [legacy, "/srv/openrig/shared-docs"]],
    ["there is no old tree", base, []],
  ])("is silent when %s", (_why, sources, present) => {
    expect(legacySharedDocsNotice(sources, exists(present as string[]))).toBeNull();
  });

  it("the daemon warns once per process, and moves or copies nothing", async () => {
    const { operatorHome, instanceHome } = scratchInstance();
    // A fresh process's module state: the rows above already resolved this layout, which spent this worker's one notice.
    vi.resetModules();
    const { resolveSharedDocsRoot } = await import("../src/openrig-compat.js");
    const before = fs.readdirSync(path.join(operatorHome, ".openrig", "shared-docs"), { recursive: true }).sort();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveSharedDocsRoot()).toBe(path.join(instanceHome, "shared-docs"));
    resolveSharedDocsRoot();
    expect(warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("OPENRIG_SHARED_DOCS_ROOT"))).toHaveLength(1);
    expect(fs.existsSync(path.join(instanceHome, "shared-docs"))).toBe(false);
    expect(fs.readdirSync(path.join(operatorHome, ".openrig", "shared-docs"), { recursive: true }).sort()).toEqual(before);
    warn.mockRestore();
  });
});

// Review of f4aeb5705 (verify-sec), finding 1: a relative OPENRIG_SHARED_DOCS_ROOT was used as is, so the daemon (trust root,
// from its cwd) and each Codex seat (--add-dir, from the seat's cwd) resolved different trees. A value that is not absolute
// is not used: one warning naming the variable, then the default. It is never resolved against a cwd.
describe("o9o.46 (review): a shared-docs root variable that is not absolute is not used", () => {
  it.each(["OPENRIG_SHARED_DOCS_ROOT", "RIGX_SHARED_DOCS_ROOT"])("a relative %s gives the default <OPENRIG_HOME>/shared-docs and one warning naming it", async (name) => {
    const { instanceHome } = scratchInstance();
    vi.stubEnv(name, "relative-docs");
    vi.resetModules();
    const { resolveSharedDocsRoot } = await import("../src/openrig-compat.js");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveSharedDocsRoot()).toBe(path.join(instanceHome, "shared-docs"));
    resolveSharedDocsRoot();
    // Exactly one "not used" notice for the variable (the legacy-tree notice may also name OPENRIG_SHARED_DOCS_ROOT as the remedy).
    expect(warn.mock.calls.map((c) => String(c[0])).filter((m) => m.startsWith(`Warning: ${name}=`) && m.includes("not an absolute path"))).toHaveLength(1);
    warn.mockRestore();
  });

  it("an absolute RIGX_SHARED_DOCS_ROOT is the older name of the same setting, used only when OPENRIG_SHARED_DOCS_ROOT is unset", async () => {
    scratchInstance();
    const legacy = temp("o9o46-rigx-");
    const named = temp("o9o46-named-");
    vi.stubEnv("RIGX_SHARED_DOCS_ROOT", legacy);
    vi.resetModules();
    const compat = await import("../src/openrig-compat.js");
    expect(compat.resolveSharedDocsRoot()).toBe(legacy);
    vi.stubEnv("OPENRIG_SHARED_DOCS_ROOT", named);
    expect(compat.resolveSharedDocsRoot()).toBe(named);
  });
});

