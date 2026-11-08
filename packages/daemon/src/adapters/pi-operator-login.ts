// OF-279: a Pi seat gets the operator's Pi login by a declared symlink, made by the pane-hosted runner at every launch
// (fresh, resume, restore, handover successor, fork: all start the runner, and the runner calls this once before it
// spawns pi).
//
// The declaration is per host (`pi.operator_login_dir`, a daemon setting passed to the runner as --operator-login-dir):
// the operator's Pi login is a property of the machine. models.json is declared per member (`pi: { link_operator_models:
// true }`, the runner flag --link-operator-models), because only some seats need a custom provider.
//
// The rules, each pinned by test/pi-operator-login.test.ts:
// - a link, never a copy: <agent dir>/auth.json (and models.json when declared) becomes a symlink to the operator's file;
// - the operator's file must resolve outside the Pi state root (review F2), so a seat is never linked to a seat's file or to itself;
// - never a dangling link: if <operator dir>/auth.json (or models.json) is missing or is not a regular file the launch is
//   refused, because Pi would otherwise create "{}" through the link into the operator's own folder (Pi's
//   FileAuthStorageBackend.ensureFileExists writes "{}" when existsSync is false, and existsSync follows the link);
// - a regular auth.json holds a credential: it is left alone and used. The one exception is the 2-byte stub Pi's own
//   ensureFileExists leaves behind: a regular file of EXACTLY 2 bytes that parses as an empty object is replaced (the
//   symlink is created under a temp name and renamed over it, so the seat never has a moment without the file). That parse
//   is the only read of a seat credential file, and it happens for a 2-byte file only; the operator's files are never
//   opened by THIS module (stat and realpath only). The runner's credential check afterwards parses the file through the link, only to classify
//   the credential source (see pi-readiness.ts); nothing is printed, copied or written;
// - a symlink that already points at the operator's file is left as it is; a symlink pointing elsewhere is left alone and
//   the launch log names where it points (a link target is a path, not a credential);
// - a regular models.json is the seat's own (it may hold keys, or the OF-270 overrides): left alone and named in the log;
// - the seat dir and the agent dir are lstat-ed one by one below the state root and any link refuses the launch (the same
//   check, the same function, as the model_overrides writer);
// - declaring the models link without the host setting refuses: the member asked for something the host cannot give.
// Values printed are paths. No credential value is read or printed.
import fs from "node:fs";
import nodePath from "node:path";
import { agentDirRefusal, type AgentDirRefusalWording } from "./pi-model-overrides.js";

export interface PiOperatorLoginFs {
  lstat(p: string): fs.Stats;
  /** stat that follows links: the operator's file as Pi will see it through the link. */
  stat(p: string): fs.Stats;
  realpath(p: string): string;
  readlink(p: string): string;
  /** Only ever called on a seat's regular auth.json of exactly 2 bytes. */
  readFile(p: string): string;
  symlink(target: string, p: string): void;
  rename(from: string, to: string): void;
  unlink(p: string): void;
}

export const realPiOperatorLoginFs: PiOperatorLoginFs = {
  lstat: (p) => fs.lstatSync(p),
  stat: (p) => fs.statSync(p),
  // .native: the platform's canonical path, case included (the JS realpath keeps the case it was given, and on a case-insensitive disk that
  // lets a differently-cased spelling of a seat's own path slip past the state-root check; review N2).
  realpath: (p) => fs.realpathSync.native(p),
  readlink: (p) => fs.readlinkSync(p),
  readFile: (p) => fs.readFileSync(p, "utf8"),
  symlink: (target, p) => fs.symlinkSync(target, p),
  rename: (a, b) => fs.renameSync(a, b),
  unlink: (p) => fs.unlinkSync(p),
};

export type LinkPiOperatorLoginResult =
  | { ok: true; lines: string[] }
  | { ok: false; error: string };

const WORDING: AgentDirRefusalWording = {
  noun: "the operator login link",
  verb: "link",
  symlinkTail: "so the operator login cannot be linked into it. Replace the link with a real directory, or unset pi.operator_login_dir.",
};

export const OPERATOR_LOGIN_DOC = "docs/reference/pi-operator-login.md";

const code = (err: unknown) => (err as NodeJS.ErrnoException)?.code ?? "error";

