// credential-file.ts — the one rule for reading a file that holds a credential or a token, or a registry that says where
// credentials go (workspaces-o9o.151). Pure: no filesystem. The reading is an outbound port, CredentialFileReader, which an
// adapter implements (adapters/node-credential-file-reader.ts); the CLI reaches the same adapter through the
// `@openrig/daemon/credential-file` surface, and the plugin hook scripts carry an inline copy pinned by a parity test.
//
// The rule (o9o.78's terminal token and pda-client.ts follow it): open the path itself with O_NOFOLLOW|O_NONBLOCK (a symlink at
// the file is refused, a FIFO cannot hang the open), fstat the OPEN descriptor, require a regular file owned by the current
// user, check its mode by the file's kind, cap the size, and read from that same descriptor.
//  - secret:   no group or other bits at all (a token, an auth file, a secrets env file, the endpoint snapshot);
//  - registry: no group or other WRITE bits (it names where secrets go, so nobody else may change it; reading it is fine).
//  - user-config: no mode rule (o9o.182, CoS ruling (A) 11-19 00:48Z): another program's file OpenRig only merges into (Claude's settings,
//    .mcp.json and .claude.json), written under the user's own umask (every live one on sparky was 0664, user-private group). The link,
//    regular-file, one-name, owner and size rules still hold, and OpenRig never chmods it.
// A refusal names the file and the fix; the content of a refused file is never returned.

export type CredentialFileKind = "secret" | "registry" | "user-config";

export interface CredentialFilePolicy {
  /** The noun a refusal starts with: "the terminal token", "the hosts registry". */
  label: string;
  kind: CredentialFileKind;
  /** Bytes; a larger file is refused. */
  maxBytes: number;
  /** Set only through seatCredentialLinkPolicy (one of SEAT_CREDENTIAL_LINKS): a symlink AT the file is followed only when its
   *  real path is exactly this file's real path, and that target is then held to the whole rule. Unset, a link is refused. */
  linkTarget?: string;
  /** o9o.160 (CoS 11-18 13:36Z): the file may be a link to anywhere, its REAL target judged by the whole rule (and narrowed by
   *  readOwnFile). Only for config.json, whose writer deliberately follows a link (a supported dotfiles layout). */
  followLinks?: true;
}

export type CredentialFileProblem =
  | "missing" | "symlink" | "unexpected_link_target" | "not_regular_file" | "hard_linked" | "wrong_owner" | "group_or_other_access"
  | "group_or_other_write" | "too_large" | "unreadable";

export type CredentialFileRead =
  /** `mode`: the permission bits of the file judged and read, from its own descriptor (o9o.182, verify-sec2: the write half keeps it;
   *  re-stating the path instead would read a link swapped in after the read). Set by the procedure; a test double may leave it out. */
  | { ok: true; content: string; mode?: number }
  | { ok: false; problem: CredentialFileProblem; message: string };

/** The outbound port: read one credential file under a policy, or judge it without reading it. Never throws for a file problem;
 *  returns the refusal. */
export interface CredentialFileReader {
  read(path: string, policy: CredentialFilePolicy): CredentialFileRead;
  /** The same verdict without reading the content (o9o.151 fix: a file OpenRig vouches for but has no business reading). */
  inspect(path: string, policy: CredentialFilePolicy): { ok: true } | (CredentialFileRead & { ok: false });
}

/**
 * A credential file the rule refused, raised where the refusal must stop an operation instead of degrading it (o9o.151 fix, CoS
 * ruling (a): a Codex seat whose shared login fails the codex-auth policy is not launched at all, while an ordinary seeding failure
 * keeps its shared-home fallback). The message names the file and the fix.
 */
export class CredentialFileRefusedError extends Error {
  constructor(readonly file: string, readonly problem: CredentialFileProblem, message: string) {
    super(message);
    this.name = "CredentialFileRefusedError";
  }
}

