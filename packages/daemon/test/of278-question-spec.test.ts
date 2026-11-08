import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { seatQuestionsSchema } from "../src/db/migrations/127_seat_questions.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { RigSpecSchema } from "../src/domain/rigspec-schema.js";
import { RigSpecCodec } from "../src/domain/rigspec-codec.js";
import { MAX_AUTO_ANSWER_MINUTES } from "../src/domain/seat-question-policy.js";
import type { RuntimeAdapter } from "../src/domain/runtime-adapter.js";
import { existingRigRoot } from "./helpers/existing-rig-root.js";

// OF-278: `question_policy: { auto_answer_after: <minutes> }` is a top-level rig key (default 15, 0 = off). It persists on the rig row, like
// non_interruptive, and it is not a rig-mode field.
const raw = { version: "0.2", name: "choice", pods: [{ id: "dev", label: "Dev", members: [{ id: "shell", runtime: "terminal", agent_ref: "builtin:terminal", profile: "none", cwd: "." }], edges: [] }], edges: [] };

describe("question_policy in the rig spec", () => {
  it.each([0, 1, 15, 45, MAX_AUTO_ANSWER_MINUTES])("accepts auto_answer_after: %s and round-trips it", (minutes) => {
    const spec = { ...raw, question_policy: { auto_answer_after: minutes } };
    expect(RigSpecSchema.validate(spec).errors).toEqual([]);
    const normalized = RigSpecSchema.normalize(spec);
    expect(normalized.questionPolicy).toEqual({ autoAnswerAfter: minutes });
    const out = RigSpecCodec.parse(RigSpecCodec.serialize(normalized)) as Record<string, unknown>;
    expect(out["question_policy"]).toEqual({ auto_answer_after: minutes });
  });
  it("leaves an absent policy absent, through normalize and serialize", () => {
    expect(RigSpecSchema.validate(raw).errors).toEqual([]);
    const normalized = RigSpecSchema.normalize(raw);
    expect(normalized).not.toHaveProperty("questionPolicy");
    expect(RigSpecCodec.serialize(normalized)).not.toContain("question_policy");
  });
  it.each([[-1], [MAX_AUTO_ANSWER_MINUTES + 1], [1.5], ["15"], [null], [true]])("rejects auto_answer_after: %j", (minutes) => {
    expect(RigSpecSchema.validate({ ...raw, question_policy: { auto_answer_after: minutes } }).errors.join("\n")).toContain("question_policy.auto_answer_after: must be a whole number of minutes");
  });
  it.each([["a string", "15"], ["a list", [15]], ["null", null]])("rejects a question_policy that is %s", (_n, value) => {
    expect(RigSpecSchema.validate({ ...raw, question_policy: value }).errors).toContain("question_policy: must be a mapping");
  });
  it("rejects a key it does not know, so a typo does not silently leave the default", () => {
    expect(RigSpecSchema.validate({ ...raw, question_policy: { auto_answer_afer: 5 } }).errors).toContain('question_policy: unknown key "auto_answer_afer"');
  });
  it("is not a rig-mode field: the rig-mode types and defaults never name it", async () => {
    const { readFileSync } = await import("node:fs");
    for (const f of ["rig-mode-types.ts", "rig-mode-defaults.ts", "rig-mode-validator.ts"]) {
      expect(readFileSync(join(import.meta.dirname, "../src/domain/rig-mode", f), "utf8")).not.toMatch(/question_policy|questionPolicy|auto_answer|autoAnswer/);
    }
  });
});

describe("question_policy on the rig row", () => {
  const roots: string[] = [];
  afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

  it("migration leaves existing rigs on the default, survives reopen, and clears back to it", () => {
    const dir = mkdtempSync(join(tmpdir(), "qp-")); roots.push(dir);
    const file = join(dir, "rig.db"); let db = createDb(file);
    migrate(db, ALL_MIGRATIONS.filter((m) => m.name !== seatQuestionsSchema.name));
    let repo = new RigRepository(db); const rig = repo.createRig("kept");
    expect(repo.getRigQuestionAutoAnswerMinutes(rig.id)).toBeNull();   // no column yet: reads as the default, writes nothing
    repo.setRigQuestionAutoAnswerMinutes(rig.id, 3);
    migrate(db, ALL_MIGRATIONS);
    expect(repo.getRigQuestionAutoAnswerMinutes(rig.id)).toBeNull();
    repo.setRigQuestionAutoAnswerMinutes(rig.id, 0);
    db.close();
    db = createDb(file); migrate(db, ALL_MIGRATIONS); repo = new RigRepository(db);
    expect(repo.getRigQuestionAutoAnswerMinutes(rig.id)).toBe(0);      // 0 is off, and is not the same as unset
    repo.setRigQuestionAutoAnswerMinutes(rig.id, null);
    expect(repo.getRigQuestionAutoAnswerMinutes(rig.id)).toBeNull();
    expect(repo.getRigQuestionAutoAnswerMinutes(repo.createRig("other").id)).toBeNull();
    db.close();
  });

  it.each([[undefined, null], [0, 0], [7, 7]] as const)("an authored policy %s persists as %s at instantiate and exports back", async (declared, stored) => {
    const db = createFullTestDb();
    const adapter = { runtime: "claude-code", listInstalled: async () => [], project: async () => ({ projected: [], skipped: [], failed: [] }),
      deliverStartup: async () => ({ delivered: 0, failed: [] }), launchHarness: async () => ({ ok: true }), checkReady: async () => ({ ready: true }) } as RuntimeAdapter;
    const agent = 'name: impl\nversion: "1.0.0"\nresources:\n  skills: []\nprofiles:\n  default:\n    uses:\n      skills: []\n';
    const setup = createTestApp(db, { adapters: { "claude-code": adapter }, podInstantiatorFsOps: {
      exists: (p: string) => p.includes("agents/impl"), readFile: (p: string) => { if (p.includes("agents/impl")) return agent; throw new Error("missing"); },
    } });
    try {
      const spec = `version: "0.2"\nname: qp-pod\n${declared === undefined ? "" : `question_policy:\n  auto_answer_after: ${declared}\n`}pods:\n  - id: dev\n    label: Dev\n    members:\n      - id: impl\n        runtime: claude-code\n        agent_ref: local:agents/impl\n        profile: default\n        cwd: .\n    edges: []\nedges: []\n`;
      const result = await setup.podInstantiator.instantiate(spec, existingRigRoot("work-fixture"));
      expect(result.ok, JSON.stringify(result)).toBe(true);
      const rigId = (result as { ok: true; result: { rigId: string } }).result.rigId;
      expect(setup.rigRepo.getRigQuestionAutoAnswerMinutes(rigId)).toBe(stored);
      const exported = setup.rigSpecExporter.exportRig(rigId) as import("../src/domain/types.js").RigSpec;
      if (stored === null) expect(exported).not.toHaveProperty("questionPolicy");
      else expect(exported.questionPolicy).toEqual({ autoAnswerAfter: stored });
      expect(RigSpecCodec.serialize(exported).includes("question_policy")).toBe(stored !== null);
    } finally { db.close(); }
  });
});
