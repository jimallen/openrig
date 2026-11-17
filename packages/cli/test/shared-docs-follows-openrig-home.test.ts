import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveLegacyTopologyRigsRoot } from "../src/config-store.js";
import { heartbeatCommand } from "../src/commands/heartbeat.js";
import { resolveSharedDocsRoot } from "../src/openrig-compat.js";

// workspaces-o9o.46, the CLI's builders. The shared-docs tree follows OPENRIG_HOME (OPENRIG_SHARED_DOCS_ROOT names another), the
// rule in @openrig/daemon/shared-docs-root. Every home here is a temp dir; the operator's real one is never read or written.

const temps: string[] = [];
const temp = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
};
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

function writeQueue(sharedDocs: string, id: string): void {
  const dir = join(sharedDocs, "rigs", "alpha", "state", "dev");
  mkdirSync(dir, { recursive: true });
  // The entry shape heartbeat.test.ts writes.
  writeFileSync(join(dir, "impl.queue.md"), ["---", "doc: q", "---", "", "# queue", "", "---", `id: ${id}`,
    "ts-created: 2026-04-24T08:00:00Z", "ts-updated: 2026-04-24T08:00:00Z", "state: in-progress", "blocked-on: null",
    "handed-off-to: null", "---", "", `### ${id}`, "", "body"].join("\n"));
}

/** An operator account whose ~/.openrig/shared-docs holds a queue, and an instance with its own OPENRIG_HOME holding another. */
function scratchInstance(): { operatorHome: string; instanceHome: string } {
  const operatorHome = temp("o9o46-op-");
  writeQueue(join(operatorHome, ".openrig", "shared-docs"), "operators-item");
  const instanceHome = temp("o9o46-inst-");
  writeQueue(join(instanceHome, "shared-docs"), "instances-item");
  vi.stubEnv("HOME", operatorHome);
  vi.stubEnv("OPENRIG_HOME", instanceHome);
  vi.stubEnv("RIGGED_HOME", undefined);
  vi.stubEnv("OPENRIG_SHARED_DOCS_ROOT", undefined);
  return { operatorHome, instanceHome };
}

describe("o9o.46: the CLI's shared-docs builders follow OPENRIG_HOME", () => {
  it("the legacy topology rigs root of an instance with its own home is under that home", () => {
    const { instanceHome } = scratchInstance();
    expect(resolveLegacyTopologyRigsRoot()).toBe(join(instanceHome, "shared-docs", "rigs"));
  });

  it("rig heartbeat with no shared-docs variable reads the instance's tree, not the operator's", async () => {
    scratchInstance();
    const logs: string[] = [];
    const errors: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => { logs.push(a.join(" ")); });
    vi.spyOn(console, "error").mockImplementation((...a) => { errors.push(a.join(" ")); });
    const exitBefore = process.exitCode;
    process.exitCode = undefined;
    try {
      await heartbeatCommand({ env: {}, now: () => new Date("2026-04-24T12:00:00Z") }).parseAsync(["node", "rig", "--rig", "alpha", "--json"]);
      expect(errors).toEqual([]);
      expect(process.exitCode).toBeUndefined();
    } finally {
      process.exitCode = exitBefore;
    }
    const report = JSON.parse(logs[0] ?? "{}") as { items?: Array<{ id: string }> };
    expect(report.items?.map((i) => i.id)).toEqual(["instances-item"]);
  });
});

describe("o9o.46: the CLI tells a box with a non-default home how to keep its old tree", () => {
  it("warns once per process naming OPENRIG_SHARED_DOCS_ROOT, and moves nothing", () => {
    const operatorHome = temp("o9o46-op-");
    mkdirSync(join(operatorHome, ".openrig", "shared-docs", "rigs"), { recursive: true });
    const instanceHome = temp("o9o46-inst-");
    vi.stubEnv("HOME", operatorHome);
    vi.stubEnv("OPENRIG_HOME", instanceHome);
    vi.stubEnv("RIGGED_HOME", undefined);
    vi.stubEnv("OPENRIG_SHARED_DOCS_ROOT", undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveSharedDocsRoot()).toBe(join(instanceHome, "shared-docs"));
    resolveSharedDocsRoot();
    const notices = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("OPENRIG_SHARED_DOCS_ROOT"));
    expect(notices).toEqual([expect.stringContaining(`OPENRIG_SHARED_DOCS_ROOT=${join(operatorHome, ".openrig", "shared-docs")}`)]);
    expect(existsSync(join(instanceHome, "shared-docs"))).toBe(false);
    expect(existsSync(join(operatorHome, ".openrig", "shared-docs", "rigs"))).toBe(true);
  });
});

// Review of f4aeb5705 (verify-sec): finding 1 for the CLI's resolver, and finding 2, rig heartbeat's own selector, which let
// RIGX_SHARED_DOCS_ROOT win over OPENRIG_SHARED_DOCS_ROOT. Heartbeat now takes the one rule and nothing else.
describe("o9o.46 (review): the CLI takes the same one rule", () => {
  it("a relative OPENRIG_SHARED_DOCS_ROOT is not used by the CLI either", async () => {
    const { instanceHome } = scratchInstance();
    vi.stubEnv("OPENRIG_SHARED_DOCS_ROOT", "relative-docs");
    vi.resetModules();
    const { resolveSharedDocsRoot: resolve } = await import("../src/openrig-compat.js");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolve()).toBe(join(instanceHome, "shared-docs"));
  });

  it("rig heartbeat with both variables set reads OPENRIG_SHARED_DOCS_ROOT's tree, not RIGX_SHARED_DOCS_ROOT's", async () => {
    scratchInstance();
    const configured = temp("o9o46-configured-");
    const legacy = temp("o9o46-legacy-");
    writeQueue(configured, "configured-item");
    writeQueue(legacy, "legacy-item");
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => { logs.push(a.join(" ")); });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const exitBefore = process.exitCode;
    try {
      await heartbeatCommand({ env: { OPENRIG_SHARED_DOCS_ROOT: configured, RIGX_SHARED_DOCS_ROOT: legacy }, now: () => new Date("2026-04-24T12:00:00Z") })
        .parseAsync(["node", "rig", "--rig", "alpha", "--json"]);
    } finally {
      process.exitCode = exitBefore;
    }
    const report = JSON.parse(logs[0] ?? "{}") as { items?: Array<{ id: string }> };
    expect(report.items?.map((i) => i.id)).toEqual(["configured-item"]);
  });
});
