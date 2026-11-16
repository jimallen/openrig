import { STARTUP_FROM_FORMS, parseStartupFrom, type SeatStartupSpecReader, type StartupFrom } from "../domain/seat-startup-source.js";
import { OutboxHandler } from "../domain/outbox-handler.js";
import { Hono } from "hono";
import type { RigRepository } from "../domain/rig-repository.js";
import type { SessionRegistry } from "../domain/session-registry.js";
import type { DiscoveryRepository } from "../domain/discovery-repository.js";
import type { EventBus } from "../domain/event-bus.js";
import type { TmuxAdapter } from "../adapters/tmux.js";
import { observeClaudePaneStartedAt } from "../domain/native-process-lineage.js";
import { SeatStatusService } from "../domain/seat-status-service.js";
import { SeatHandoverService } from "../domain/seat-handover-service.js";
import { SeatSwitchClientService } from "../domain/seat-switch-client-service.js";
import { SeatLifecycleService } from "../domain/seat-lifecycle-service.js";
import { makePredecessorRecapResolver } from "../domain/predecessor-recap-resolver.js";
import type { ContextUsageStore } from "../domain/context-usage-store.js";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { resolveAuthoredRecapPointer } from "../domain/context-packs/seat-recap-store.js";
import { buildRebuildPrimingChain } from "../domain/rebuild-priming-chain.js";
import { OPENRIG_HOME } from "../openrig-compat.js";
import { SettingsStore } from "../domain/user-settings/settings-store.js";
import { transportSenderSession } from "./require-sender-identity.js";
import { listQueued } from "../domain/seat-messaging/queued-messages.js";
import { SqliteQueuedMessages } from "../adapters/sqlite-queued-messages.js";
import { nodeRelaunchChecks, type SeatLeaseStore } from "../adapters/seat-lease-store.js";
import { RELAUNCH_CHECK_NAMES, type RelaunchCheckName } from "../domain/relaunch-checks.js";

export const seatRoutes = new Hono();

const QUEUED_DEFAULT_LIMIT = 100;
const QUEUED_MAX_LIMIT = 1000;

// S09 is an independent delivery preference, never a lifecycle or permission change.
seatRoutes.post("/set-typing-guard/:seatRef", async c => {
  const guard = (c.get("tmuxAdapter" as never) as TmuxAdapter).deliveryGuard;
  if (!guard) return c.json({ error: "Delivery guard unavailable" }, 503);
  const body = await c.req.json<Record<string, unknown>>();
  if (typeof body.enabled !== "boolean" || typeof body.reason !== "string" || !body.reason.trim()) {
    return c.json({ error: "enabled boolean and reason required" }, 400);
  }
  const actor = transportSenderSession(c);
  if (!actor) return c.json({ error: "Sender identity required for preference audit" }, 400);
  try {
    const target = guard.target(c.req.param("seatRef"));
    const preference = await guard.set(target.nodeId, body.enabled, actor, body.reason);
    return c.json({ ...preference, tradeoff: "Automatic terminal input is paused while enabled, even at an empty prompt. Disabling does not replay retained messages." }, preference.pending ? 202 : 200);
  } catch (error) { return c.json({ error: (error as Error).message }, 409); }
});

seatRoutes.get("/held-messages/:seatRef", c => {
  const guard = (c.get("tmuxAdapter" as never) as TmuxAdapter).deliveryGuard;
  if (!guard) return c.json({ error: "Delivery guard unavailable" }, 503);
  try {
    const target = guard.target(c.req.param("seatRef"));
    const outbox = new OutboxHandler(guard.db);
    const id = c.req.query("id");
    if (id) {
      const entry = outbox.getById(id);
      if (entry?.guardBinding?.nodeId !== target.nodeId) return c.json({ error: "No retained history for this node and ID" }, 404);
      return c.json({ entry });
    }
    return c.json(outbox.heldForNode(target.nodeId, Number(c.req.query("limit") ?? 100), Number(c.req.query("offset") ?? 0)));
  } catch (error) { return c.json({ error: (error as Error).message }, 400); }
});

