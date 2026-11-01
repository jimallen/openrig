// hc cutover W41 (security F5): the TUI's Open sends what the daemon's terminal guard needs. The TUI hands its client the CLI's
// `terminalAuthHeaders` (main.ts), so every write, `POST /api/terminal/open` included, carries the bearer when one exists.
import { describe, expect, it } from "vitest";
import { DaemonClient } from "../src/daemon-client.js";

describe("TUI terminal open carries the terminal bearer", () => {
  it("sends Authorization on POST /api/terminal/open, read fresh from the header source on each call", async () => {
    const seen: Array<{ url: string; auth: string | null }> = [];
    let token = "first-token";
    const client = new DaemonClient({
      baseUrl: "http://fixture",
      headers: () => ({ Authorization: `Bearer ${token}` }),
      fetchImpl: (async (url: string, init?: RequestInit) => {
        seen.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") });
        return new Response(JSON.stringify({ provider: "herdr", ok: true, opened: ["a@r"], absent: [], degraded: [], pages: 1 }), { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof fetch,
    });
    await client.openTerminal("rig:acme");
    token = "second-token";
    await client.openTerminal("rig:acme");
    expect(seen).toEqual([
      { url: "http://fixture/api/terminal/open", auth: "Bearer first-token" },
      { url: "http://fixture/api/terminal/open", auth: "Bearer second-token" },
    ]);
  });
});
