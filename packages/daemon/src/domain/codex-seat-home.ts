import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parse as parseToml } from "smol-toml";
import { codexActivityHookTrustRecords, computeCodexHandlerHash, upsertCodexHookTrust } from "../adapters/codex-runtime-adapter.js";

/**
 * OPR-fork: codex seats must NOT share one ~/.codex app-server environment.
 *
 * Codex's managed app-server is a singleton PER CODEX_HOME: the first TUI in a
 * home spawns it, and its environment (including our OPENRIG_* seat-identity
 * stamps) freezes with that first launcher. Every later codex TUI in the same
 * home runs its agent shell tools with the FIRST seat's env — so
 * `rig whoami` / `rig send` inside a codex seat resolve identity env-first
 * (whoami steps 3/4) to a foreign seat (measured live: a verify seat resolved
 * as queue-worker@kernel via resolvedBy=node_id on codex 0.158.0).
 *
 * Fix: each codex seat launches with CODEX_HOME set to a per-seat home. The
 * codex harness and its managed app-server then freeze the RIGHT seat's env.
 * The seat home shares the operator's account material by symlink (auth,
 * config incl. project trust state, packages, skills) and COPIES profile
 * fragments: a copied <profile>.config.toml canonicalizes to a per-seat path,
 * keeping codex resume key_source distinct per seat instead of collapsing all
 * seats onto the shared profile path.
 */

const SYMLINKED_ENTRIES = [
  "auth.json",
  "config.toml",
  "AGENTS.md",
  "plugins",
  "rules",
  "skills",
  "shell_snapshots",
  "mcp-oauth-locks",
] as const;

// `packages` is deliberately NOT symlinked wholesale: codex's app-server
// management mutates `packages/app-server-daemon/current` (absolute link). If
// every seat home shared the packages dir, each daemon install would repoint
// the link INTO the last-installed seat's home — observed live: a test-run
// seat home was later deleted and the shared current dangled, breaking daemon
// startup for every other seat. Instead each seat gets a REAL packages dir:
// releases are symlinked (the heavy payload, immutable), and `current` is an
// absolute link rooted INSIDE the seat home (through the releases symlink).

export interface CodexSeatHome {
  /** The per-seat CODEX_HOME directory (…/codex-seats/<sanitized session>). */
  path: string;
  linked: string[];
  copiedProfiles: string[];
}

/**
 * Seat-home directory length budget. Codex's managed app-server binds a unix
 * socket UNDER the home dir; macOS sun_path (~104 bytes) is breached by long
 * instance rig names (measured: verify-qa@jims-team-rfp-rulz died with
 * 'shorter than SUN_LEN' under /Users/<u>/.openrig/codex-seats/). Long names
 * fall back to a bounded readable+hashed form: the member stays legible, the
 * hash keeps per-instance distinctness.
 */
const MAX_SESSION_DIR_CHARS = 24;

export function sanitizeSessionForPath(sessionName: string): string {
  // tmux session names are already constrained (letters/digits/._-);
  // keep `@` for readability (exec-cos@jims-team), defend the rest.
  const safe = sessionName.replace(/[^A-Za-z0-9._@-]+/g, "_");
  if (safe.length <= MAX_SESSION_DIR_CHARS) return safe;
  const at = safe.indexOf("@");
  const member = at > 0 ? safe.slice(0, at) : safe.slice(0, 12);
  const rig = at > 0 ? safe.slice(at + 1) : undefined;
  const hash = createHash("sha256").update(sessionName).digest("hex").slice(0, 8);
  if (!rig) return `${member}-${hash}`;
  const rigBudget = Math.max(4, MAX_SESSION_DIR_CHARS - member.length - 10); // '@' + '-' + 8-char hash
  return `${member}@${rig.slice(0, rigBudget)}-${hash}`;
}

export function codexSeatHomePath(openrigHome: string, sessionName: string): string {
  return path.join(openrigHome, "codex-seats", sanitizeSessionForPath(sessionName));
}