// workspaces-o9o.9: the rows `rig send` calls "queued" — open, owed a delivery by the pump — which held-messages (the guard's retained rows)
// never lists. Keyed on the exact session name, as cancel-message is, so an id read here is the id that command takes. Read-only.
seatRoutes.get("/queued/:seat", c => {
  const outbox = c.get("outboxHandler" as never) as OutboxHandler | undefined;
  if (!outbox) return c.json({ error: "Outbox unavailable" }, 503);
  const raw = Number(c.req.query("limit") ?? QUEUED_DEFAULT_LIMIT);
  const limit = Number.isInteger(raw) && raw > 0 ? Math.min(raw, QUEUED_MAX_LIMIT) : QUEUED_DEFAULT_LIMIT;
  return c.json(listQueued(new SqliteQueuedMessages(outbox.db), c.req.param("seat"), limit));
});

seatRoutes.post("/retire-held-message/:seatRef/:id", async c => {
  const guard = (c.get("tmuxAdapter" as never) as TmuxAdapter).deliveryGuard;
  if (!guard) return c.json({ error: "Delivery guard unavailable" }, 503);
  const body = await c.req.json<Record<string, unknown>>();
  const actor = transportSenderSession(c);
  if (!actor || typeof body.reason !== "string" || !body.reason.trim()) return c.json({ error: "Sender identity and reason required" }, 400);
  try {
    const target = guard.target(c.req.param("seatRef"));
    const outbox = new OutboxHandler(guard.db); const id = c.req.param("id");
    // OF-168: a held message whose binding is not JSON names no seat, so it cannot be matched to this one; it is released by id (the
    // quota refusal names this command), and the retirement records that the binding was unreadable.
    if (!outbox.isUnreadableHeld(id) && outbox.getById(id)?.guardBinding?.nodeId !== target.nodeId) return c.json({ error: "No held message for this node and ID" }, 404);
    return c.json({ entry: outbox.retire(id, actor, body.reason), effect: "Retired from active quota; evidence preserved. No delivery, native consumption or work closure is asserted." });
  } catch (error) { return c.json({ error: (error as Error).message }, 409); }
});

seatRoutes.get("/status/:seatRef", (c) => {
  const rigRepo = c.get("rigRepo" as never) as RigRepository;
  const service = new SeatStatusService({ rigRepo });
  const result = service.getStatus(c.req.param("seatRef")!);

  if (result.ok) {
    const guard = (c.get("tmuxAdapter" as never) as TmuxAdapter | undefined)?.deliveryGuard;
    const target = guard?.maybeTarget(c.req.param("seatRef")!);
    return c.json({ ...result.status, ...(guard && target ? { typingGuard: {
      ...guard.preference(target.nodeId), heldCount: new OutboxHandler(guard.db).heldForNode(target.nodeId, 1).total,
    } } : {}) });
  }

  if (result.code === "seat_ambiguous") {
    return c.json(result, 409);
  }
  if (result.code === "seat_ref_required") {
    return c.json(result, 400);
  }
  return c.json(result, 404);
});

