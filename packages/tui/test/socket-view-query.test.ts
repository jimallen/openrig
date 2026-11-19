// workspaces-o9o.172: the socket "view" OBSERVE query, a bounded digest of the snapshot the TUI renders every topology view from, so a
// scenario can compare the TUI's world with `ps` and `queue` (ROUTING R-21). Read-only by the socket's class, like "state" and "commands":
// it never dispatches and never calls onMutation. It carries names and status only: no pane text, no paths, no credentials. readAt is when
// the TUI last confirmed its read (LoadState.lastSuccessAt), so a stale TUI can be named.
import { describe, expect, it } from "vitest";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createControlSocket, describeState } from "../src/socket-server.js";
import { createViewState } from "../src/state.js";
import { demoSnapshot } from "../src/demo-data.js";
import { describeView, utf8Bytes, VIEW_DIGEST_LIMITS, VIEW_REPLY_MAX_BYTES } from "../src/observe/view-digest.js";
import type { FleetSnapshot, LoadState } from "../src/types.js";

/** The reply line exactly as the socket wrote it, newline included, as bytes (never re-encoded through a JS string). */
async function queryBytes(sockPath: string, line: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(sockPath, () => conn.write(line + "\n"));
    const chunks: Buffer[] = [];
    conn.on("data", (d: Buffer) => {
      chunks.push(d);
      const all = Buffer.concat(chunks);
      const nl = all.indexOf(0x0a);
      if (nl >= 0) { conn.end(); resolve(all.subarray(0, nl + 1)); }
    });
    conn.on("error", reject);
  });
}

async function query(sockPath: string, line: string): Promise<Record<string, unknown>> {
  return JSON.parse((await queryBytes(sockPath, line)).toString("utf8")) as Record<string, unknown>;
}

