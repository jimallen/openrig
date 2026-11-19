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
// A refusal names the file and the fix; the content of a refused file is never returned.

export type CredentialFileKind = "secret" | "registry";

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
  | { ok: true; content: string }
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
/** o9o.160: Codex's config.toml chooses the provider credential. It is Codex's (or the operator's) file and OpenRig never chmods it:
 *  another user's file, or one others can change, is refused (CoS 11-18 13:51Z, from verify-ops' census: every live one, sparky and
 *  stu, has no group/other write; mbp unverified).
 *  THE ASYMMETRY (CoS 11-18 18:50Z): config.toml is configuration, not a login, and OF-42 supports a dotfiles-linked shared
 *  ~/.codex/config.toml, so a link AT the shared config is followed and its real target is judged by the whole rule (followLinks).
 *  The shared auth.json is a login: a link at it refuses (Jim, 17:47Z; CODEX_AUTH_POLICY has no followLinks). A seat's own
 *  config.toml is still followed only to the exact shared path (SEAT_CREDENTIAL_LINKS codex-config: its linkTarget wins). */
export const CODEX_CONFIG_POLICY: CredentialFilePolicy = { label: "the Codex config", kind: "registry", maxBytes: 1024 * 1024, followLinks: true };

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
    const problem = judgeOpenedCredentialFile(ops.fstat(fd), policy, ops.currentUid());
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
    return { ok: true, content };
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
