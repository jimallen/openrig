// OPR.0.4.1.29 — `rig auth <verb> [--runtime codex]`: CLI-LOCAL / daemon-free auth-profile management.
// Capability-grouped with runtime as an orthogonal flag (NOT `rig codex-auth`, NOT a `rig codex` noun)
// per conventions/cli-read-command-grammar. Every line printed here is built ONLY from the structured,
// non-secret result fields of the secret-safe lib — a token value can never reach stdout/stderr.
import { Command } from "commander";
import {
  resolveCodexHome,
  authStatus,
  authList,
  authSave,
  authSwitch,
  authValidate,
  authSeatSet,
  authSeatsListResult,
  authSeatShow,
  authSeatsReport,
  SEAT_REGISTRY_DISCLAIMER,
  type CodexAuthPaths,
} from "../lib/codex-auth.js";

export interface AuthCommandDeps {
  /** env source (default process.env) — tests point CODEX_HOME at a fixture. */
  env?: NodeJS.ProcessEnv;
  /** login-state probe (default: real `codex login status`, exit-code-only). Injectable for tests. */
  loginStatus?: (codexHome: string) => "logged_in" | "not_logged_in" | "unavailable";
  /** clock for seats set updated_ts (default new Date().toISOString()). */
  now?: () => string;
}

function fail(reason: string): void {
  console.error(`rig auth: ${reason}`);
  process.exitCode = 1;
}

// MVP supports only --runtime codex. Other runtimes are the SAME surface with a different flag
// (future); reject non-codex now with a clear message rather than silently treating it as codex.
function ensureRuntime(runtime: string): boolean {
  if (runtime !== "codex") {
    fail(`unsupported_runtime ${runtime} (MVP supports: codex)`);
    return false;
  }
  return true;
}