/** The facts about the opened file the rule judges (an adapter supplies them from fstat). */
export interface OpenedFileFacts {
  isFile: boolean;
  /** Hard links to the inode (o9o.151 fix, ruling (c)): more than one means another name reaches the same bytes. */
  nlink: number;
  uid: number;
  mode: number;
  size: number;
}

/**
 * The verdict on an opened file, before it is read: null when it passes. Pure, so every implementation (the fs adapter, the
 * hook scripts' inline copy) judges the same facts the same way.
 */
export function judgeOpenedCredentialFile(facts: OpenedFileFacts, policy: CredentialFilePolicy, currentUid: number): CredentialFileProblem | null {
  if (!facts.isFile) return "not_regular_file";
  if (facts.nlink > 1) return "hard_linked";
  if (facts.uid !== currentUid) return "wrong_owner";
  if (policy.kind === "secret" && (facts.mode & 0o077) !== 0) return "group_or_other_access";
  if (policy.kind === "registry" && (facts.mode & 0o022) !== 0) return "group_or_other_write";
  if (facts.size > policy.maxBytes) return "too_large";
  return null;
}

/** The refusal message: what is wrong with which file, and the fix. Never the content. */
export function credentialFileRefusal(path: string, policy: CredentialFilePolicy, problem: CredentialFileProblem): string {
  const it = `${policy.label} ${path}`;
  switch (problem) {
    case "missing":
      return `${it} does not exist`;
    case "symlink":
      return `${it} is a symbolic link; a credential file is read only as a plain file, so replace the link with the file itself`;
    case "unexpected_link_target":
      return `${it} is a symbolic link to somewhere other than ${policy.linkTarget ?? "its known shared file"}; OpenRig follows a seat credential link only to that file, so remove the link (OpenRig re-makes it at the next launch) or replace it with the file itself`;
    case "hard_linked":
      return `${it} is a hard link (another name reaches the same file); a credential file must have one name, so make it a separate copy (cp, then rm the extra name)`;
    case "not_regular_file":
      return `${it} is not a regular file (a directory, pipe, device or socket); it must be a plain file`;
    case "wrong_owner":
      return `${it} belongs to another user; it must be owned by the user OpenRig runs as (chown it to yourself, or recreate it)`;
    case "group_or_other_access":
      return `${it} can be read or written by other users; run: chmod 600 ${shellQuote(path)}`;
    case "group_or_other_write":
      return `${it} can be changed by other users; run: chmod go-w ${shellQuote(path)}`;
    case "too_large":
      return `${it} is over the ${policy.maxBytes}-byte limit for ${policy.label}; it is not a credential file`;
    case "unreadable":
      return `${it} could not be read (check its permissions)`;
  }
}

