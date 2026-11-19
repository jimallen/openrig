// workspaces-o9o.182 (CoS 11-19 00:48Z): `rig auth`'s seat registry names the Codex auth profile each seat uses, so it chooses a
// credential. It is read and rewritten under the credential rule for a secret OpenRig owns: never read through a link, never written
// through a link at its temp name, and kept 0600.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveCodexHome, authSeatSet, authSeatsList } from "../src/lib/codex-auth.js";

const NOW = () => "2026-06-26T00:00:00Z";
let home: string;
let paths: ReturnType<typeof resolveCodexHome>;
beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codexauth-guarded-")));
  paths = resolveCodexHome({ CODEX_HOME: home });
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

const ROWS = "seat\trig\truntime\tcwd\tauth_profile\tupdated_ts\nplanted@rig\trig\tcodex\t/x\tplanted\t2026-06-26T00:00:00Z\n";

describe("the Codex seat registry is OpenRig's own secret file (workspaces-o9o.182)", () => {
  it("a symlinked registry is not read: it lists no seats", () => {
    const elsewhere = path.join(home, "planted.tsv");
    fs.writeFileSync(elsewhere, ROWS, { mode: 0o600 });
    fs.symlinkSync(elsewhere, paths.registryPath);
    expect(authSeatsList(paths)).toEqual([]);
  });

  it("a set never writes through a link planted at the temp name: the planted target is untouched and the row lands", () => {
    const victim = path.join(home, "victim.txt");
    fs.writeFileSync(victim, "keep me\n", { mode: 0o600 });
    fs.symlinkSync(victim, `${paths.registryPath}.${process.pid}.tmp`);
    expect(authSeatSet(paths, { seat: "dev1@rig", rig: "rig", runtime: "codex", cwd: "/x", authProfile: "work" }, NOW)).toMatchObject({ ok: true });
    expect(fs.readFileSync(victim, "utf-8")).toBe("keep me\n");
    expect(authSeatsList(paths).map((r) => [r.seat, r.authProfile])).toEqual([["dev1@rig", "work"]]);
    expect(fs.statSync(paths.registryPath).mode & 0o777).toBe(0o600);
  });

  it("a registry of ours others can read is narrowed to 0600 and still read", () => {
    fs.writeFileSync(paths.registryPath, ROWS);
    fs.chmodSync(paths.registryPath, 0o644);
    expect(authSeatsList(paths).map((r) => r.seat)).toEqual(["planted@rig"]);
    expect(fs.statSync(paths.registryPath).mode & 0o777).toBe(0o600);
  });
});
