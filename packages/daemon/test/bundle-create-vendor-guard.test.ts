// `rig bundle create` copies files out of folders the author pointed it at: whole persona folders
// (vendorDirectory), docs and startup files (collectRigFile), and the author bundle.yaml's skill, plugin,
// context-pack, agent-image and workflow-spec paths. Before this, every one of those read with a plain
// readFileSync: a symlink inside a persona folder pointing at an outside file had that file's bytes written
// into the bundle, and a FIFO was read unguarded (with no writer a synchronous read blocks the whole daemon).
// They now go through vendored-file-guard.ts -> the shared checkGuardedFile reader (one O_NOFOLLOW|O_NONBLOCK
// descriptor, regular file, one link, per-file cap), with the real path held inside the folder and a per-folder
// total cap.
//
// TRUST BOUNDARY: the daemon API caller is trusted. These rows pin accident/swap protection, not a defence
// against a hostile caller.
//
// FIFO rows: a writer stays attached (looping) and is killed in `finally`, so a regression that reads the FIFO
// FAILS (the request returns 201) instead of hanging the worker. The one NO-writer row runs the real route in a
// CHILD process with a timeout, so a regression that blocks forever fails the test instead of hanging vitest.

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

const MARKER = "VENDOR-GUARD-OUTSIDE-MARKER";
// Literals on purpose: the route rows must compile and run against the base too. vendored-file-guard.test.ts pins
// that these equal the exported constants.
const VENDORED_FILE_MAX_BYTES = 1024 * 1024;
const VENDORED_TREE_MAX_BYTES = 8 * 1024 * 1024;
const OVER = VENDORED_FILE_MAX_BYTES + 1;
const AGENT_YAML = ["name: impl-agent", 'version: "1.0.0"', "resources:", "  skills: []", "profiles:", "  default:", "    uses:", "      skills: []"].join("\n");
const RIG_YAML = (extra: string[] = []) => [
  'version: "0.2"', "name: vendor-guard-rig", ...extra, "pods:",
  "  - id: dev", "    label: dev", "    members:", "      - id: impl", '        agent_ref: "local:agents/impl"',
  "        profile: default", "        runtime: claude-code", "        cwd: .", "    edges: []", "edges: []",
].join("\n");

