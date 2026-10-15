// Author bundle.yaml trees (skills, plugins, context packs, agent images, workflow specs) and bundle.yaml itself.
//
// Follow-up to bundle-create-vendor-guard.test.ts. The guarded pass read the tree, then cpSync read it AGAIN:
// a declared directory swapped for a link to an outside directory, a file swapped for a 3 MiB file, or a file
// swapped for a link to an outside FIFO all got past the guard (the last one hangs the daemon). The tree is now
// written from the bytes the guarded pass read. Also here: a symlink cycle inside a declared tree (it hung create),
// a FIFO named bundle.yaml (it hung create), and a legacy package whose copied symlink leads to a FIFO (the
// integrity walk followed it).
//
// TRUST BOUNDARY: the daemon API caller is trusted; these rows pin accident/swap protection.
//
// Swap rows use the afterGuardedPass seam of consumeAuthorBundleYaml (the way the culture guard's rows use
// beforeOpen/afterRead). Rows that would HANG on a regression run in a CHILD process with a timeout, so a
// regression fails the test instead of hanging the worker; FIFO rows with a writer attached kill it in `finally`.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { createTestApp } from "./helpers/test-app.js";
import { consumeAuthorBundleYaml } from "../src/routes/bundles.js";

const MARKER = "AUTHOR-TREE-OUTSIDE-MARKER";
const AGENT_YAML = ["name: impl-agent", 'version: "1.0.0"', "resources:", "  skills: []", "profiles:", "  default:", "    uses:", "      skills: []"].join("\n");
const RIG_YAML = [
  'version: "0.2"', "name: author-tree-rig", "pods:",
  "  - id: dev", "    label: dev", "    members:", "      - id: impl", '        agent_ref: "local:agents/impl"',
  "        profile: default", "        runtime: claude-code", "        cwd: .", "    edges: []", "edges: []",
].join("\n");
const LEGACY_SPEC = ["schema_version: 1", "name: test-rig", 'version: "1.0"', "nodes:", "  - id: dev", "    runtime: claude-code", "    package_refs:", "      - ./test-pkg", "edges: []"].join("\n");
const LEGACY_PKG = [
  "schema_version: 1", "name: test-pkg", 'version: "1.0.0"', "summary: Test", "compatibility:", "  runtimes:", "    - claude-code",
  "exports:", "  skills:", "    - source: skills/h", "      name: h", "      supported_scopes: [project_shared]", "      default_scope: project_shared",
].join("\n");

