// workspaces-o9o.172: the socket "view" OBSERVE query, a bounded digest of the snapshot the TUI renders every topology view from, so a
// scenario can compare the TUI's world with `ps` and `queue` (ROUTING R-21). Read-only by the socket's class, like "state" and "commands":
// it never dispatches and never calls onMutation. It carries names and status only: no pane text, no paths, no credentials. readAt is when
// the TUI last confirmed its read (LoadState.lastSuccessAt), so a stale TUI can be named.
import { describe, expect, it } from "vitest";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createControlSocket, describeState } from "../src/socket-server.js";
import { createViewState } from "../src/state.js";
import { demoSnapshot } from "../src/demo-data.js";
import type { FleetSnapshot, LoadState } from "../src/types.js";

async function query(sockPath: string, line: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(sockPath, () => conn.write(line + "\n"));
    let buf = "";
    conn.on("data", (d) => {
      buf += d.toString();
      if (buf.includes("\n")) { conn.end(); resolve(JSON.parse(buf.slice(0, buf.indexOf("\n"))) as Record<string, unknown>); }
    });
    conn.on("error", reject);
  });
}

let n = 0;
async function withSocket(snapshot: FleetSnapshot, load: LoadState | null, run: (q: (line: string) => Promise<Record<string, unknown>>, mutations: () => number, view: ReturnType<typeof createViewState>) => Promise<void>) {
  const view = createViewState({ instanceId: "o9o172", getSnapshot: () => snapshot });
  const sockPath = path.join(os.tmpdir(), `t-o9o172-${process.pid}-${n++}.sock`);
  let mutated = 0;
  const sock = await createControlSocket({ socketPath: sockPath, view, onMutation: () => { mutated++; }, observeView: () => ({ snapshot, load }) } as Parameters<typeof createControlSocket>[0]);
  try { await run((line) => query(sockPath, line), () => mutated, view); } finally { await sock.close(); }
}

const rigCount = (s: FleetSnapshot) => s.hosts.reduce((total, h) => total + h.rigs.length, 0);

