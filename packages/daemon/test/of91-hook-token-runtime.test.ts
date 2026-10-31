// OF-91: POST /api/activity/hooks session_identity must bind the resume-token TYPE to the seat's STORED runtime
// (nodes.runtime), never to the runtime the request body claims. Production consequence: with only the local hook
// token, a hook claiming codex (or pi, omp, claude-code) against another runtime's seat relabelled or overwrote that
// seat's resume token with a token of the wrong type, and the next restore picked the wrong adapter.
//
// Deployed entrypoint: startup.ts mounts activityRoutes; its posters are the openrig-core activity-relay.cjs
// (claude-code, codex; runtime from the seat's launch env OPENRIG_RUNTIME) and pi-runner.ts (pi and omp).
// The expected values below are written out literally; nothing here imports the rule it pins.

import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { mkTemp } from "./helpers/temp-roots.js";

const dir = mkTemp(join(tmpdir(), "of91-"));
const ompFile = join(dir, "claim-omp.jsonl");
writeFileSync(ompFile, "{}\n");

type Runtime = "claude-code" | "codex" | "pi" | "omp" | "pda";
const SEAT_RUNTIMES = ["claude-code", "codex", "pi", "omp", "pda", "terminal"] as const;
const CLAIMS: Runtime[] = ["claude-code", "codex", "pi", "omp", "pda"];

// The token each seat runtime already holds (hook provenance, so a wrong-typed write WOULD overwrite it).
const SEEDED: Record<string, { type: string; token: string } | null> = {
  "claude-code": { type: "claude_id", token: "0f6cf1cc-9c4e-4f7e-9d38-1c1f80f9e001" },
  codex: { type: "codex_id", token: "thread-seeded-codex" },
  pi: { type: "pi_session_file", token: "/seed/pi.jsonl" },
  omp: { type: "omp_session_file", token: "/seed/omp.jsonl" },
  pda: { type: "pda_agent", token: "http://127.0.0.1:9001/agents/seeded" },
  terminal: null,
};
// What each claim posts, and the row it would store if the claim were honoured.
const CLAIM: Record<Runtime, { sessionId: string; sessionFile?: string; type: string; token: string }> = {
  "claude-code": { sessionId: "0f6cf1cc-9c4e-4f7e-9d38-1c1f80f9e002", type: "claude_id", token: "0f6cf1cc-9c4e-4f7e-9d38-1c1f80f9e002" },
  codex: { sessionId: "thread-claimed-codex", type: "codex_id", token: "thread-claimed-codex" },
  pi: { sessionId: "native-pi", sessionFile: "/claim/pi.jsonl", type: "pi_session_file", token: "/claim/pi.jsonl" },
  omp: { sessionId: "native-omp", sessionFile: ompFile, type: "omp_session_file", token: ompFile },
  pda: { sessionId: "http://127.0.0.1:9999/agents/evil", type: "pda_agent", token: "http://127.0.0.1:9999/agents/evil" },
};

/** `spelling`: post this text as the runtime claim instead of the claim's own name (the OF-97 case/whitespace rows). */
async function post(seatRuntime: string, claim: Runtime | "terminal" | null, spelling?: string) {
  const db = createFullTestDb();
  try {
    const rigRepo = new RigRepository(db);
    const rig = rigRepo.createRig("of91");
    const node = rigRepo.addNode(rig.id, "dev.worker", { runtime: seatRuntime });
    const reg = new SessionRegistry(db);
    const sess = reg.registerSession(node.id, "dev-worker@of91");
    reg.updateStatus(sess.id, "running");
    const seed = SEEDED[seatRuntime];
    if (seed) reg.updateResumeToken(sess.id, seed.type, seed.token, "hook");
    const generation = reg.currentOccupantTenure(node.id)?.generationUuid ?? null;
    const adapters = { omp: { readSessionFile: () => ({ ok: true, sessionFile: ompFile }) } } as never;
    const { app } = createTestApp(db, { activityHookToken: "tok", adapters });
    const row = () => db.prepare("SELECT resume_type, resume_token, resume_provenance FROM sessions WHERE id = ?").get(sess.id);
    const events = () => (db.prepare("SELECT count(*) AS n FROM events WHERE type = 'agent.session_identity'").get() as { n: number }).n;
    const before = row(), eventsBefore = events();
    const c = claim && claim !== "terminal" ? CLAIM[claim] : { sessionId: "term-1" };
    const res = await app.request("/api/activity/hooks", {
      method: "POST",
      headers: { "content-type": "application/json", "x-openrig-activity-token": "tok" },
      body: JSON.stringify({ eventFamily: "session_identity", sessionName: "dev-worker@of91", runtime: spelling ?? claim, generation, ...c }),
    });
    return { status: res.status, body: await res.json() as Record<string, unknown>, before, after: row(), eventsAdded: events() - eventsBefore };
  } finally {
    db.close();
  }
}