seatRoutes.post("/handover/:seatRef", async (c) => {
  const body: Record<string, unknown> = await c.req.json().catch(() => ({}));
  const rigRepo = c.get("rigRepo" as never) as RigRepository;
  const service = new SeatHandoverService({
    db: rigRepo.db,
    rigRepo,
    sessionRegistry: c.get("sessionRegistry" as never) as SessionRegistry,
    discoveryRepo: c.get("discoveryRepo" as never) as DiscoveryRepository,
    eventBus: c.get("eventBus" as never) as EventBus,
    tmuxAdapter: c.get("tmuxAdapter" as never) as TmuxAdapter,
    sessionEnv: (c.get("sessionEnv" as never) as Record<string, string | undefined> | undefined) ?? undefined,
    runtimeSessionEnv: (c.get("runtimeSessionEnv" as never) as Record<string, Record<string, string | undefined>> | undefined) ?? undefined,
    // B1 — launch a fresh successor into a live agent via the runtime adapters.
    runtimeAdapters: (c.get("runtimeAdapters" as never) as Record<string, import("../domain/runtime-adapter.js").RuntimeAdapter> | undefined) ?? undefined,
    // OPR.0.4.6.02 S1 — the shared tmux option-defaults applier, so a FRESH
    // handover successor gets the same mouse/status/clipboard defaults as a
    // launched seat (orch C1 scope ruling).
    tmuxOptionDefaults: (c.get("tmuxOptionDefaults" as never) as import("../domain/tmux-option-defaults.js").TmuxOptionDefaultsApplier | undefined) ?? undefined,
    // OF-183 — whether this daemon may change the shared Codex config.toml (a handover successor's seat home links to it).
    codexConfigWritePolicy: (c.get("codexConfigWritePolicy" as never) as import("../domain/codex-config-write-policy.js").CodexConfigWritePolicy | undefined) ?? undefined,
    // workspaces-o9o.10: the successor warns, as a fresh launch does, when a Claude seat's own home sets no model.
    claudeHomeRead: { exists: (p) => existsSync(p), isDirectory: (p) => statSync(p).isDirectory(), readFile: (p) => readFileSync(p, "utf8") },
    // B2 — discovered-mode resume-token capture derive-helper deps.
    contextUsageStore: (c.get("contextUsageStore" as never) as import("../domain/resume-token-capture.js").ResumeTokenCaptureDeps["contextUsageStore"]) ?? undefined,
    resumeTokenCapturer: (c.get("resumeMetadataRefresher" as never) as import("../domain/resume-token-capture.js").ResumeTokenCaptureDeps["resumeTokenCapturer"]) ?? undefined,
    // #421 — the pane's current Claude process start time, so capture skips an older sidecar.
    claudeProcessStartedAt: (sessionName: string) => observeClaudePaneStartedAt({ target: sessionName, tmux: c.get("tmuxAdapter" as never) as TmuxAdapter }),
    // Wire the predecessor-recap resolver so the successor boot packet fires
    // with a bounded from-record recap. Reuses the full ContextUsageStore from context (readAndNormalize
    // = claude transcript_path; readCodexAndNormalize = codex rollout_path) + a resume-token lookup for
    // the codex thread id; parseJsonlExchanges is the resolver's default. Absent store → resolver omitted
    // (recap sections omitted honestly). Firing proven live in the money-proof e2e.
    predecessorRecapResolver: (() => {
      const store = c.get("contextUsageStore" as never) as ContextUsageStore | undefined;
      if (!store) return undefined;
      const db = rigRepo.db;
      return makePredecessorRecapResolver({
        // B16 — session_id rides the read so the resolver can verify the name-keyed sidecar is the
        // PREDECESSOR's (canonical-name reuse means a booted successor overwrites it).
        readClaudeRecord: (sessionName) => {
          const usage = store.readAndNormalize(sessionName);
          return { transcriptPath: usage.transcriptPath, sessionId: usage.sessionId ?? null };
        },
        readCodexTranscriptPath: (args) => store.readCodexAndNormalize(args).transcriptPath,
        lookupResumeToken: (nodeId, sessionName) => {
          const row = db
            .prepare("SELECT resume_token FROM sessions WHERE node_id = ? AND session_name = ? ORDER BY id DESC LIMIT 1")
            .get(nodeId, sessionName) as { resume_token: string | null } | undefined;
          return row?.resume_token ?? null;
        },
      });
    })(),
    // OPR.0.5.3.5 mini-req 7 — the AUTHORED recap pointer for the successor
    // packet: seat dir from topology.root CONFIG (slice-06 D1 layout); every
    // outcome labeled — present with chain depth, or a named absence carrying
    // the path tried (a seat-id/directory mapping gap surfaces loudly at the
    // door drive instead of silently).
    authoredRecapResolver: (seatRef: string) => {
      const topologyRoot = String(new SettingsStore().resolveOne("topology.root").value);
      return resolveAuthoredRecapPointer(seatRef, topologyRoot);
    },
    // OPR.0.5.5.5 (fix B3) — the ONE production rebuild priming chain builder
    // (rebuild-priming-chain.ts): RECAP.md, LEARNED.md, latest restore packet
    // when the seat's restore-pending marker names one, superseded recaps
    // newest-first. Declares only; the service existence-filters (named gaps).
    rebuildPrimingResolver: (seatRef: string) => buildRebuildPrimingChain(seatRef, {
      topologyRoot: String(new SettingsStore().resolveOne("topology.root").value),
      openrigHome: OPENRIG_HOME,
    }),
    // OPR.0.4.6.PI1 FR-6 — the Pi adapter in the runtime-adapter map exposes
    // the pi-runner sidecar reader; reuse it structurally (no new context var).
    piRunnerStateStore: (() => {
      const adapters = c.get("runtimeAdapters" as never) as Record<string, unknown> | undefined;
      const pi = adapters?.["pi"] as { readSessionFile?: (sessionName: string) => { ok: true; sessionFile: string } | { ok: false; reason: string } } | undefined;
      return typeof pi?.readSessionFile === "function"
        ? { readSessionFile: pi.readSessionFile.bind(pi) as (sessionName: string) => { ok: true; sessionFile: string } | { ok: false; reason: string } }
        : undefined;
    })(),
    ompRunnerStateStore: (() => {
      const adapters = c.get("runtimeAdapters" as never) as Record<string, unknown> | undefined;
      const omp = adapters?.["omp"] as { readSessionFile?: (sessionName: string) => { ok: true; sessionFile: string } | { ok: false; reason: string } } | undefined;
      return typeof omp?.readSessionFile === "function"
        ? { readSessionFile: omp.readSessionFile.bind(omp) }
        : undefined;
    })(),
    // GHOST-STAGE (e/Class-B) — the canonical OccupantInvalidator so commit()'s re-key call fires
    // (invalidate the retiring occupant's seat-name-keyed stores before the successor accumulates any).
    occupantInvalidator: (c.get("occupantInvalidator" as never) as import("../domain/occupant-invalidator.js").OccupantInvalidator | undefined) ?? undefined,
    // WAVE-O B1 (R2 508e383d) — the daemon's ONE SeatActivityService rides every
    // production handover construction, so a real committed swap reaches
    // declareOccupantSwap and the successor never inherits the retiree's evidence or
    // promoted rung authority. Optional in the deps contract; ALWAYS wired here.
    activityOracle: (c.get("seatActivityService" as never) as import("../domain/seat-activity-service.js").SeatActivityService | undefined) ?? undefined,
  });
  const result = await service.handover({
    seatRef: c.req.param("seatRef")!,
    reason: typeof body["reason"] === "string" ? body["reason"] : null,
    source: typeof body["source"] === "string" ? body["source"] : null,
    operator: typeof body["operator"] === "string" ? body["operator"] : null,
    dryRun: body["dryRun"] === true,
  });

  if (result.ok) {
    return c.json("plan" in result ? result.plan : result.result);
  }

  if (result.code === "missing_reason" || result.code === "invalid_source") {
    return c.json(result, 400);
  }
  if (result.code === "seat_ambiguous") {
    return c.json(result, 409);
  }
  if (result.code === "successor_creation_not_implemented" ||
    result.code === "source_not_supported") {
    return c.json(result, 501);
  }
  if (result.code === "tmux_probe_failed") {
    return c.json(result, 502);
  }
  if (result.code === "current_occupant_required" ||
    result.code === "adopted_occupant" || // OF-164: the person releases or stops it first
    result.code === "discovered_not_active" ||
    result.code === "successor_tmux_absent" ||
    result.code === "successor_already_managed" ||
    result.code === "successor_is_current" ||
    result.code === "runtime_mismatch" ||
    result.code === "handover_unsupported_runtime") {
    return c.json(result, 409);
  }
  if (result.code === "seat_ref_required") {
    return c.json(result, 400);
  }
  if (result.code === "seat_cwd_unusable" || result.code === "claude_config_dir_missing") {
    return c.json(result, 409); // the person can fix it: create the folder (OF-124), or the seat's Claude home
  }
  if (result.code === "handover_commit_failed" ||
    result.code === "successor_create_failed" ||
    result.code === "context_delivery_failed") {
    return c.json(result, 500);
  }
  return c.json(result, 404);
});

