import { coreRuntimeLocationRefusal } from "@openrig/daemon/hc";

/**
 * A seat does not control the daemon. The `rig daemon` verbs stop, start and restart, run from inside a seat, can end the host's terminals
 * (incident 2026-11-02: a Pi seat, unprompted, stopped and started the daemon from its shell, and a core it started onto the
 * host's runtime dir ended every program under the real holder). The seat's identity is the environment the launcher gives
 * every node (node-launcher.ts), so a shell that carries it is a seat's.
 *
 * What this is not: containment. A model can still signal a pid or call a binary by path. It stops the reflex, with a
 * message that says who to ask.
 */

/** The variables that make a shell a seat's, with the legacy `RIGGED_` aliases the CLI also reads (readOpenRigEnv). Restated in
 *  packages/tui/src/crash-cart/start-daemon.ts, which strips them for the person's own `s` key; both lists are pinned by name. */
export const SEAT_IDENTITY_ENV_NAMES = ["OPENRIG_SESSION_NAME", "OPENRIG_NODE_ID", "RIGGED_SESSION_NAME", "RIGGED_NODE_ID"] as const;

/** The `rig daemon` verbs a seat may not run. `status` and `logs` read; every other verb of the command is one of these. */
export const SEAT_REFUSED_DAEMON_VERBS: readonly string[] = ["start", "stop", "restart"];

/** The identity names this env sets, in the list's order. An empty or blank value is no identity, as the CLI reads it. */
export function seatIdentityNames(env: NodeJS.ProcessEnv): string[] {
  return SEAT_IDENTITY_ENV_NAMES.filter((name) => (env[name] ?? "").trim() !== "");
}

/** The refusal for `rig daemon <verb>` in this env, or null when it is not a seat's. Names only: no value is printed. */
export function seatDaemonControlRefusal(verb: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!SEAT_REFUSED_DAEMON_VERBS.includes(verb)) return null;
  const names = seatIdentityNames(env);
  if (names.length === 0) return null;
  return `rig daemon ${verb} is refused in a seat (${names.join(", ")} set). Stopping or starting the daemon from a seat can end other seats' terminals. `
    + "Report to the operator that the daemon needs attention and what you saw (`rig daemon status`, `rig daemon logs`); "
    + "they run it from a shell outside any seat.";
}

/** Why no daemon may be started with this env, or null: the seat check, then the core's runtime location (the daemon starts the hc core
 *  when none runs). Applied in startDaemon, the one place a daemon is spawned, so `rig up`, `rig start` and `rig context add` are covered
 *  as `rig daemon start` is (second plan read S4). A daemon that will not start a core (OPENRIG_HC_NO_START_CORE=1, as test runs set it) is
 *  not judged on the location. */
export function daemonStartRefusal(env: NodeJS.ProcessEnv = process.env): string | null {
  return seatDaemonControlRefusal("start", env)
    ?? (env["OPENRIG_HC_NO_START_CORE"] === "1" ? null : coreRuntimeLocationRefusal(env));
}
