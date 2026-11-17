// workspaces-o9o.11: the real reads behind `LocalHostFacts` (host-readiness.ts). Kept apart so the checks stay pure.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { LocalHostFacts } from "./host-readiness.js";
import { defaultHostRegistryPath, loadHostRegistry } from "./host-registry.js";

export function realLocalHostFacts(): LocalHostFacts {
  return {
    platform: process.platform,
    uid: typeof process.getuid === "function" ? process.getuid() : null,
    readFile: (file) => { try { return readFileSync(file, "utf-8"); } catch { return null; } },
    readdir: (dir) => { try { return readdirSync(dir); } catch { return null; } },
    readlink: (file) => { try { return readlinkSync(file); } catch { return null; } },
    stat: (file) => { try { const st = statSync(file); return { isFile: st.isFile(), isDirectory: st.isDirectory(), uid: st.uid }; } catch { return null; } },
    gitTemplateHasExclude: () => {
      const dir = mkdtempSync(path.join(tmpdir(), "openrig-doctor-git-"));
      try {
        execFileSync("git", ["init", "-q", dir], { stdio: ["ignore", "ignore", "ignore"] });
        return existsSync(path.join(dir, ".git", "info", "exclude"));
      } catch {
        return null;
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    registeredHosts: () => {
      if (!existsSync(defaultHostRegistryPath())) return null;
      const loaded = loadHostRegistry();
      return loaded.ok ? { ids: loaded.registry.hosts.map((host) => host.id) } : { error: loaded.error };
    },
  };
}