// S5 (OPR.0.5.4.7) — the seat-lifecycle verb surface: set-model / stop / clean.
// One service, one resolution path, one status mapping shared by all three verbs.
export function seatLifecycleService(c: { get(key: never): unknown }): SeatLifecycleService {
  const rigRepo = c.get("rigRepo" as never) as RigRepository;
  const seatLeases = c.get("seatLeases" as never) as SeatLeaseStore | undefined;
  return new SeatLifecycleService({
    db: rigRepo.db,
    rigRepo,
    sessionRegistry: c.get("sessionRegistry" as never) as SessionRegistry,
    eventBus: c.get("eventBus" as never) as EventBus,
    tmuxAdapter: c.get("tmuxAdapter" as never) as TmuxAdapter,
    nodeLauncher: c.get("nodeLauncher" as never) as import("../domain/node-launcher.js").NodeLauncher,
    startupOrchestrator: (c.get("startupOrchestrator" as never) as import("../domain/startup-orchestrator.js").StartupOrchestrator | undefined) ?? undefined,
    runtimeAdapters: (c.get("runtimeAdapters" as never) as Record<string, import("../domain/runtime-adapter.js").RuntimeAdapter> | undefined) ?? undefined,
    occupantInvalidator: (c.get("occupantInvalidator" as never) as import("../domain/occupant-invalidator.js").OccupantInvalidator | undefined) ?? undefined,
    activityOracle: (c.get("seatActivityService" as never) as import("../domain/seat-activity-service.js").SeatActivityService | undefined) ?? undefined,
    transcripts: (c.get("contextUsageStore" as never) as ContextUsageStore | undefined) ?? undefined,
    // OF-32: the instantiator re-reads a fresh seat's startup policy from its rig's spec source.
    seatStartupSource: (c.get("podInstantiator" as never) as SeatStartupSpecReader | undefined) ?? undefined,
    mcpTrust: (c.get("mcpTrust" as never) as import("../domain/seat-lifecycle-service.js").SeatLifecycleDeps["mcpTrust"] | undefined) ?? undefined,
    // set-claude-home's read-only findings about a Claude home (names only; never a credential file).
    claudeHomeRead: { exists: (p) => existsSync(p), isDirectory: (p) => statSync(p).isDirectory(), readFile: (p) => readFileSync(p, "utf8") },
    // workspaces-o9o.8: the seat's leases and folder, read before a fresh launch stops a live occupant.
    ...(seatLeases ? { seatLeases, relaunchChecks: nodeRelaunchChecks(seatLeases) } : {}),
  });
}

