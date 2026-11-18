// workspaces-o9o.151: Pi credential files under the credential rule.
// - linkPiOperatorLogin links a seat only to an operator file that passes the whole rule (ours, no group/other bits, capped); the
//   live census found them 0600 on sparky and stu (mbp unverified).
// - applyPiModelOverrides narrows the seat's own models.json (the runner rewrites it) to 0600, the o9o.78 precedent for a file
//   OpenRig owns: never a refusal for mode, so a working seat is not broken by the upgrade.
// - the runner reads a seat's auth.json/models.json for its credential notice under the rule, following a seat link only to the
//   operator's file (SEAT_CREDENTIAL_LINKS pi-auth, pi-models).
// Every fixture sets its own mode. The token-like values are fake and not credential-shaped.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { linkPiOperatorLogin, piSeatCredentialRefusal, piSeatMetadataReader } from "../src/adapters/pi-operator-login.js";
import { applyPiModelOverrides } from "../src/adapters/pi-model-overrides.js";

let dir: string;
let state: string;
let operator: string;
let agentDir: string;
beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(nodePath.join(os.tmpdir(), "pi-cred-")));
  state = nodePath.join(dir, "state");
  operator = nodePath.join(dir, "operator");
  agentDir = nodePath.join(state, "seat@t", "agent");
  fs.mkdirSync(operator);
  fs.mkdirSync(agentDir, { recursive: true });
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const AUTH = JSON.stringify({ "openai-codex": { type: "oauth", access: "dummy-access", refresh: "dummy-refresh", expires: 4102444800000 } });
const put = (p: string, text: string, mode: number) => { fs.writeFileSync(p, text); fs.chmodSync(p, mode); };
const link = (linkModels = false) =>
  linkPiOperatorLogin({ stateRoot: state, agentDir, sessionName: "seat@t", operatorDir: operator, linkModels });
const exists = (p: string) => { try { fs.lstatSync(p); return true; } catch { return false; } };

describe("linkPiOperatorLogin links only to an operator file that passes the rule (o9o.151)", () => {
  it("CONTROL: a 0600 operator auth.json is linked", () => {
    put(nodePath.join(operator, "auth.json"), AUTH, 0o600);
    expect(link()).toMatchObject({ ok: true });
    expect(fs.lstatSync(nodePath.join(agentDir, "auth.json")).isSymbolicLink()).toBe(true);
  });

  it("refuses an operator auth.json others can read, naming it and the fix, and links nothing", () => {
    const op = nodePath.join(operator, "auth.json");
    put(op, AUTH, 0o644);
    const r = link();
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain(op);
    expect(r.error).toContain("chmod 600");
    expect(r.error).not.toContain("dummy-access");
    expect(exists(nodePath.join(agentDir, "auth.json"))).toBe(false);
  });

  it("refuses an operator models.json the group can read when models are linked too, linking neither", () => {
    put(nodePath.join(operator, "auth.json"), AUTH, 0o600);
    put(nodePath.join(operator, "models.json"), "{}", 0o640);
    const r = link(true);
    expect(r.ok).toBe(false);
    expect(exists(nodePath.join(agentDir, "auth.json"))).toBe(false);
    expect(exists(nodePath.join(agentDir, "models.json"))).toBe(false);
  });
});

describe("applyPiModelOverrides narrows the seat's own models.json, never refuses it for mode (o9o.151)", () => {
  const LUNA = { "openai-codex": { "gpt-6-luna": { contextWindow: 820000 } } };
  const models = () => nodePath.join(agentDir, "models.json");

  it("narrows a 0644 models.json to 0600 even when no change is needed", () => {
    put(models(), JSON.stringify({ providers: { "openai-codex": { modelOverrides: { "gpt-6-luna": { contextWindow: 820000 } } } } }), 0o644);
    expect(applyPiModelOverrides({ stateRoot: state, agentDir, overrides: LUNA })).toMatchObject({ ok: true, wrote: false });
    expect(fs.statSync(models()).mode & 0o777).toBe(0o600);
  });

  it("CONTROL: a 0644 models.json that needs the change is rewritten at 0600", () => {
    put(models(), "{}", 0o644);
    expect(applyPiModelOverrides({ stateRoot: state, agentDir, overrides: LUNA })).toMatchObject({ ok: true, wrote: true });
    expect(fs.statSync(models()).mode & 0o777).toBe(0o600);
  });
});

describe("piSeatMetadataReader: the runner's credential-notice reads (o9o.151)", () => {
  const seatAuth = () => nodePath.join(agentDir, "auth.json");

  it("reads a seat's own 0600 auth.json", () => {
    put(seatAuth(), AUTH, 0o600);
    expect(piSeatMetadataReader(operator)(seatAuth())).toBe(AUTH);
  });

  it("follows the seat's link to the operator's auth.json (SEAT_CREDENTIAL_LINKS pi-auth)", () => {
    put(nodePath.join(operator, "auth.json"), AUTH, 0o600);
    fs.symlinkSync(nodePath.join(operator, "auth.json"), seatAuth());
    expect(piSeatMetadataReader(operator)(seatAuth())).toBe(AUTH);
  });

  it("refuses a seat link to anything else", () => {
    put(nodePath.join(dir, "elsewhere.json"), AUTH, 0o600);
    fs.symlinkSync(nodePath.join(dir, "elsewhere.json"), seatAuth());
    expect(() => piSeatMetadataReader(operator)(seatAuth())).toThrow(/somewhere other than/);
  });

  it("refuses the link when no operator login is declared", () => {
    put(nodePath.join(operator, "auth.json"), AUTH, 0o600);
    fs.symlinkSync(nodePath.join(operator, "auth.json"), seatAuth());
    expect(() => piSeatMetadataReader(undefined)(seatAuth())).toThrow(/symbolic link/);
  });

  it("narrows the seat's own auth.json others can read to 0600 and reads it (OpenRig's file: narrowed, never refused for mode)", () => {
    put(seatAuth(), AUTH, 0o644);
    expect(piSeatMetadataReader(operator)(seatAuth())).toBe(AUTH);
    expect(fs.statSync(seatAuth()).mode & 0o777).toBe(0o600);
  });

  it("refuses a seat auth.json that is not a plain file, and the runner refuses the launch on it (fail closed)", () => {
    fs.mkdirSync(seatAuth(), { mode: 0o700 });
    expect(() => piSeatMetadataReader(operator)(seatAuth())).toThrow(/not a regular file/);
    expect(piSeatCredentialRefusal(agentDir, operator)).toMatch(/^seat credential file: .*auth\.json.*not a regular file/);
  });

  it("CONTROL: the launch check passes a seat with no credential files (absence is the credential gate's call) and one linked to the operator", () => {
    expect(piSeatCredentialRefusal(agentDir, operator)).toBeNull();
    put(nodePath.join(operator, "auth.json"), AUTH, 0o600);
    fs.symlinkSync(nodePath.join(operator, "auth.json"), seatAuth());
    expect(piSeatCredentialRefusal(agentDir, operator)).toBeNull();
  });

  it("keeps ENOENT for a missing file, so the notice still says absent", () => {
    let code: unknown;
    try { piSeatMetadataReader(operator)(seatAuth()); } catch (err) { code = (err as NodeJS.ErrnoException).code; }
    expect(code).toBe("ENOENT");
  });

  it("CONTROL: settings.json is not a credential and is read as before", () => {
    put(nodePath.join(agentDir, "settings.json"), "{}", 0o644);
    expect(piSeatMetadataReader(operator)(nodePath.join(agentDir, "settings.json"))).toBe("{}");
  });
});
