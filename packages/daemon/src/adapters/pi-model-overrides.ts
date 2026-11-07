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
// - atomic: a temp file in the same directory, mode 0600, fsync, rename; the mode is read back after;
// - nothing to change (no overrides, or the file already holds the values): the file is not touched at all;
// - auth.json is never opened, created or listed here.
// Values printed are numbers the spec states; no other value of the file is ever echoed.
import fs from "node:fs";
import nodePath from "node:path";
import { parsePiModelsJson } from "./pi-readiness.js";
import { normalizePiModelOverrides, type PiModelOverrides } from "./pi-runner-protocol.js";

export const PI_MODELS_JSON_MAX_BYTES = 1024 * 1024;

/** The subset of node:fs this module uses, injectable so a failure mid-write can be tested without a broken disk. */
export interface PiModelOverridesFs {
  lstat(p: string): fs.Stats;
  readlink(p: string): string;
  readFile(p: string): string;
  /** Create `p` exclusively (fails if it exists) with mode 0600, write `data`, fsync, close. */
  createExclusive(p: string, data: string): void;
  rename(from: string, to: string): void;
  unlink(p: string): void;
}

export const realPiModelOverridesFs: PiModelOverridesFs = {
  lstat: (p) => fs.lstatSync(p),
  readlink: (p) => fs.readlinkSync(p),
  readFile: (p) => fs.readFileSync(p, "utf8"),
  createExclusive: (p, data) => {
    const fd = fs.openSync(p, "wx", 0o600);
    try {
      fs.fchmodSync(fd, 0o600); // the creation mode is masked by the umask; the file is 0600 whatever it is
      fs.writeFileSync(fd, data);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
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

export function applyPiModelOverrides(opts: {
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
  try {
    io.createExclusive(tmp, `${JSON.stringify(doc, null, 2)}\n`);
    io.rename(tmp, file);
  } catch (err) {
    try { io.unlink(tmp); } catch { /* the temp may not exist */ }
    return refuse(`could not write ${file}: ${(err as NodeJS.ErrnoException).code ?? "error"}; the previous file ${existed ? "is unchanged" : "was not created"}`);
  }
  let after: fs.Stats;
  try { after = io.lstat(file); } catch { return refuse(`wrote ${file} but cannot read it back`); }
  if (after.isSymbolicLink() || !after.isFile()) return refuse(`${file} is not a regular file after the write`);
  if ((after.mode & 0o777) !== 0o600) return refuse(`${file} has mode ${(after.mode & 0o777).toString(8)} after the write, not 600`);
  return { ok: true, wrote: true, changes };
}