function seatLifecycleStatus(code: string): 400 | 404 | 409 | 500 | 502 {
  if (code === "seat_ref_required" || code === "missing_model" || code === "missing_reason" || code === "fresh_required"
    || code === "missing_effort" || code === "invalid_effort" || code === "invalid_startup_from" || code === "invalid_hand_over_since"
    || code === "missing_actor" || code === "invalid_mcp_server" || code === "invalid_mcp_state" || code === "invalid_mcp_spec_file" || code === "apply_spec_invalid_spec_file"
    || code === "invalid_claude_config_dir" || code === "invalid_despite" || code === "invalid_lease_holder" || code === "invalid_lease_pid") return 400;
  if (code === "seat_not_found" || code === "lease_not_found") return 404;
  if (code === "tmux_probe_failed") return 502;
  if (code === "launch_unavailable" || code === "runtime_adapter_missing" || code === "launch_failed" || code === "startup_failed"
    || code === "effort_unavailable" || code === "mcp_unavailable" || code === "apply_spec_not_saved" || code === "claude_home_unavailable"
    || code === "leases_unavailable") return 500;
  // seat_ambiguous / session_live / session_not_live / no_session / claimed_session /
  // nothing_to_clean — state conflicts, not client syntax errors.
  return 409;
}

seatRoutes.post("/set-permissions/:seatRef", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  const actor = transportSenderSession(c) ?? (typeof body?.operator === "string" ? body.operator.trim() : undefined);
  if (!actor) return c.json({ error: "Sender identity is required; pass --operator <address> when running outside a managed seat." }, 400);
  if (!body || Array.isArray(body) || typeof body.mode !== "string") return c.json({ error: "mode is required" }, 400);
  if (typeof body.reason !== "string") return c.json({ error: "reason is required" }, 400);
  const result = await seatLifecycleService(c).setPermissions({
    seatRef: c.req.param("seatRef"), mode: body.mode, reason: body.reason, actor,
  });
  return c.json(result, result.ok ? 200 : seatLifecycleStatus(result.code));
});

seatRoutes.post("/set-model/:seatRef", async (c) => {
  const body: Record<string, unknown> = await c.req.json().catch(() => ({}));
  const result = await seatLifecycleService(c).setModel({
    seatRef: c.req.param("seatRef")!,
    model: typeof body["model"] === "string" ? body["model"] : "",
    reason: typeof body["reason"] === "string" ? body["reason"] : "",
    operator: typeof body["operator"] === "string" ? body["operator"] : null,
  });
  if (result.ok) return c.json(result);
  return c.json(result, seatLifecycleStatus(result.code));
});

