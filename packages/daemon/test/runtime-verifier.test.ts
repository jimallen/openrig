import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { RuntimeVerifier, HC_PINNED_VERSION } from "../src/domain/runtime-verifier.js";
import { ProbeTimeoutError } from "../src/adapters/bounded-probe-exec.js";
import { HC_GENERATION, HcError, HcOutcomeUnknownError, HcUnavailableError, type HcHello } from "../src/adapters/hc-client.js";
import type { ExecFn } from "../src/adapters/tmux.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";


function createMockExec(responses: Record<string, string | Error>): ExecFn {
  return vi.fn(async (cmd: string) => {
    for (const [pattern, response] of Object.entries(responses)) {
      if (cmd.includes(pattern)) {
        if (response instanceof Error) throw response;
        return response;
      }
    }
    throw new Error("command not found");
  });
}

const PIN = "0.1.16";
/** A core's `hello`, with the fields a test varies. */
const hello = (over: Partial<HcHello> = {}): HcHello => ({
  generation: HC_GENERATION, version: PIN, core: { id: "c", name: "n" }, framed: false, methods: [], features: [], ...over,
});
/** A verifier whose core answers with `answer`; a function so a test can make it throw. */
const withCore = (db: Database.Database, exec: ExecFn, answer: () => Promise<HcHello>) =>
  new RuntimeVerifier({ exec, db, hcHello: answer });

