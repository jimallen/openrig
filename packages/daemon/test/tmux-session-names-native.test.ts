import { afterEach, beforeAll, afterAll, describe, expect, it } from "vitest";
import { HcAdapter } from "../src/adapters/hc-adapter.js";
import { hcTerminalName, SEAT_LABEL } from "../src/adapters/hc-host.js";
import { findHc, startHcScratch, type HcScratch } from "./helpers/hc-scratch.js";

// Seat names are free text to the daemon: they hold the metadata separator of a listing format, leading and trailing spaces, and
// each other as prefixes. tmux needed a listing format and quoting that survived all of that; hc keeps the name in a label, and
// finds the terminal by the digest of the whole name, so none of it can be mistaken for structure.
describe.skipIf(!findHc())("hc literal seat names", () => {
  let scratch: HcScratch;
  let adapter: HcAdapter;
  let names: string[] = [];
  beforeAll(() => { scratch = startHcScratch(); adapter = new HcAdapter(scratch.client()); }, 60_000);
  afterAll(() => scratch?.cleanup());
  afterEach(async () => { for (const name of names) await adapter.killSession(name).catch(() => undefined); names = []; });

  async function withSeats(seats: string[], check: () => Promise<void>) {
    names = seats;
    for (const name of seats) {
      await scratch.client().call("terminal.run", {
        argv: ["sh", "-c", "printf 'native-session-fixture\\n'; sleep 60"], name: hcTerminalName(name), labels: { [SEAT_LABEL]: name },
        cwd: scratch.root, no_parent: true, no_notify: true, outlive_parent: true,
      });
    }
    // Synchronize with output instead of assuming the newly started program is ready.
    for (const name of seats) {
      await expect.poll(() => adapter.capturePaneContent(name), { timeout: 10_000 }).toContain("native-session-fixture");
    }
    await check();
  }

  it("discovers names containing the metadata separator", async () => {
    const seats = ["agent|notes", "agent|12"];
    await withSeats(seats, async () => {
      const sessions = await adapter.listSessions();
      expect(sessions.map((s) => s.name).sort()).toEqual([...seats].sort());
      for (const session of sessions) {
        expect(session.windows).toBe(1);
        expect(session.created).toMatch(/^\d+$/);
        expect(session.attached).toBe(false);
      }
      for (const name of seats) {
        const panes = await adapter.listPanes(name);
        expect(panes, name).toHaveLength(1);
        expect(panes[0]!.id).toMatch(/^t\d+$/);
      }
    });
  });

  it("batched capture preserves leading and trailing spaces", async () => {
    const seats = [" agent ", "agent", "agent|notes"];
    await withSeats(seats, async () => {
      const batch = await adapter.capturePanesContent([...seats, "missing"]);
      expect(batch).not.toBeNull();
      for (const name of seats) {
        const single = await adapter.capturePaneContent(name);
        expect(single).toContain("native-session-fixture");
        expect(batch!.get(name)?.text).toBe(single);
      }
      expect(batch!.get("missing")?.text).toBeNull();
    });
  });

  it("ordinary session discovery and capture remain unchanged", async () => {
    await withSeats(["plain"], async () => {
      expect(await adapter.listSessions()).toEqual([expect.objectContaining({ name: "plain", windows: 1, attached: false })]);
      const batch = await adapter.capturePanesContent(["plain"]);
      expect(batch!.get("plain")?.text).toBe(await adapter.capturePaneContent("plain"));
    });
  });
});