export function linkPiOperatorLogin(opts: {
  /** The Pi state root (`<OPENRIG_HOME>/state/pi`). */
  stateRoot: string;
  agentDir: string;
  sessionName: string;
  /** `pi.operator_login_dir`; undefined or "" = the host declares no operator login. */
  operatorDir: string | undefined;
  /** The member's `pi.link_operator_models`. */
  linkModels: boolean;
  fsOps?: PiOperatorLoginFs;
  /** Test seam for the temp link name. */
  tempSuffix?: () => string;
}): LinkPiOperatorLoginResult {
  const operatorDir = opts.operatorDir?.trim() ? opts.operatorDir : undefined;
  if (operatorDir === undefined) {
    return opts.linkModels
      ? { ok: false, error: "this member declares pi.link_operator_models but the host setting pi.operator_login_dir is not set, so there is no operator models.json to link. Set it (rig config set pi.operator_login_dir <the operator's Pi agent folder>) or remove link_operator_models from the spec." }
      : { ok: true, lines: [] };
  }
  const io = opts.fsOps ?? realPiOperatorLoginFs;
  if (!nodePath.isAbsolute(operatorDir) || operatorDir.split(nodePath.sep).includes("..")) {
    return { ok: false, error: `pi.operator_login_dir ${JSON.stringify(operatorDir)} is not an absolute folder path without "..".` };
  }
  const dirRefusal = agentDirRefusal(io, opts.stateRoot, opts.agentDir, WORDING);
  if (dirRefusal) return { ok: false, error: dirRefusal };

  const lines: string[] = [];
  const names = opts.linkModels ? ["auth.json", "models.json"] : ["auth.json"];
  // The operator's files first, for every name, so a refusal leaves the seat dir as found.
  for (const name of names) {
    const target = nodePath.join(operatorDir, name);
    let st: fs.Stats;
    try { st = io.stat(target); } catch (err) {
      return { ok: false, error: `the operator's ${name} (${target}) cannot be inspected (${code(err)}); not linking, because a link to a missing file would make Pi create "{}" in the operator's folder. Log in to Pi as the operator first (or fix pi.operator_login_dir).` };
    }
    if (!st.isFile()) return { ok: false, error: `the operator's ${name} (${target}) is not a regular file; not linking it.` };
    // Review F2: the operator's file must not live under the Pi state root (it would be a seat's own file, or the seat's own stub: linking a
    // seat's auth.json to itself makes a looping link). Judged on the real paths, so a link or a symlinked folder into a seat dir refuses too.
    let realTarget: string; let realState: string;
    try { realTarget = io.realpath(target); realState = io.realpath(opts.stateRoot); } catch (err) {
      return { ok: false, error: `cannot resolve the operator's ${name} (${target}) or the Pi state root (${code(err)}); not linking.` };
    }
    if (realTarget === realState || realTarget.startsWith(realState + nodePath.sep)) {
      return { ok: false, error: `the operator's ${name} (${target}) resolves to ${realTarget}, inside the Pi state root ${realState}; that is a seat's own file, not the operator's login. Point pi.operator_login_dir at the operator's own Pi folder.` };
    }
  }
  for (const name of names) {
    const target = nodePath.join(operatorDir, name);
    const file = nodePath.join(opts.agentDir, name);
    const result = linkOne(io, name, file, target, opts.tempSuffix);
    if ("error" in result) return { ok: false, error: result.error };
    lines.push(result.line);
  }
  return { ok: true, lines };
}

function linkOne(io: PiOperatorLoginFs, name: string, file: string, target: string, tempSuffix: (() => string) | undefined): { line: string } | { error: string } {
  const shared = name === "auth.json"
    ? ` The login is shared with the operator's own Pi and every other seat linked to it; concurrent token refresh across them is not proven safe (${OPERATOR_LOGIN_DOC}).`
    : "";
  let st: fs.Stats | undefined;
  try { st = io.lstat(file); } catch (err) {
    if (code(err) !== "ENOENT") return { error: `cannot inspect ${file}: ${code(err)}; not linking the operator ${name}.` };
  }
  const makeLink = (): { error: string } | null => {
    try { io.symlink(target, file); } catch (err) {
      return { error: `could not link ${file} to ${target}: ${code(err)}${code(err) === "EEXIST" ? " (the name appeared during the launch)" : ""}; the seat's ${name} is unchanged.` };
    }
    return null;
  };
  if (!st) {
    const failed = makeLink();
    return failed ?? { line: `${name} linked to the operator's (${target}).${shared}` };
  }
  if (st.isSymbolicLink()) {
    let at: string;
    try { at = io.readlink(file); } catch (err) { return { error: `cannot read the link ${file}: ${code(err)}; not changing it.` }; }
    if (nodePath.resolve(nodePath.dirname(file), at) === target) return { line: `${name} is linked to the operator's (${target}).${shared}` };
    return { line: `${name} is a symlink to ${at}, not the operator's ${target}; left alone, so ${name} is NOT the operator's.` };
  }
  if (!st.isFile()) return { error: `${file} is not a regular file or a symlink; not replacing it.` };
  if (name === "auth.json" && st.size === 2 && isEmptyObjectFile(io, file)) {
    const tmp = nodePath.join(nodePath.dirname(file), `.${name}.link.${(tempSuffix ?? (() => `${process.pid}.${Math.random().toString(36).slice(2, 10)}`))()}.tmp`);
    try { io.symlink(target, tmp); } catch (err) {
      return { error: `could not link ${tmp}: ${code(err)}; the seat's ${name} is unchanged.` };
    }
    try { io.rename(tmp, file); } catch (err) {
      try { io.unlink(tmp); } catch { /* the temp link may not exist */ }
      return { error: `could not replace the empty ${file} with a link: ${code(err)}; it is unchanged.` };
    }
    return { line: `${name} was the empty 2-byte stub Pi leaves; replaced by a link to the operator's (${target}).${shared}` };
  }
  return { line: name === "auth.json"
    ? `auth.json is this seat's own file (${st.size} bytes) and holds its own login; left alone and used, not linked to the operator's.`
    : `${name} is this seat's own file (${st.size} bytes); left alone, not linked to the operator's.` };
}

/** The one allowed read of a seat credential file: a regular file of exactly 2 bytes, parsed only to see that it is "{}". */
function isEmptyObjectFile(io: PiOperatorLoginFs, file: string): boolean {
  try {
    const value: unknown = JSON.parse(io.readFile(file));
    return typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length === 0;
  } catch { return false; }
}