describe("OF-91: the resume-token type is bound to the seat's stored runtime", () => {
  // Own-runtime hooks keep working unchanged (the legitimate posters).
  it.each(["claude-code", "codex", "pi", "omp"] as const)("%s seat, hook claims its own runtime: persisted as that runtime's own token type", async (rt) => {
    const r = await post(rt, rt);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, tokenPersisted: true });
    expect(r.after).toEqual({ resume_type: CLAIM[rt].type, resume_token: CLAIM[rt].token, resume_provenance: "hook" });
    expect(r.eventsAdded).toBe(1);
  });

  it("pda seat, hook claims pda: refused (a pda token is recorded by the launch), stored token unchanged", async () => {
    const r = await post("pda", "pda");
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ ok: false, code: "session_identity_not_accepted", tokenPersisted: false });
    expect(r.after).toEqual(r.before);
    expect(r.eventsAdded).toBe(0);
  });

  it("terminal seat, hook claims terminal: no resume type exists, nothing stored, route still answers 200", async () => {
    const r = await post("terminal", "terminal");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, tokenPersisted: false });
    expect(r.after).toEqual(r.before);
  });

  // Every off-diagonal cell: a body-claimed runtime that is not the seat's stored runtime.
  const offDiagonal: Array<[string, Runtime | "terminal"]> = [];
  for (const seat of SEAT_RUNTIMES) for (const claim of [...CLAIMS, "terminal" as const]) {
    if (seat !== claim) offDiagonal.push([seat, claim]);
  }
  it.each(offDiagonal)("%s seat, hook claims %s: refused 409, stored token and events unchanged", async (seat, claim) => {
    const r = await post(seat, claim);
    expect(r.after).toEqual(r.before); // the reported symptom first: the seat's token must not be relabelled or overwritten
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ ok: false, tokenPersisted: false });
    expect(r.body["code"]).toBe(seat === "pda" || claim === "pda" ? "session_identity_not_accepted" : "runtime_mismatch");
    expect(r.after).toEqual(r.before);
    expect(r.eventsAdded).toBe(0);
  });

  it("the table is exhaustive: 6 seat runtimes x 6 claims = 36 cells, 6 diagonal, 30 off-diagonal", () => {
    expect(SEAT_RUNTIMES.length * (CLAIMS.length + 1)).toBe(36);
    expect(offDiagonal.length).toBe(30);
  });

  // OF-97 (review-of91 N1): the runtime compare is exact. A case-insensitive or trimming compare would treat
  // "Codex" / " codex " as the seat's OWN runtime and write the token (the body is otherwise the seat's own, so the
  // write would succeed). Written literally here; the spellings are what a sloppy or hostile poster could send.
  const SPELLINGS: Record<string, string[]> = {
    "claude-code": ["Claude-Code", "CLAUDE-CODE", " claude-code ", "claude-code\n"],
    codex: ["Codex", "CODEX", " codex ", "codex\n", "\tcodex"],
    pi: ["Pi", "PI", " pi ", "pi\n"],
    omp: ["Omp", "OMP", " omp ", "omp\n"],
  };
  const variantRows: Array<[Runtime, string]> = [];
  for (const [rt, spellings] of Object.entries(SPELLINGS)) for (const s of spellings) variantRows.push([rt as Runtime, s]);
  it.each(variantRows)("%s seat, hook claims its own runtime spelled %j: not the own-runtime claim, refused 409, nothing written", async (rt, spelling) => {
    const r = await post(rt, rt, spelling);
    expect(r.after).toEqual(r.before); // the seat's seeded token is not overwritten by the claimed one
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ ok: false, code: "runtime_mismatch", tokenPersisted: false });
    expect(r.eventsAdded).toBe(0);
  });
  // The OMP block's own runtime check (activity.ts, after the OF-91 compare) is reachable only by a null claim.
  it("omp seat, hook names no runtime: refused 409 runtime_mismatch (OMP identity is claimed, never inferred), nothing written", async () => {
    const r = await post("omp", null);
    expect(r.after).toEqual(r.before);
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ ok: false, code: "runtime_mismatch", tokenPersisted: false });
    expect(r.eventsAdded).toBe(0);
  });
  it("the variant table is exhaustive: 4 own-runtimes, 4+5+4+4 = 17 spellings", () => {
    expect(variantRows.length).toBe(17);
  });

  // A claim-less hook is not a claim: it never persisted anything and must not start to.
  it("claude-code seat, hook names no runtime: nothing stored (unchanged)", async () => {
    const r = await post("claude-code", null);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ tokenPersisted: false });
    expect(r.after).toEqual(r.before);
  });
});
