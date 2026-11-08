// OF-270: a Pi seat's model overrides (spec member `model_overrides`) written into the seat's own agent-dir
// models.json by the pane-hosted runner, at every launch (fresh, resume, restore, handover successor, fork: all of
// them start the runner, and the runner calls this once before it spawns pi).
//
// The rules, each pinned by test/pi-model-overrides.test.ts:
// - never write through a symlink: a models.json that is a link (build-arch's points at the operator's own
//   ~/.pi/agent/models.json) is refused with a message naming the file; nothing is written anywhere;
// - merge, never clobber: every other key survives; the spec wins only at the exact override path
//   providers.<provider>.modelOverrides.<model>.contextWindow, and each value it changes is reported;
// - a file that is not plain JSON (Pi also reads // comments and trailing commas) is refused rather than rewritten,
//   since a rewrite would drop what the operator wrote;
// - never write through a symlinked directory either: the seat dir and the agent dir are lstat-ed one by one below the
//   state root, any link refuses the launch, and realpath(agent dir) must equal the expected path (a symlinked state
//   root itself is allowed, since it may be legitimate: only what lies below it is judged);
// - atomic: a temp file in the same directory (created exclusively, so a planted name refuses instead of being followed),
//   mode 0600, fsync, rename, fsync of the directory; the mode is read back after;
// - a file holding an integer beyond 2^53 is refused: JSON.parse/stringify would round it, and a refusal is cheaper than a
//   precision-safe rewrite;
// - nothing to change (no overrides, or the file already holds the values): the file is not touched at all;
// - auth.json is never opened, created or listed here.
// Measured against Pi 1.4.0 (installed package, composeModelProvider from dist/core/provider-composer.js, with the built-in
// catalog from pi-ai/providers/all): an override-only block is ACCEPTED both for a built-in provider (openai-codex: the
// model's window becomes the override) and for a provider id Pi does not know (no error, zero models, so the override applies
// to nothing: "Unknown override IDs are ignored"). So nothing here refuses a provider that is absent from the file; the cost
// of a misspelt provider is an override that does nothing, never a failed seat.
// Values printed are numbers the spec states; no other value of the file is ever echoed.
import fs from "node:fs";
import nodePath from "node:path";
import { parsePiModelsJson } from "./pi-readiness.js";
import { normalizePiModelOverrides, type PiModelOverrides } from "./pi-runner-protocol.js";

export const PI_MODELS_JSON_MAX_BYTES = 1024 * 1024;

/** The subset of node:fs this module uses, injectable so a failure mid-write can be tested without a broken disk. */
export interface PiModelOverridesFs {
  lstat(p: string): fs.Stats;
  realpath(p: string): string;
  /** fsync the directory itself, so the rename survives a crash. */
  fsyncDir(p: string): void;
  readlink(p: string): string;
  readFile(p: string): string;
  /** Create `p` exclusively (fails if it exists) with mode 0600, write `data`, fsync, close. */
  createExclusive(p: string, data: string): void;
  rename(from: string, to: string): void;
  unlink(p: string): void;
}

export const realPiModelOverridesFs: PiModelOverridesFs = {
  lstat: (p) => fs.lstatSync(p),
  realpath: (p) => fs.realpathSync(p),
  fsyncDir: (p) => {
    const fd = fs.openSync(p, "r");
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  },
  readlink: (p) => fs.readlinkSync(p),
  readFile: (p) => fs.readFileSync(p, "utf8"),
  createExclusive: (p, data) => {
    const fd = fs.openSync(p, "wx", 0o600); // "wx" (O_EXCL): a name someone planted, a symlink included, refuses here
    try {
      // Redundant with the mode read-back after the rename (which refuses anything but 600), kept as defence in depth: the
      // creation mode above is masked by the umask, and this makes the file 0600 whatever the umask is.
      fs.fchmodSync(fd, 0o600);
      fs.writeFileSync(fd, data);
      fs.fsyncSync(fd);
    } catch (err) {
      try { fs.closeSync(fd); } catch { /* already failing */ }
      try { fs.unlinkSync(p); } catch { /* the file we created */ }
      throw err;
    }
    fs.closeSync(fd);
  },
  rename: (a, b) => fs.renameSync(a, b),
  unlink: (p) => fs.unlinkSync(p),
};

export type ApplyPiModelOverridesResult =
  | { ok: true; wrote: boolean; changes: string[] }
  | { ok: false; error: string };

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/** The reason the agent dir cannot be trusted as a place to write, or null. `stateRoot/<seat>/agent` is judged below the root:
 *  each of the seat dir and the agent dir must be a real directory (lstat), and the agent dir's realpath must be exactly
 *  the realpath of the state root plus the same two names. */