/**
 * Codex keys hook trust by the config path it loaded, so a seat reading the shared
 * config.toml through its own CODEX_HOME symlink is a different trust key from the
 * shared path (measured: Codex 0.162.1 writes seat-path keys).
 *
 * OF-42: trust moves from the shared key to the seat key only when it can be VERIFIED.
 * The hash Codex stores covers the event and the hook definition (never the path), so
 * OpenRig recomputes it from the file's current hooks and compares:
 *
 * - A `[hooks.state."<shared>:<suffix>"]` record is copied to `<seat>:<suffix>` only when its
 *   stored hash equals the hash Codex computes now for the hook at that position. A stale
 *   record (the hook was edited since it was trusted), a record whose position holds no
 *   hook, and a hook with no record are all left alone: nothing is ever created that the
 *   shared key does not hold, and nothing unverifiable is copied.
 * - A seat record that already equals the current hash is left alone. A seat record whose
 *   hash differs from the current one is stale by the same rule and is replaced, but only
 *   from a verified shared record. A seat record the shared key cannot vouch against is
 *   never touched, so trust given inside the seat for a newer definition survives.
 * - OpenRig's own managed hooks are computed for the seat key directly, so they follow a
 *   relay change after an upgrade.
 */
export interface CodexHookTrustCopy {
  key: string;
  hash: string;
  action: "copied" | "replaced";
}