export function authCommand(depsOverride?: AuthCommandDeps): Command {
  const env = depsOverride?.env ?? process.env;
  const paths = (): CodexAuthPaths => resolveCodexHome(env);
  const withRuntime = (c: Command): Command => c.option("--runtime <runtime>", "Runtime axis (MVP: codex)", "codex");

  const auth = new Command("auth").description(
    "Manage agent auth profiles (CLI-local; runtime via --runtime). Tokens are never printed, logged, or stored.",
  );

  withRuntime(auth.command("status"))
    .description("Auth-file presence + login state (no secrets).")
    .action((opts: { runtime: string }) => {
      if (!ensureRuntime(opts.runtime)) return;
      const r = authStatus(paths(), { loginStatus: depsOverride?.loginStatus });
      console.log(`codex_home: ${r.codexHome}`);
      console.log(`codex_home_present: ${r.codexHomePresent ? "yes" : "no"}`);
      console.log(`active_auth_present: ${r.activeAuthPresent ? "yes" : "no"}`);
      console.log(`active_auth_mode: ${r.activeAuthMode ?? "n/a"}`);
      console.log(`active_auth_mode_safe: ${r.activeAuthModeSafe}`);
      console.log(`saved_profiles: ${r.profileCount}`);
      console.log(`login_status: ${r.loginStatus}`);
    });

  withRuntime(auth.command("list"))
    .description("List saved profiles by name.")
    .action((opts: { runtime: string }) => {
      if (!ensureRuntime(opts.runtime)) return;
      for (const name of authList(paths())) console.log(name);
    });

  withRuntime(auth.command("save <profile>"))
    .description("Snapshot the active auth state into a named profile (file copy; contents never echoed).")
    .action((profile: string, opts: { runtime: string }) => {
      if (!ensureRuntime(opts.runtime)) return;
      const r = authSave(paths(), profile);
      if (!r.ok) return fail(r.reason);
      console.log(`saved_profile: ${r.name}`);
      console.log(`profile_path: ${r.path}`);
      console.log(`profile_mode: ${r.mode}`);
    });

  withRuntime(auth.command("switch <profile>"))
    .description("Activate a saved profile.")
    .action((profile: string, opts: { runtime: string }) => {
      if (!ensureRuntime(opts.runtime)) return;
      const r = authSwitch(paths(), profile);
      if (!r.ok) return fail(r.reason);
      console.log(`activated_profile: ${r.name}`);
      console.log(`active_auth: ${r.activePath}`);
      console.log(`active_mode: ${r.mode}`);
      console.log(`note: ${r.note}`);
    });

  withRuntime(auth.command("validate <profile>"))
    .description("Check a profile's file mode + JSON parseability (NOT live-auth).")
    .action((profile: string, opts: { runtime: string }) => {
      if (!ensureRuntime(opts.runtime)) return;
      const r = authValidate(paths(), profile);
      if (!r.ok) return fail(r.reason);
      console.log(`profile_valid: ${r.name}`);
      console.log(`profile_path: ${r.path}`);
      console.log(`profile_mode: ${r.mode}`);
      console.log("note: checks file mode + JSON parseability only, NOT live account state.");
    });

  const seats = auth.command("seats").description("Seat -> profile registry (metadata only; not proof of a live account).");

  withRuntime(seats.command("list"))
    .description("List seat -> profile mappings.")
    .action((opts: { runtime: string }) => {
      if (!ensureRuntime(opts.runtime)) return;
      const listed = authSeatsListResult(paths());
      if (!listed.ok) return fail(`${listed.reason}: ${listed.detail}`);
      for (const row of listed.rows) console.log(`${row.seat}\t${row.authProfile}\t${row.updatedTs}`);
      console.log(`# ${SEAT_REGISTRY_DISCLAIMER}`);
    });

  withRuntime(seats.command("show <seat>"))
    .description("Show the registry row for one seat.")
    .action((seat: string, opts: { runtime: string }) => {
      if (!ensureRuntime(opts.runtime)) return;
      const r = authSeatShow(paths(), seat);
      if (!r.ok) return fail(r.detail ? `${r.reason}: ${r.detail}` : r.reason);
      console.log(`seat: ${r.row.seat}`);
      console.log(`rig: ${r.row.rig}`);
      console.log(`runtime: ${r.row.runtime}`);
      console.log(`cwd: ${r.row.cwd}`);
      console.log(`auth_profile: ${r.row.authProfile}`);
      console.log(`updated_ts: ${r.row.updatedTs}`);
      console.log(`note: ${SEAT_REGISTRY_DISCLAIMER}`);
    });

  withRuntime(seats.command("set"))
    .description("Upsert a seat -> profile metadata row.")
    .requiredOption("--seat <seat>", "Seat session name")
    .requiredOption("--rig <rig>", "Rig name")
    .option("--cwd <cwd>", "Working dir (metadata)")
    .option("--profile <profile>", "Auth profile label (or omit for unknown)")
    .action((opts: { runtime: string; seat?: string; rig?: string; cwd?: string; profile?: string }) => {
      if (!ensureRuntime(opts.runtime)) return;
      const r = authSeatSet(
        paths(),
        { seat: opts.seat ?? "", rig: opts.rig ?? "", runtime: "codex", cwd: opts.cwd, authProfile: opts.profile },
        depsOverride?.now,
      );
      if (!r.ok) return fail(r.detail ? `${r.reason}: ${r.detail}` : r.reason);
      console.log(`seat_upserted: ${r.seat}`);
      console.log(`registry_path: ${r.registryPath}`);
      console.log(`registry_mode: ${r.mode}`);
      console.log(`note: ${r.disclaimer}`);
    });

  withRuntime(seats.command("report"))
    .description("Counts: total / known / unknown / malformed.")
    .action((opts: { runtime: string }) => {
      if (!ensureRuntime(opts.runtime)) return;
      const r = authSeatsReport(paths());
      console.log(`registry_present: ${r.registryPresent ? "yes" : "no"}`);
      console.log(`registry_mode: ${r.registryMode ?? "n/a"}`);
      console.log(`registry_mode_safe: ${r.registryModeSafe}`);
      if (r.refused) console.log(`registry_refused: ${r.refused}`);
      console.log(`total_seats: ${r.total}`);
      console.log(`known_profiles: ${r.known}`);
      console.log(`unknown_profiles: ${r.unknown}`);
      console.log(`malformed_rows: ${r.malformed}`);
      console.log(`# ${SEAT_REGISTRY_DISCLAIMER}`);
    });

  return auth;
}
