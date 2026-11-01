import fs from "node:fs";
import type Database from "better-sqlite3";
import { codexSeatGate } from "../../adapters/codex-seat-gate.js";
import { hookSeatGate } from "../../adapters/hook-seat-gate.js";
import type { HookSeenStore } from "../../adapters/hook-seen-store.js";
import { parsePiRunnerState, piSeatPaths, type PiRunnerState } from "../../adapters/pi-runner-protocol.js";
import { piSeatGate } from "../../adapters/seat-gate-readers.js";
import { ClaudeSeatHop, CodexSeatHop, PiSeatHop, type ForegroundGroupOf, type HcHopInput, type HopGuard, type HopRows } from "../../adapters/seat-hops.js";
import type { HcClient } from "../../adapters/hc-client.js";
import type { ClaudeNativeInbox } from "../claude-native-inbox.js";
import type { LastHop, MessageId, SeatGate } from "./ports.js";
import type { SeatMessagingPorts } from "./pump-ports.js";

export interface RuntimeSeatPortsDeps {
  db: Database.Database;
  rows: HopRows & { nonceOf(id: MessageId): string | null };
  hookStore: HookSeenStore;
  stateRoots: { pi: string; omp: string };
  client: Pick<HcClient, "call">;
  input: HcHopInput;
  guard: HopGuard;
  /** Read late: the inbox is built after these ports. */
  inbox: () => Pick<ClaudeNativeInbox, "eligibility" | "writeToSeat" | "transcriptOf">;
  fileIncludes: (path: string, needle: string) => boolean | null;
  rolloutOf: (seat: string) => string | null;
  foregroundGroup?: ForegroundGroupOf;
}

/** Which gate a seat declared at launch. Only these runtimes have one: pda, terminal and stub seats are not the pump's, and a seat of a
 *  gated runtime that never declared (an older relay or runner) stays as it was. */
export class RuntimeSeatPorts implements SeatMessagingPorts {
  private readonly claudeHop: LastHop;
  private readonly codexHop: LastHop;
  private readonly piHop: LastHop;

  constructor(private readonly deps: RuntimeSeatPortsDeps) {
    const { rows, guard, client, input } = deps;
    this.claudeHop = new ClaudeSeatHop({
      rows, guard, client, input,
      foregroundGroup: deps.foregroundGroup,
      eligibility: (seat) => deps.inbox().eligibility(seat),
      writeToSeat: (endpoint, sender, text) => deps.inbox().writeToSeat(endpoint, sender, text),
    });
    this.codexHop = new CodexSeatHop({ rows, guard, client, input, foregroundGroup: deps.foregroundGroup });
    this.piHop = new PiSeatHop({ rows, guard, client, input, runnerState: (seat) => this.runnerState(seat) });
  }

  private runtimeOf(seat: string): string | null {
    const rows = this.deps.db.prepare(`SELECT n.runtime AS runtime, r.archived_at AS archivedAt FROM nodes n JOIN rigs r ON r.id = n.rig_id LEFT JOIN bindings b ON b.node_id = n.id
      WHERE b.tmux_session = ? OR (b.tmux_session IS NULL AND replace(n.logical_id, '.', '-') || '@' || r.name = ?) ORDER BY r.created_at DESC`).all(seat, seat) as Array<{ runtime: string | null; archivedAt: string | null }>;
    const live = rows.filter((row) => row.archivedAt === null);
    if (live.length > 0) return live.length === 1 ? live[0]!.runtime : null;
    // An archived rig's seat keeps its gate: a record beats the seat's end, and its messages go back to their senders through the pump.
    return rows[0]?.runtime ?? null;
  }

  private stateRoot(runtime: string | null): string | null {
    return runtime === "pi" ? this.deps.stateRoots.pi : runtime === "omp" ? this.deps.stateRoots.omp : null;
  }

  private runnerState(seat: string): PiRunnerState | null {
    const root = this.stateRoot(this.runtimeOf(seat));
    if (root === null) return null;
    try { return parsePiRunnerState(fs.readFileSync(piSeatPaths(root, seat).runnerStatePath, "utf8")); } catch { return null; }
  }

  gateFor(seat: string): SeatGate | null {
    const runtime = this.runtimeOf(seat);
    const { hookStore: store, rows } = this.deps;
    const nonce = (id: MessageId) => rows.nonceOf(id);
    if (runtime === "claude-code") {
      if (store.declaredVersion(seat) === null) return null;
      return hookSeatGate({
        store, nonceOf: nonce, fileIncludes: this.deps.fileIncludes,
        transcriptsOf: (name) => { const path = this.deps.inbox().transcriptOf(name) ?? store.declaredTranscript(name); return path === null ? [] : [path]; },
      });
    }
    if (runtime === "codex") return store.declaredVersion(seat) === null ? null : codexSeatGate({ store, nonceOf: nonce, rolloutPathOf: (name) => this.deps.rolloutOf(name) ?? store.declaredTranscript(name) });
    const stateRoot = this.stateRoot(runtime);
    if (stateRoot === null || this.runnerState(seat)?.seatGate === undefined) return null;
    return piSeatGate({ stateRoot, nonceOf: nonce });
  }

  hopFor(seat: string): LastHop | null {
    if (this.gateFor(seat) === null) return null;
    const runtime = this.runtimeOf(seat);
    return runtime === "claude-code" ? this.claudeHop : runtime === "codex" ? this.codexHop : this.piHop;
  }
}
