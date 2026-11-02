/** Starting a local instance must never silently target the default daemon or
 * launch kernel occupants before the user has selected them. */
export function daemonStartArgs(target: string): string[] {
  const url = new URL(target);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("This target is not a local daemon endpoint. Reconnect after its owner starts it; no local daemon was started.");
  }
  return ["daemon", "start", "--no-kernel", "--host", url.hostname.replace(/^\[|\]$/g, ""),
    "--port", url.port || "80"];
}

/** The names that make a shell a seat's (packages/cli/src/seat-daemon-guard.ts, which refuses `rig daemon start|stop` where one is set). */
const SEAT_IDENTITY_ENV_NAMES = ["OPENRIG_SESSION_NAME", "OPENRIG_NODE_ID", "RIGGED_SESSION_NAME", "RIGGED_NODE_ID"];

/** How the crash cart's `s` key (and the startup controller) runs `rig daemon start`. The kernel's TUI is a terminal node, so the
 *  pane it runs in carries a seat's identity, and the CLI refuses a seat. This is a person's keypress, so the child gets the pane's
 *  env without the identity: the refusal is for a seat that reaches for the command, not for the person who asks the TUI to. Nothing
 *  else changes, so the daemon still starts in the runtime location and home the pane names. */
export function daemonStartExecOptions(env: NodeJS.ProcessEnv): { timeout: number; env: NodeJS.ProcessEnv } {
  const child = { ...env };
  for (const name of SEAT_IDENTITY_ENV_NAMES) delete child[name];
  return { timeout: 30_000, env: child };
}