describe("the socket 'view' query (o9o.172)", () => {
  it("returns a digest of the snapshot: one row per rig the TUI holds, with its host and agents, and the hosts that are down", async () => {
    const snapshot = demoSnapshot();
    await withSocket(snapshot, { inFlight: false, settled: true, lastSuccessAt: Date.parse("2026-11-18T15:00:00.000Z") }, async (q) => {
      const res = await q("view");
      expect(res.ok).toBe(true);
      expect(res.instanceId).toBe("o9o172");
      const view = res.view as { rigs: Array<{ host: string; name: string; agents: Array<{ name: string; status: string }> }>; hostsDown: string[]; counts: { rigs: number; agents: number }; truncated: boolean };
      expect(view.rigs).toHaveLength(rigCount(snapshot));
      expect(view.rigs.map((r) => `${r.host}/${r.name}`)).toEqual(snapshot.hosts.flatMap((h) => h.rigs.map((r) => `${h.name}/${r.name}`)));
      const first = snapshot.hosts[0]!.rigs[0]!;
      expect(view.rigs[0]!.agents.map((a) => a.name)).toEqual(first.pods.flatMap((p) => p.agents.map((a) => a.name)));
      expect(view.hostsDown).toEqual(snapshot.hostsDown.map((h) => h.hostId));
      expect(view.counts.rigs).toBe(rigCount(snapshot));
      expect(view.truncated).toBe(false);
    });
  });

  it("never mutates: no dispatch, no onMutation, the view state unchanged", async () => {
    await withSocket(demoSnapshot(), null, async (q, mutations, view) => {
      const before = JSON.stringify(describeState(view.get()));
      await q("view");
      await q("view");
      expect(mutations()).toBe(0);
      expect(JSON.stringify(describeState(view.get()))).toBe(before);
    });
  });

  it("carries names and status only: no pane text, paths or credentials, whatever the snapshot rows hold", async () => {
    const snapshot = demoSnapshot();
    const agent = snapshot.hosts[0]!.rigs[0]!.pods[0]!.agents[0]!;
    const secretish = ["s3cr", "et-", "o9o172-", "sentinel"].join("");
    const pathish = ["/home", "/someone", "/o9o172-path-sentinel"].join("");
    const paneish = "o9o172 pane text sentinel";
    Object.assign(agent, { cwd: pathish, preview: paneish, token: secretish, paneText: paneish });
    await withSocket(snapshot, null, async (q) => {
      const raw = JSON.stringify(await q("view"));
      for (const sentinel of [secretish, pathish, paneish]) expect(raw).not.toContain(sentinel);
      const allowed = new Set(["ok", "instanceId", "view", "readAt", "stale", "settled", "rigs", "hostsDown", "counts", "truncated",
        "host", "name", "id", "reachable", "agentCount", "agents", "session", "status"]);
      const keys = new Set<string>();
      const walk = (v: unknown) => { if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { keys.add(k); walk(x); } };
      walk(JSON.parse(raw));
      expect([...keys].filter((k) => !allowed.has(k))).toEqual([]);
    });
  });

  it("a TUI started without the snapshot port answers ok:false, and still never mutates", async () => {
    const view = createViewState({ instanceId: "o9o172-noport", getSnapshot: () => demoSnapshot() });
    const sockPath = path.join(os.tmpdir(), `t-o9o172-noport-${process.pid}.sock`);
    let mutated = 0;
    const sock = await createControlSocket({ socketPath: sockPath, view, onMutation: () => { mutated++; } });
    try {
      const res = await query(sockPath, "view");
      expect(res.ok).toBe(false);
      expect(res.view).toBeUndefined();
      expect(mutated).toBe(0);
    } finally { await sock.close(); }
  });

  it("readAt is when the TUI last confirmed its read; null before any; stale and settled as the load says", async () => {
    await withSocket(demoSnapshot(), { inFlight: false, settled: true, stale: true, lastSuccessAt: Date.parse("2026-11-18T15:00:00.000Z") }, async (q) => {
      expect((await q("view")).view).toMatchObject({ readAt: "2026-11-18T15:00:00.000Z", stale: true, settled: true });
    });
    await withSocket(demoSnapshot(), null, async (q) => {
      expect((await q("view")).view).toMatchObject({ readAt: null, settled: false });
    });
  });

  // verify-qa2 review: EVERY variable-length field is bounded: each list AND each string, and truncated says when anything was cut.
  it("hostsDown is capped (100) and says truncated", async () => {
    const snapshot = demoSnapshot();
    snapshot.hostsDown = Array.from({ length: 10_000 }, (_v, i) => ({ hostId: `host-${i}`, status: "unreachable" }));
    await withSocket(snapshot, null, async (q) => {
      const view = (await q("view")).view as { hostsDown: string[]; truncated: boolean };
      expect(view.hostsDown).toHaveLength(100);
      expect(view.truncated).toBe(true);
    });
  });

  it("every string is capped (100 characters) and says truncated", async () => {
    const snapshot = demoSnapshot();
    const long = "n".repeat(1_000_000);
    const host = snapshot.hosts[0]!;
    host.name = long;
    host.rigs[0]!.name = long;
    host.rigs[0]!.pods[0]!.agents[0]!.name = long;
    host.rigs[0]!.pods[0]!.agents[0]!.status = long;
    snapshot.hostsDown = [{ hostId: long, status: "unreachable" }];
    await withSocket(snapshot, null, async (q) => {
      const res = await q("view");
      const raw = JSON.stringify(res);
      expect(raw.length).toBeLessThan(200_000);
      const view = res.view as { rigs: Array<{ host: string; name: string; agents: Array<{ name: string; status: string }> }>; hostsDown: string[]; truncated: boolean };
      for (const s of [view.rigs[0]!.host, view.rigs[0]!.name, view.rigs[0]!.agents[0]!.name, view.rigs[0]!.agents[0]!.status, view.hostsDown[0]!]) expect(s.length).toBe(100);
      expect(view.truncated).toBe(true);
    });
  });

  it("the largest possible digest (every list full, every string at its cap) is under 1 MB", async () => {
    const snapshot = demoSnapshot();
    const s100 = "x".repeat(5000);
    const agent = { ...snapshot.hosts[0]!.rigs[0]!.pods[0]!.agents[0]!, name: s100, session: s100, status: s100 };
    snapshot.hosts = [{ ...snapshot.hosts[0]!, name: s100, rigs: Array.from({ length: 600 }, (_v, i) => ({ ...snapshot.hosts[0]!.rigs[0]!, id: s100, name: `${i}${s100}`,
      pods: [{ ...snapshot.hosts[0]!.rigs[0]!.pods[0]!, agents: Array.from({ length: 300 }, () => agent) }] })) }];
    snapshot.hostsDown = Array.from({ length: 500 }, () => ({ hostId: s100, status: "unreachable" }));
    await withSocket(snapshot, null, async (q) => {
      const raw = JSON.stringify(await q("view"));
      expect(raw.length).toBeLessThan(1_000_000);
    });
  });

  it("is bounded: past 500 rigs the digest stops and says truncated", async () => {
    const snapshot = demoSnapshot();
    const host = snapshot.hosts[0]!;
    const template = host.rigs[0]!;
    host.rigs = Array.from({ length: 600 }, (_v, i) => ({ ...template, name: `rig-${i}`, pods: [] }));
    await withSocket(snapshot, null, async (q) => {
      const view = (await q("view")).view as { rigs: unknown[]; truncated: boolean; counts: { rigs: number } };
      expect(view.rigs).toHaveLength(500);
      expect(view.truncated).toBe(true);
      expect(view.counts.rigs).toBe(rigCount(snapshot));
    });
  });
});