function codexEventLabel(event: string): string {
  return event.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

/** `<event_label>:<group>:<handler>` -> the hash Codex computes for that authored hook now. */
function currentHookHashes(content: string): Map<string, string> {
  const out = new Map<string, string>();
  let hooks: unknown;
  try {
    hooks = (parseToml(content) as Record<string, unknown>)["hooks"];
  } catch {
    return out; // unparseable file: nothing can be verified
  }
  if (!hooks || typeof hooks !== "object") return out;
  for (const [event, groups] of Object.entries(hooks as Record<string, unknown>)) {
    if (event === "state" || !Array.isArray(groups)) continue;
    const label = codexEventLabel(event);
    groups.forEach((group, gi) => {
      const g = group as { matcher?: unknown; hooks?: unknown };
      if (!g || !Array.isArray(g.hooks)) return;
      g.hooks.forEach((handler, hi) => {
        if (!handler || typeof handler !== "object") return;
        const hash = computeCodexHandlerHash(label, { matcher: g.matcher, handler: handler as Record<string, unknown> });
        if (hash) out.set(`${label}:${gi}:${hi}`, hash);
      });
    });
  }
  return out;
}

/** The scalar fields of one `[hooks.state."<key>"]` record (trusted_hash, enabled, ...). */
type HookStateRecord = Record<string, string | number | boolean>;

/**
 * Every `[hooks.state."<key>"]` record, read from the PARSED document, so text that merely looks
 * like a record (inside a multiline string, a comment) is never mistaken for one. An unparseable
 * file yields no records: nothing can be verified, so nothing is copied.
 */
function hookStateRecords(content: string): Map<string, HookStateRecord> {
  const out = new Map<string, HookStateRecord>();
  let state: unknown;
  try {
    const hooks = (parseToml(content) as Record<string, unknown>)["hooks"];
    state = hooks && typeof hooks === "object" ? (hooks as Record<string, unknown>)["state"] : undefined;
  } catch {
    return out;
  }
  if (!state || typeof state !== "object") return out;
  for (const [key, value] of Object.entries(state as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const rec: HookStateRecord = {};
    for (const [field, v] of Object.entries(value as Record<string, unknown>)) {
      if ((typeof v === "string" || typeof v === "number" || typeof v === "boolean") && /^[A-Za-z0-9_-]+$/.test(field)) rec[field] = v;
    }
    out.set(key, rec);
  }
  return out;
}

/** Set (or, for undefined, remove) one scalar field inside an existing `[hooks.state."<key>"]` table. */
function setHookStateField(content: string, key: string, field: string, value: string | number | boolean | undefined): string {
  const header = `[hooks.state.${JSON.stringify(key)}]`;
  const lines = content.split("\n");
  const headerIndex = lines.findIndex((line) => line.trim() === header);
  if (headerIndex === -1) return content;
  let end = lines.length;
  for (let i = headerIndex + 1; i < lines.length; i++) {
    if (lines[i]!.trim().startsWith("[")) { end = i; break; }
  }
  const at = lines.findIndex((line, i) => i > headerIndex && i < end && new RegExp(`^\\s*${field}\\s*=`).test(line));
  if (value === undefined) {
    if (at >= 0) lines.splice(at, 1);
  } else if (at >= 0) {
    lines[at] = `${field} = ${JSON.stringify(value)}`;
  } else {
    lines.splice(headerIndex + 1, 0, `${field} = ${JSON.stringify(value)}`);
  }
  return lines.join("\n");
}

const sameFields = (a: HookStateRecord | undefined, b: HookStateRecord): boolean =>
  !!a && a["trusted_hash"] === b["trusted_hash"] && a["enabled"] === b["enabled"];

export function planCodexHookTrustMirror(
  content: string,
  sharedKeySource: string,
  seatKeySource: string,
): { content: string; copies: CodexHookTrustCopy[] } {
  if (sharedKeySource === seatKeySource) return { content, copies: [] };
  const records = hookStateRecords(content);
  const current = currentHookHashes(content);
  const copies: CodexHookTrustCopy[] = [];
  let next = content;
  for (const [key, shared] of records) {
    if (!key.startsWith(`${sharedKeySource}:`)) continue;
    const suffix = key.slice(sharedKeySource.length);
    const sharedHash = shared["trusted_hash"];
    const want = current.get(suffix.slice(1));
    if (typeof sharedHash !== "string" || want === undefined || sharedHash !== want) continue; // unverifiable: copy nothing
    const seatKey = `${seatKeySource}${suffix}`;
    const have = records.get(seatKey);
    // The seat record is the shared record's own, field for field (its hash, and `enabled` so a
    // hook Jim switched off stays off), never a recomputed value: Codex stays the only arbiter.
    if (sameFields(have, shared)) continue;
    let candidate = upsertCodexHookTrust(next, seatKey, sharedHash);
    for (const [field, value] of Object.entries(shared)) {
      if (field !== "trusted_hash") candidate = setHookStateField(candidate, seatKey, field, value);
    }
    if (shared["enabled"] === undefined) candidate = setHookStateField(candidate, seatKey, "enabled", undefined);
    // A seat record the text could not express (an unusual header form) must not break the file.
    if (!sameFields(hookStateRecords(candidate).get(seatKey), shared)) continue;
    next = candidate;
    copies.push({ key: seatKey, hash: sharedHash, action: have === undefined ? "copied" : "replaced" });
  }
  for (const { key, hash } of codexActivityHookTrustRecords(next, seatKeySource)) {
    next = upsertCodexHookTrust(next, key, hash);
  }
  return { content: next, copies };
}

export function mirrorCodexHookTrust(content: string, sharedKeySource: string, seatKeySource: string): string {
  return planCodexHookTrustMirror(content, sharedKeySource, seatKeySource).content;
}

// One writer per config file in this process; the write itself is temp + rename so a Codex
// starting in another seat never reads a truncated file.
const configWrites = new Map<string, Promise<unknown>>();

async function syncSeatHookTrust(home: string, log: (message: string) => void): Promise<boolean> {
  const seatConfig = path.join(home, "config.toml");
  const stat = await fs.lstat(seatConfig).catch(() => null);
  if (!stat?.isSymbolicLink()) return false; // a seat-owned config carries its own trust
  const sharedKeySource = await fs.realpath(seatConfig);
  const seatKeySource = path.join(await fs.realpath(home), "config.toml");
  const run = (configWrites.get(sharedKeySource) ?? Promise.resolve()).catch(() => undefined).then(async () => {
    const content = await fs.readFile(sharedKeySource, "utf-8");
    const { content: next, copies } = planCodexHookTrustMirror(content, sharedKeySource, seatKeySource);
    if (next === content) return false;
    const { mode } = await fs.stat(sharedKeySource);
    const tmp = `${sharedKeySource}.openrig-${process.pid}-${createHash("sha256").update(seatKeySource).digest("hex").slice(0, 8)}`;
    await fs.writeFile(tmp, next, { mode });
    await fs.rename(tmp, sharedKeySource);
    // Logged after the rename, so a line never names trust that was not written.
    for (const c of copies) log(`[openrig] codex seat hook trust ${c.action}: ${c.key} ${c.hash} (from ${sharedKeySource})`);
    return true;
  });
  configWrites.set(sharedKeySource, run);
  return run;
}

async function linkIfMissing(source: string, dest: string): Promise<boolean> {
  try {
    await fs.lstat(dest);
    return false; // already present — never overwrite a working seat home
  } catch {
    await fs.symlink(source, dest);
    return true;
  }
}

/**
 * Per-seat packages dir: shared everything EXCEPT the app-server-daemon
 * management state. `current` is rooted inside the seat home so one seat's
 * daemon install/update can never repoint a link another seat depends on.
 * Returns labels of seats-linked entries for reporting.
 */
async function seedSeatPackages(home: string, shared: string): Promise<string[]> {
  const sharedPkgs = path.join(shared, "packages");
  const sharedAsd = path.join(sharedPkgs, "app-server-daemon");
  const linked: string[] = [];
  try {
    await fs.lstat(path.join(sharedAsd, "releases"));
  } catch {
    return linked; // no managed daemon on the shared home — nothing to seed
  }
  const seatPkgs = path.join(home, "packages");
  const seatAsd = path.join(seatPkgs, "app-server-daemon");
  await fs.mkdir(seatAsd, { recursive: true });

  // heavy, immutable payload: one directory, one link
  if (await linkIfMissing(path.join(sharedAsd, "releases"), path.join(seatAsd, "releases")))
    linked.push("packages/app-server-daemon/releases");

  // small mutable housekeeping: copied so one seat's update never writes the
  // shared file
  for (const small of ["auto-update-version"] as const) {
    const src = path.join(sharedAsd, small);
    const dest = path.join(seatAsd, small);
    try {
      await fs.copyFile(src, dest);
      linked.push(`packages/app-server-daemon/${small}`);
    } catch {
      // absent — fine
    }
  }

  // `current`: absolute, rooted INSIDE the seat home (via its releases link).
  // Version source of truth: the shared current link if it resolves, else the
  // newest release dir.
  let version: string | null = null;
  try {
    const sharedCurrent = await fs.readlink(path.join(sharedAsd, "current"));
    const byName = path.basename(sharedCurrent);
    await fs.lstat(path.join(sharedAsd, "releases", byName));
    version = byName;
  } catch {
    const releases = await fs.readdir(path.join(sharedAsd, "releases")).catch(() => []);
    version = releases.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).pop() ?? null;
  }
  if (version) {
    const dest = path.join(seatAsd, "current");
    try {
      await fs.lstat(dest);
    } catch {
      await fs.symlink(path.join(seatAsd, "releases", version), dest);
      linked.push("packages/app-server-daemon/current");
    }
  }

  // every other top-level packages entry links straight through
  const otherPkgs = await fs.readdir(sharedPkgs).catch(() => [] as string[]);
  for (const entry of otherPkgs) {
    if (entry === "app-server-daemon") continue;
    const src = path.join(sharedPkgs, entry);
    if (await linkIfMissing(src, path.join(seatPkgs, entry)))
      linked.push(`packages/${entry}`);
  }
  return linked;
}

/**
 * Create (idempotently) the per-seat codex home under
 * `<openrigHome>/codex-seats/<session>` seeded from the shared codex home.
 * Missing shared entries are skipped (a minimal codex install still works;
 * codex creates its own session/state files inside the home).
 */
export async function ensureCodexSeatHome(
  sessionName: string,
  opts?: { openrigHome?: string; sharedCodexHome?: string; log?: (message: string) => void },
): Promise<CodexSeatHome> {
  const openrigHome = opts?.openrigHome ?? process.env["OPENRIG_HOME"] ?? path.join(os.homedir(), ".openrig");
  const shared = opts?.sharedCodexHome ?? process.env["CODEX_HOME_DEFAULT"] ?? path.join(os.homedir(), ".codex");
  const home = codexSeatHomePath(openrigHome, sessionName);

  await fs.mkdir(home, { recursive: true });

  const linked: string[] = [];
  for (const entry of SYMLINKED_ENTRIES) {
    const source = path.join(shared, entry);
    try {
      await fs.lstat(source);
    } catch {
      continue; // absent on the shared home — skip silently
    }
    const dest = path.join(home, entry);
    if (await linkIfMissing(source, dest)) linked.push(entry);
  }
  linked.push(...(await seedSeatPackages(home, shared)));
  // Every launch, not only on creation: trust given after the home was made carries over too.
  await syncSeatHookTrust(home, opts?.log ?? ((message) => console.log(message))).catch(() => false);

  // Profile fragments are COPIED (see module doc): per-seat canonical path,
  // per-seat identity edits stay seat-local.
  const copiedProfiles: string[] = [];
  let entries: string[] = [];
  try {
    entries = await fs.readdir(shared);
  } catch {
    // no shared codex home at all — the seat home exists but is empty;
    // codex will bootstrap it.
  }
  for (const entry of entries) {
    if (!entry.endsWith(".config.toml")) continue;
    const source = path.join(shared, entry);
    const stat = await fs.lstat(source).catch(() => null);
    if (!stat?.isFile()) continue;
    const dest = path.join(home, entry);
    try {
      await fs.lstat(dest);
    } catch {
      await fs.copyFile(source, dest);
      copiedProfiles.push(entry);
    }
  }

  return { path: home, linked, copiedProfiles };
}
