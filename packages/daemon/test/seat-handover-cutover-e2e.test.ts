import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { HcAdapter } from "../src/adapters/hc-adapter.js";
import { hcTerminalName } from "../src/adapters/hc-host.js";
import type { HcTerminal } from "../src/adapters/hc-client.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { DiscoveryRepository } from "../src/domain/discovery-repository.js";
import { EventBus } from "../src/domain/event-bus.js";
import { SeatHandoverService } from "../src/domain/seat-handover-service.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { createDb } from "../src/db/connection.js";
import { findHc, startHcScratch, type HcScratch } from "./helpers/hc-scratch.js";
import { waitUntil } from "./helpers/hc-private-core.js";

// P14 — the committed money-proof e2e for the seat-handover CUTOVER (r1's LOW-optional). Drives the REAL handover
// (createSuccessor → terminateRetiree → respawn → commit) against a PRIVATE hc core, proving the retiree's process is DEAD,
// its history stays READABLE, and the successor boots under the SAME seat name, on BOTH the graceful and forced retiree-exit
// paths.
//
// What hc changes (design-hc-cutover §3 gap 5): there is no pane to keep. A respawn is kill, then run again under the same
// name and labels, so the terminal's ADDRESS changes (the binding follows the label), and the predecessor's scrollback is not
// above the successor's output: it stays readable at its old address as a finished terminal. The tmux money proof "the SAME
// pane id, scrollback in the SAME pane" has no meaning here; what it guarded, that the predecessor's history survives the
// cutover, is asserted at the old address.
//
// Isolation: the core is helpers/hc-scratch.ts's (own HOME, HC_SESSION and XDG paths, a verified stop at the end, an orphan
// guard); the adapter reaches that core's socket and no other. Skips when hc is unavailable.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const HC = findHc();
let core: HcScratch | undefined;
const scratch = (): HcScratch => (core ??= startHcScratch());

afterAll(() => { core?.cleanup(); });

const get = (terminal: string) => scratch().client().call<HcTerminal>("terminal.get", { terminal });
const typeLine = (seat: string, text: string) => scratch().client().call("terminal.send", { terminal: hcTerminalName(seat), text });
const read = async (terminal: string, lines: number) => (await scratch().client().call<{ text: string }>("terminal.read", { terminal, lines })).text;

