// workspaces-6ul: SettingsStore keeps the settings rules in the domain (env > file > default, validation, verify-after-write) and
// reaches config.json only through its SettingsFile port; the file mechanics live in adapters/node-settings-file.ts. These rows drive
// the store through an in-memory SettingsFile, with no file at all, and pin the null-object reader the domain falls back to.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { CredentialFileRead } from "../src/domain/credential-file.js";
import type { SettingsFile } from "../src/domain/user-settings/settings-file.js";
import { DEFAULT_SETTINGS, SettingsStore } from "../src/domain/user-settings/settings-store.js";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));

/** config.json in memory: `content` null means absent; `refusal` makes every read refuse. */
function memoryFile(content: string | null = null, refusal?: CredentialFileRead & { ok: false }) {
  const file = {
    path: "/mem/.openrig/config.json",
    content,
    writes: 0,
    read: (): CredentialFileRead => refusal ?? (file.content === null
      ? { ok: false, problem: "missing", message: "no config.json" } : { ok: true, content: file.content }),
    exists: () => file.content !== null,
    write: (next: string) => { file.content = next; file.writes++; },
    remove: () => { file.content = null; },
  };
  const port: SettingsFile = file;
  return { file, port };
}

const ENV = "OPENRIG_QUEUE_WAKE_RETRY_CAP";
afterEach(() => { delete process.env[ENV]; });

describe("workspaces-6ul: SettingsStore reaches config.json only through its SettingsFile port", () => {
  it("settings-store imports no node:fs, node:os or node:crypto", () => {
    const text = readFileSync(SRC + "domain/user-settings/settings-store.ts", "utf8");
    const imports = text.split("\n").filter((l) => /^import\b/.test(l) && /from\s+["']node:(fs|os|crypto)["']/.test(l));
    expect(imports).toEqual([]);
  });

  it("resolves env > file > default through the port, and path defaults under the home it was given", () => {
    const { port } = memoryFile(JSON.stringify({ queue: { wakeRetryCap: 5 } }));
    const store = new SettingsStore(port, "/home/x/.openrig");
    expect(store.resolveOne("queue.wake_retry_cap")).toMatchObject({ value: 5, source: "file" });
    process.env[ENV] = "7";
    expect(store.resolveOne("queue.wake_retry_cap")).toMatchObject({ value: 7, source: "env" });
    expect(store.resolveOne("queue.wake_swap_grace_seconds")).toMatchObject({ value: 180, source: "default" });
    expect(store.resolveOne("topology.root").value).toBe("/home/x/.openrig/topology");
    expect(store.resolveOne("workspace.specs_root").value).toBe("/home/x/.openrig/workspace/specs");
  });

  it("writes and resets through the port, verifying the write by reading it back", () => {
    const { file, port } = memoryFile();
    const store = new SettingsStore(port, "/h");
    store.set("queue.wake_retry_cap", "4");
    expect(JSON.parse(file.content!)).toEqual({ queue: { wakeRetryCap: 4 } });
    store.reset("queue.wake_retry_cap");
    expect(JSON.parse(file.content!)).toEqual({ queue: {} });
    store.reset();
    expect(file.content).toBeNull();
  });

  it("a refused read throws, naming the fix; a write that does not persist is refused", () => {
    const { port } = memoryFile(null, { ok: false, problem: "wrong_owner", message: "config.json belongs to another user" });
    expect(() => new SettingsStore(port, "/h").resolveOne("queue.wake_retry_cap"))
      .toThrow("refusing to read the OpenRig config: config.json belongs to another user");
    const lossy = memoryFile();
    lossy.file.write = () => { lossy.file.writes++; };
    expect(() => new SettingsStore(lossy.port, "/h").set("queue.wake_retry_cap", "4")).toThrow(/did NOT persist/);
  });

  it("DEFAULT_SETTINGS resolves a key to its built-in default and reads nothing; a home-derived key has no default there", () => {
    process.env[ENV] = "9";
    expect(DEFAULT_SETTINGS.resolveOne("queue.wake_retry_cap")).toEqual({ value: 3, source: "default", defaultValue: 3 });
    expect(() => DEFAULT_SETTINGS.resolveOne("topology.root")).toThrow("topology.root has no default without an OpenRig home");
    expect(() => DEFAULT_SETTINGS.resolveOne("policies.claude_compaction.message_file_path")).toThrow(/no default without an OpenRig home/);
  });
});
