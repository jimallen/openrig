import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parse as parseToml } from "smol-toml";
import { unrestrictedCodexConfigWrites, type CodexConfigWritePolicy } from "./codex-config-write-policy.js";
import { codexActivityHookTrustRecords, computeCodexHandlerHash, findTomlTable, lineStartsAtDocumentLevel, upsertCodexHookTrust, upsertVerifiedCodexHookTrust } from "../adapters/codex-runtime-adapter.js";

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
  /** Profile fragments NOT used because they carry an OpenRig seat identity variable (OF-43): a shared source
   *  is not copied; a seat-home copy is moved aside as `<name>.refused-openrig-identity`. */
  refusedProfiles: string[];
  /** What an operator should be told about this launch's profiles, one sentence each, names only (OF-115): a profile
   *  moved aside or not copied, and a shared config.toml that sets an identity variable for every seat. The launchers
   *  put these in the launch's warnings; the same text is also logged. */
  warnings: string[];
}

/** The per-seat identity variables the launcher injects (node-launcher.ts). A profile that sets one of these
 *  would give the seat another seat's identity (or the activity-hook token) the moment its posture loads it. */
export const CODEX_PROFILE_FOREIGN_IDENTITY_VARS: readonly string[] = [
  "OPENRIG_NODE_ID", "OPENRIG_SESSION_NAME", "OPENRIG_RUNTIME", "OPENRIG_OCCUPANT_GENERATION", "OPENRIG_ACTIVITY_HOOK_TOKEN",
  // The legacy aliases the cli, hooks and daemon read when the OPENRIG_ name is empty (a profile can drop the
  // OPENRIG_ names with shell_environment_policy and set only these). Census: a search for RIGGED_<name> over
  // packages (non-test) finds a read for each of these five and for no other identity variable.
  "RIGGED_NODE_ID", "RIGGED_SESSION_NAME", "RIGGED_RUNTIME", "RIGGED_OCCUPANT_GENERATION", "RIGGED_ACTIVITY_HOOK_TOKEN",
];

/** The identity variable names a profile's text sets, as keys anywhere in the document or as `NAME=value`
 *  strings; unparseable TOML falls back to a word match (fail closed). Names only, never values. */
export function codexProfileIdentityVars(text: string): string[] {
  const names = CODEX_PROFILE_FOREIGN_IDENTITY_VARS;
  const found = new Set<string>();
  try {
    const walk = (node: unknown): void => {
      if (typeof node === "string") {
        // NAME=value anywhere in the string: after `export `, `&&`, `;` or a space, not only at the start.
        for (const n of names) if (new RegExp(`(?:^|[^A-Za-z0-9_])${n}=`).test(node)) found.add(n);
      } else if (Array.isArray(node)) {
        node.forEach(walk);
      } else if (node && typeof node === "object") {
        for (const [k, v] of Object.entries(node)) {
          if (names.includes(k)) found.add(k);
          walk(v);
        }
      }
    };
    walk(parseToml(text));
  } catch {
    for (const n of names) if (new RegExp(`\\b${n}\\b`).test(text)) found.add(n);
  }
  return [...found].sort();
}

/** Move a refused seat copy (a file, or a symlink to one) to `<dest>.refused-openrig-identity-<ms>-<n>` without ever
 *  replacing a file: the name is claimed first (a hard link for a file, a new link to the same target for a symlink;
 *  EEXIST on a taken name tries the next), then the original name is removed. Returns the new name, or null when the
 *  copy was already gone: a concurrent launch of the same seat moved it first (ENOENT), which is the outcome wanted,
 *  not a failure (OF-115: it used to throw, and the launcher then fell back to the shared CODEX_HOME). */
