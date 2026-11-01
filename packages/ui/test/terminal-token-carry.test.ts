import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const TOKEN = "test-terminal-token-xyz";

beforeEach(() => {
  window.localStorage.setItem("openrig.terminalBearerToken", TOKEN);
});

afterEach(() => {
  window.localStorage.removeItem("openrig.terminalBearerToken");
  vi.restoreAllMocks();
});

function stubFetch(): { calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ content: "test", lines: 1, ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  return { calls };
}

describe("terminal-token carry on protected UI fetches", () => {
  it("fetchNodePreview sends Authorization: Bearer <token>", async () => {
    const { calls } = stubFetch();
    const { fetchNodePreview } = await import("../src/hooks/useNodePreview.js");
    await fetchNodePreview("rig-1", "dev.impl", 20);
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toContain("/preview");
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers?.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("fetchSessionPreview sends Authorization: Bearer <token>", async () => {
    const { calls } = stubFetch();
    const { fetchSessionPreview } = await import("../src/hooks/useNodePreview.js");
    await fetchSessionPreview("dev-impl@test-rig", 20);
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toContain("/preview");
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers?.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("terminalAuthHeaders reads token from localStorage", async () => {
    const { terminalAuthHeaders } = await import("../src/components/mission-control/missionControlAuth.js");
    expect(terminalAuthHeaders().Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("terminalAuthHeaders returns empty when no token", async () => {
    window.localStorage.removeItem("openrig.terminalBearerToken");
    const { terminalAuthHeaders } = await import("../src/components/mission-control/missionControlAuth.js");
    expect(terminalAuthHeaders().Authorization).toBeUndefined();
  });

  it("source guard: no UI source calls the removed cmux routes (open-cmux, cmux/launch, adapters/cmux)", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const srcDir = path.resolve(import.meta.dirname, "../src");
    const files = (fs.readdirSync(srcDir, { recursive: true }) as string[])
      .filter((f) => /\.(ts|tsx)$/.test(f));
    expect(files.length, "positive control: the walk saw the UI source tree").toBeGreaterThan(50);
    const offenders = files.filter((f) => /open-cmux|cmux\/launch|adapters\/cmux/.test(fs.readFileSync(path.join(srcDir, f), "utf-8")));
    expect(offenders).toEqual([]);
  });
});
