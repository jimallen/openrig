// workspaces-o9o.82 (verify-sec review): the piece is the FIRST record after the pre-send snapshot that is the piece (marked by the daemon,
// or by text with an older daemon), and only that record's own turn can close it. Two user records of identical raw text are both marked;
// a LATER one closing its turn must not stand in for the piece while the piece's own turn is still open.
import { describe, expect, it } from "vitest";
import { analyzeWalkSuffix } from "../src/lib/walk-consumption.js";

const PIECE = "Walk this piece: the complete middle matters.";
const lines = (records: object[]) => records.map((r) => JSON.stringify(r)).join("\n") + "\n";
/** The daemon's mark, or nothing (an older daemon: the text rule). */
const mark = (marked: boolean) => (marked ? { openrigPieceMatch: true } : {});

const claude = (marked: boolean, closes: "first" | "second") => lines([
  { type: "user", uuid: "first", message: { role: "user", content: PIECE }, ...mark(marked) },
  { type: "user", uuid: "second", message: { role: "user", content: PIECE }, ...mark(marked) },
  { type: "assistant", uuid: "answer", parentUuid: closes, message: { role: "assistant", content: "done" } },
  { type: "system", subtype: "turn_duration", uuid: "closed", parentUuid: "answer" },
]);

const codex = (marked: boolean, closes: "turn-1" | "turn-2") => lines([
  { type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } },
  { type: "turn_context", payload: { turn_id: "turn-1" } },
  { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: PIECE }] }, ...mark(marked) },
  ...(closes === "turn-1" ? [{ type: "event_msg", payload: { type: "task_complete", turn_id: "turn-1" } }] : []),
  { type: "event_msg", payload: { type: "task_started", turn_id: "turn-2" } },
  { type: "turn_context", payload: { turn_id: "turn-2" } },
  { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: PIECE }] }, ...mark(marked) },
  ...(closes === "turn-2" ? [{ type: "event_msg", payload: { type: "task_complete", turn_id: "turn-2" } }] : []),
]);

describe("walk binds a piece to its FIRST record after the snapshot", () => {
  describe.each([
    ["daemon marks (serverMatched)", true],
    ["an older daemon (text rule)", false],
  ])("%s", (_mode, marked) => {
    const opts = { serverMatched: marked };

    it("Claude: a later identical prompt closing its turn does not close the piece's open turn", () => {
      expect(analyzeWalkSuffix(claude(marked, "second"), PIECE, opts)).toEqual({ consumed: true, turnClosed: false });
    });

    it("Claude: the piece's own (first) turn closing closes it", () => {
      expect(analyzeWalkSuffix(claude(marked, "first"), PIECE, opts)).toEqual({ consumed: true, turnClosed: true });
    });

    it("Codex: a later identical message's turn completing does not close the piece's open turn", () => {
      expect(analyzeWalkSuffix(codex(marked, "turn-2"), PIECE, opts)).toEqual({ consumed: true, turnClosed: false });
    });

    it("Codex: the piece's own (first) turn completing closes it", () => {
      expect(analyzeWalkSuffix(codex(marked, "turn-1"), PIECE, opts)).toEqual({ consumed: true, turnClosed: true });
    });
  });
});