// OPR.0.7.0.7 — save (or, with clear: true, remove) one seat's effort choice for its next
// managed continuation. A distinct route fails closed against daemons without it.
seatRoutes.post("/set-effort/:seatRef", async (c) => {
  const body: Record<string, unknown> = await c.req.json().catch(() => ({}));
  const clear = body["clear"] === true;
  if (clear && body["effort"] !== undefined) return c.json({ ok: false, code: "invalid_effort", message: "Pass an effort level or clear, not both." }, 400);
  const result = await seatLifecycleService(c).setEffort({
    seatRef: c.req.param("seatRef")!,
    effort: clear ? null : typeof body["effort"] === "string" ? body["effort"] : "",
    reason: typeof body["reason"] === "string" ? body["reason"] : "",
    operator: typeof body["operator"] === "string" ? body["operator"] : null,
  });
  if (result.ok) return c.json(result);
  return c.json(result, seatLifecycleStatus(result.code));
});

// A Claude seat's own Claude config home for its next launch (or, with clear: true, back to the daemon's own). Audited.
seatRoutes.post("/set-claude-home/:seatRef", async (c) => {
  const body: Record<string, unknown> = await c.req.json().catch(() => ({}));
  const clear = body["clear"] === true;
  if (clear === (body["dir"] !== undefined)) return c.json({ ok: false, code: "invalid_claude_config_dir", message: "Pass exactly one of a directory or clear." }, 400);
  const result = await seatLifecycleService(c).setClaudeHome({
    seatRef: c.req.param("seatRef")!,
    dir: clear ? null : typeof body["dir"] === "string" ? body["dir"] : "",
    reason: typeof body["reason"] === "string" ? body["reason"] : "",
    operator: transportSenderSession(c) ?? (typeof body["operator"] === "string" ? body["operator"] : null),
  });
  if (result.ok) return c.json(result);
  return c.json(result, seatLifecycleStatus(result.code));
});

// Per-seat Codex MCP servers: switch one declared server on or off for one seat instance (audited, actor required).
seatRoutes.post("/set-mcp/:seatRef", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  const actor = transportSenderSession(c) ?? (typeof body?.operator === "string" ? body.operator.trim() : undefined);
  if (!actor) return c.json({ ok: false, code: "missing_actor", message: "Sender identity is required; pass --operator <address> when running outside a managed seat." }, 400);
  const result = await seatLifecycleService(c).setMcpServer({
    seatRef: c.req.param("seatRef")!,
    server: typeof body["server"] === "string" ? body["server"] : "",
    state: body["state"] === "on" || body["state"] === "off" ? body["state"] : ("" as "on"),
    reason: typeof body["reason"] === "string" ? body["reason"] : "",
    actor,
    ...(typeof body["specFile"] === "string" ? { specFile: body["specFile"] } : {}),
  });
  if (result.ok) return c.json(result);
  return c.json(result, seatLifecycleStatus(result.code));
});

// OF-283 — apply a seat's retained spec fields from the spec: a Pi seat's env_passthrough, model_overrides and
// pi.link_operator_models, a Claude Code seat's remote_control and ask_in_modal.
// A dry run unless `yes` is exactly true; only a write needs an audit actor. Never relaunches anything.
seatRoutes.post("/apply-spec/:seatRef", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  const actor = transportSenderSession(c) ?? (typeof body?.operator === "string" && body.operator.trim() ? body.operator.trim() : null);
  const result = await seatLifecycleService(c).applySpec({
    seatRef: c.req.param("seatRef")!,
    yes: body["yes"] === true,
    actor,
    ...(typeof body["reason"] === "string" ? { reason: body["reason"] } : {}),
    ...(typeof body["specFile"] === "string" ? { specFile: body["specFile"] } : {}),
  });
  if (result.ok) return c.json(result);
  return c.json(result, seatLifecycleStatus(result.code));
});

// OPR.0.7.0.7 — read one seat's effort four ways: requested, saved, emitted at launch, observed natively.
seatRoutes.get("/effort/:seatRef", async (c) => {
  const result = await seatLifecycleService(c).effortReport(c.req.param("seatRef")!);
  if (result.ok) return c.json(result);
  return c.json(result, seatLifecycleStatus(result.code));
});

/** OF-32: where a fresh launch takes its startup policy from; absent means the spec as it is now. */
function startupFromOf(body: Record<string, unknown>): StartupFrom | undefined | null {
  const value = body["startupFrom"];
  if (value === undefined) return undefined;
  return parseStartupFrom(value);
}
const INVALID_STARTUP_FROM = { ok: false, code: "invalid_startup_from", message: `startupFrom must be ${STARTUP_FROM_FORMS}.` } as const;

