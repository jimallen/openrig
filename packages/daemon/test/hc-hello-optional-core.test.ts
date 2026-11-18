// workspaces-87f: an older hc's `hello` can leave out `core`, or `core.id` (o9o.165, verify-sec F4). HcHello now says so, so the
// compiler makes every reader handle an absent core instead of letting `hello.core.id` read as a string that is not there (the
// TypeError o9o.165 found at hc-core-watch's connect). These rows pin the type and each reader's behaviour on such a hello.
import { describe, it, expect, expectTypeOf, vi } from "vitest";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { RuntimeVerifier } from "../src/domain/runtime-verifier.js";
import { HC_GENERATION, type HcHello } from "../src/adapters/hc-client.js";
import { verifyHello } from "../src/adapters/hc-core-watch.js";
import { HC_TESTED_VERSION } from "../src/adapters/hc-version.js";
import type { ExecFn } from "../src/adapters/tmux.js";

/** A hello with no core object at all. */
const corelessHello = (): HcHello => ({ generation: HC_GENERATION, version: HC_TESTED_VERSION, framed: false, methods: [], features: [] });
/** A hello whose core names no id. */
const idlessHello = (): HcHello => ({ ...corelessHello(), core: { name: "n" } });

describe("HcHello: core and core.id are optional (workspaces-87f)", () => {
  it("the type says a core, and its id and name, may be absent", () => {
    expectTypeOf<HcHello["core"]>().toEqualTypeOf<{ id?: string; name?: string } | undefined>();
  });

  // CoS ruling on the verify-sec FAIL (workspaces-87f): once an id is known for the core, a hello without one is another core.
  it("verifyHello refuses a hello with no core, or a core with no id, once an id is pinned (core_changed)", () => {
    expect(() => verifyHello(corelessHello(), { coreId: "core-a" })).toThrow(expect.objectContaining({ kind: "core_changed" }));
    expect(() => verifyHello(idlessHello(), { coreId: "core-a" })).toThrow(expect.objectContaining({ kind: "core_changed" }));
  });

  it("verifyHello accepts a hello with no core, or a core with no id, while no id is pinned (an older hc that never sends one)", () => {
    expect(verifyHello(corelessHello(), {})).toEqual({ verdict: "tested", version: HC_TESTED_VERSION });
    expect(verifyHello(idlessHello(), {})).toEqual({ verdict: "tested", version: HC_TESTED_VERSION });
  });

  it("control: a core that names another id is still refused", () => {
    expect(() => verifyHello({ ...corelessHello(), core: { id: "core-b", name: "n" } }, { coreId: "core-a" }))
      .toThrow(expect.objectContaining({ kind: "core_changed" }));
  });

  it("the runtime verifier verifies hc from a hello with no core, and records only the generation and version", async () => {
    const db = createDb();
    migrate(db, ALL_MIGRATIONS);
    try {
      const exec: ExecFn = vi.fn(async (cmd: string) => {
        if (cmd.includes("hc --version")) return `hc ${HC_TESTED_VERSION}\n`;
        throw new Error("command not found");
      });
      const result = await new RuntimeVerifier({ exec, db, hcHello: async () => corelessHello() }).verifyHc();
      expect(result.status).toBe("verified");
      expect(JSON.parse(result.capabilitiesJson ?? "null")).toEqual({ generation: HC_GENERATION, coreVersion: HC_TESTED_VERSION });
      expect(result.error).toBeNull();
    } finally {
      db.close();
    }
  });
});
