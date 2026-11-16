// workspaces-o9o.47: every route that returns transcript text redacts it by default, with the shared transcript policy
// (redactTranscriptContent). Before this, GET /api/transcripts/:s/full redacted at the route while /tail and /grep
// returned the text as stored, and POST /api/ask returned rig, seat and session excerpts unredacted. Matching runs on
// the REDACTED text too: a grep regex or an ask keyword that only a secret's raw bytes satisfy finds nothing, so a
// caller cannot probe a secret out of the transcript one character at a time.
//
// The fixture secret is built at runtime: no credential-shaped literal sits in this file (CoS rule, 2026-11-16).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { TranscriptStore } from "../src/domain/transcript-store.js";
import { transcriptRoutes } from "../src/routes/transcripts.js";
import { HistoryQuery, type ExecDep } from "../src/domain/history-query.js";

/** A fake key the shared policy redacts (`sk-` and 16+ word characters), assembled so the source holds no such literal. */
const SECRET = ["s", "k-"].join("") + "o9o47fixture" + "Q".repeat(12);
/** A prefix only the raw secret contains: the probe a caller would use to recover it a character at a time. */
const PROBE = SECRET.slice(0, 14);
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const LINE = `export OPENAI_KEY=${SECRET} # set by the deploy step`;

/** rg/grep for real, as the daemon runs them (startup.ts execDep shape). */
const realExec: ExecDep = (cmd, args) => new Promise((resolve) => {
  execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
    const code: unknown = err ? (err as { code?: unknown }).code : 0;
    resolve({ stdout: String(stdout), exitCode: typeof code === "number" ? code : 2 });
  });
});

