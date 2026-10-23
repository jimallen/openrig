// pda L2c (J-3): the TUI words a pda seat's cost exactly as `rig usage cost` does, and labels its setting.
// Without a pda branch a "reported" pda seat would fall through to the Claude statusline wording.
import { describe, expect, it } from "vitest";
import { costLine } from "../../cli/src/commands/usage.js";
import { costHeadLine, costLines } from "../src/cost/cost-model.js";
import { configLabel, type ConfigEntry } from "../src/config/config-model.js";

const reported = { seatSession: "research@r", runtime: "pda", status: "reported", kind: "model-priced estimate", source: "pda assistant entries (usage.cost.total)",
  costUsd: 0.75, window: { conversationId: "conv-1", agent: "research", since: "2026-10-23T09:00:01.000Z", asOf: "2026-10-23T09:00:04.000Z" },
  coverage: "spend in runs this seat took part in: assistant entries only; excludes compaction and tool usage",
  entries: { own: 4, ownWithoutCost: { declaredZeroPrice: 1, absent: 2 }, errorOrAborted: 1, other: { count: 3, costUsd: 4 }, unknownOrigin: { count: 1, costUsd: null } },
  tokens: { input: 400, output: 80, cacheRead: 20, cacheWrite: 4 } };
const absent = { ...reported, status: "absent", costUsd: undefined, reason: "pda's provider declares a zero price table, so its entries carry no cost (tokens are shown)" };

describe("System → Cost: pda seats", () => {
  it.each([["reported", reported], ["absent", absent]])("the %s head line is the line rig usage cost prints, and never the Claude wording", (_name, seat) => {
    expect(costHeadLine(seat as never)).toBe(costLine(seat as never));
    expect(costHeadLine(seat as never)).toContain("pda conversation conv-1");
    expect(costHeadLine(seat as never)).not.toContain("Claude statusline");
  });

  it("the view shows the served coverage, so the exclusions are readable beside the figure", () => {
    const text = costLines({ status: { body: { seats: [reported], note: "n" } } } as never, 400).map((l) => l.text).join("\n");
    expect(text).toContain("excludes compaction and tool usage");
    expect(text).toContain("coverage: spend in runs this seat took part in");
  });

  it("labels usage.pda_cost_facts", () => {
    const entry = { key: "usage.pda_cost_facts", group: "general" } as ConfigEntry;
    expect(configLabel(entry)).toBe("pda cost from assistant entries");
  });
});