export interface AgentDirRefusalWording { noun: string; verb: string; symlinkTail: string }
const MODEL_OVERRIDES_WORDING: AgentDirRefusalWording = {
  noun: "model_overrides",
  verb: "write",
  symlinkTail: "so the model_overrides this seat declares cannot be applied. Replace the link with a real directory, or remove model_overrides from the spec.",
};

export function agentDirRefusal(io: Pick<PiModelOverridesFs, "lstat" | "realpath">, stateRoot: string, agentDir: string, what: AgentDirRefusalWording = MODEL_OVERRIDES_WORDING): string | null {
  const rel = nodePath.relative(stateRoot, agentDir);
  const parts = rel.split(nodePath.sep);
  if (rel === "" || rel.startsWith("..") || nodePath.isAbsolute(rel) || parts.some((part) => part === "" || part === "..")) {
    return `${agentDir} is not below the Pi state root ${stateRoot}; not writing ${what.noun}.`;
  }
  let walked = stateRoot;
  for (const part of parts) {
    walked = nodePath.join(walked, part);
    let st: fs.Stats;
    try { st = io.lstat(walked); } catch (err) { return `cannot inspect ${walked}: ${(err as NodeJS.ErrnoException).code ?? "error"}; not writing ${what.noun}.`; }
    if (st.isSymbolicLink()) return `${walked} is a symlink; the runner never writes through a symlinked seat or agent directory, ${what.symlinkTail}`;
    if (!st.isDirectory()) return `${walked} is not a directory; not writing ${what.noun}.`;
  }
  let real: string;
  let expected: string;
  try {
    real = io.realpath(agentDir);
    expected = nodePath.join(io.realpath(stateRoot), ...parts);
  } catch (err) { return `cannot resolve ${agentDir}: ${(err as NodeJS.ErrnoException).code ?? "error"}; not writing ${what.noun}.`; }
  if (real !== expected) return `${agentDir} resolves to ${real}, not ${expected}; the runner will not ${what.verb} ${what.noun} through it.`;
  return null;
}