describe("workspaces-o9o.47: transcript text leaves the daemon redacted", () => {
  let db: Database.Database;
  let root: string;
  let app: Hono;

  beforeEach(() => {
    db = createFullTestDb();
    root = mkdtempSync(join(tmpdir(), "o9o47-"));
    const rigRepo = new RigRepository(db);
    const sessionRegistry = new SessionRegistry(db);
    const rig = rigRepo.createRig("my-rig");
    const node = rigRepo.addNode(rig.id, "dev-impl", { role: "worker", runtime: "claude-code" });
    const session = sessionRegistry.registerSession(node.id, "dev-impl@my-rig");
    sessionRegistry.updateStatus(session.id, "running");
    const store = new TranscriptStore({ transcriptsRoot: join(root, "transcripts"), enabled: true });
    store.ensureTranscriptDir("my-rig");
    writeFileSync(store.getTranscriptPath("my-rig", "dev-impl@my-rig"), `starting deploy\n${LINE}\ndeploy finished\n`);
    app = new Hono();
    app.use("*", async (c, next) => {
      c.set("rigRepo" as never, rigRepo);
      c.set("sessionRegistry" as never, sessionRegistry);
      c.set("transcriptStore" as never, store);
      c.set("db" as never, db);
      await next();
    });
    app.route("/api/transcripts", transcriptRoutes());
  });

  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  const get = async (path: string) => {
    const res = await app.request(path);
    const text = await res.text();
    return { status: res.status, text, body: JSON.parse(text) as Record<string, unknown> };
  };

  it("GET /tail redacts the secret and keeps the rest of the line", async () => {
    const { status, text, body } = await get("/api/transcripts/dev-impl@my-rig/tail?lines=10");

    expect(status).toBe(200);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(PROBE);
    expect(body["content"]).toContain("export OPENAI_KEY=[REDACTED] # set by the deploy step");
  });

  it("GET /grep returns the matching line redacted", async () => {
    const { status, text, body } = await get(`/api/transcripts/dev-impl@my-rig/grep?pattern=${encodeURIComponent("OPENAI_KEY")}`);

    expect(status).toBe(200);
    expect(text).not.toContain(SECRET);
    expect(body["matches"]).toEqual(["export OPENAI_KEY=[REDACTED] # set by the deploy step"]);
  });

  it("GET /grep with a regex only the raw secret satisfies finds nothing (no probing oracle)", async () => {
    const { status, text, body } = await get(`/api/transcripts/dev-impl@my-rig/grep?pattern=${encodeURIComponent(escapeRegex(PROBE))}`);

    expect(status).toBe(200);
    // The response echoes the caller's own pattern (the probe it sent); nothing of the transcript line comes back.
    expect(body["pattern"]).toBe(escapeRegex(PROBE));
    expect(body["matches"]).toEqual([]);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("OPENAI_KEY");
  });

  describe("GET /grep on a transcript whose last line has no newline (the store's final-chunk path)", () => {
    beforeEach(() => {
      const store = new TranscriptStore({ transcriptsRoot: join(root, "transcripts"), enabled: true });
      writeFileSync(store.getTranscriptPath("my-rig", "dev-impl@my-rig"), `starting deploy\n${LINE}`);
    });

    it("returns the last line redacted", async () => {
      const { status, text, body } = await get(`/api/transcripts/dev-impl@my-rig/grep?pattern=${encodeURIComponent("OPENAI_KEY")}`);

      expect(status).toBe(200);
      expect(text).not.toContain(SECRET);
      expect(body["matches"]).toEqual(["export OPENAI_KEY=[REDACTED] # set by the deploy step"]);
    });

    it("a regex only the raw secret satisfies finds nothing", async () => {
      const { status, text, body } = await get(`/api/transcripts/dev-impl@my-rig/grep?pattern=${encodeURIComponent(escapeRegex(PROBE))}`);

      expect(status).toBe(200);
      expect(body["matches"]).toEqual([]);
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain("OPENAI_KEY");
    });
  });

  it("GET /full stays redacted", async () => {
    const { status, text, body } = await get("/api/transcripts/dev-impl@my-rig/full");

    expect(status).toBe(200);
    expect(text).not.toContain(SECRET);
    expect(body["content"]).toContain("export OPENAI_KEY=[REDACTED] # set by the deploy step");
  });

  describe("POST /api/ask's evidence (HistoryQuery)", () => {
    const seat = "dev-impl@my-rig";
    const hq = () => new HistoryQuery({ transcriptsRoot: join(root, "transcripts"), exec: realExec, claudeProjectsRoot: join(root, "projects") });
    const writeSession = (token: string) => {
      mkdirSync(join(root, "projects", "-work-repo"), { recursive: true });
      writeFileSync(join(root, "projects", "-work-repo", `${token}.jsonl`), `${JSON.stringify({ type: "user", text: LINE })}\n`);
    };

    it("rig-wide search: excerpts are redacted", async () => {
      const result = await hq().search("my-rig", "where is OPENAI_KEY exported");

      expect(result.insufficient).toBe(false);
      expect(JSON.stringify(result)).not.toContain(SECRET);
      expect(result.excerpts).toEqual(["export OPENAI_KEY=[REDACTED] # set by the deploy step"]);
    });

    it("rig-wide search: a keyword only the raw secret contains finds nothing", async () => {
      const result = await hq().search("my-rig", `who used ${PROBE}`);

      expect(JSON.stringify(result)).not.toContain(PROBE);
      expect(result.excerpts).toEqual([]);
      expect(result.insufficient).toBe(true);
    });

    it("seat search: hits are redacted", async () => {
      const result = await hq().searchSeat("my-rig", seat, "where is OPENAI_KEY exported");

      expect(JSON.stringify(result)).not.toContain(SECRET);
      expect(result.hits.map((h) => h.text)).toEqual(["export OPENAI_KEY=[REDACTED] # set by the deploy step"]);
    });

    it("seat search: a keyword only the raw secret contains finds nothing", async () => {
      const result = await hq().searchSeat("my-rig", seat, `who used ${PROBE}`);

      expect(JSON.stringify(result)).not.toContain(PROBE);
      expect(result.hits).toEqual([]);
      expect(result.insufficient).toBe(true);
    });

    it("session search: excerpts are redacted", async () => {
      writeSession("tok-o9o47");
      const result = await hq().searchSession("tok-o9o47", "where is OPENAI_KEY exported");

      expect(result.found).toBe(true);
      expect(JSON.stringify(result)).not.toContain(SECRET);
      expect(result.excerpts).toHaveLength(1);
      expect(result.excerpts[0]).toContain("export OPENAI_KEY=[REDACTED] # set by the deploy step");
    });

    it("session search: a secret straddling the 240-character excerpt cut is redacted before the cut", async () => {
      // The secret starts at character 232 of the JSONL line, so cutting first would leave an 8-character stub of it
      // ("sk-" and five more) that the policy no longer recognises, and that stub would be returned as is.
      const text = `${"pad ".repeat(50).slice(0, 197)} OPENAI_KEY=${SECRET} # set by the deploy step`;
      const raw = JSON.stringify({ type: "user", text });
      expect(raw.indexOf(SECRET)).toBe(232);
      mkdirSync(join(root, "projects", "-work-repo"), { recursive: true });
      writeFileSync(join(root, "projects", "-work-repo", "tok-o9o47-long.jsonl"), `${raw}\n`);

      const result = await hq().searchSession("tok-o9o47-long", "where is OPENAI_KEY exported");

      expect(JSON.stringify(result)).not.toContain(SECRET.slice(0, 6));
      expect(result.excerpts).toEqual([`${raw.replace(SECRET, "[REDACTED]").slice(0, 240)}…`]);
    });

    it("session search: a keyword only the raw secret contains finds nothing", async () => {
      writeSession("tok-o9o47");
      const result = await hq().searchSession("tok-o9o47", `who used ${PROBE}`);

      expect(JSON.stringify(result)).not.toContain(PROBE);
      expect(result.excerpts).toEqual([]);
      expect(result.insufficient).toBe(true);
    });

    describe("when rg fails and the search falls back to grep", () => {
      const rgFails: ExecDep = (cmd, args) => (cmd === "rg" ? Promise.resolve({ stdout: "", exitCode: 2 }) : realExec(cmd, args));
      const hqGrep = () => new HistoryQuery({ transcriptsRoot: join(root, "transcripts"), exec: rgFails, claudeProjectsRoot: join(root, "projects") });

      it("rig-wide search: excerpts are redacted", async () => {
        const result = await hqGrep().search("my-rig", "where is OPENAI_KEY exported");

        expect(result.backend).toBe("grep");
        expect(JSON.stringify(result)).not.toContain(SECRET);
        expect(result.excerpts).toEqual(["export OPENAI_KEY=[REDACTED] # set by the deploy step"]);
      });

      it("rig-wide search: a keyword only the raw secret contains finds nothing", async () => {
        const result = await hqGrep().search("my-rig", `who used ${PROBE}`);

        expect(result.backend).toBe("grep");
        expect(JSON.stringify(result)).not.toContain(PROBE);
        expect(result.excerpts).toEqual([]);
      });

      it("session search: excerpts are redacted", async () => {
        writeSession("tok-o9o47");
        const result = await hqGrep().searchSession("tok-o9o47", "where is OPENAI_KEY exported");

        expect(result.backend).toBe("grep");
        expect(JSON.stringify(result)).not.toContain(SECRET);
        expect(result.excerpts).toHaveLength(1);
        expect(result.excerpts[0]).toContain("export OPENAI_KEY=[REDACTED] # set by the deploy step");
      });

      it("session search: a keyword only the raw secret contains finds nothing", async () => {
        writeSession("tok-o9o47");
        const result = await hqGrep().searchSession("tok-o9o47", `who used ${PROBE}`);

        expect(result.backend).toBe("grep");
        expect(JSON.stringify(result)).not.toContain(PROBE);
        expect(result.excerpts).toEqual([]);
      });
    });
  });
});