// workspaces-o9o.8: held relaunch checks the operator names to launch anyway. Anything but an array of check names is refused, never dropped
// (a dropped one would launch without the override the operator meant, or with one they did not).
const INVALID_DESPITE = { ok: false, code: "invalid_despite", message: `despite must be a list of ${RELAUNCH_CHECK_NAMES.join(", ")}.` } as const;
function despiteOf(body: Record<string, unknown>): RelaunchCheckName[] | null {
  const value = body["despite"];
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((name): name is RelaunchCheckName => typeof name === "string" && (RELAUNCH_CHECK_NAMES as readonly string[]).includes(name))) return null;
  return value;
}

seatRoutes.post("/lease/:seatRef", async (c) => {
  const body: Record<string, unknown> = await c.req.json().catch(() => ({}));
  if (typeof body["holder"] !== "string") return c.json({ ok: false, code: "invalid_lease_holder", message: "holder is required." }, 400);
  if (body["release"] !== true && typeof body["pid"] !== "number") return c.json({ ok: false, code: "invalid_lease_pid", message: "pid is required, a number." }, 400);
  const result = seatLifecycleService(c).seatLease({
    seatRef: c.req.param("seatRef")!, holder: body["holder"], release: body["release"] === true,
    ...(typeof body["pid"] === "number" ? { pid: body["pid"] } : {}),
    ...(typeof body["reason"] === "string" && body["reason"].trim() ? { reason: body["reason"].trim() } : {}),
  });
  return result.ok ? c.json(result) : c.json(result, seatLifecycleStatus(result.code));
});

// A distinct route fails closed against older daemons that do not support previews.
seatRoutes.post("/launch-plan/:seatRef", async (c) => {
  const body: Record<string, unknown> = await c.req.json().catch(() => ({}));
  const startupFrom = startupFromOf(body);
  if (startupFrom === null) return c.json(INVALID_STARTUP_FROM, 400);
  const despite = despiteOf(body);
  if (despite === null) return c.json(INVALID_DESPITE, 400);
  const result = await seatLifecycleService(c).planFresh({
    seatRef: c.req.param("seatRef")!, fresh: body["fresh"] === true, stop: body["stop"] === true, startupFrom, despite,
  });
  return result.ok ? c.json(result) : c.json(result, seatLifecycleStatus(result.code));
});

seatRoutes.post("/launch/:seatRef", async (c) => {
  const body: Record<string, unknown> = await c.req.json().catch(() => ({}));
  const startupFrom = startupFromOf(body);
  if (startupFrom === null) return c.json(INVALID_STARTUP_FROM, 400);
  // workspaces-o9o.7: a since-time that is not a string is refused, never dropped (a dropped one would hand over less than asked).
  if (body["handOverSince"] !== undefined && typeof body["handOverSince"] !== "string") {
    return c.json({ ok: false, code: "invalid_hand_over_since", message: "handOverSince must be an ISO 8601 time string, such as 2026-11-15T23:06:06Z." }, 400);
  }
  const despite = despiteOf(body);
  if (despite === null) return c.json(INVALID_DESPITE, 400);
  const result = await seatLifecycleService(c).launchFresh({
    despite,
    startupFrom,
    seatRef: c.req.param("seatRef")!,
    fresh: body["fresh"] === true,
    reason: typeof body["reason"] === "string" ? body["reason"] : "",
    stop: body["stop"] === true,
    operator: typeof body["operator"] === "string" ? body["operator"] : null,
    ...(typeof body["handOverSince"] === "string" ? { handOverSince: body["handOverSince"] } : {}),
  });
  if (result.ok) return c.json(result);
  return c.json(result, seatLifecycleStatus(result.code));
});

// OPR.0.7.0.5 — in-place restart. A refusal (nothing was stopped) is an error status; once a restart ran,
// the reply is 200 and its `outcome` says what happened, so a not-started/incomplete/unknown result is
// reported, never retried by the transport.
seatRoutes.post("/restart-plan/:seatRef", async (c) => {
  const result = await seatLifecycleService(c).restartInPlace({ seatRef: c.req.param("seatRef")!, plan: true });
  return result.ok ? c.json(result) : c.json(result, seatLifecycleStatus(result.code));
});

