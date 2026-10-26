// OF-102: `rig spec-source show|set` - read, or record, where an existing rig's spec came from, so
// `rig seat launch <seat> --fresh --startup-from spec` can re-read that rig's startup policy. Rigs made before
// OpenRig recorded a spec source have none. `set` changes only that record (audited); no seat is touched.
import nodePath from "node:path";
import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl, daemonStatusGuard } from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";
import { resolveRigHandle } from "../rig-handle.js";

export function specSourceCommand(depsOverride?: StatusDeps): Command {
  const cmd = new Command("spec-source")
    .description("Show or record the spec file a rig's fresh seat launches re-read startup files from");
  const getDeps = (): StatusDeps => depsOverride ?? { lifecycleDeps: realDeps(), clientFactory: (url: string) => new DaemonClient(url) };

  /** The rig's id, or null after printing why not (ambiguous or unknown handles never reach a request). */
  async function resolveRig(client: DaemonClient, handle: string, json?: boolean): Promise<string | null> {
    const resolution = await resolveRigHandle(client, handle);
    if (resolution.kind === "resolved") return resolution.id;
    if (resolution.kind === "passthrough") return resolution.handle;
    const message = resolution.kind === "ambiguous"
      ? `'${resolution.name}' matches ${resolution.ids.length} rigs; re-run with one id: ${resolution.ids.join(", ")}`
      : `No rig found matching '${resolution.handle}'. List rigs with: rig ps`;
    if (json) console.log(JSON.stringify({ ok: false, error: message })); else console.error(`Error: ${message}`);
    process.exitCode = 2;
    return null;
  }

  cmd.command("show")
    .argument("<rig>", "Rig name or ID")
    .option("--json", "JSON output")
    .description("Show the rig's recorded spec source, where it leads now, and whether it can be read")
    .action(async (rig: string, opts: { json?: boolean }) => {
      const deps = getDeps();
      const status = await getDaemonStatus(deps.lifecycleDeps);
      if (!daemonStatusGuard(status)) return;
      const client = deps.clientFactory(getDaemonUrl(status));
      const rigId = await resolveRig(client, rig, opts.json);
      if (!rigId) return;
      const res = await client.get<Record<string, unknown>>(`/api/rigs/${encodeURIComponent(rigId)}/spec-source`);
      if (opts.json) {
        console.log(JSON.stringify(res.data, null, 2));
        if (res.status >= 400) process.exitCode = res.status >= 500 ? 2 : 1;
        return;
      }
      if (res.status >= 400) {
        console.error(String(res.data["message"] ?? res.data["error"] ?? `Failed (HTTP ${res.status})`));
        process.exitCode = res.status >= 500 ? 2 : 1;
        return;
      }
      const source = res.data["specSource"] as string | null;
      if (!source) {
        console.log(`Rig ${res.data["rigName"]} records no spec source. Record one with: rig spec-source set ${res.data["rigName"]} <path-to-rig.yaml> --operator <address>`);
        return;
      }
      console.log(`Spec source: ${source}`);
      if (res.data["resolvedPath"] && res.data["resolvedPath"] !== source) console.log(`  now leads to: ${res.data["resolvedPath"]}`);
      if (res.data["unavailable"]) console.log(`  cannot be used now: ${res.data["unavailable"]}`);
    });

  cmd.command("set")
    .argument("<rig>", "Rig name or ID")
    .argument("<path>", "Rig spec file (rig.yaml); a link keeps its spelling")
    .option("--operator <address>", "Operator recorded on the audit event when no session identity is present")
    .option("--json", "JSON output")
    .description("Record or replace the rig's spec source (audited; changes no seat, session or saved startup context)")
    .addHelpText("after", `
The spec must exist, parse as a rig spec, be named like this rig, and declare every seat the rig has.
The path is recorded as typed (relative paths are made absolute against this directory, but links
are not followed), so a library link keeps leading to whatever release it points at later.

Examples:
  rig spec-source set kernel ~/.openrig/shared-docs/rigs/kernel/rig.yaml --operator me@kernel
  rig seat launch operator.agent@kernel --fresh --stop --startup-from spec --reason "re-read spec"`)
    .action(async (rig: string, path: string, opts: { operator?: string; json?: boolean }) => {
      const deps = getDeps();
      const status = await getDaemonStatus(deps.lifecycleDeps);
      if (!daemonStatusGuard(status)) return;
      const client = deps.clientFactory(getDaemonUrl(status));
      const rigId = await resolveRig(client, rig, opts.json);
      if (!rigId) return;
      const res = await client.post<Record<string, unknown>>(`/api/rigs/${encodeURIComponent(rigId)}/spec-source`, {
        path: nodePath.resolve(path), ...(opts.operator ? { operator: opts.operator } : {}),
      });
      if (opts.json) {
        console.log(JSON.stringify(res.data, null, 2));
        if (res.status >= 400) process.exitCode = res.status >= 500 ? 2 : 1;
        return;
      }
      if (res.status >= 400) {
        console.error(String(res.data["message"] ?? res.data["error"] ?? `Failed (HTTP ${res.status})`));
        const mismatches = res.data["mismatches"];
        if (Array.isArray(mismatches)) for (const m of mismatches) console.error(`  - ${String(m)}`);
        process.exitCode = res.status >= 500 ? 2 : 1;
        return;
      }
      if (res.data["changed"] === false) { console.log(`Spec source already ${res.data["to"]}; nothing changed.`); return; }
      console.log(`Spec source of ${res.data["rigName"]}: ${res.data["from"] ?? "(none)"} -> ${res.data["to"]}`);
      console.log(String(res.data["effect"]));
    });

  return cmd;
}