describe("seat-handover cutover money-proof (private hc core, both retiree-exit paths)", () => {
  it.runIf(HC !== null)(
    "the retiree dies, predecessor history stays readable, and the successor boots under the SAME seat name on graceful + forced paths",
    async () => {
      const adapter = new HcAdapter(scratch().client());
      // Verify isolation FIRST: the private core must show no seat before this run starts one.
      expect(await adapter.listSessions()).toEqual([]);

      for (const graceful of [true, false]) {
        const SEAT = `dev-impl@${graceful ? "graceful" : "forced"}-rig`;
        const created = await adapter.createSession(SEAT, "/tmp");
        expect(created, "the seat's terminal is created").toEqual({ ok: true });
        await sleep(300);
        const before = await get(hcTerminalName(SEAT));
        const address = before.address;
        // GRACEFUL: arm a SIGTERM trap so the retiree shell exits cleanly; FORCED: no trap → SIGKILL fallback.
        if (graceful) await typeLine(SEAT, "trap 'exit 0' TERM");
        // 150 predecessor lines → real DEEP scrollback (past the terminal's 120-row screen).
        await typeLine(SEAT, "i=1; while [ $i -le 150 ]; do echo v1_line_${i}_atom_A5; i=$((i+1)); done");
        await waitUntil(() => read(address, 400), (text) => text.includes("v1_line_150_atom_A5"), "the predecessor's last line");

        const db = createDb(); db.pragma("foreign_keys = ON"); migrate(db, ALL_MIGRATIONS);
        const rigRepo = new RigRepository(db), sessionRegistry = new SessionRegistry(db);
        const discoveryRepo = new DiscoveryRepository(db), eventBus = new EventBus(db);
        const rig = rigRepo.createRig(`${graceful ? "graceful" : "forced"}-rig`);
        const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "codex", cwd: "/tmp" });
        const session = sessionRegistry.registerSession(node.id, SEAT);
        sessionRegistry.updateStatus(session.id, "running");
        sessionRegistry.updateStartupStatus(session.id, "ready", new Date("2026-08-07T09:00:00Z").toISOString());
        sessionRegistry.updateBinding(node.id, { attachmentType: "hc", tmuxSession: SEAT, terminalAddress: address });

        const marker = {
          runtime: "codex",
          async launchHarness(binding: any) {
            await typeLine(binding.tmuxSession, "printf '\\n=== SUCCESSOR v2 in the SAME seat ===\\n'; stty -echo 2>/dev/null; cat");
            await sleep(150);
            return { ok: true, resumeToken: "tok", resumeType: "codex_id" };
          },
          async checkReady() { return { ready: true }; },
        };
        const service = new SeatHandoverService({
          db, rigRepo, sessionRegistry, discoveryRepo, eventBus,
          tmuxAdapter: adapter, runtimeAdapters: { codex: marker as any },
          predecessorRecapResolver: () => ({ recap: [{ role: "user", content: "finish A5" }, { role: "assistant", content: "A5 landed; handing to v2" }], recordPath: "/tmp/pred-record.jsonl" }),
          readinessTimeoutMs: 3000, sleep,
          seatCwdFault: () => null, // fixture seat folders are fake paths
        });

        // (i-a) capture the retiree PROCESS (the terminal's root pid) BEFORE cutover — the
        // ghost-wake source (specimen 5) was gen-1's SESSION-LOCAL memory-only cron, which
        // lives and dies INSIDE this process. Proving the retiree is dead post-handover is
        // the class-closing pin: a session-local automation cannot fire once its process is gone.
        const retireePid = before.pid;
        expect(retireePid, "hc reports the retiree's pid").toBeGreaterThan(1);

        const result: any = await service.handover({ seatRef: SEAT, reason: "context ~85%", source: "fresh", operator: "orch@seat" });
        await sleep(500);
        const after = await get(hcTerminalName(SEAT));
        const cap = await read(after.address, 400);
        const old = await get(address);
        const oldCap = await read(address, 400);
        const predLines = oldCap.split("\n").filter((l) => l.includes("v1_line_")).length;

        // The money proof, both paths:
        expect(result.ok, `${graceful ? "graceful" : "forced"} handover: ${JSON.stringify(result)}`).toBe(true);
        expect(after.state, "the seat's name now answers with a live terminal").toBe("live");
        expect(after.labels["openrig.seat"], "the successor carries the seat's canonical name").toBe(SEAT);
        expect(after.address, "a respawn mints a new address (no pane to keep)").not.toBe(address);
        expect(sessionRegistry.getBindingForNode(node.id), "the binding follows the label to the new terminal")
          .toMatchObject({ attachmentType: "hc", terminalAddress: after.address });
        expect(old.state, "the predecessor's terminal is finished, not removed").toBe("finished");
        expect(predLines, "predecessor deep history PRESERVED, readable at its old address").toBeGreaterThan(100);
        expect(cap, "successor booted in the seat's new terminal").toContain("SUCCESSOR v2");
        expect(cap, "stopgap from-record recap fired").toContain("from record");
        // The terminal carries no scrollback of the predecessor's. What the successor was DELIVERED is another matter: the restore
        // packet quotes the retiree's visible screen on purpose ("Predecessor terminal (captured)"), so the packet's own text is
        // set aside and what the new terminal held before it arrived is what must be clean. The history above the captured
        // screen (line 1 of 150 on a 120-row terminal) must be in neither.
        const packetAt = cap.indexOf("=== OpenRig seat handover");
        expect(packetAt, "the restore packet reached the successor's terminal").toBeGreaterThan(0);
        expect(cap.slice(0, packetAt), "the predecessor's lines are not in the successor's terminal before the packet").not.toContain("v1_line_");
        expect(cap, "the predecessor's history above the captured screen was not carried over").not.toContain("v1_line_1_atom_A5");

        // (i-a) THE CLASS-CLOSING PIN: the retiree process is DEAD post-handover, so its
        // session-local memory-only automations (crons/timers registered in-process — the
        // ghost-wake source) died with it. A regression that let the retiree survive the
        // cutover (or respawned WITHOUT terminating it first) flips this red.
        let retireeAlive = true;
        try { execFileSync("sh", ["-c", `kill -0 ${retireePid}`], { stdio: "ignore" }); }
        catch { retireeAlive = false; }
        expect(retireeAlive, `${graceful ? "graceful" : "forced"} retiree process (pid ${retireePid}) DEAD post-handover — session-local automations die with it`).toBe(false);
        db.close();
      }
    },
    60_000,
  );
});
