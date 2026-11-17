import { redact } from "../restore-packet/redaction.js";

/** Receipt evidence only: complete input and its closed native turn, never comprehension. */
export function analyzeWalkSuffix(suffix: string, content: string): { consumed: boolean; turnClosed: boolean } {
  // CRLF and surrounding whitespace are the only permitted transport normalization.
  // Internal whitespace (including code indentation) remains content.
  const canonical = (text: string) => text.replace(/\r\n/g, "\n").trim();
  const expected = canonical(content);
  // workspaces-o9o.60: the daemon serves the record as a redacted view (the shared transcript policy, which `redact` is
  // the CLI twin of), so a piece holding a secret-shaped string appears there redacted. A record text that equals the
  // piece as sent, or the piece as redacted, is the piece; an older daemon serves it unredacted.
  const redactedExpected = canonical(redact(content));
  const isPiece = (text: string) => expected !== "" && (text === expected || text === redactedExpected);
  const textOf = (value: unknown): string => typeof value === "string" ? value
    : Array.isArray(value) ? value.map(b => (b?.type === "text" || b?.type === "input_text") && typeof b.text === "string" ? b.text : "").join("") : "";
  let consumed = false;
  type Record = {
    type?: string; subtype?: string; uuid?: string; parentUuid?: string; isSidechain?: boolean; isMeta?: boolean;
    message?: { role?: string; content?: unknown };
    payload?: { type?: string; role?: string; content?: unknown; turn_id?: string };
  };
  const claudeRecords = new Map<string, Record>();
  const matchedInputs = new Set<string>();
  const isPrompt = (rec: Record) => rec.type === "user" && rec.message?.role === "user" && !rec.isMeta
    && !(Array.isArray(rec.message.content) && rec.message.content.some(b => b?.type === "tool_result"));
  let activeTurn: string | undefined;
  let matchedTurn: string | undefined;
  for (const line of suffix.split("\n").slice(0, -1)) { // unfinished appends are not evidence
    let rec: Record;
    try { rec = JSON.parse(line); } catch { continue; }
    if (!rec || rec.isSidechain) continue;
    if (rec.type === "compacted") return { consumed, turnClosed: false };
    const p = rec.payload;
    if (rec.type === "event_msg" && p?.type === "task_started") {
      activeTurn = typeof p.turn_id === "string" ? p.turn_id : undefined;
    }
    if (rec.type === "turn_context" && activeTurn !== p?.turn_id) activeTurn = undefined;
    if (rec.type === "response_item" && p?.type === "message" && p.role === "user"
      && isPiece(canonical(textOf(p.content)))) {
      consumed = true;
      matchedTurn = activeTurn;
    }
    if (rec.type === "event_msg" && p?.type === "task_complete") {
      if (matchedTurn && activeTurn === matchedTurn && p.turn_id === matchedTurn) return { consumed: true, turnClosed: true };
      if (p.turn_id === activeTurn) activeTurn = undefined;
    }
    if (typeof rec.uuid === "string") claudeRecords.set(rec.uuid, rec);
    if (isPrompt(rec) && isPiece(canonical(textOf(rec.message?.content)))) {
      consumed = true;
      if (typeof rec.uuid === "string") matchedInputs.add(rec.uuid);
    }
  }
  // Native Claude can flush the assistant and closure before the user record.
  // Follow UUID ancestry after collecting the suffix; append order is not turn order.
  for (const closure of claudeRecords.values()) {
    if (closure.type !== "system" || closure.subtype !== "turn_duration") continue;
    const visited = new Set<string>();
    let parent = closure.parentUuid;
    let sawAssistant = false;
    while (parent && !visited.has(parent)) {
      visited.add(parent);
      const rec = claudeRecords.get(parent);
      if (!rec) break;
      if (isPrompt(rec)) {
        if (sawAssistant && matchedInputs.has(parent)) return { consumed: true, turnClosed: true };
        break; // Another input's completion cannot certify this piece.
      }
      if (rec.type === "assistant" && rec.message?.role === "assistant") sawAssistant = true;
      parent = rec.parentUuid;
    }
  }
  return { consumed, turnClosed: false };
}