async function moveAsideUnique(dest: string, symlink: boolean): Promise<string | null> {
  const stamp = Date.now();
  const linkTarget = symlink ? await fs.readlink(dest).catch(() => null) : null;
  if (symlink && linkTarget === null) return null;
  for (let n = 0; ; n++) {
    const target = `${dest}.refused-openrig-identity-${stamp}-${n}`;
    try {
      if (symlink) await fs.symlink(linkTarget!, target);
      else await fs.link(dest, target);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EEXIST") continue;
      if (code === "ENOENT") return null;
      throw err;
    }
    try {
      await fs.unlink(dest);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    return target;
  }
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

/**
 * The two fields of a `[hooks.state."<key>"]` record that Codex 0.162.1 reads (measured: every other
 * field is ignored, and a non-boolean `enabled` makes Codex drop every hook in the file).
 */
export interface HookStateRecord { trusted_hash?: string; enabled?: boolean }

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
    const { trusted_hash: hash, enabled } = value as Record<string, unknown>;
    const rec: HookStateRecord = {};
    if (typeof hash === "string") rec.trusted_hash = hash;
    if (typeof enabled === "boolean") rec.enabled = enabled;
    out.set(key, rec);
  }
  return out;
}

/** Set (or, for undefined, remove) one scalar field inside an existing `[hooks.state."<key>"]` table. */
function setHookStateField(content: string, key: string, field: string, value: string | number | boolean | undefined): string {
  const header = `[hooks.state.${JSON.stringify(key)}]`;
  const lines = content.split("\n");
  const table = findTomlTable(lines, header);
  if (table === null) return content;
  const headerIndex = table.headerIndex;
  const atDocumentLevel = lineStartsAtDocumentLevel(lines.join("\n"));
  const at = lines.findIndex((line, i) => i > headerIndex && i < table.end && atDocumentLevel[i] && new RegExp(`^\\s*${field}\\s*=`).test(line));
  if (value === undefined) {
    if (at >= 0) lines.splice(at, 1);
  } else if (at >= 0) {
    lines[at] = `${field} = ${JSON.stringify(value)}`;
  } else {
    lines.splice(headerIndex + 1, 0, `${field} = ${JSON.stringify(value)}`);
  }
  return lines.join("\n");
}

/**
 * A seat record needs nothing when it holds the shared hash and is off wherever the shared record is
 * off. "Disabled wins": `enabled = false` flows from shared to seat, but a seat-local
 * `enabled = false` is Jim's setting for that seat and is never cleared or overwritten.
 */
const seatRecordIsCurrent = (seat: HookStateRecord | undefined, shared: HookStateRecord): boolean =>
  !!seat && seat.trusted_hash === shared.trusted_hash && !(shared.enabled === false && seat.enabled !== false);

/** A mirror write is kept only when the PARSED candidate holds the seat record as meant (see seatRecordIsCurrent). */
export const mirrorWriteIsAccepted = (candidate: string, seatKey: string, shared: HookStateRecord): boolean =>
  seatRecordIsCurrent(hookStateRecords(candidate).get(seatKey), shared);

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
    const sharedHash = shared.trusted_hash;
    const want = current.get(suffix.slice(1));
    if (typeof sharedHash !== "string" || want === undefined || sharedHash !== want) continue; // unverifiable: copy nothing
    const seatKey = `${seatKeySource}${suffix}`;
    const have = records.get(seatKey);
    // The seat record carries the shared record's own hash (never a recomputed value: Codex stays the
    // only arbiter) and, when the shared hook is switched off, that `enabled = false` too.
    if (seatRecordIsCurrent(have, shared)) continue;
    // Header-shaped text for a seat record the parsed document does not hold is a string (or comment) that
    // mimics one. Nothing is created beside it: that is the OF-42 re-check's accepted fail-closed outcome.
    if (have === undefined && content.split("\n").some((line) => line.trim() === `[hooks.state.${JSON.stringify(seatKey)}]`)) continue;
    let candidate = upsertCodexHookTrust(next, seatKey, sharedHash);
    if (shared.enabled === false) candidate = setHookStateField(candidate, seatKey, "enabled", false);
    // A seat record the text could not express (an unusual header form, a fake header inside a
    // string) must not be written into: the parsed result has to be the record we meant.
    if (!mirrorWriteIsAccepted(candidate, seatKey, shared)) continue;
    next = candidate;
    copies.push({ key: seatKey, hash: sharedHash, action: have === undefined ? "copied" : "replaced" });
  }
  for (const { key, hash } of codexActivityHookTrustRecords(next, seatKeySource)) {
    next = upsertVerifiedCodexHookTrust(next, key, hash);
  }
  return { content: next, copies };
}