function shellQuote(p: string): string {
  return /^[\w./~-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`;
}

// The policies, one per kind of file, so every site that reads the same kind of file holds it to the same rule. Caps are far
// above any real file of the kind and far below a log or a bundle.
export const TERMINAL_TOKEN_POLICY: CredentialFilePolicy = { label: "the terminal token", kind: "secret", maxBytes: 4096 };
export const BEARER_FILE_POLICY: CredentialFilePolicy = { label: "the bearer token file", kind: "secret", maxBytes: 4096 };
export const ACTIVITY_HOOK_TOKEN_POLICY: CredentialFilePolicy = { label: "the activity hook token", kind: "secret", maxBytes: 4096 };
export const ACTIVITY_ENDPOINT_POLICY: CredentialFilePolicy = { label: "the activity endpoint file", kind: "secret", maxBytes: 16 * 1024 };
export const SLACK_SECRETS_POLICY: CredentialFilePolicy = { label: "the Slack secrets file", kind: "secret", maxBytes: 64 * 1024 };
export const PI_AUTH_POLICY: CredentialFilePolicy = { label: "the Pi auth file", kind: "secret", maxBytes: 1024 * 1024 };
export const PI_MODELS_POLICY: CredentialFilePolicy = { label: "the Pi models file", kind: "secret", maxBytes: 1024 * 1024 };
export const CODEX_AUTH_POLICY: CredentialFilePolicy = { label: "the Codex auth profile", kind: "secret", maxBytes: 1024 * 1024 };
/** hosts.yaml names remote daemons and the bearer files sent to them: nobody else may change it. A link at the file is refused like
 *  any other (o9o.151 decision 4: verify-ops' census found no live host with a linked hosts.yaml; sparky and stu, mbp unverified). */
export const HOSTS_REGISTRY_POLICY: CredentialFilePolicy = { label: "the hosts registry", kind: "registry", maxBytes: 1024 * 1024 };
/** o9o.160: the routing registries. daemon.json and config.json choose the URL the CLI sends the terminal token to;
 *  slack-connector.json names the Slack secrets file. OpenRig writes all three, so a file of ours others can change is narrowed
 *  (readOwnFile), never refused; a link or another user's file is refused. */
export const DAEMON_STATE_POLICY: CredentialFilePolicy = { label: "the daemon state file", kind: "registry", maxBytes: 64 * 1024 };
/** config.json may be a link (its writer follows one by design); daemon.json may not (its writer renames over the name). */
export const OPENRIG_CONFIG_POLICY: CredentialFilePolicy = { label: "the OpenRig config file", kind: "registry", maxBytes: 1024 * 1024, followLinks: true };
export const SLACK_CONNECTOR_POLICY: CredentialFilePolicy = { label: "the Slack connector config", kind: "registry", maxBytes: 256 * 1024 };
/** o9o.182: the CLI's learned host-identity sidecar picks which hosts.yaml entry (url + bearer) a reply hint resolves to. OpenRig
 *  writes it (rig host doctor), so a file of ours others can change is narrowed, never refused; a link or another user's file is
 *  refused (sparky's live one was 0664, user-private group: o9o.182 census). */
export const HOST_BINDINGS_POLICY: CredentialFilePolicy = { label: "the host bindings file", kind: "registry", maxBytes: 1024 * 1024 };
/** o9o.160: Codex's config.toml chooses the provider credential. It is Codex's (or the operator's) file and OpenRig never chmods it:
 *  another user's file, or one others can change, is refused (CoS 11-18 13:51Z, from verify-ops' census: every live one, sparky and
 *  stu, has no group/other write; mbp unverified).
 *  THE ASYMMETRY (CoS 11-18 18:50Z): config.toml is configuration, not a login, and OF-42 supports a dotfiles-linked shared
 *  ~/.codex/config.toml, so a link AT the shared config is followed and its real target is judged by the whole rule (followLinks).
 *  The shared auth.json is a login: a link at it refuses (Jim, 17:47Z; CODEX_AUTH_POLICY has no followLinks). A seat's own
 *  config.toml is still followed only to the exact shared path (SEAT_CREDENTIAL_LINKS codex-config: its linkTarget wins). */
export const CODEX_CONFIG_POLICY: CredentialFilePolicy = { label: "the Codex config", kind: "registry", maxBytes: 1024 * 1024, followLinks: true };
/** o9o.182: a shared Codex profile file (<CODEX_HOME>/<profile>.config.toml) copied into a seat home. The copy is a plain file read
 *  as itself (a link is refused), held to the Codex config's rule otherwise. */
export const CODEX_PROFILE_POLICY: CredentialFilePolicy = { label: "the Codex profile file", kind: "registry", maxBytes: 1024 * 1024 };
/** o9o.182 (CoS 11-19 00:48Z): `rig auth`'s seat registry names the Codex auth profile each seat uses, so it chooses a credential. OpenRig
 *  writes it 0600. */
export const CODEX_SEAT_REGISTRY_POLICY: CredentialFilePolicy = { label: "the Codex seat registry", kind: "secret", maxBytes: 1024 * 1024 };
/** o9o.182, CoS ruling (A) 11-19 00:48Z: Claude's own files OpenRig merges into. user-config: a link, a non-regular file, a hard link,
 *  another user's file or an oversized one is refused; group/other write is neither refused nor changed (every live one on sparky was
 *  0664 under a user-private group). The caps sit far above any real file (sparky's ~/.claude.json was 220 KB). */
export const CLAUDE_SETTINGS_POLICY: CredentialFilePolicy = { label: "the Claude settings file", kind: "user-config", maxBytes: 4 * 1024 * 1024 };
export const CLAUDE_MCP_POLICY: CredentialFilePolicy = { label: "the Claude MCP config", kind: "user-config", maxBytes: 4 * 1024 * 1024 };
export const CLAUDE_STATE_POLICY: CredentialFilePolicy = { label: "the Claude state file", kind: "user-config", maxBytes: 64 * 1024 * 1024 };

/**
 * The seat credential links OpenRig itself makes, and the only links the credential rule follows (o9o.151; CoS 11-18 11:34Z, from
 * verify-ops' census of the live hosts, where every one of these resolved to a regular 0600 file of the operator's). A seat's file
 * may be a link to its runtime's shared file and nothing else; every other link, anywhere, is refused. The shared file is passed in
 * by the adapter that knows it (the domain cannot read the home directory).
 */
export const SEAT_CREDENTIAL_LINKS = {
  /** A Pi seat's auth.json -> <pi.operator_login_dir>/auth.json (OF-279, linkPiOperatorLogin). */
  "pi-auth": { runtime: "pi", seatFile: "auth.json", sharedFile: "<pi.operator_login_dir>/auth.json", policy: PI_AUTH_POLICY },
  /** A Pi seat's models.json -> <pi.operator_login_dir>/models.json, for members with pi.link_operator_models (OF-279). */
  "pi-models": { runtime: "pi", seatFile: "models.json", sharedFile: "<pi.operator_login_dir>/models.json", policy: PI_MODELS_POLICY },
  /** A Codex seat's auth.json -> <CODEX_HOME>/auth.json (the shared Codex login). */
  "codex-auth": { runtime: "codex", seatFile: "auth.json", sharedFile: "<CODEX_HOME>/auth.json", policy: CODEX_AUTH_POLICY },
  /** A Codex seat's config.toml -> <CODEX_HOME>/config.toml (OF-183: the seat reads the shared config; o9o.160). */
  "codex-config": { runtime: "codex", seatFile: "config.toml", sharedFile: "<CODEX_HOME>/config.toml", policy: CODEX_CONFIG_POLICY },
} as const satisfies Record<string, { runtime: string; seatFile: string; sharedFile: string; policy: CredentialFilePolicy }>;

export type SeatCredentialLink = keyof typeof SEAT_CREDENTIAL_LINKS;

/** The policy for a seat credential file that may be one of SEAT_CREDENTIAL_LINKS: a link is followed only to `sharedFile`.
 *  `sharedFile` undefined (the host declares no shared login) means no link is followed. */
export function seatCredentialLinkPolicy(link: SeatCredentialLink, sharedFile: string | undefined): CredentialFilePolicy {
  const base = SEAT_CREDENTIAL_LINKS[link].policy;
  return sharedFile ? { ...base, linkTarget: sharedFile } : base;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The procedure (o9o.160, CoS 11-18 13:38Z option B): the rule's open/judge/narrow/read steps, as pure functions over an injected
// CredentialFileOps, so every reader runs ONE procedure; the node:fs adapters supply the ops (SettingsStore's config.json since
// workspaces-6ul, crash-cart's readDaemonJson since workspaces-o9o.161; no domain module does its own file I/O). This module imports
// nothing.
// ---------------------------------------------------------------------------------------------------------------------------------

/** The file operations the procedure needs. Errors carry the errno `code` (ENOENT, ELOOP, EMLINK, ...). */
export interface CredentialFileOps {
  /** Open read-only, never following a symlink at the name and never blocking (a FIFO cannot hang): O_RDONLY|O_NOFOLLOW|O_NONBLOCK. */
  openNoFollow(path: string): number;
  fstat(fd: number): OpenedFileFacts;
  /** Read into `buf` at `offset`, up to `length` bytes, from the current position; 0 at end of file. */
  read(fd: number, buf: Uint8Array, offset: number, length: number): number;
  fchmod(fd: number, mode: number): void;
  close(fd: number): void;
  /** lstat(path).isSymbolicLink(); throws (ENOENT) when absent. */
  isSymbolicLink(path: string): boolean;
  realpath(path: string): string;
  /** The uid a file must belong to (the process's own). */
  currentUid(): number;
}

type Refusal = CredentialFileRead & { ok: false };

function errnoCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

function refusal(path: string, policy: CredentialFilePolicy, problem: CredentialFileProblem): Refusal {
  return { ok: false, problem, message: credentialFileRefusal(path, policy, problem) };
}

function openProblem(err: unknown): CredentialFileProblem {
  const code = errnoCode(err);
  // ELOOP (Linux) / EMLINK (macOS) is O_NOFOLLOW meeting a symlink.
  return code === "ENOENT" ? "missing" : code === "ELOOP" || code === "EMLINK" ? "symlink" : "unreadable";
}

/**
 * Where to open, per the policy's link mode (the open itself never follows, so the file opened is held to the whole rule):
 * - linkTarget (SEAT_CREDENTIAL_LINKS): a link is followed only when it resolves to exactly that file;
 * - followLinks (config.json, a supported dotfiles layout): a link is followed to its real target, wherever it is;
 * - neither: the path itself, so a link is refused by the open.
 */
function resolveLinkedTarget(ops: CredentialFileOps, path: string, policy: CredentialFilePolicy): { target: string } | { problem: CredentialFileProblem } {
  if (policy.linkTarget === undefined && !policy.followLinks) return { target: path };
  try {
    if (!ops.isSymbolicLink(path)) return { target: path };
    const real = ops.realpath(path);
    if (policy.linkTarget === undefined) return { target: real };
    let expected: string;
    try { expected = ops.realpath(policy.linkTarget); } catch { return { problem: "unexpected_link_target" }; }
    return real === expected ? { target: real } : { problem: "unexpected_link_target" };
  } catch (err) {
    return { problem: errnoCode(err) === "ENOENT" ? "missing" : "unreadable" };
  }
}

/** Read `path` under `policy` with `ops`. Never throws for a file problem: a refusal names the file and the fix. */
export function readCredentialFileWith(ops: CredentialFileOps, path: string, policy: CredentialFilePolicy): CredentialFileRead {
  const resolved = resolveLinkedTarget(ops, path, policy);
  if ("problem" in resolved) return refusal(path, policy, resolved.problem);
  let fd: number;
  try { fd = ops.openNoFollow(resolved.target); } catch (err) { return refusal(path, policy, openProblem(err)); }
  try {
    const facts = ops.fstat(fd);
    const problem = judgeOpenedCredentialFile(facts, policy, ops.currentUid());
    if (problem) return refusal(path, policy, problem);
    const buf = new Uint8Array(policy.maxBytes + 1);
    let n = 0;
    for (;;) {
      const got = ops.read(fd, buf, n, buf.length - n);
      if (got === 0) break;
      n += got;
      if (n > policy.maxBytes) return refusal(path, policy, "too_large");
    }
    const content = new TextDecoder().decode(buf.subarray(0, n));
    return { ok: true, content, mode: facts.mode & 0o7777 };
  } catch {
    return refusal(path, policy, "unreadable");
  } finally {
    ops.close(fd);
  }
}

/**
 * For a file OpenRig itself owns and writes: the o9o.78 precedent. A link (unless the policy follows it), a non-file or another
 * user's file is refused; a plain file of ours is narrowed on the opened descriptor (so the file narrowed is the file checked): a
 * secret to 0600, a registry by clearing its group/other WRITE bits only. Null when it is now fit to read; the refusal otherwise.
 */
export function narrowOwnFileWith(ops: CredentialFileOps, path: string, policy: CredentialFilePolicy): Refusal | null {
  const resolved = resolveLinkedTarget(ops, path, policy);
  if ("problem" in resolved) return refusal(path, policy, resolved.problem);
  let fd: number;
  try { fd = ops.openNoFollow(resolved.target); } catch (err) { return refusal(path, policy, openProblem(err)); }
  try {
    const st = ops.fstat(fd);
    // Before any chmod (o9o.151 ruling (c)): a hard-linked name would let the fchmod change another name's file.
    const problem: CredentialFileProblem | null = !st.isFile ? "not_regular_file" : st.nlink > 1 ? "hard_linked" : st.uid !== ops.currentUid() ? "wrong_owner" : null;
    if (problem) return refusal(path, policy, problem);
    if (policy.kind === "secret" && (st.mode & 0o077) !== 0) ops.fchmod(fd, 0o600);
    if (policy.kind === "registry" && (st.mode & 0o022) !== 0) ops.fchmod(fd, st.mode & 0o7777 & ~0o022);
    return null;
  } finally {
    ops.close(fd);
  }
}

/** narrowOwnFileWith then readCredentialFileWith: the read for a file OpenRig owns. */
export function readOwnFileWith(ops: CredentialFileOps, path: string, policy: CredentialFilePolicy): CredentialFileRead {
  return narrowOwnFileWith(ops, path, policy) ?? readCredentialFileWith(ops, path, policy);
}

/** Judge a credential file WITHOUT reading it (the operator's Pi login before a seat is linked to it). No content in the result. */
export function inspectCredentialFileWith(ops: CredentialFileOps, path: string, policy: CredentialFilePolicy): { ok: true } | Refusal {
  const resolved = resolveLinkedTarget(ops, path, policy);
  if ("problem" in resolved) return refusal(path, policy, resolved.problem);
  let fd: number;
  try { fd = ops.openNoFollow(resolved.target); } catch (err) { return refusal(path, policy, openProblem(err)); }
  try {
    const problem = judgeOpenedCredentialFile(ops.fstat(fd), policy, ops.currentUid());
    return problem ? refusal(path, policy, problem) : { ok: true };
  } finally {
    ops.close(fd);
  }
}

/** The node:fs surface credentialFileOpsFrom uses, typed structurally so this module imports nothing. */
export interface NodeFsLike {
  constants: { O_RDONLY: number; O_NOFOLLOW: number; O_NONBLOCK: number };
  openSync(path: string, flags: number): number;
  fstatSync(fd: number): { isFile(): boolean; nlink: number; uid: number; mode: number; size: number };
  readSync(fd: number, buffer: Uint8Array, offset: number, length: number, position: null): number;
  fchmodSync(fd: number, mode: number): void;
  closeSync(fd: number): void;
  lstatSync(path: string): { isSymbolicLink(): boolean };
  realpathSync(path: string): string;
}

/** CredentialFileOps over a node:fs-shaped module: the adapter passes node:fs; a domain module that already imports node:fs (under
 *  the hexagonal baseline) passes that, so every reader runs this one procedure. */
export function credentialFileOpsFrom(fs: NodeFsLike, currentUid: () => number): CredentialFileOps {
  const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = fs.constants;
  return {
    openNoFollow: (path) => fs.openSync(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK),
    fstat: (fd) => {
      const st = fs.fstatSync(fd);
      return { isFile: st.isFile(), nlink: st.nlink, uid: st.uid, mode: st.mode, size: st.size };
    },
    read: (fd, buf, offset, length) => fs.readSync(fd, buf, offset, length, null),
    fchmod: (fd, mode) => fs.fchmodSync(fd, mode),
    close: (fd) => fs.closeSync(fd),
    isSymbolicLink: (path) => fs.lstatSync(path).isSymbolicLink(),
    realpath: (path) => fs.realpathSync(path),
    currentUid,
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The write half (workspaces-o9o.182): a read-modify-write of a credential-adjacent file (Claude's settings and state, Codex's
// config.toml and profile files, OpenRig's host-bindings.json and seat registry, the Slack connector config), as one procedure over
// injected file ops, so the fs adapter and the domain modules that already do their own file I/O run the same rule.
//  - The file is judged before it is changed: read under its policy. A refused file is left exactly as it is and the refusal (naming
//    the file and the fix) is returned. A file OpenRig owns (`own`) is narrowed first, as readOwnFileWith does.
//  - A policy that follows links (Codex's config.toml, OF-42's dotfiles layout) is followed to its REAL path, and that path is what is
//    judged and replaced, so the operator's link survives the write. Any other link is refused, a dangling one included.
//  - The new content goes to a fresh temp file beside the target (O_CREAT|O_EXCL|O_NOFOLLOW: never a link and never an existing
//    file), with the target's own mode (or `createMode` for a new file) pinned on the descriptor, fsynced, then renamed over the
//    target. A link swapped in at the target after the check is replaced, never written through; a reader never sees a torn file.
// ---------------------------------------------------------------------------------------------------------------------------------

/** The file operations the write half needs, beyond the read half's. Errors carry the errno `code`. */
export interface GuardedFileOps extends CredentialFileOps {
  /** lstat(path): its permission bits, or null when absent (ENOENT); other errors throw. Never follows a link. */
  lstatMode(path: string): { mode: number; isSymbolicLink: boolean } | null;
  /** Create a NEW file for writing: O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW at `mode`. */
  createExclusive(path: string, mode: number): number;
  writeAll(fd: number, content: string): void;
  fsync(fd: number): void;
  rename(from: string, to: string): void;
  /** Remove a file, ignoring a missing one. */
  removeQuiet(path: string): void;
  /** A short random suffix for a temp name (hex). */
  randomSuffix(): string;
  /** This process's id, for the temp name. */
  pid(): number;
}

export type GuardedRewriteResult =
  /** `path` is the file actually judged and replaced (the real path when the policy follows a link). */
  | { ok: true; written: boolean; path: string }
  | Refusal;

export interface GuardedRewriteOptions {
  /** OpenRig's own file: narrowed (readOwnFile) before it is read, instead of refused for group/other bits. */
  own?: boolean;
  /** Mode for a file that does not exist yet (default 0600). An existing file keeps its own mode. */
  createMode?: number;
  /** Write even when `mutate` returns the text unchanged (a writer that has always rewritten its file keeps doing so); null from
   *  `mutate` still writes nothing. */
  rewriteUnchanged?: boolean;
}

/**
 * Read `path` under `policy`, give its content (null when absent) to `mutate`, and write what `mutate` returns. `mutate` returning
 * null, or the same text, writes nothing. Never throws for a file the rule refuses (that is returned); `mutate` throwing, or a failed
 * write, throws (the temp file removed).
 */
export function rewriteGuardedFileWith(
  ops: GuardedFileOps,
  path: string,
  policy: CredentialFilePolicy,
  mutate: (current: string | null) => string | null,
  options: GuardedRewriteOptions = {},
): GuardedRewriteResult {
  const target = rewriteTarget(ops, path, policy);
  if (typeof target !== "string") return target;
  // The real path is judged as itself: a link appearing there now is refused by the open.
  const judged: CredentialFilePolicy = { label: policy.label, kind: policy.kind, maxBytes: policy.maxBytes };
  const relabel = (r: Refusal): Refusal => (target === path ? r : { ...r, message: `${r.message} (the real file behind ${path})` });
  let current: string | null = null;
  let mode = options.createMode ?? 0o600;
  const before = ops.lstatMode(target);
  if (before !== null) {
    if (options.own) {
      const narrowed = narrowOwnFileWith(ops, target, judged);
      if (narrowed) return relabel(narrowed);
    }
    const read = readCredentialFileWith(ops, target, judged);
    if (!read.ok) return relabel(read);
    current = read.content;
    // The mode of the file judged and read, from its own descriptor: the path is never asked again (verify-sec2, o9o.182: a link swapped
    // in after the read made a re-stat of the path publish the replacement at the link's 0777).
    mode = (read.mode ?? before.mode) & 0o7777;
  }
  const next = mutate(current);
  if (next === null || (next === current && !options.rewriteUnchanged)) return { ok: true, written: false, path: target };
  writeReplacingWith(ops, target, next, mode);
  return { ok: true, written: true, path: target };
}

/** Write `content` to `target` as a fresh file renamed over it: never through a link at the target or at the temp name. */
export function writeReplacingWith(ops: GuardedFileOps, target: string, content: string, mode: number): void {
  const slash = target.lastIndexOf("/");
  const dir = slash >= 0 ? target.slice(0, slash + 1) : "";
  const temp = `${dir}.${target.slice(slash + 1)}.openrig-${ops.pid()}-${ops.randomSuffix()}.tmp`;
  const fd = ops.createExclusive(temp, mode);
  try {
    try {
      ops.fchmod(fd, mode); // the umask never widens or narrows it
      ops.writeAll(fd, content);
      ops.fsync(fd);
    } finally {
      ops.close(fd);
    }
    ops.rename(temp, target);
  } catch (err) {
    ops.removeQuiet(temp);
    throw err;
  }
}

/** The path to judge and replace: the path itself, or for a policy that follows links, the link's real path. */
function rewriteTarget(ops: GuardedFileOps, path: string, policy: CredentialFilePolicy): string | Refusal {
  if (!policy.followLinks) return path;
  let at: { mode: number; isSymbolicLink: boolean } | null;
  try { at = ops.lstatMode(path); } catch { return refusal(path, policy, "unreadable"); }
  if (at === null || !at.isSymbolicLink) return path;
  try {
    return ops.realpath(path);
  } catch {
    // A dangling link: OpenRig does not create a file at the far end of someone's link.
    return refusal(path, policy, "missing");
  }
}

/** The node:fs surface guardedFileOpsFrom uses, typed structurally so this module imports nothing. */
export interface NodeFsWriteLike extends NodeFsLike {
  constants: NodeFsLike["constants"] & { O_WRONLY: number; O_CREAT: number; O_EXCL: number };
  openSync(path: string, flags: number, mode?: number): number;
  lstatSync(path: string): { isSymbolicLink(): boolean; mode: number };
  writeFileSync(fd: number, data: string, encoding: "utf-8"): void;
  fsyncSync(fd: number): void;
  renameSync(from: string, to: string): void;
  rmSync(path: string, options: { force: true }): void;
}

/** GuardedFileOps over a node:fs-shaped module (see credentialFileOpsFrom). */
export function guardedFileOpsFrom(fs: NodeFsWriteLike, currentUid: () => number, randomSuffix: () => string, pid: () => number): GuardedFileOps {
  const { O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = fs.constants;
  return {
    ...credentialFileOpsFrom(fs, currentUid),
    lstatMode: (path) => {
      try {
        const st = fs.lstatSync(path);
        return { mode: st.mode, isSymbolicLink: st.isSymbolicLink() };
      } catch (err) {
        if (errnoCode(err) === "ENOENT") return null;
        throw err;
      }
    },
    createExclusive: (path, mode) => fs.openSync(path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, mode),
    writeAll: (fd, content) => fs.writeFileSync(fd, content, "utf-8"),
    fsync: (fd) => fs.fsyncSync(fd),
    rename: (from, to) => fs.renameSync(from, to),
    removeQuiet: (path) => fs.rmSync(path, { force: true }),
    randomSuffix,
    pid,
  };
}