/** An integer literal outside the safe range anywhere in the text (outside strings). JSON.parse would round it. */
function hasUnsafeInteger(text: string): boolean {
  for (const m of text.matchAll(/"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g)) {
    const token = m[0];
    if (token[0] === '"' || /[.eE]/.test(token)) continue;
    const n = BigInt(token);
    if (n > BigInt(Number.MAX_SAFE_INTEGER) || n < -BigInt(Number.MAX_SAFE_INTEGER)) return true;
  }
  return false;
}

export function applyPiModelOverrides(opts: {
  /** The Pi state root (`<OPENRIG_HOME>/state/pi`); the seat dir and agent dir below it are checked for links. */
  stateRoot: string;
  agentDir: string;
  overrides: PiModelOverrides | undefined;
  fsOps?: PiModelOverridesFs;
  /** Test seam for the temp file name. */
  tempSuffix?: () => string;
}): ApplyPiModelOverridesResult {
  if (opts.overrides === undefined) return { ok: true, wrote: false, changes: [] };
  const wanted = normalizePiModelOverrides(opts.overrides);
  if (!wanted) return { ok: false, error: "model_overrides is not valid (a positive integer contextWindow under provider and model names); not touching models.json" };
  const io = opts.fsOps ?? realPiModelOverridesFs;
  const file = nodePath.join(opts.agentDir, "models.json");
  const dirRefusal = agentDirRefusal(io, opts.stateRoot, opts.agentDir);
  if (dirRefusal) return { ok: false, error: dirRefusal };
  const refuse = (error: string): ApplyPiModelOverridesResult => ({ ok: false, error });

  let doc: Rec = {};
  let existed = false;
  let st: fs.Stats | undefined;
  try { st = io.lstat(file); } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") return refuse(`cannot inspect ${file}: ${(err as NodeJS.ErrnoException).code ?? "error"}; not writing model_overrides`);
  }
  if (st) {
    existed = true;
    if (st.isSymbolicLink()) {
      let target = "(unreadable)";
      try { target = io.readlink(file); } catch { /* the message still names the file */ }
      return refuse(`${file} is a symlink (to ${target}); the runner never writes through a symlink, so the model_overrides this seat declares cannot be applied. Replace the link with this seat's own regular models.json (copy the target in, or leave only the overrides), or remove model_overrides from the spec.`);
    }
    if (!st.isFile()) return refuse(`${file} is not a regular file; the runner will not write model_overrides over it. Remove it or fix it by hand.`);
    if (st.size > PI_MODELS_JSON_MAX_BYTES) return refuse(`${file} is larger than ${PI_MODELS_JSON_MAX_BYTES} bytes; not rewriting it.`);
    let text: string;
    try { text = io.readFile(file); } catch (err) { return refuse(`cannot read ${file}: ${(err as NodeJS.ErrnoException).code ?? "error"}; not writing model_overrides`); }
    if (hasUnsafeInteger(text)) return refuse(`${file} holds an integer beyond 2^53 (9007199254740991), which rewriting the file would round to a different number; the runner will not rewrite it. Quote that value as a string in the file, or remove model_overrides from the spec.`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      let readable = true;
      try { parsePiModelsJson(text); } catch { readable = false; }
      return refuse(readable
        ? `${file} holds comments, a byte-order mark or trailing commas, which a rewrite would drop; the runner will not rewrite it. Make it plain JSON, or remove model_overrides from the spec.`
        : `${file} is not valid JSON; the runner will not overwrite it. Repair it, or remove model_overrides from the spec.`);
    }
    if (!isRec(parsed)) return refuse(`${file} is not a JSON object; the runner will not overwrite it.`);
    doc = parsed;
  }

  // Merge. Shape problems at the touched paths are refused, never replaced.
  const changes: string[] = [];
  if (own(doc, "providers") && !isRec(doc["providers"])) return refuse(`${file}: "providers" is not an object; not merging model_overrides into it.`);
  const providers: Rec = isRec(doc["providers"]) ? doc["providers"] : {};
  for (const provider of Object.keys(wanted)) {
    const where = (suffix: string) => `providers.${provider}.${suffix}`;
    if (own(providers, provider) && !isRec(providers[provider])) return refuse(`${file}: providers.${provider} is not an object; not merging model_overrides into it.`);
    const entry: Rec = isRec(providers[provider]) ? (providers[provider] as Rec) : {};
    if (own(entry, "modelOverrides") && !isRec(entry["modelOverrides"])) return refuse(`${file}: ${where("modelOverrides")} is not an object; not merging model_overrides into it.`);
    const overridesAt: Rec = isRec(entry["modelOverrides"]) ? (entry["modelOverrides"] as Rec) : {};
    for (const model of Object.keys(wanted[provider]!)) {
      const path = where(`modelOverrides.${model}.contextWindow`);
      if (own(overridesAt, model) && !isRec(overridesAt[model])) return refuse(`${file}: ${where(`modelOverrides.${model}`)} is not an object; not merging model_overrides into it.`);
      const modelEntry: Rec = isRec(overridesAt[model]) ? (overridesAt[model] as Rec) : {};
      const want = wanted[provider]![model]!.contextWindow;
      const have = modelEntry["contextWindow"];
      if (own(modelEntry, "contextWindow") && have === want) continue;
      changes.push(`${path} ${typeof have === "number" ? have : "unset"} -> ${want}`);
      modelEntry["contextWindow"] = want;
      overridesAt[model] = modelEntry;
    }
    entry["modelOverrides"] = overridesAt;
    providers[provider] = entry;
  }
  if (changes.length === 0) return { ok: true, wrote: false, changes };
  doc["providers"] = providers;

  const tmp = nodePath.join(opts.agentDir, `.models.json.${(opts.tempSuffix ?? (() => `${process.pid}.${Math.random().toString(36).slice(2, 10)}`))()}.tmp`);
  // The exclusive create cleans up after itself once it has created the file; when it refuses (EEXIST: the name was planted)
  // the entry is not ours, so it is left exactly as found.
  try {
    io.createExclusive(tmp, `${JSON.stringify(doc, null, 2)}\n`);
  } catch (err) {
    return refuse(`could not write ${file}: ${(err as NodeJS.ErrnoException).code ?? "error"}; the previous file ${existed ? "is unchanged" : "was not created"}`);
  }
  try {
    io.rename(tmp, file);
  } catch (err) {
    try { io.unlink(tmp); } catch { /* the temp may not exist */ }
    return refuse(`could not write ${file}: ${(err as NodeJS.ErrnoException).code ?? "error"}; the previous file ${existed ? "is unchanged" : "was not created"}`);
  }
  // The rename is in place; make it survive a crash. A failure is reported, not hidden (the file is complete either way).
  try { io.fsyncDir(opts.agentDir); } catch (err) {
    return refuse(`replaced ${file} but could not fsync its directory (${(err as NodeJS.ErrnoException).code ?? "error"}); the new content is in place`);
  }
  let after: fs.Stats;
  try { after = io.lstat(file); } catch { return refuse(`wrote ${file} but cannot read it back`); }
  if (after.isSymbolicLink() || !after.isFile()) return refuse(`${file} is not a regular file after the write`);
  if ((after.mode & 0o777) !== 0o600) return refuse(`${file} has mode ${(after.mode & 0o777).toString(8)} after the write, not 600`);
  return { ok: true, wrote: true, changes };
}
