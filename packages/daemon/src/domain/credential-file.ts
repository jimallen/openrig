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
} as const satisfies Record<string, { runtime: string; seatFile: string; sharedFile: string; policy: CredentialFilePolicy }>;

export type SeatCredentialLink = keyof typeof SEAT_CREDENTIAL_LINKS;

/** The policy for a seat credential file that may be one of SEAT_CREDENTIAL_LINKS: a link is followed only to `sharedFile`.
 *  `sharedFile` undefined (the host declares no shared login) means no link is followed. */
export function seatCredentialLinkPolicy(link: SeatCredentialLink, sharedFile: string | undefined): CredentialFilePolicy {
  const base = SEAT_CREDENTIAL_LINKS[link].policy;
  return sharedFile ? { ...base, linkTarget: sharedFile } : base;
}
