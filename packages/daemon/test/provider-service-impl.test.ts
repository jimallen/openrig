// Slice-04 (OPR.0.5.0.4) C1 — production ProviderService wiring pins (getReadModel over injected
// deps; precheck fail-closed on unknown auth per BR-3; switch never fabricates success).
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { createFullTestDb } from "./helpers/test-app.js";
import { ProviderServiceImpl } from "../src/domain/provider/provider-service-impl.js";
import { mkTemp } from "./helpers/temp-roots.js";
import { CodexUsageWindows } from "../src/domain/provider/codex-usage-windows.js";
import { ClaudeUsageWindows } from "../src/domain/provider/claude-usage-windows.js";

const ASOF = "2026-08-04T00:00:00.000Z";

function emptyCodexHomeEnv(): NodeJS.ProcessEnv {
  const home = mkTemp(nodePath.join(os.tmpdir(), "provider-impl-codex-"));
  return { CODEX_HOME: home } as NodeJS.ProcessEnv;
}

function makeSvc() {
  return new ProviderServiceImpl({
    db: createFullTestDb(),
    listRigs: () => [], // no rigs → no seats; getReadModel never touches getNodeInventory
    env: emptyCodexHomeEnv(),
    now: () => ASOF,
  });
}

describe("ProviderServiceImpl — production getReadModel/precheck/switch wiring", () => {
  it("getReadModel over an empty codex home + no rigs is a well-formed empty four-block", async () => {
    const model = await makeSvc().getReadModel();
    // S-A amendment (OPR.0.5.0.4 A2, README 21a5cb73): the read model additively carries the
    // host-level usage rollup — empty here (no providers present ⇒ no rows, honestly).
    expect(model).toEqual({ accounts: [], bindings: [], signals: [], hostUsage: [], asOf: ASOF });
  });

  it("precheck for an unknown/absent target fails CLOSED (target_auth_unknown), never safe", async () => {
    const r = await makeSvc().precheck({ seat: "dev-driver@rig", toAccount: "no-such-account" });
    expect(r.safe).toBe(false);
    if (r.safe === false) expect(r.reasons).toContain("target_auth_unknown");
  });

  it("switchAccount precheck-gates to failed_safely (never fabricates succeeded)", async () => {
    const r = await makeSvc().switchAccount({ seat: "dev-driver@rig", toAccount: "no-such-account", forceUnsafe: false });
    expect(r.outcome).toBe("failed_safely");
    if (r.outcome === "failed_safely") expect(r.reasons.length).toBeGreaterThan(0);
  });

  it("switchAccount with forceUnsafe still cannot succeed — the switch-exec D seam is unwired, so honest failed_safely", async () => {
    const r = await makeSvc().switchAccount({ seat: "dev-driver@rig", toAccount: "no-such-account", forceUnsafe: true });
    expect(r.outcome).toBe("failed_safely");
    if (r.outcome === "failed_safely") expect(r.reasons).toContain("switch_execution_not_yet_wired");
  });

  it("getReadModel surfaces Claude statusline signals from the collectClaudeSignals dep (C3 wiring)", async () => {
    const sig = { provider: "claude" as const, accountRef: "sub", sourceClass: "unknown" as const, authority: "unknown" as const, asOf: ASOF, unknownReason: "claude_no_statusline_cache_yet", automationUse: "do_not_automate" as const };
    const svc = new ProviderServiceImpl({ db: createFullTestDb(), listRigs: () => [], env: emptyCodexHomeEnv(), now: () => ASOF, collectClaudeSignals: () => [sig] });
    const model = await svc.getReadModel();
    expect(model.signals).toEqual([sig]);
  });

  it("a Claude refresh also reads each seat-owned Claude home's login, once per distinct home, and the read model names it per seat", async () => {
    const { RigRepository } = await import("../src/domain/rig-repository.js");
    const db = createFullTestDb();
    const rigRepo = new RigRepository(db);
    const rig = rigRepo.createRig("ez");
    const { SessionRegistry } = await import("../src/domain/session-registry.js");
    const registry = new SessionRegistry(db);
    for (const [id, home] of [["build.impl", "/h/.claude-cel"], ["build.ux", "/h/.claude-cel"], ["exec.cos", undefined]] as const) {
      const node = rigRepo.addNode(rig.id, id, { runtime: "claude-code", cwd: "/w", ...(home ? { claudeConfigDir: home } : {}) });
      registry.updateStatus(registry.registerSession(node.id, `${id.replace(".", "-")}@ez`).id, "running");
    }
    const reads: string[] = [];
    const svc = new ProviderServiceImpl({
      db, listRigs: () => [{ id: rig.id }], env: { ...emptyCodexHomeEnv(), HOME: "/h" }, now: () => ASOF,
      usageWindows: { enabled: () => true,
        windows: new CodexUsageWindows({ read: async () => ({ ok: false, at: ASOF, reason: "spawn_failed", detail: "not part of this test" }) }),
        claude: new ClaudeUsageWindows({ readIdentity: async () => ({ ok: false, at: ASOF, reason: "auth_status_failed", detail: "the daemon's own home is not this test" }), listSamples: () => [] }) },
      readClaudeHomeIdentity: async (home) => { reads.push(home); return { ok: true, observedAt: ASOF, auth: { loggedIn: true, authMethod: "claude.ai", email: "cel@example.test", orgId: "o", orgName: null, subscriptionType: "max" } }; },
    });
    const before = await svc.getReadModel();
    expect(before.seatAccounts?.find((a) => a.seatSession === "build-impl@ez")?.configured).toMatchObject({ source: "seat_home", home: "/h/.claude-cel", login: null });
    await svc.refreshUsage("claude");
    expect(reads).toEqual(["/h/.claude-cel"]);
    const after = await svc.getReadModel();
    expect(after.seatAccounts?.find((a) => a.seatSession === "build-ux@ez")?.configured).toMatchObject({ source: "seat_home", login: { outcome: "ok", loggedIn: true, email: "cel@example.test" } });
    expect(after.seatAccounts?.find((a) => a.seatSession === "exec-cos@ez")?.configured).toMatchObject({ source: "default_login" });
    db.close();
  });
});

