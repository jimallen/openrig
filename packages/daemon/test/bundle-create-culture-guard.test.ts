// `rig bundle create` reads the spec's culture_file through the shared culture-file guard
// (culture-file-guard.ts), the same refusal delivery and restore apply. Before this, the pod assembler
// read it with a plain readFileSync: a FIFO there hung bundle creation, and an oversize or hard-linked
// file was bundled.
//
// TRUST BOUNDARY: the daemon API caller is trusted. These rows pin accident/swap protection, not a
// defence against a hostile caller.
//
// FIFO row: a writer stays attached (looping) and is killed in `finally`, so a regression that reads the
// FIFO FAILS (the request returns 201) instead of hanging the worker. Same pattern as rig-add-culture.test.ts.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync, spawn } from "node:child_process";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { createTestApp } from "./helpers/test-app.js";
import { PodBundleAssembler, type PodAssemblerFsOps } from "../src/domain/pod-bundle-assembler.js";
import { checkCultureFile } from "../src/domain/culture-file-guard.js";

const MARKER = "BUNDLE-CULTURE-MARKER";
const OVER = 256 * 1024 + 1;

describe("bundle create: the culture file is read through the culture-file guard", () => {
  let db: Database.Database;
  let app: ReturnType<typeof createTestApp>["app"];
  let tmpDir: string;

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-culture-guard-"));
    app = createTestApp(db).app;
    const agentsDir = path.join(tmpDir, "agents", "impl");
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(path.join(agentsDir, "agent.yaml"), [
      "name: impl-agent", 'version: "1.0.0"', "resources:", "  skills: []", "profiles:", "  default:", "    uses:", "      skills: []",
    ].join("\n"));
    fs.writeFileSync(path.join(tmpDir, "rig.yaml"), [
      'version: "0.2"', "name: culture-guard-rig", "culture_file: culture.md", "pods:",
      "  - id: dev", "    label: dev", "    members:", "      - id: impl", '        agent_ref: "local:agents/impl"',
      "        profile: default", "        runtime: claude-code", "        cwd: .", "    edges: []", "edges: []",
    ].join("\n"));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const create = () => app.request("/api/bundles/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ specPath: path.join(tmpDir, "rig.yaml"), bundleName: "cg", bundleVersion: "0.1.0", outputPath: path.join(tmpDir, "cg.rigbundle") }),
  });
  const noArtifact = () => expect(fs.existsSync(path.join(tmpDir, "cg.rigbundle"))).toBe(false);

  it("CONTROL: a regular single-link culture file is bundled (201, artifact written)", async () => {
    fs.writeFileSync(path.join(tmpDir, "culture.md"), `# culture\n${MARKER}\n`);
    const res = await create();
    expect(res.status, await res.clone().text()).toBe(201);
    expect(fs.existsSync(path.join(tmpDir, "cg.rigbundle"))).toBe(true);
  });

  it("a FIFO is refused as not a regular file and does not hang bundle creation", async () => {
    const fifo = path.join(tmpDir, "culture.md");
    execFileSync("mkfifo", [fifo]);
    const writer = spawn("sh", ["-c", 'while :; do printf "%s" "$1" > "$2"; done', "sh", `# fifo\n${MARKER}\n`, fifo], { stdio: "ignore" });
    try {
      const res = await create();
      const body = await res.json() as { error?: string };
      expect(res.status, JSON.stringify(body)).toBe(500);
      expect(body.error).toMatch(/culture file "culture\.md" .* is not a regular file/);
      noArtifact();
    } finally { writer.kill("SIGKILL"); }
  }, 10000);

  it("an oversize culture file is refused, naming the limit, and is not bundled", async () => {
    fs.writeFileSync(path.join(tmpDir, "culture.md"), Buffer.alloc(OVER, 0x61));
    const res = await create();
    const body = await res.json() as { error?: string };
    expect(res.status, JSON.stringify(body)).toBe(500);
    expect(body.error).toMatch(/is 262145 bytes, over the 262144-byte limit/);
    noArtifact();
  });

  it("a hard-linked culture file is refused and is not bundled", async () => {
    fs.writeFileSync(path.join(tmpDir, "culture.md"), `# culture\n${MARKER}\n`);
    fs.linkSync(path.join(tmpDir, "culture.md"), path.join(tmpDir, "alias.md"));
    const res = await create();
    const body = await res.json() as { error?: string };
    expect(res.status, JSON.stringify(body)).toBe(500);
    expect(body.error).toMatch(/has 2 hard links/);
    noArtifact();
  });

  // The guard's bytes are what is copied: a UTF-8 string round trip would turn 0xa0 0xa1 into U+FFFD.
  it("the guarded bytes are copied verbatim (non-UTF-8 bytes are not decoded)", () => {
    const bytes = Buffer.concat([Buffer.from(`# culture\n${MARKER}\n`), Uint8Array.from([0xa0, 0xa1, 0xff, 0x0a])]);
    fs.writeFileSync(path.join(tmpDir, "culture.md"), bytes);
    fs.writeFileSync(path.join(tmpDir, "rig-terminal.yaml"), [
      'version: "0.2"', "name: culture-bytes-rig", "culture_file: culture.md", "pods:",
      "  - id: dev", "    label: dev", "    members:", "      - id: shell", "        agent_ref: builtin:terminal",
      "        profile: none", "        runtime: terminal", "        cwd: .", "    edges: []", "edges: []",
    ].join("\n"));
    const realFs = {
      readFile: (p: string) => fs.readFileSync(p, "utf-8"),
      readFileBuffer: (p: string) => fs.readFileSync(p),
      readCultureFile: (r: string, p: string) => checkCultureFile(r, p),
      realpath: (p: string) => fs.realpathSync(p),
      exists: (p: string) => fs.existsSync(p),
      mkdirp: (p: string) => { fs.mkdirSync(p, { recursive: true }); },
      writeFile: (p: string, c: string | Uint8Array) => { fs.writeFileSync(p, c); },
      copyDir: () => {},
      listFiles: () => [],
    } as unknown as PodAssemblerFsOps;
    const out = path.join(tmpDir, "staged");
    new PodBundleAssembler({ fsOps: realFs }).assemble({ rigRoot: tmpDir, rigSpecPath: path.join(tmpDir, "rig-terminal.yaml"), outputDir: out, bundleName: "b", bundleVersion: "1.0.0" });
    expect(fs.readFileSync(path.join(out, "culture.md")).equals(bytes)).toBe(true);
  });
});