export function mirrorCodexHookTrust(content: string, sharedKeySource: string, seatKeySource: string): string {
  return planCodexHookTrustMirror(content, sharedKeySource, seatKeySource).content;
}

// One writer per config file in this process; the write itself is temp + rename so a Codex
// starting in another seat never reads a truncated file.
const configWrites = new Map<string, Promise<unknown>>();

async function syncSeatHookTrust(home: string, log: (message: string) => void, policy: CodexConfigWritePolicy): Promise<boolean> {
  const seatConfig = path.join(home, "config.toml");
  const stat = await fs.lstat(seatConfig).catch(() => null);
  if (!stat?.isSymbolicLink()) return false; // a seat-owned config carries its own trust
  const sharedKeySource = await fs.realpath(seatConfig);
  const seatKeySource = path.join(await fs.realpath(home), "config.toml");
  // OF-183: the seat's config.toml is a symlink to the SHARED file, and this mirror edits the file it points at. A
  // daemon that is not the host's installed one leaves it alone (the seat then asks for hook trust natively).
  const decision = policy.decide(sharedKeySource);
  if (!decision.allowed) {
    log(`[openrig] codex seat hook trust not mirrored: ${decision.reason}`);
    return false;
  }
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
  opts?: { openrigHome?: string; sharedCodexHome?: string; log?: (message: string) => void; configWritePolicy?: CodexConfigWritePolicy },
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
  await syncSeatHookTrust(home, opts?.log ?? ((message) => console.log(message)), opts?.configWritePolicy ?? unrestrictedCodexConfigWrites).catch(() => false);

  // Profile fragments are COPIED (see module doc): per-seat canonical path,
  // per-seat identity edits stay seat-local.
  const copiedProfiles: string[] = [];
  const refusedProfiles: string[] = [];
  const warnings: string[] = [];
  const log = opts?.log ?? ((message: string) => console.log(message));
  const say = (message: string): void => { log(message); warnings.push(message); };

  // config.toml is symlinked into every seat and is read without `-p`, so an identity variable set there reaches every
  // codex seat whatever its profile (OF-115). It is the operator's own file and carries the trust and settings every
  // seat needs, so it is reported, not withheld.
  const sharedConfigPath = path.join(shared, "config.toml");
  const sharedConfig = await fs.readFile(sharedConfigPath, "utf8").catch(() => null);
  const sharedConfigVars = sharedConfig === null ? [] : codexProfileIdentityVars(sharedConfig);
  if (sharedConfigVars.length > 0) {
    say(`codex seat home ${home}: the shared ${sharedConfigPath} sets ${sharedConfigVars.join(", ")}, which every codex seat reads; remove it from that file`);
  }

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
    const existing = await fs.lstat(dest).catch(() => null);
    if (existing) {
      // Copy-once stays, but a copy that carries a seat identity is moved aside on every launch (OF-43); a
      // clean shared source is then copied fresh below. A symlink is read through (OF-115): an operator's link to a
      // file that carries identity is moved aside as the link, never followed or rewritten.
      const symlink = existing.isSymbolicLink();
      if (!existing.isFile() && !symlink) continue;
      const text = await fs.readFile(dest, "utf8").catch(() => null);
      const vars = text === null ? [] : codexProfileIdentityVars(text);
      if (vars.length === 0) continue;
      await moveAsideUnique(dest, symlink);
      refusedProfiles.push(entry);
      say(`codex seat home ${home}: moved profile ${entry} aside; it sets ${vars.join(", ")}, which would give the seat another identity`);
    }
    const sourceText = await fs.readFile(source, "utf8").catch(() => null);
    const vars = sourceText === null ? [] : codexProfileIdentityVars(sourceText);
    if (vars.length > 0) {
      if (!refusedProfiles.includes(entry)) refusedProfiles.push(entry);
      say(`codex seat home ${home}: did not copy profile ${entry}; it sets ${vars.join(", ")}, which would give the seat another identity, so a launch with -p ${entry.replace(/\.config\.toml$/, "")} finds no profile file`);
      continue;
    }
    await fs.copyFile(source, dest);
    copiedProfiles.push(entry);
  }

  return { path: home, linked, copiedProfiles, refusedProfiles, warnings };
}