let n = 0;
async function withSocket(snapshot: FleetSnapshot, load: LoadState | null, run: (q: (line: string) => Promise<Record<string, unknown>>, mutations: () => number, view: ReturnType<typeof createViewState>, qBytes: (line: string) => Promise<Buffer>) => Promise<void>, instanceId = "o9o172") {
  const view = createViewState({ instanceId, getSnapshot: () => snapshot });
  const sockPath = path.join(os.tmpdir(), `t-o9o172-${process.pid}-${n++}.sock`);
  let mutated = 0;
  const sock = await createControlSocket({ socketPath: sockPath, view, onMutation: () => { mutated++; }, observeView: () => ({ snapshot, load }) } as Parameters<typeof createControlSocket>[0]);
  try { await run((line) => query(sockPath, line), () => mutated, view, (line) => queryBytes(sockPath, line)); } finally { await sock.close(); }
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
        "host", "name", "id", "reachable", "inventory", "agentCount", "agents", "session", "status"]);
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

  // verify-qa2's second review: the bound is on the ENCODED reply. Measured on the bytes the socket wrote, at the maximum counts
  // (600 rigs x 300 agents, 500 down hosts, every string far past its cap), with each worst-case filler: ASCII; CJK (3 bytes
  // a character); NUL and a lone surrogate (JSON writes each as a 6-byte escape); an emoji (a surrogate pair, 4 bytes).
  /** The stated bound, written out here so these rows measure bytes against it whatever the module exports. */
  const REPLY_BOUND = 1_000_000;
  const fillers: Array<[string, string]> = [["ASCII", "x"], ["CJK", "\u6f22"], ["NUL", "\u0000"], ["lone surrogate", "\ud800"], ["surrogate pair", "\ud83d\ude00"]];
  it.each(fillers)("at the maximum counts with %s text, the whole reply line is at most 1,000,000 bytes and says truncated", async (_name, unit) => {
    const snapshot = demoSnapshot();
    const big = unit.repeat(5000);
    const agent = { ...snapshot.hosts[0]!.rigs[0]!.pods[0]!.agents[0]!, name: big, session: big, status: big };
    snapshot.hosts = [{ ...snapshot.hosts[0]!, name: big, rigs: Array.from({ length: 600 }, (_v, i) => ({ ...snapshot.hosts[0]!.rigs[0]!, id: big, name: `${i}${big}`,
      inventoryNotLoaded: false, inventoryUnavailable: false,
      pods: [{ ...snapshot.hosts[0]!.rigs[0]!.pods[0]!, agents: Array.from({ length: 300 }, () => agent) }] })) }];
    snapshot.hostsDown = Array.from({ length: 500 }, () => ({ hostId: big, status: "unreachable" }));
    await withSocket(snapshot, null, async (_q, _m, _v, qBytes) => {
      const line = await qBytes("view");
      expect(line.length).toBeLessThanOrEqual(REPLY_BOUND);
      const view = (JSON.parse(line.toString("utf8")) as { view: { rigs: unknown[]; truncated: boolean; counts: { rigs: number } } }).view;
      expect(view.truncated).toBe(true);
      expect(view.rigs.length).toBeGreaterThan(0);
      expect(view.counts.rigs).toBe(600);
    });
  });

  // verify-qa2's third review: the digest can shrink, the envelope cannot, so the instance id is bounded (128 UTF-8 bytes) and an
  // over-long one is refused at start, naming the limit. With the longest id allowed, written in the character JSON escapes most
  // (NUL: 1 byte, a 6-byte escape), the whole line still fits at the maximum counts.
  /** The stated id limit, written out here so these rows measure against it whatever the module exports. */
  const ID_LIMIT = 128;
  const maxSnapshot = (): FleetSnapshot => {
    const snapshot = demoSnapshot();
    const big = "\u6f22".repeat(5000);
    const agent = { ...snapshot.hosts[0]!.rigs[0]!.pods[0]!.agents[0]!, name: big, session: big, status: big };
    snapshot.hosts = [{ ...snapshot.hosts[0]!, name: big, rigs: Array.from({ length: 600 }, (_v, i) => ({ ...snapshot.hosts[0]!.rigs[0]!, id: big, name: `${i}${big}`,
      inventoryNotLoaded: false, inventoryUnavailable: false,
      pods: [{ ...snapshot.hosts[0]!.rigs[0]!.pods[0]!, agents: Array.from({ length: 300 }, () => agent) }] })) }];
    snapshot.hostsDown = Array.from({ length: 500 }, () => ({ hostId: big, status: "unreachable" }));
    return snapshot;
  };

  it("the bound covers the envelope too: with the longest instance id allowed, all of it escaped, the whole line still fits", async () => {
    const instanceId = "\u0000".repeat(ID_LIMIT);
    await withSocket(maxSnapshot(), null, async (_q, _m, _v, qBytes) => {
      const line = await qBytes("view");
      expect(line.length).toBeLessThanOrEqual(REPLY_BOUND);
      expect((JSON.parse(line.toString("utf8")) as { instanceId: string }).instanceId).toBe(instanceId);
    }, instanceId);
  });

  it("an over-long instance id is refused, naming the limit: the 1,100,000-character id verify-qa2 measured", () => {
    expect(() => createViewState({ instanceId: "i".repeat(1_100_000), getSnapshot: () => demoSnapshot() }))
      .toThrow(`the instance id is 1100000 bytes; the limit is ${ID_LIMIT} bytes (UTF-8)`);
  });

  it("the id limit is in UTF-8 bytes, inclusive: 128 bytes start, 129 are refused, whatever the characters", () => {
    const accepted = ["i".repeat(ID_LIMIT), "\u6f22".repeat(42) + "ii", "\ud83d\ude00".repeat(32), "\u0000".repeat(ID_LIMIT)];
    const refused = ["i".repeat(ID_LIMIT + 1), "\u6f22".repeat(43), "\ud83d\ude00".repeat(32) + "i"];
    for (const instanceId of [...accepted, ...refused]) expect(Buffer.byteLength(instanceId, "utf8")).toBe(accepted.includes(instanceId) ? ID_LIMIT : ID_LIMIT + 1);
    for (const instanceId of accepted) expect(createViewState({ instanceId, getSnapshot: () => demoSnapshot() }).instanceId).toBe(instanceId);
    for (const instanceId of refused) expect(() => createViewState({ instanceId, getSnapshot: () => demoSnapshot() }), JSON.stringify(instanceId)).toThrow(`the limit is ${ID_LIMIT} bytes`);
  });

  it("the control socket refuses a view store with an over-long id before it binds", async () => {
    const view = { ...createViewState({ instanceId: "o9o172", getSnapshot: () => demoSnapshot() }), instanceId: "i".repeat(1_100_000) };
    const sockPath = path.join(os.tmpdir(), `t-o9o172-${process.pid}-${n++}.sock`);
    await expect(createControlSocket({ socketPath: sockPath, view, observeView: () => ({ snapshot: demoSnapshot(), load: null }) } as Parameters<typeof createControlSocket>[0]))
      .rejects.toThrow(`the limit is ${ID_LIMIT} bytes`);
    expect(fs.existsSync(sockPath)).toBe(false);
  });

  it("a later assignment to the store's id cannot change a reply: the socket answers with the id it checked when it bound", async () => {
    await withSocket(maxSnapshot(), null, async (q, _m, view, qBytes) => {
      // The type says readonly; Object.assign is what a caller could still do at run time (verify-qa2: 1,100,154 bytes this way).
      Object.assign(view, { instanceId: "i".repeat(1_100_000) });
      expect(view.instanceId).toHaveLength(1_100_000);
      const line = await qBytes("view");
      expect(line.length).toBeLessThanOrEqual(REPLY_BOUND);
      const reply = JSON.parse(line.toString("utf8")) as { instanceId: string; view: { rigs: unknown[] } };
      expect(reply.instanceId).toBe("o9o172");
      // The digest's budget is sized on the same captured id, so it is not starved by the assigned one.
      expect(reply.view.rigs.length).toBeGreaterThan(0);
      expect((await q("state")).instanceId).toBe("o9o172");
      expect((await q("commands")).instanceId).toBe("o9o172");
    });
  });

  it("the TUI refuses an over-long --instance when it starts: exit 1, the limit named, no CLI call, no control socket", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "o9o172-id-"));
    try {
      const entry = fileURLToPath(new URL("../dist/main.js", import.meta.url));
      // A short --socket: the default path (run/tui-<id>.sock) is refused past ~104 bytes for its own reason, which would hide this one.
      const socketPath = path.join(root, "s.sock");
      // The CLI the TUI calls first (`config get ui.timezone`), replaced by one that leaves a mark: refused at start means never called.
      const marker = path.join(root, "cli-called");
      const cliEntry = path.join(root, "cli.mjs");
      fs.writeFileSync(cliEntry, `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "called");\n`);
      const child = spawn(process.execPath, [entry, "--demo", "--socket", socketPath, "--instance", "i".repeat(ID_LIMIT + 1)], {
        env: { ...process.env, OPENRIG_HOME: root, OPENRIG_TUI_SOCKET: "", OPENRIG_TUI_CLI_ENTRY: cliEntry, NO_COLOR: "1" }, stdio: ["pipe", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (d: Buffer) => { stderr += d.toString("utf8"); });
      // A TUI that starts instead keeps running: stop it after 10 s, so the row fails on the exit code rather than hanging.
      const stop = setTimeout(() => child.kill("SIGTERM"), 10_000);
      const code = await new Promise<number | null>((resolve) => child.on("exit", (c) => resolve(c))).finally(() => clearTimeout(stop));
      expect(code).toBe(1);
      expect(stderr).toContain(`the instance id is ${ID_LIMIT + 1} bytes; the limit is ${ID_LIMIT} bytes (UTF-8)`);
      expect(fs.existsSync(socketPath)).toBe(false);
      // The CLI child outlives a TUI that exits right after starting it, so give it time to leave its mark before reading.
      await new Promise((resolve) => setTimeout(resolve, 2000));
      expect(fs.existsSync(marker)).toBe(false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }, 20_000);

  it("CONTROL: a reply that fits is not cut: the demo snapshot's digest is whole, untruncated, and far under the bound", async () => {
    await withSocket(demoSnapshot(), null, async (_q, _m, _v, qBytes) => {
      const line = await qBytes("view");
      const view = (JSON.parse(line.toString("utf8")) as { view: { rigs: unknown[]; truncated: boolean; counts: { rigs: number } } }).view;
      expect(view.truncated).toBe(false);
      expect(view.rigs).toHaveLength(view.counts.rigs);
      expect(line.length).toBeLessThan(REPLY_BOUND / 10);
    });
  });

  it("agent detail goes before rig rows: every rig keeps its row and its whole agentCount while agent lists are cut", async () => {
    const snapshot = demoSnapshot();
    const cjk = "\u6f22".repeat(5000);
    const template = snapshot.hosts[0]!.rigs[0]!;
    const agent = { ...template.pods[0]!.agents[0]!, name: cjk, session: cjk, status: cjk };
    snapshot.hosts = [{ ...snapshot.hosts[0]!, rigs: Array.from({ length: 40 }, (_v, i) => ({ ...template, name: `rig-${i}`, inventoryNotLoaded: false, inventoryUnavailable: false,
      pods: [{ ...template.pods[0]!, agents: Array.from({ length: 50 }, () => agent) }] })) }];
    snapshot.hostsDown = [];
    await withSocket(snapshot, null, async (_q, _m, _v, qBytes) => {
      const line = await qBytes("view");
      expect(line.length).toBeLessThanOrEqual(REPLY_BOUND);
      const view = (JSON.parse(line.toString("utf8")) as { view: { rigs: Array<{ name: string; agentCount: number; agents: unknown[] }>; truncated: boolean } }).view;
      expect(view.truncated).toBe(true);
      expect(view.rigs.map((r) => r.name)).toEqual(Array.from({ length: 40 }, (_v, i) => `rig-${i}`));
      expect(view.rigs.every((r) => r.agentCount === 50)).toBe(true);
      expect(view.rigs.reduce((n, r) => n + r.agents.length, 0)).toBeLessThan(2000);
      // Cut from the last rig back: the first rig keeps its whole capped list.
      expect(view.rigs[0]!.agents).toHaveLength(50);
    });
  });

  it("a cap never splits a surrogate pair (a lone half is a 6-byte escape and not text)", () => {
    const snapshot = demoSnapshot();
    snapshot.hosts[0]!.rigs[0]!.name = "a".repeat(99) + "\ud83d\ude00".repeat(10);
    const name = describeView({ snapshot, load: null }).rigs[0]!.name;
    expect(name).toBe("a".repeat(99));
    expect(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(name)).toBe(false);
  });

  it("utf8Bytes counts what the socket writes, and describeView honours a byte budget it is handed", () => {
    expect(VIEW_REPLY_MAX_BYTES).toBe(REPLY_BOUND);
    for (const text of ["", "x", "\u00e9", "\u6f22", "\ud83d\ude00", "\ud800", "a\udc00b", JSON.stringify("\u0000\ud800\u6f22")]) {
      expect(utf8Bytes(text), JSON.stringify(text)).toBe(Buffer.byteLength(text, "utf8"));
    }
    const full = Buffer.byteLength(JSON.stringify(describeView({ snapshot: demoSnapshot(), load: null })), "utf8");
    const budget = Math.floor(full / 2);
    const small = describeView({ snapshot: demoSnapshot(), load: null }, VIEW_DIGEST_LIMITS, budget);
    expect(Buffer.byteLength(JSON.stringify(small), "utf8")).toBeLessThanOrEqual(budget);
    expect(small.truncated).toBe(true);
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

  // Measured on a real TUI (solo-stub, 1 node in ps): the TUI reads a rig's seats only when its page needs them, so the rig sat in the
  // snapshot with pods [] and the digest said agentCount 0. "Not read" must never read as "no agents".
  it("a rig whose seats the TUI has not read (or could not read) has agentCount null and says which, never 0", async () => {
    const snapshot = demoSnapshot();
    const [read, notLoaded, unavailable] = [0, 1, 2].map((i) => ({ ...snapshot.hosts[0]!.rigs[0]!, name: `r${i}` }));
    snapshot.hosts[0]!.rigs = [read!, { ...notLoaded!, pods: [], inventoryNotLoaded: true }, { ...unavailable!, pods: [], inventoryUnavailable: true }];
    await withSocket(snapshot, null, async (q) => {
      const view = (await q("view")).view as { rigs: Array<{ name: string; inventory: string; agentCount: number | null }> };
      const want = read!.pods.reduce((n, p) => n + p.agents.length, 0);
      expect(want).toBeGreaterThan(0);
      expect(view.rigs.map((r) => [r.name, r.inventory, r.agentCount])).toEqual([
        ["r0", "read", want], ["r1", "not-loaded", null], ["r2", "unavailable", null],
      ]);
    });
  });
});
