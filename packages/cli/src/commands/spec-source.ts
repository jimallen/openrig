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
    .option("--bearer <token>", "Operator bearer token, needed only when the daemon was started with one (or set OPENRIG_AUTH_BEARER_TOKEN).")
    .option("--json", "JSON output")
    .description("Record or replace the rig's spec source (trusted spec folders only; audited; changes no seat, session or saved startup context)")
    .addHelpText("after", `
The spec must exist, parse as a rig spec, be named like this rig (or be a project rig spec for it), and
declare every seat the rig has. The path is recorded as typed (relative paths are made absolute against this
directory, but links are not followed), so a library link keeps leading to whatever release it points at later.

This decides what the rig's seats are started from, so the spec file must be one a seat could not have written:
it has to lie (by its real location, links followed) under <OPENRIG_HOME>/shared-docs/rigs, the released copies
(~/.agents-release) or the spec library, be a regular file with one link, and sit on a path owned by you or root
and not writable by group or others. A spec in a temp folder, a git work tree or a seat's folder is refused.
The same rules are applied again every time the recorded source is READ (a fresh launch, a --fresh restore and its
restore-check, "rig seat set-mcp"), including for a source recorded by "rig up" before this command existed: a source
that no longer qualifies refuses that seat's launch with startup_source_untrusted (nothing is stopped, and it never
falls back to the saved files by itself). "rig spec-source show" says whether a launch would refuse it. A path inside
another OpenRig install's packaged specs (.../@openrig/cli/daemon/specs/...) is refused, because a launch always
reads a packaged spec from the running install.
If the daemon was started with OPENRIG_AUTH_BEARER_TOKEN, the call must also carry that token (--bearer or the
same variable); a daemon without one is gated by the folder rule alone.

AFTER THIS, startup files come from the spec by default: a plain "rig seat launch <seat> --fresh" and every
seat listed with --fresh in a restore or "rig up --existing" re-read the spec instead of replaying the saved
files (not only --startup-from spec). Pass --startup-from stored to replay the saved files.

Examples:
  rig spec-source set kernel ~/.openrig/shared-docs/rigs/kernel/rig.yaml --operator me@kernel
  rig seat launch operator.agent@kernel --fresh --stop --startup-from spec --reason "re-read spec"`)
    .action(async (rig: string, path: string, opts: { operator?: string; bearer?: string; json?: boolean }) => {
      const deps = getDeps();
      const status = await getDaemonStatus(deps.lifecycleDeps);
      if (!daemonStatusGuard(status)) return;
      const client = deps.clientFactory(getDaemonUrl(status));
      const rigId = await resolveRig(client, rig, opts.json);
      if (!rigId) return;
      const bearer = opts.bearer ?? process.env.OPENRIG_AUTH_BEARER_TOKEN;
      const res = await client.post<Record<string, unknown>>(`/api/rigs/${encodeURIComponent(rigId)}/spec-source`, {
        path: nodePath.resolve(path), ...(opts.operator ? { operator: opts.operator } : {}),
      }, { headers: bearer ? { Authorization: `Bearer ${bearer}` } : {} });
      if (opts.json) {
        console.log(JSON.stringify(res.data, null, 2));
        if (res.status >= 400) process.exitCode = res.status >= 500 ? 2 : 1;
        return;
      }
      if (res.status === 401) {
        console.error("Unauthorized. This daemon requires its operator bearer token: pass --bearer <token> or export OPENRIG_AUTH_BEARER_TOKEN, then re-run.");
        process.exitCode = 1;
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
      const warnings = res.data["warnings"];
      if (Array.isArray(warnings)) for (const w of warnings) console.error(`Warning: ${String(w)}`);
    });

  return cmd;
}