describe("RuntimeVerifier", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
  });

  afterEach(() => {
    db.close();
  });

  // T1: hc present at the pin, core on this generation -> verified
  it("hc at the pinned version with a core on this generation -> verified, recording both", async () => {
    const exec = createMockExec({ "hc --version": "hc 0.1.16\n" });
    const result = await withCore(db, exec, async () => hello()).verifyHc();

    expect(result.status).toBe("verified");
    expect(result.version).toBe("0.1.16");
    expect(result.runtime).toBe("hc");
    expect(JSON.parse(result.capabilitiesJson!)).toEqual({ generation: HC_GENERATION, coreVersion: "0.1.16" });
    expect(result.error).toBeNull();
  });

  it("the pin is hc 0.1.16 and the generation 1 (restated, so a change must be deliberate)", () => {
    expect(HC_PINNED_VERSION).toBe("0.1.16");
    expect(HC_GENERATION).toBe(1);
  });

  // T2: hc missing -> not_found
  it("hc missing -> not_found, and the core is not asked", async () => {
    let asked = 0;
    const result = await withCore(db, createMockExec({}), async () => { asked++; return hello(); }).verifyHc();

    expect(result.status).toBe("not_found");
    expect(result.error).toBeTruthy();
    expect(asked).toBe(0);
  });

  it.each(["0.1.14", "0.1.15", "0.2.0"])("hc %s is not the pin -> error naming both, and the core is not asked", async (installed) => {
    let asked = 0;
    const exec = createMockExec({ "hc --version": `hc ${installed}` });
    const result = await withCore(db, exec, async () => { asked++; return hello(); }).verifyHc();

    expect(result.status).toBe("error");
    expect(result.version).toBe(installed);
    expect(result.error).toContain(installed);
    expect(result.error).toContain(PIN);
    expect(asked).toBe(0);
  });

  it("a running core on another generation -> error, however it says so", async () => {
    const exec = createMockExec({ "hc --version": "hc 0.1.16" });
    const answers: Array<[() => Promise<HcHello>, string]> = [
      [async () => hello({ generation: HC_GENERATION + 1 }), "the hc core speaks generation 2, this build 1"],
      [async () => { throw new HcError("this core speaks generation 2", "unsupported_generation", -32000); }, "the hc core refused generation 1"],
    ];
    for (const [answer, expected] of answers) {
      const result = await withCore(db, exec, answer).verifyHc();
      expect(result.status).toBe("error");
      expect(result.error).toContain(expected);
    }
  });

  it("a running core of another version than the pin -> error", async () => {
    const exec = createMockExec({ "hc --version": "hc 0.1.16" });
    const result = await withCore(db, exec, async () => hello({ version: "0.1.14" })).verifyHc();
    expect(result.status).toBe("error");
    expect(result.error).toContain("0.1.14");
  });

  it("no core running -> degraded, not an error: the check starts none", async () => {
    const exec = createMockExec({ "hc --version": "hc 0.1.16" });
    const result = await withCore(db, exec, async () => { throw new HcUnavailableError("hc core not reachable at /x"); }).verifyHc();
    expect(result.status).toBe("degraded");
    expect(result.error).toBe("no hc core is running");
    expect(result.version).toBe("0.1.16");
  });

  it("a core that cannot be read -> error, not degraded", async () => {
    const exec = createMockExec({ "hc --version": "hc 0.1.16" });
    for (const err of [new HcError("boom", "internal", -32603), new HcOutcomeUnknownError("hello: no reply", "hello")]) {
      const result = await withCore(db, exec, async () => { throw err; }).verifyHc();
      expect(result.status, err.name).toBe("error");
      expect(result.error, err.name).toContain("could not be read");
    }
  });

  it("runs only `hc --version` for hc and for its old name tmux", async () => {
    const seen: string[] = [];
    const exec = vi.fn(async (cmd: string) => { seen.push(cmd); return "hc 0.1.16"; });
    await withCore(db, exec, async () => hello()).verifyAll(["hc", "tmux"]);
    expect(seen).toEqual(["hc --version", "hc --version"]);
  });

  // T5: claude --version succeeds -> verified
  it("claude --version succeeds -> verified", async () => {
    const exec = createMockExec({ "claude --version": "claude 1.0.23" });
    const verifier = new RuntimeVerifier({ exec, db });

    const result = await verifier.verifyClaude();

    expect(result.status).toBe("verified");
    expect(result.version).toBe("1.0.23");
    expect(result.runtime).toBe("claude-code");
  });

  // T6: codex --version succeeds -> verified
  it("codex --version succeeds -> verified", async () => {
    const exec = createMockExec({ "codex --version": "codex 0.5.1" });
    const verifier = new RuntimeVerifier({ exec, db });

    const result = await verifier.verifyCodex();

    expect(result.status).toBe("verified");
    expect(result.version).toBe("0.5.1");
    expect(result.runtime).toBe("codex");
  });

  // T7: verifyHc auto-persists to DB
  it("verification auto-persists to runtime_verifications table", async () => {
    const exec = createMockExec({ "hc --version": "hc 0.1.16" });
    const verifier = withCore(db, exec, async () => hello());

    const result = await verifier.verifyHc();

    const row = db.prepare("SELECT * FROM runtime_verifications WHERE runtime = ?")
      .get("hc") as { id: string; runtime: string; version: string; status: string } | undefined;

    expect(row).toBeDefined();
    expect(row!.runtime).toBe("hc");
    expect(row!.version).toBe("0.1.16");
    expect(row!.status).toBe("verified");
    expect(row!.id).toBe(result.id);
  });

  // T8: Re-verify hc twice -> only 1 row
  it("re-verification updates existing record (1 row per runtime)", async () => {
    const exec = createMockExec({ "hc --version": "hc 0.1.16" });
    const verifier = withCore(db, exec, async () => hello());

    await verifier.verifyHc();
    await verifier.verifyHc();

    const rows = db.prepare("SELECT * FROM runtime_verifications WHERE runtime = ?")
      .all("hc") as Array<{ id: string }>;

    expect(rows).toHaveLength(1);
  });

  // T9: claude --version fails, --help succeeds -> verified, version=null
  it("claude --version fails but --help succeeds -> verified with null version", async () => {
    const exec = vi.fn(async (cmd: string) => {
      if (cmd === "claude --version") throw new Error("not found");
      if (cmd === "claude --help") return "Claude Code CLI\nUsage: claude [options]";
      throw new Error("unknown command");
    });
    const verifier = new RuntimeVerifier({ exec, db });

    const result = await verifier.verifyClaude();

    expect(result.status).toBe("verified");
    expect(result.version).toBeNull();
    expect(result.runtime).toBe("claude-code");
  });

  // T10: Persisted runtime field is 'claude-code' (canonical name)
  it("persisted runtime field matches canonical name 'claude-code'", async () => {
    const exec = createMockExec({ "claude --version": "claude 1.0.0" });
    const verifier = new RuntimeVerifier({ exec, db });

    await verifier.verifyClaude();

    const row = db.prepare("SELECT * FROM runtime_verifications WHERE runtime = ?")
      .get("claude-code") as { runtime: string } | undefined;

    expect(row).toBeDefined();
    expect(row!.runtime).toBe("claude-code");
  });

  // T11: codex --version fails, --help succeeds -> verified, version=null
  it("codex --version fails but --help succeeds -> verified with null version", async () => {
    const exec = vi.fn(async (cmd: string) => {
      if (cmd === "codex --version") throw new Error("not found");
      if (cmd === "codex --help") return "Codex CLI\nUsage: codex [options]";
      throw new Error("unknown command");
    });
    const verifier = new RuntimeVerifier({ exec, db });

    const result = await verifier.verifyCodex();

    expect(result.status).toBe("verified");
    expect(result.version).toBeNull();
    expect(result.runtime).toBe("codex");
  });

  // T12: hc --version garbage output -> status='error'
  it("hc --version with unparseable output -> error status", async () => {
    const exec = createMockExec({ "hc --version": "some garbage with no version" });
    const verifier = withCore(db, exec, async () => hello());

    const result = await verifier.verifyHc();

    expect(result.status).toBe("error");
    expect(result.error).toContain("unparseable");
    expect(result.version).toBeNull();
  });

  // T13: cmux was removed -> it is an unknown runtime and nothing is run for it
  it('verifyAll(["cmux"]) -> not_found "unknown runtime", and no command is run', async () => {
    const exec = vi.fn(async () => "never");
    const results = await new RuntimeVerifier({ exec, db }).verifyAll(["cmux"]);

    expect(exec).not.toHaveBeenCalled();
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ runtime: "cmux", status: "not_found", error: "unknown runtime: cmux" });
  });

  // T14: verifyAll preserves input order + persists canonical names
  it("verifyAll preserves input order and persists canonical runtime names", async () => {
    const exec = createMockExec({
      "codex --version": "codex 0.5.0",
      "claude --version": "claude 1.2.3",
      "hc --version": "hc 0.1.16",
    });
    const verifier = withCore(db, exec, async () => hello());

    const results = await verifier.verifyAll(["codex", "claude-code", "hc"]);

    // Input order preserved
    expect(results).toHaveLength(3);
    expect(results[0]!.runtime).toBe("codex");
    expect(results[1]!.runtime).toBe("claude-code");
    expect(results[2]!.runtime).toBe("hc");

    // All persisted with canonical names
    const rows = db.prepare("SELECT runtime FROM runtime_verifications ORDER BY runtime")
      .all() as Array<{ runtime: string }>;
    const names = rows.map((r) => r.runtime).sort();
    expect(names).toEqual(["claude-code", "codex", "hc"]);
  });

  it('verifyAll(["tmux"]) is the seat-host check under its old name: it records "hc" and runs no tmux', async () => {
    const seen: string[] = [];
    const exec = vi.fn(async (cmd: string) => { seen.push(cmd); return "hc 0.1.16"; });
    const results = await withCore(db, exec, async () => hello()).verifyAll(["tmux"]);

    expect(results.map((r) => [r.runtime, r.status])).toEqual([["hc", "verified"]]);
    expect(seen.every((cmd) => !cmd.startsWith("tmux"))).toBe(true);
  });

  it("hc --version goes through the bounded probe exec, and a probe that does not answer is an error, not not_found", async () => {
    const exec = vi.fn(async () => { throw new Error("exec must not run the hc probe"); });
    const hang = vi.fn(async () => { throw new ProbeTimeoutError("hc --version", 30_000); });
    let asked = 0;
    const verifier = new RuntimeVerifier({ exec, probeExec: hang, db, hcHello: async () => { asked++; return hello(); } });

    const result = await verifier.verifyHc();

    expect(result.status).toBe("error");
    expect(result.error).toContain("did not answer");
    expect(hang).toHaveBeenCalledWith("hc --version");
    expect(exec).not.toHaveBeenCalled();
    expect(asked).toBe(0);
  });
});