seatRoutes.post("/restart/:seatRef", async (c) => {
  const body: Record<string, unknown> = await c.req.json().catch(() => ({}));
  const result = await seatLifecycleService(c).restartInPlace({
    seatRef: c.req.param("seatRef")!,
    reason: typeof body["reason"] === "string" ? body["reason"] : "",
    operator: typeof body["operator"] === "string" ? body["operator"] : null,
  });
  return result.ok ? c.json(result) : c.json(result, seatLifecycleStatus(result.code));
});

seatRoutes.post("/restart-verify/:seatRef", async (c) => {
  const body: Record<string, unknown> = await c.req.json().catch(() => ({}));
  const result = await seatLifecycleService(c).verifyRestartInPlace({
    seatRef: c.req.param("seatRef")!,
    expectAccount: typeof body["expectAccount"] === "string" ? body["expectAccount"] : null,
  });
  return result.ok ? c.json(result) : c.json(result, seatLifecycleStatus(result.code));
});

seatRoutes.post("/continue/:seatRef", async (c) => {
  const result = await seatLifecycleService(c).continueFreshStartup(c.req.param("seatRef"));
  return c.json(result, result.ok ? 200 : 409);
});

seatRoutes.post("/stop/:seatRef", async (c) => {
  const body: Record<string, unknown> = await c.req.json().catch(() => ({}));
  const result = await seatLifecycleService(c).stopSeat({
    seatRef: c.req.param("seatRef")!,
    reason: typeof body["reason"] === "string" ? body["reason"] : "",
    operator: typeof body["operator"] === "string" ? body["operator"] : null,
  });
  if (result.ok) return c.json(result);
  return c.json(result, seatLifecycleStatus(result.code));
});

seatRoutes.post("/clean/:seatRef", async (c) => {
  const body: Record<string, unknown> = await c.req.json().catch(() => ({}));
  const result = await seatLifecycleService(c).cleanSeat({
    seatRef: c.req.param("seatRef")!,
    reason: typeof body["reason"] === "string" ? body["reason"] : "",
    operator: typeof body["operator"] === "string" ? body["operator"] : null,
  });
  if (result.ok) return c.json(result);
  return c.json(result, seatLifecycleStatus(result.code));
});

// OPR.0.4.3.26 — seat-recovery VIEW retarget. Points an attached tmux client at
// the seat's canonical session/window. VIEW-ONLY: it resolves the seat READ-ONLY
// (SeatStatusService) and only probes/switches via the tmux adapter (already in
// context). It does NOT construct SeatHandoverService / SessionRegistry writes /
// SessionReconciler and never routes through converge/reconcile — no routing,
// binding, session, transcript, or identity mutation is possible here.
seatRoutes.post("/switch-client/:seatRef", async (c) => {
  const body: Record<string, unknown> = await c.req.json().catch(() => ({}));
  const rigRepo = c.get("rigRepo" as never) as RigRepository;
  const service = new SeatSwitchClientService({
    rigRepo,
    tmuxAdapter: c.get("tmuxAdapter" as never) as TmuxAdapter,
  });

  const rawWindow = body["toWindow"];
  const toWindow = typeof rawWindow === "number" && Number.isInteger(rawWindow) ? rawWindow : null;

  const result = await service.switchClient({
    seatRef: c.req.param("seatRef")!,
    client: typeof body["client"] === "string" && body["client"] !== "" ? body["client"] : null,
    toWindow,
  });

  if (result.ok) {
    return c.json(result.result);
  }

  if (result.code === "seat_ref_required") {
    return c.json(result, 400);
  }
  if (result.code === "seat_not_found" ||
    result.code === "client_not_found" ||
    result.code === "window_not_found") {
    return c.json(result, 404);
  }
  if (result.code === "seat_ambiguous" ||
    result.code === "missing_canonical_session" ||
    result.code === "session_not_found" ||
    result.code === "no_client" ||
    result.code === "ambiguous_client" ||
    // hc has no attached clients: the host cannot do this. A refusal the operator can read (the CLI exits 1 on a 4xx), never the 502 of a tmux-layer failure.
    result.code === "not_supported_on_host") {
    return c.json(result, 409);
  }
  // switch_failed / tmux_probe_failed — a tmux-layer failure, not a client error.
  return c.json(result, 502);
});