describe("bundle create: files copied out of author folders go through the vendored-file guard", () => {
  let db: Database.Database;
  let app: ReturnType<typeof createTestApp>["app"];
  let tmpDir: string;
  let persona: string;
  let outside: string;
  const writers: Array<ReturnType<typeof spawn>> = [];

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    // realpath'd: a macOS tmpdir is a symlink and agent_refs resolve against the real location.
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bundle-vendor-guard-")));
    outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bundle-vendor-outside-")));
    app = createTestApp(db).app;
    persona = path.join(tmpDir, "agents", "impl");
    fs.mkdirSync(path.join(persona, "guidance"), { recursive: true });
    fs.writeFileSync(path.join(persona, "agent.yaml"), AGENT_YAML);
    fs.writeFileSync(path.join(persona, "guidance", "role.md"), "# role\nbe useful\n");
    fs.writeFileSync(path.join(tmpDir, "rig.yaml"), RIG_YAML());
  });

  afterEach(() => {
    for (const w of writers.splice(0)) w.kill("SIGKILL");
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  const output = () => path.join(tmpDir, "vg.rigbundle");
  const create = () => app.request("/api/bundles/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ specPath: path.join(tmpDir, "rig.yaml"), bundleName: "vg", bundleVersion: "0.1.0", outputPath: output() }),
  });
  const noArtifact = () => expect(fs.existsSync(output())).toBe(false);
  const refused = async (pattern: RegExp) => {
    const res = await create();
    const body = await res.json() as { error?: string };
    expect(res.status, JSON.stringify(body)).toBe(400);
    expect(body.error).toMatch(pattern);
    noArtifact();
  };
  const extract = async (): Promise<string> => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-vendor-unpack-"));
    const tar = await import("tar");
    await tar.extract({ file: output(), cwd: dir });
    return dir;
  };
  const fifoWithWriter = (fifo: string) => {
    execFileSync("mkfifo", [fifo]);
    const w = spawn("sh", ["-c", 'while :; do printf "%s" "$1" > "$2"; done', "sh", `fifo content ${MARKER}\n`, fifo], { stdio: "ignore" });
    writers.push(w);
  };

  // ---- positive controls: a normal persona folder still vendors, byte for byte ----

  it("CONTROL: a normal persona folder (nested dirs, binary bytes, an in-folder symlink, an executable) vendors byte-identically", async () => {
    const binary = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    fs.writeFileSync(path.join(persona, "guidance", "blob.bin"), binary);
    fs.writeFileSync(path.join(persona, "run.sh"), "#!/bin/sh\necho ok\n", { mode: 0o755 });
    fs.symlinkSync("guidance/role.md", path.join(persona, "alias.md"));
    const res = await create();
    expect(res.status, await res.clone().text()).toBe(201);
    const dir = await extract();
    try {
      const vendored = path.join(dir, "agents", "impl-agent");
      expect(fs.readFileSync(path.join(vendored, "agent.yaml"), "utf-8")).toBe(AGENT_YAML);
      expect(fs.readFileSync(path.join(vendored, "guidance", "role.md"), "utf-8")).toBe("# role\nbe useful\n");
      expect(fs.readFileSync(path.join(vendored, "guidance", "blob.bin")).equals(binary)).toBe(true);
      // The in-folder link is bundled as the regular file it points to.
      expect(fs.lstatSync(path.join(vendored, "alias.md")).isFile()).toBe(true);
      expect(fs.readFileSync(path.join(vendored, "alias.md"), "utf-8")).toBe("# role\nbe useful\n");
      expect(fs.statSync(path.join(vendored, "run.sh")).mode & 0o111).not.toBe(0);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it("CONTROL: a dangling symlink under a declared skill is still a recovery warning, not a refusal", async () => {
    fs.writeFileSync(path.join(persona, "agent.yaml"), [
      "name: impl-agent", 'version: "1.0.0"', "resources:", "  skills:", "    - id: greet", "      path: skills/greet",
      "profiles:", "  default:", "    uses:", "      skills: [greet]",
    ].join("\n"));
    fs.mkdirSync(path.join(persona, "skills", "greet"), { recursive: true });
    fs.symlinkSync("absent-target", path.join(persona, "skills", "greet", "SKILL.md"));
    const res = await create();
    const body = await res.json() as { warning?: string };
    expect(res.status, JSON.stringify(body)).toBe(201);
    expect(body.warning).toMatch(/unresolved declared skill "greet"/);
  });

  // ---- the reported defect: a symlink in a persona folder leaks an outside file into the bundle ----

  it("a symlink inside a persona folder to a file OUTSIDE it is refused and its bytes are not bundled", async () => {
    fs.writeFileSync(path.join(outside, "secret.txt"), `${MARKER}\n`);
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(persona, "leak.txt"));
    await refused(/bundled file "agents\/impl-agent\/leak\.txt" resolves to .*secret\.txt, outside its folder .*through a symlink/);
  });

  it("a RELATIVE symlink that climbs out of the persona folder is refused", async () => {
    fs.writeFileSync(path.join(tmpDir, "rig-secret.txt"), `${MARKER}\n`);
    fs.symlinkSync("../../rig-secret.txt", path.join(persona, "up.txt"));
    await refused(/outside its folder/);
  });

  it("a symlink to a DIRECTORY outside the persona folder is refused", async () => {
    fs.writeFileSync(path.join(outside, "a.txt"), MARKER);
    fs.symlinkSync(outside, path.join(persona, "linkdir"));
    await refused(/outside its folder/);
  });

  it("a symlink to a directory INSIDE the persona folder is refused as not a regular file (it was never walked)", async () => {
    fs.symlinkSync("guidance", path.join(persona, "linkdir"));
    await refused(/is not a regular file/);
  });

  it("a symlink to an outside file is refused for an IMPORTED persona folder too", async () => {
    fs.mkdirSync(path.join(tmpDir, "agents", "shared"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "agents", "shared", "agent.yaml"), ["name: shared-agent", 'version: "1.0.0"', "resources:", "  skills: []", "profiles:", "  default:", "    uses:", "      skills: []"].join("\n"));
    fs.writeFileSync(path.join(persona, "agent.yaml"), [
      "name: impl-agent", 'version: "1.0.0"', "imports:", "  - ref: local:../shared", "resources:", "  skills: []", "profiles:", "  default:", "    uses:", "      skills: []",
    ].join("\n"));
    fs.writeFileSync(path.join(outside, "secret.txt"), MARKER);
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(tmpDir, "agents", "shared", "leak.txt"));
    await refused(/agents\/shared-agent\/leak\.txt.*outside its folder/);
  });

  // ---- FIFOs and other non-regular files ----

  it("a FIFO in the persona folder is refused as not a regular file (writer attached)", async () => {
    fifoWithWriter(path.join(persona, "pipe"));
    await refused(/bundled file "agents\/impl-agent\/pipe" .* is not a regular file/);
  }, 10000);

  it("a symlink INSIDE the folder to a FIFO is refused too (writer attached)", async () => {
    fifoWithWriter(path.join(persona, "pipe"));
    fs.symlinkSync("pipe", path.join(persona, "viapipe"));
    await refused(/is not a regular file/);
  }, 10000);

  it("NO WRITER: a FIFO in the persona folder is refused promptly; the daemon route does not block (child process, 25 s timeout)", () => {
    execFileSync("mkfifo", [path.join(persona, "pipe")]);
    const child = path.join(import.meta.dirname, "helpers", "bundle-create-child.ts");
    const r = spawnSync(process.execPath, ["--import", "tsx", child, tmpDir], { encoding: "utf-8", timeout: 25000, killSignal: "SIGKILL", cwd: path.join(import.meta.dirname, "..") });
    // ETIMEDOUT here is the regression: the synchronous read of a writer-less FIFO blocked.
    expect(r.error, `child did not finish: ${r.error?.message} ${r.stderr}`).toBeUndefined();
    expect(r.status, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout.trim().split("\n").pop()!) as { status: number; body: string };
    expect(out.status, out.body).toBe(400);
    expect(out.body).toMatch(/is not a regular file/);
  }, 40000);

  // ---- size caps ----

  it("a file over the per-file cap is refused, naming the limit", async () => {
    fs.writeFileSync(path.join(persona, "big.bin"), Buffer.alloc(OVER, 0x61));
    await refused(new RegExp(`is ${OVER} bytes, over the ${VENDORED_FILE_MAX_BYTES}-byte limit`));
  });

  it("CONTROL: a file exactly at the per-file cap is bundled", async () => {
    fs.writeFileSync(path.join(persona, "edge.bin"), Buffer.alloc(VENDORED_FILE_MAX_BYTES, 0x61));
    const res = await create();
    expect(res.status, await res.clone().text()).toBe(201);
  });

  it("a folder whose files together pass the total cap is refused though each file is under the per-file cap", async () => {
    const each = VENDORED_FILE_MAX_BYTES - 1024;
    const n = Math.floor(VENDORED_TREE_MAX_BYTES / each) + 1;
    expect(n * each).toBeGreaterThan(VENDORED_TREE_MAX_BYTES);
    for (let i = 0; i < n; i++) fs.writeFileSync(path.join(persona, `part-${i}.bin`), Buffer.alloc(each, 0x61));
    await refused(/holds more than 8388608 bytes of files/);
  });

  it("a hard-linked file in the persona folder is refused", async () => {
    fs.writeFileSync(path.join(outside, "x.txt"), MARKER);
    fs.linkSync(path.join(outside, "x.txt"), path.join(persona, "hl.txt"));
    await refused(/has 2 hard links/);
  });

  // ---- docs and startup files (collectRigFile) ----

  it("a docs file that is a FIFO is refused, not read (writer attached)", async () => {
    fifoWithWriter(path.join(tmpDir, "doc.md"));
    fs.writeFileSync(path.join(tmpDir, "rig.yaml"), RIG_YAML(["docs:", "  - path: doc.md"]));
    await refused(/bundled file "doc\.md" .* is not a regular file/);
  }, 10000);

  it("a startup file over the per-file cap is refused", async () => {
    fs.writeFileSync(path.join(tmpDir, "boot.md"), Buffer.alloc(OVER, 0x61));
    fs.writeFileSync(path.join(tmpDir, "rig.yaml"), RIG_YAML(["startup:", "  files:", "    - path: boot.md", "      deliveryHint: auto"]));
    await refused(/boot\.md.* over the .*-byte limit/);
  });

  it("CONTROL: a normal docs file is bundled", async () => {
    fs.writeFileSync(path.join(tmpDir, "doc.md"), "# doc\n");
    fs.writeFileSync(path.join(tmpDir, "rig.yaml"), RIG_YAML(["docs:", "  - path: doc.md"]));
    const res = await create();
    expect(res.status, await res.clone().text()).toBe(201);
  });

  // ---- author bundle.yaml trees (consumeAuthorBundleYaml) ----

  const authorBundle = (lines: string[]) => fs.writeFileSync(path.join(tmpDir, "bundle.yaml"), lines.join("\n"));

  it("a declared skill directory holding a symlink to a FIFO is refused, not read (writer attached)", async () => {
    fs.mkdirSync(path.join(tmpDir, "skills", "s"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "skills", "s", "SKILL.md"), "# s");
    // Sorted so the LINK is met before the pipe itself (a direct pipe entry is refused on sight, see bundle-create-author-tree).
    fifoWithWriter(path.join(tmpDir, "skills", "s", "zpipe"));
    fs.symlinkSync("zpipe", path.join(tmpDir, "skills", "s", "apipe"));
    authorBundle(["skills:", "  - skills/s/SKILL.md"]);
    await refused(/skills\/s\/apipe.* is not a regular file/);
  }, 10000);

  it("a declared workflow spec that is a FIFO is refused (writer attached)", async () => {
    fs.mkdirSync(path.join(tmpDir, "workflows"), { recursive: true });
    fifoWithWriter(path.join(tmpDir, "workflows", "flow.yaml"));
    authorBundle(["workflow_specs:", "  - workflows/flow.yaml"]);
    await refused(/workflows\/flow\.yaml.* is not a regular file/);
  }, 10000);

  it("an oversize file inside a declared plugin directory is refused", async () => {
    fs.mkdirSync(path.join(tmpDir, "plugins", "p"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "plugins", "p", "plugin.json"), "{}");
    fs.writeFileSync(path.join(tmpDir, "plugins", "p", "big.bin"), Buffer.alloc(OVER, 0x61));
    authorBundle(["plugins:", "  - id: p", "    source:", "      kind: local", "      path: plugins/p"]);
    await refused(/plugins\/p\/big\.bin.* over the .*-byte limit/);
  });

  it("a declared plugin directory over the total cap is refused", async () => {
    fs.mkdirSync(path.join(tmpDir, "plugins", "p"), { recursive: true });
    const each = VENDORED_FILE_MAX_BYTES - 1024;
    const n = Math.floor(VENDORED_TREE_MAX_BYTES / each) + 1;
    for (let i = 0; i < n; i++) fs.writeFileSync(path.join(tmpDir, "plugins", "p", `part-${i}.bin`), Buffer.alloc(each, 0x61));
    authorBundle(["plugins:", "  - id: p", "    source:", "      kind: local", "      path: plugins/p"]);
    await refused(/holds more than 8388608 bytes of files/);
  });

  it("CONTROL: a normal declared skill directory and workflow spec are bundled byte-identically", async () => {
    fs.mkdirSync(path.join(tmpDir, "skills", "s"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "skills", "s", "SKILL.md"), "# s\n");
    fs.writeFileSync(path.join(tmpDir, "skills", "s", "helper.txt"), "help\n");
    fs.mkdirSync(path.join(tmpDir, "workflows"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "workflows", "flow.yaml"), "workflow:\n  id: f\n  version: '1'\n  roles: { producer: {} }\n  steps:\n    - id: produce\n      actor_role: producer\n");
    authorBundle(["skills:", "  - skills/s/SKILL.md", "workflow_specs:", "  - workflows/flow.yaml"]);
    const res = await create();
    expect(res.status, await res.clone().text()).toBe(201);
    const dir = await extract();
    try {
      expect(fs.readFileSync(path.join(dir, "skills", "s", "helper.txt"), "utf-8")).toBe("help\n");
      expect(fs.readFileSync(path.join(dir, "skills", "s", "SKILL.md"), "utf-8")).toBe("# s\n");
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  // ---- the route-level 400 is specific; the assembler seam is wired in production ----

  it("CONTROL: a non-guard assembler failure (unresolvable agent_ref) is still a 500, not a 400", async () => {
    fs.rmSync(path.join(tmpDir, "agents"), { recursive: true });
    const res = await create();
    expect(res.status, await res.clone().text()).toBe(500);
  });
});
