// workspaces-o9o.44: `rig doctor` names a plugin folder the daemon ignores (a stale copy of openrig-core beside the real
// one once crash-looped Sparky's daemon), by the daemon's own rule, and reads it from disk so it answers while the
// daemon is down. Temp folders only.
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runDoctorChecks, type DoctorDeps } from "../src/commands/doctor.js";
import { stubConfigStore } from "./helpers/stub-config-store.js";

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true }); });

function makeDeps(pluginsDir: string): DoctorDeps {
  return {
    exists: () => true,
    baseDir: "/install/cli/dist",
    readFile: () => null,
    exec: (cmd: string) => (cmd === "hc --version" ? "hc 0.1.16\n" : ""),
    checkPort: async () => true,
    configStore: stubConfigStore({
      daemon: { port: 7433, host: "127.0.0.1" },
      db: { path: "/tmp/openrig/openrig.sqlite" },
      transcripts: { enabled: true, path: "/tmp/openrig/transcripts", lines: 1000, pollIntervalSeconds: 2 },
    }),
    platform: "linux",
    mkdirp: () => {},
    checkWritable: () => {},
    readHcHello: async () => ({ kind: "no_core", detail: "fixture: no core" }),
    pluginsDir,
  };
}

function plugin(dir: string, name: string): void {
  fs.mkdirSync(path.join(dir, ".claude-plugin"), { recursive: true });
  fs.mkdirSync(path.join(dir, "hooks"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name, version: "0.1.0", hooks: "./hooks/claude.json" }));
  fs.writeFileSync(path.join(dir, "hooks", "claude.json"), JSON.stringify({
    hooks: { Stop: [{ hooks: [{ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/refocus.cjs"' }] }] },
  }));
}

function pluginsDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "o9o44-doctor-"));
  roots.push(root);
  return path.join(root, "plugins");
}

describe("rig doctor: vendored_plugins (o9o.44)", () => {
  it("warns, naming the stale copy, the folder kept, and the fix, and moves nothing", () => {
    const dir = pluginsDir();
    plugin(path.join(dir, "openrig-core"), "openrig-core");
    const stale = path.join(dir, "openrig-core.bak-20261021-stale");
    plugin(stale, "openrig-core");

    const check = runDoctorChecks(makeDeps(dir)).checks.find((c) => c.name === "vendored_plugins");

    expect(check?.status).toBe("warn");
    expect(check?.message).toContain(`${stale} is ignored (${path.join(dir, "openrig-core")} is used)`);
    expect(check?.fix).toBe(`Move ${stale} out of ${dir}.`);
    expect(fs.readdirSync(dir).sort()).toEqual(["openrig-core", "openrig-core.bak-20261021-stale"]);
  });

  it("passes when every plugin folder registers its own hooks", () => {
    const dir = pluginsDir();
    plugin(path.join(dir, "openrig-core"), "openrig-core");

    const check = runDoctorChecks(makeDeps(dir)).checks.find((c) => c.name === "vendored_plugins");

    expect(check?.status).toBe("pass");
  });

  it("passes when the plugins folder does not exist", () => {
    const check = runDoctorChecks(makeDeps(pluginsDir())).checks.find((c) => c.name === "vendored_plugins");
    expect(check?.status).toBe("pass");
  });
});
