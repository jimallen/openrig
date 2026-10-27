// OF-135: the CLI twin of the daemon's rigAdviceHandle (domain/rig-ref.ts): advice names a rig by its name while that name
// reaches it and only it, else by its id. Same expectations as the daemon's rows. OF-152: ids count across every rig,
// archived included (an id wins, as resolveRigHandle matches it); names count among unarchived rigs only.
import { describe, expect, it } from "vitest";
import { rigAdviceHandle, fetchAdviceRigs } from "../src/rig-handle.js";
import type { DaemonClient } from "../src/client.js";

describe("cli rigAdviceHandle", () => {
  const live = (id: string, name: string) => ({ id, name, archived: false });
  const rigs = [live("id-solo", "solo"), live("id-twin-a", "twin"), live("id-twin-b", "twin"), live("id-x", "id-solo"),
    { id: "id-old", name: "reused", archived: true }, live("id-new", "reused"),
    { id: "id-arch", name: "elsewhere", archived: true }, live("id-y", "id-arch")];
  it.each([
    ["a unique name", "id-solo", "solo", "solo"],
    ["a shared name", "id-twin-a", "twin", "id-twin-a"],
    ["a name that is another listed rig's id (the id would win)", "id-x", "id-solo", "id-x"],
    ["a name that is an ARCHIVED rig's id (the id would still win, OF-152)", "id-y", "id-arch", "id-y"],
    ["an archived namesake does not make the name ambiguous", "id-new", "reused", "reused"],
    ["the archived rig itself is named by its id", "id-old", "reused", "id-old"],
    ["a rig missing from the list", "id-gone", "gone", "id-gone"],
    ["a name carried by another rig only (this one not listed)", "id-other", "solo", "id-other"],
  ])("%s", (_label, rigId, rigName, expected) => {
    expect(rigAdviceHandle(rigId, rigName, rigs)).toBe(expected);
  });
  it("rigs that could not be read (null) give the id (always exact)", () => {
    expect(rigAdviceHandle("id-solo", "solo", null)).toBe("id-solo");
    expect(rigAdviceHandle("id-solo", "solo", [])).toBe("id-solo");
  });

  describe("fetchAdviceRigs", () => {
    const client = (get: (url: string) => Promise<{ status: number; data: unknown }>): Pick<DaemonClient, "get"> => ({
      get: <T,>(url: string) => get(url) as Promise<{ status: number; data: T }>,
    });
    it("reads every rig, archived included, and marks the archived ones", async () => {
      const urls: string[] = [];
      const rigsRead = await fetchAdviceRigs(client(async (url) => {
        urls.push(url);
        return { status: 200, data: [{ id: "a", name: "x", archivedAt: null }, { id: "b", name: "y", archivedAt: "2026-10-27T00:00:00Z" }] };
      }));
      expect(urls).toEqual(["/api/rigs/summary?includeArchived=true"]);
      expect(rigsRead).toEqual([{ id: "a", name: "x", archived: false }, { id: "b", name: "y", archived: true }]);
    });
    it.each([
      ["an error status", async () => ({ status: 500, data: { error: "x" } })],
      ["a body that is not a list", async () => ({ status: 200, data: { rigs: [] } })],
      ["a failed request", async () => { throw new Error("down"); }],
    ] as const)("%s reads as unreadable (null), never as no rigs", async (_label, get) => {
      expect(await fetchAdviceRigs(client(get))).toBeNull();
    });
  });
});
