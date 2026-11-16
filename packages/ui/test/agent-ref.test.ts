// workspaces-o9o.1: the UI's reading of `shipped:<rel>` agent refs (src/lib/agent-ref.ts). The rendered paths are pinned in
// rig-spec-display-agent-ref, library-review and live-node-details tests; these pin the edge cases they do not reach.
import { describe, it, expect } from "vitest";
import { describeAgentRef, findShippedAgentEntry, shippedAgentManifestPath } from "../src/lib/agent-ref.js";

describe("shippedAgentManifestPath", () => {
  it("is <rel>/agent.yaml for a shipped: ref, normalised (./, //, an inner .., a trailing slash)", () => {
    expect(shippedAgentManifestPath("shipped:agents/shared")).toBe("agents/shared/agent.yaml");
    expect(shippedAgentManifestPath("shipped:./agents//development/x/../implementer/")).toBe("agents/development/implementer/agent.yaml");
  });

  it("is null for every ref the daemon refuses or that is not shipped:", () => {
    for (const ref of ["shipped:", "shipped:/abs/agents/x", "shipped:..", "shipped:../agents/x", "shipped:agents/../../x", "shipped:.",
      "local:agents/x", "path:/x/agents/y", "Shipped:agents/x", "shipped-x:agents/x", null, undefined]) {
      expect(shippedAgentManifestPath(ref), String(ref)).toBeNull();
    }
  });
});

describe("findShippedAgentEntry", () => {
  const e = (id: string, sourceType: string, relativePath: string, kind = "agent") => ({ id, kind, sourceType, relativePath });

  it("finds the builtin agent entry at exactly that path, whatever its name", () => {
    const hit = e("op", "builtin", "rigs/launch/kernel/agents/operator/agent/agent.yaml");
    expect(findShippedAgentEntry("shipped:rigs/launch/kernel/agents/operator/agent", [e("other", "builtin", "agents/operator/agent.yaml"), hit])).toBe(hit);
  });

  it("matches a relativePath written with backslashes (a Windows-built index)", () => {
    const hit = e("w", "builtin", "agents\\shared\\agent.yaml");
    expect(findShippedAgentEntry("shipped:agents/shared", [hit])).toBe(hit);
  });

  it("does not take a user_file entry, a rig entry, or a path that is only a prefix", () => {
    expect(findShippedAgentEntry("shipped:agents/shared", [
      e("u", "user_file", "agents/shared/agent.yaml"),
      e("r", "builtin", "agents/shared/agent.yaml", "rig"),
      e("p", "builtin", "agents/shared/extra/agent.yaml"),
    ])).toBeNull();
  });

  it("is null for a ref that is not shipped:", () => {
    expect(findShippedAgentEntry("local:agents/shared", [e("b", "builtin", "agents/shared/agent.yaml")])).toBeNull();
  });
});

describe("describeAgentRef", () => {
  it("a shipped: ref with two agents/ segments is named after the LAST one (the persona's own folder)", () => {
    expect(describeAgentRef("shipped:agents/teams/agents/lead")).toEqual({ specName: "lead", source: "builtin" });
  });

  it("a shipped: ref with no agents/ segment is named by its whole path, still builtin", () => {
    expect(describeAgentRef("shipped:personas/x")).toEqual({ specName: "personas/x", source: "builtin" });
  });

  it("CONTROL: the other schemes read as before", () => {
    expect(describeAgentRef("local:agents/apps/vault-specialist")).toEqual({ specName: "apps/vault-specialist", source: "user_file" });
    expect(describeAgentRef("fork:agents/qa@0.2.0")).toEqual({ specName: "qa", source: "fork" });
    expect(describeAgentRef("builtin:agents/driver")).toEqual({ specName: "driver", source: "builtin" });
    expect(describeAgentRef("path:/x/agents/y")).toEqual({ specName: "path:/x/agents/y", source: "user_file" });
  });
});
