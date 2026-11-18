import { existsSync, readFileSync } from "node:fs";
import { getDefaultOpenRigPath } from "../openrig-compat.js";
import { loadHostRegistry } from "../domain/hosts/hosts-registry-reader.js";
import { nodeCredentialFileReader } from "./node-credential-file-reader.js";
import type { HostDirectory } from "../domain/seat-messaging/reply-path.js";

/**
 * This host's name for another host, read the way `rig send member@rig@<host>` resolves it here (cli resolveHost with its learned bindings), so a
 * reply line this daemon writes is a command the CLI on this host can run (workspaces-o9o.16). The order is the CLI's: a registry alias, then an
 * entry's declared `hostId`, then the self-id the CLI learned for an entry (host-bindings.json). Both files are read on every call, so a host the
 * operator adds is named on the next arrival, and both fail open: a missing or broken file names nothing, which reads as "no reply path".
 */
export class RegistryHostDirectory implements HostDirectory {
  constructor(private readonly paths: { registry?: string; bindings?: string } = {}) {}

  nameFor(hostId: string): string | null {
    const loaded = loadHostRegistry(nodeCredentialFileReader, this.paths.registry);
    if (!loaded.ok) return null;
    const hosts = loaded.registry.hosts;
    const learned = learnedSelfIds(this.paths.bindings ?? getDefaultOpenRigPath("host-bindings.json"));
    const match = hosts.find((h) => h.id === hostId) ?? hosts.find((h) => h.hostId === hostId) ?? hosts.find((h) => learned[h.id] === hostId);
    return match?.id ?? null;
  }
}

/** The CLI's learned sidecar, read only: each registry alias with the self-id it was learned to have. The CLI owns the file and its writes. */
function learnedSelfIds(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as { version?: unknown; bindings?: unknown } | null;
    if (!parsed || typeof parsed !== "object" || (parsed.version !== undefined && parsed.version !== 1)) return {};
    if (!parsed.bindings || typeof parsed.bindings !== "object") return {};
    const out: Record<string, string> = {};
    for (const [alias, binding] of Object.entries(parsed.bindings as Record<string, unknown>)) {
      const hostId = (binding as { hostId?: unknown } | null)?.hostId;
      if (typeof hostId === "string" && hostId.length > 0) out[alias] = hostId;
    }
    return out;
  } catch {
    return {};
  }
}