describe("bundle create: author bundle.yaml trees are written from the guarded bytes", () => {
  let db: Database.Database;
  let app: ReturnType<typeof createTestApp>["app"];
  let root: string;
  let outside: string;
  let staging: string;
  const writers: Array<ReturnType<typeof spawn>> = [];

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "author-tree-")));
    outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "author-tree-outside-")));
    staging = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "author-tree-staging-")));
    app = createTestApp(db).app;
    fs.mkdirSync(path.join(root, "agents", "impl"), { recursive: true });
    fs.writeFileSync(path.join(root, "agents", "impl", "agent.yaml"), AGENT_YAML);
    fs.writeFileSync(path.join(root, "rig.yaml"), RIG_YAML);
  });
  afterEach(() => {
    for (const w of writers.splice(0)) w.kill("SIGKILL");
    db.close();
    for (const d of [root, outside, staging]) fs.rmSync(d, { recursive: true, force: true });
  });

  const declareSkill = () => {
    fs.mkdirSync(path.join(root, "skills", "s"), { recursive: true });
    fs.writeFileSync(path.join(root, "skills", "s", "SKILL.md"), "# s\n");
    fs.writeFileSync(path.join(root, "skills", "s", "helper.txt"), "help\n");
    fs.writeFileSync(path.join(root, "bundle.yaml"), ["skills:", "  - skills/s/SKILL.md"].join("\n"));
  };
  const staged = (...p: string[]) => path.join(staging, ...p);
  const fifoWithWriter = (fifo: string) => {
    execFileSync("mkfifo", [fifo]);
    writers.push(spawn("sh", ["-c", 'while :; do printf "%s" "$1" > "$2"; done', "sh", `fifo ${MARKER}\n`, fifo], { stdio: "ignore" }));
  };
  const create = (spec = "rig.yaml") => app.request("/api/bundles/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ specPath: path.join(root, spec), bundleName: "at", bundleVersion: "0.1.0", outputPath: path.join(root, "at.rigbundle") }),
  });
  const childCreate = (dir: string) => spawnSync(process.execPath, ["--import", "tsx", path.join(import.meta.dirname, "helpers", "bundle-create-child.ts"), dir],
    { encoding: "utf-8", timeout: 25000, killSignal: "SIGKILL", cwd: path.join(import.meta.dirname, "..") });
  const childOutcome = (r: ReturnType<typeof spawnSync>) => {
    // ETIMEDOUT is the regression: the route blocked.
    expect(r.error, `child did not finish: ${r.error?.message} ${r.stderr}`).toBeUndefined();
    expect(r.status, String(r.stderr)).toBe(0);
    return JSON.parse(String(r.stdout).trim().split("\n").pop()!) as { status: number; body: string };
  };

  // ---- the swap window between the guarded pass and the write ----

  it("CONTROL: a declared skill tree is written byte-identically, with the executable bit kept and no temp residue", () => {
    declareSkill();
    fs.writeFileSync(path.join(root, "skills", "s", "run.sh"), "#!/bin/sh\necho hi\n", { mode: 0o755 });
    fs.mkdirSync(path.join(root, "skills", "s", "nested"), { recursive: true });
    fs.writeFileSync(path.join(root, "skills", "s", "nested", "deep.bin"), Buffer.from([0, 255, 128, 10]));
    consumeAuthorBundleYaml(root, staging);
    expect(fs.readFileSync(staged("skills", "s", "helper.txt"), "utf-8")).toBe("help\n");
    expect(fs.readFileSync(staged("skills", "s", "nested", "deep.bin")).equals(Buffer.from([0, 255, 128, 10]))).toBe(true);
    expect(fs.statSync(staged("skills", "s", "run.sh")).mode & 0o111).not.toBe(0);
    expect(fs.statSync(staged("skills", "s", "helper.txt")).mode & 0o111).toBe(0);
  });

  it("a declared directory swapped for a symlink to an OUTSIDE directory after the guarded pass does not bundle the outside bytes", () => {
    declareSkill();
    fs.writeFileSync(path.join(outside, "secret.txt"), MARKER);
    consumeAuthorBundleYaml(root, staging, {
      afterGuardedPass: (declared) => {
        if (declared !== "skills/s") return;
        fs.renameSync(path.join(root, "skills", "s"), path.join(root, "skills", "s.orig"));
        fs.symlinkSync(outside, path.join(root, "skills", "s"));
      },
    });
    expect(fs.existsSync(staged("skills", "s", "secret.txt"))).toBe(false);
    expect(fs.readFileSync(staged("skills", "s", "helper.txt"), "utf-8")).toBe("help\n");
  });

  it("a file swapped for a 3 MiB file after the guarded pass is not copied (the cap is not bypassed)", () => {
    declareSkill();
    consumeAuthorBundleYaml(root, staging, {
      afterGuardedPass: (declared) => {
        if (declared === "skills/s") fs.writeFileSync(path.join(root, "skills", "s", "helper.txt"), Buffer.alloc(3 * 1024 * 1024, 0x61));
      },
    });
    expect(fs.readFileSync(staged("skills", "s", "helper.txt"), "utf-8")).toBe("help\n");
  });

  it("a file swapped for a symlink to an outside FIFO after the guarded pass is not read (writer attached)", () => {
    declareSkill();
    const fifo = path.join(outside, "pipe");
    fifoWithWriter(fifo);
    consumeAuthorBundleYaml(root, staging, {
      afterGuardedPass: (declared) => {
        if (declared !== "skills/s") return;
        fs.unlinkSync(path.join(root, "skills", "s", "helper.txt"));
        fs.symlinkSync(fifo, path.join(root, "skills", "s", "helper.txt"));
      },
    });
    expect(fs.readFileSync(staged("skills", "s", "helper.txt"), "utf-8")).toBe("help\n");
  }, 10000);

  it("NO WRITER: the same swap to an outside FIFO does not block the copy (child process, 25 s timeout)", () => {
    declareSkill();
    const fifo = path.join(outside, "pipe");
    execFileSync("mkfifo", [fifo]);
    const r = spawnSync(process.execPath, ["--import", "tsx", path.join(import.meta.dirname, "helpers", "author-bundle-swap-child.ts"), root, staging, fifo],
      { encoding: "utf-8", timeout: 25000, killSignal: "SIGKILL", cwd: path.join(import.meta.dirname, "..") });
    expect(r.error, `child did not finish: ${r.error?.message} ${r.stderr}`).toBeUndefined();
    expect(r.status, r.stderr).toBe(0);
    expect((JSON.parse(r.stdout.trim().split("\n").pop()!) as { helper: string }).helper).toBe("help\n");
  }, 40000);

  // ---- symlinks inside the source root ----

  it("an in-root symlink to a file inside a declared skill tree is bundled as a regular file (it failed create with a 500 before)", () => {
    declareSkill();
    fs.symlinkSync("helper.txt", path.join(root, "skills", "s", "alias.txt"));
    consumeAuthorBundleYaml(root, staging);
    expect(fs.lstatSync(staged("skills", "s", "alias.txt")).isFile()).toBe(true);
    expect(fs.readFileSync(staged("skills", "s", "alias.txt"), "utf-8")).toBe("help\n");
  });

  it("a symlinked directory that stays inside the source root is followed and bundled as real files", () => {
    declareSkill();
    fs.mkdirSync(path.join(root, "common"), { recursive: true });
    fs.writeFileSync(path.join(root, "common", "shared.md"), "shared\n");
    fs.symlinkSync("../../common", path.join(root, "skills", "s", "common"));
    consumeAuthorBundleYaml(root, staging);
    expect(fs.lstatSync(staged("skills", "s", "common", "shared.md")).isFile()).toBe(true);
    expect(fs.readFileSync(staged("skills", "s", "common", "shared.md"), "utf-8")).toBe("shared\n");
  });

  it("a symlink in a declared tree to an OUTSIDE file is still refused", () => {
    declareSkill();
    fs.writeFileSync(path.join(outside, "secret.txt"), MARKER);
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(root, "skills", "s", "leak.txt"));
    expect(() => consumeAuthorBundleYaml(root, staging)).toThrow(/escaping bundle source root/);
    expect(fs.existsSync(staged("skills", "s", "leak.txt"))).toBe(false);
  });

  it("a FIFO entry directly inside a declared tree is refused as not a regular file (never opened)", () => {
    declareSkill();
    execFileSync("mkfifo", [path.join(root, "skills", "s", "pipe")]);
    expect(() => consumeAuthorBundleYaml(root, staging)).toThrow(/skills\/s\/pipe" is not a regular file/);
  });

  // ---- symlink cycles (these hung create) ----

  it.each([["a link to the directory itself", "."], ["a link to the parent directory", ".."]])("%s inside a declared skill tree is refused, not walked forever (child process, 25 s timeout)", (_name, target) => {
    declareSkill();
    fs.symlinkSync(target, path.join(root, "skills", "s", "loop"));
    const out = childOutcome(childCreate(root));
    expect(out.status, out.body).toBe(400);
    expect(out.body).toMatch(/symlink cycle at 'skills\/s\/loop/);
  }, 40000);

  it("a cycle inside a declared PLUGIN tree is refused too (child process)", () => {
    fs.mkdirSync(path.join(root, "plugins", "p"), { recursive: true });
    fs.writeFileSync(path.join(root, "plugins", "p", "plugin.json"), "{}");
    fs.symlinkSync(".", path.join(root, "plugins", "p", "self"));
    fs.writeFileSync(path.join(root, "bundle.yaml"), ["plugins:", "  - id: p", "    source:", "      kind: local", "      path: plugins/p"].join("\n"));
    const out = childOutcome(childCreate(root));
    expect(out.status, out.body).toBe(400);
    expect(out.body).toMatch(/symlink cycle/);
  }, 40000);

  it("CONTROL: two links to the same directory (a diamond, not a cycle) are not refused", () => {
    declareSkill();
    fs.mkdirSync(path.join(root, "common"), { recursive: true });
    fs.writeFileSync(path.join(root, "common", "shared.md"), "shared\n");
    fs.symlinkSync("../../common", path.join(root, "skills", "s", "one"));
    fs.symlinkSync("../../common", path.join(root, "skills", "s", "two"));
    consumeAuthorBundleYaml(root, staging);
    expect(fs.readFileSync(staged("skills", "s", "one", "shared.md"), "utf-8")).toBe("shared\n");
    expect(fs.readFileSync(staged("skills", "s", "two", "shared.md"), "utf-8")).toBe("shared\n");
  });

  it("a symlink fan-out (every level links twice to the next, no cycle) is refused after 20,000 entries, not walked", () => {
    declareSkill();
    const depth = 16;
    for (let i = 0; i <= depth; i++) fs.mkdirSync(path.join(root, `fan${i}`));
    for (let i = 0; i < depth; i++) for (const n of ["a", "b"]) fs.symlinkSync(`../fan${i + 1}`, path.join(root, `fan${i}`, n));
    fs.symlinkSync("../../fan0", path.join(root, "skills", "s", "fan"));
    expect(() => consumeAuthorBundleYaml(root, staging)).toThrow(/lists more than 20000 entries/);
  }, 20000);

  // ---- bundle.yaml itself ----

  it("a FIFO named bundle.yaml is refused, not read (writer attached)", async () => {
    fifoWithWriter(path.join(root, "bundle.yaml"));
    const res = await create();
    const body = await res.json() as { error?: string };
    expect(res.status, JSON.stringify(body)).toBe(400);
    expect(body.error).toMatch(/bundled file "bundle\.yaml" .* is not a regular file/);
  }, 10000);

  it("NO WRITER: a FIFO named bundle.yaml is refused promptly (child process, 25 s timeout)", () => {
    execFileSync("mkfifo", [path.join(root, "bundle.yaml")]);
    const out = childOutcome(childCreate(root));
    expect(out.status, out.body).toBe(400);
    expect(out.body).toMatch(/is not a regular file/);
  }, 40000);

  it("a bundle.yaml that is a symlink OUT of the source root is refused", async () => {
    fs.writeFileSync(path.join(outside, "bundle.yaml"), "skills: []\n");
    fs.symlinkSync(path.join(outside, "bundle.yaml"), path.join(root, "bundle.yaml"));
    const res = await create();
    const body = await res.json() as { error?: string };
    expect(res.status, JSON.stringify(body)).toBe(400);
    expect(body.error).toMatch(/outside its folder/);
  });

  // ---- legacy (non-pod) packages ----

  const legacyFixture = () => {
    fs.rmSync(path.join(root, "agents"), { recursive: true });
    fs.writeFileSync(path.join(root, "rig.yaml"), LEGACY_SPEC);
    fs.mkdirSync(path.join(root, "test-pkg", "skills", "h"), { recursive: true });
    fs.writeFileSync(path.join(root, "test-pkg", "package.yaml"), LEGACY_PKG);
    fs.writeFileSync(path.join(root, "test-pkg", "skills", "h", "SKILL.md"), "# H");
  };

  it("CONTROL: a plain legacy package still bundles (201)", async () => {
    legacyFixture();
    const res = await create();
    expect(res.status, await res.clone().text()).toBe(201);
  });

  it("a legacy package holding a symlink to an outside FIFO is refused, not followed (writer attached)", async () => {
    legacyFixture();
    const fifo = path.join(outside, "pipe");
    fifoWithWriter(fifo);
    fs.symlinkSync(fifo, path.join(root, "test-pkg", "skills", "h", "viapipe"));
    const res = await create();
    const body = await res.json() as { error?: string };
    expect(res.status, JSON.stringify(body)).toBe(400);
    expect(body.error).toMatch(/is not a regular file/);
  }, 10000);

  it("NO WRITER: a legacy package holding a symlink to an outside FIFO is refused promptly (child process, 25 s timeout)", () => {
    legacyFixture();
    const fifo = path.join(outside, "pipe");
    execFileSync("mkfifo", [fifo]);
    fs.symlinkSync(fifo, path.join(root, "test-pkg", "skills", "h", "viapipe"));
    const out = childOutcome(childCreate(root));
    expect(out.status, out.body).toBe(400);
    expect(out.body).toMatch(/is not a regular file/);
  }, 40000);
});
