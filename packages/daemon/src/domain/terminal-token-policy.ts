// terminal-token-policy.ts — which terminal bearer token the daemon requires on its terminal-class routes (attach, type into a seat, read
// its screen). Pure: the caller passes what it knows (the addresses it binds, the tokens in its environment).

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
}

/** The terminal token: the environment's, else the operator token on an explicit untrusted bind, else none (no token required). */
export function decideTerminalToken(input: TerminalTokenInput): string | null {
  const env = input.envToken?.trim();
  if (env) return env;
  if (input.explicitUntrusted) return input.operatorToken;
  return null;
}
