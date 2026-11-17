// terminal-token-policy.ts — which terminal bearer token the daemon requires on its terminal-class routes (attach, type into a seat, read
// its screen, its transcripts). Pure: the caller passes what it knows (the addresses it binds, the tokens in its environment, and a way to
// read or make the instance's token file).
//
// workspaces-o9o.78 (Jim, 2026-11-17: "Token when non-loopback"): the terminal token is required whenever the daemon listens beyond
// loopback, the tailnet included. A daemon that listens on loopback only stays tokenless.

/** The instance's terminal token file, under OPENRIG_HOME. The same host's rig CLI already sends its contents (cli client.ts). */
export const TERMINAL_TOKEN_FILE = "terminal-token";

/** Whether an address the daemon binds or a peer connects from is loopback: 127.0.0.0/8, ::1, an IPv4-mapped loopback, or `localhost`.
 *  Anything else (0.0.0.0, ::, a tailnet or LAN address, a hostname) is not. */
export function isLoopbackAddress(address: string | null | undefined): boolean {
  if (!address) return false;
  const a = address.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (a === "localhost" || a === "::1") return true;
  const v4 = a.startsWith("::ffff:") ? a.slice("::ffff:".length) : a;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4);
}

/** Whether the daemon must require the terminal token: it listens on at least one address that is not loopback. */
export function terminalTokenRequired(bindHosts: readonly string[]): boolean {
  return bindHosts.length === 0 || bindHosts.some((h) => !isLoopbackAddress(h));
}

/** What the daemon knows at startup when it decides its terminal token. */
export interface TerminalTokenInput {
  /** The hosts the daemon binds (the bind plan's). */
  bindHosts: readonly string[];
  /** OPENRIG_TERMINAL_BEARER_TOKEN, when set. */
  envToken?: string | null;
  /** OPENRIG_AUTH_BEARER_TOKEN (the operator token), when set. */
  operatorToken: string | null;
  /** An explicit bind host that is neither loopback nor the tailnet (a LAN address, 0.0.0.0). */
  explicitUntrusted: boolean;
  /** The outbound port: the instance's terminal token file's contents, made first when absent. Called only when a token is required and
   *  neither the environment nor the operator token supplies one. */
  readOrCreateFile?: () => string;
}

/**
 * The terminal token: the environment's; else the operator token on an explicit untrusted bind (as before); else, when the daemon listens
 * beyond loopback, the instance's token file; else none (loopback only: no token required).
 */
export function decideTerminalToken(input: TerminalTokenInput): string | null {
  const env = input.envToken?.trim();
  if (env) return env;
  if (input.explicitUntrusted && input.operatorToken) return input.operatorToken;
  if (!terminalTokenRequired(input.bindHosts)) return null;
  if (!input.readOrCreateFile) throw new Error("The daemon listens beyond loopback and has no terminal token source.");
  return input.readOrCreateFile();
}

/** After a listener is up: the problem when it listens beyond loopback with no terminal token (the daemon then stops), else null. */
export function listenerTokenProblem(listenedAddress: string, terminalToken: string | null): string | null {
  return isLoopbackAddress(listenedAddress) || terminalToken
    ? null
    : `The daemon is listening on ${listenedAddress}, beyond loopback, with no terminal token: terminal-class routes would be open to that network. Stopping.`;
}
