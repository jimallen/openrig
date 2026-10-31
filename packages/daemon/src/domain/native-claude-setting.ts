// Native comms (OF-180 N4): `transport.native_claude` is consulted on every send and every launch. Resolving it reads and
// parses the settings file each time, even with the flag off. This keeps the answer until the inputs that decide it change,
// so a changed setting still reaches the very next send (no time-to-live), at the price of one stat call.
import { statSync } from "node:fs";

/** A fingerprint of the settings file that changes whenever its content is replaced or rewritten: inode (an atomic
 *  rename), size, and the modification and change times in nanoseconds. A missing or unreadable file is its own value. */
export function settingsFileSignature(configPath: string): string {
  try {
    const s = statSync(configPath, { bigint: true });
    return `${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
  } catch {
    return "absent";
  }
}

/** The environment override of `transport.native_claude` (settings-store ENV_MAP; it has no legacy name). It decides the
 *  value ahead of the file, so it is part of what the cached answer depends on. */
export const NATIVE_CLAUDE_ENV = "OPENRIG_TRANSPORT_NATIVE_CLAUDE";

/** The `transport.native_claude` decision for a settings store: the file's fingerprint and the env override decide when it
 *  is read again. This is what the daemon wires into every send and launch decision. */
export function nativeClaudeFlag(store: { configPath: string; resolveOne(key: "transport.native_claude"): { value: unknown } }): () => boolean {
  return cachedFlag(
    () => `${settingsFileSignature(store.configPath)}|${process.env[NATIVE_CLAUDE_ENV] ?? ""}`,
    () => store.resolveOne("transport.native_claude").value === true,
  );
}

/** Memoises `resolve` while `signature()` is unchanged. A `resolve` that throws answers false and is NOT remembered, so a
 *  transient read error never sticks. */
export function cachedFlag(signature: () => string, resolve: () => boolean): () => boolean {
  let key: string | null = null;
  let value = false;
  return () => {
    const now = signature();
    if (key !== null && now === key) return value;
    let resolved: boolean;
    try { resolved = resolve(); } catch { key = null; return false; }
    key = now;
    value = resolved;
    return value;
  };
}
