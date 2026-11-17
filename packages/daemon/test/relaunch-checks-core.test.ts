// workspaces-o9o.8: the relaunch checks' domain core (judged on recorded process rows and in-memory ports) and the lease store adapter
// (on a temp folder, never ~/.openrig).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import type { NativeProcessRow } from "../src/domain/native-process-lineage.js";
import { blockingChecks, judgeChildren, judgeLeases, newestHandoverFile, type RelaunchCheckPort } from "../src/domain/relaunch-checks.js";
import { nodeRelaunchChecks, SeatLeaseStore, type LeaseProcessProbe } from "../src/adapters/seat-lease-store.js";

/** A process table the store reads: pid -> the start time the OS reports, or null when it cannot be read. */
const probeOf = (table: Map<number, string | null>): LeaseProcessProbe => ({ exists: (pid) => table.has(pid), startedAt: (pid) => table.get(pid) ?? null });

const row = (pid: number, ppid: number, executableName: string, command: string): NativeProcessRow => ({ pid, ppid, executableName, command });

describe("o9o.8 core: the agent's children", () => {
  it("a shell between the pane and the agent is not the agent: the agent's own build under it is held", () => {
    const rows = [row(100, 1, "zsh", "-zsh"), row(101, 100, "claude", "claude"), row(102, 101, "bash", "bash -c make"), row(103, 102, "make", "make")];
    expect(judgeChildren(rows, 100, [])).toEqual({ verdict: "held", held: [{ pid: 102, name: "bash", command: "bash -c make" }], ignored: [], overridden: false });
  });

  it("the agent's own executable beneath it (a launcher re-running the runtime) is the agent, and its children are judged", () => {
    const rows = [row(200, 1, "codex", "codex"), row(201, 200, "codex", "/opt/codex/bin/codex resume x"), row(202, 201, "cargo", "cargo build")];
    expect(judgeChildren(rows, 200, [])).toMatchObject({ verdict: "held", held: [{ pid: 202, name: "cargo" }] });
  });

  it("a pane with only shells has no agent and nothing held", () => {
    expect(judgeChildren([row(300, 1, "bash", "bash")], 300, [])).toEqual({ verdict: "clear", ignored: [] });
  });

  it("an empty process table (the lister failed) cannot be judged", () => {
    expect(judgeChildren([], 400, [])).toMatchObject({ verdict: "unknown" });
  });

  it("finding 1: MCP servers and language servers are known by what they run, never by an argument", () => {
    const rows = [row(600, 1, "claude", "claude"),
      row(601, 600, "node", "node ./scripts/build --suite mcp-smoke"),
      row(602, 600, "npx", "npx -y @upstash/context7-mcp"),
      row(603, 600, "node", "node /home/u/.npm/_npx/x/node_modules/typescript-language-server/lib/cli.mjs --stdio"),
      row(604, 600, "zsh", "zsh -c npm run lint -- --lsp")];
    expect(judgeChildren(rows, 600, [])).toMatchObject({ verdict: "held",
      held: [{ pid: 601 }, { pid: 604 }], ignored: [{ pid: 602, kind: "mcp_server" }, { pid: 603, kind: "language_server" }] });
  });

  it("finding 2: on a Pi seat the runner and pi are the agent; what pi runs, a node build included, is its work", () => {
    const rows = [row(700, 1, "node", "node /opt/openrig/daemon/dist/adapters/pi-runner.js --session-name s"), row(701, 700, "pi", "pi"),
      row(702, 701, "node", "node ./scripts/build"), row(703, 701, "bash", "bash -c make")];
    expect(judgeChildren(rows, 700, [], "pi")).toMatchObject({ verdict: "held", held: [{ pid: 702 }, { pid: 703 }] });
    expect(judgeChildren(rows.slice(0, 2), 700, [], "pi")).toEqual({ verdict: "clear", ignored: [] });
    // Without the runtime the runner's pi is taken for work: the case the finding measured.
    expect(judgeChildren(rows.slice(0, 2), 700, [])).toMatchObject({ verdict: "held", held: [{ pid: 701 }] });
  });

  it("finding 3: a lease whose holder cannot be matched by start time is unknown, never held", () => {
    expect(judgeLeases(() => [{ holder: "h", pid: 9, liveness: "unknown" }], [])).toMatchObject({ verdict: "unknown" });
    expect(judgeLeases(() => [{ holder: "h", pid: 9, liveness: "unknown" }, { holder: "g", pid: 8, liveness: "alive" }], [])).toMatchObject({ verdict: "held", held: [{ holder: "g" }] });
  });

  it("--despite lease does not override held children", () => {
    const checks = { lease: judgeLeases(() => [], ["lease"]), children: judgeChildren([row(500, 1, "claude", "claude"), row(501, 500, "zsh", "zsh -c x")], 500, ["lease"]) };
    expect(blockingChecks(checks)).toEqual(["children"]);
  });
});

describe("o9o.8 core: the newest handover file", () => {
  const port = (files: Array<{ name: string; modifiedAt: string }>): RelaunchCheckPort => ({ leases: () => [], folderFiles: () => files });

  it("the newest by modification time, not by name, among HANDOVER*.md only", () => {
    const picked = newestHandoverFile("/seat", port([
      { name: "HANDOVER-2026-11-16-notes.md", modifiedAt: "2026-11-15T10:00:00.000Z" },
      { name: "HANDOVER.md", modifiedAt: "2026-11-16T10:00:00.000Z" },
      { name: "HANDOVER.txt", modifiedAt: "2026-11-17T10:00:00.000Z" },
      { name: "MY-HANDOVER.md", modifiedAt: "2026-11-17T10:00:00.000Z" },
    ]));
    expect(picked).toEqual({ path: "/seat/HANDOVER.md", modifiedAt: "2026-11-16T10:00:00.000Z" });
  });

  it("none", () => {
    expect(newestHandoverFile("/seat", port([{ name: "NOTES.md", modifiedAt: "2026-11-16T10:00:00.000Z" }]))).toBeNull();
  });
});

describe("o9o.8 adapter: the seat lease store", () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "o9o8-store-")); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it("a lease is a private file (0600 in a 0700 folder), counted while its holder is alive and reported stale once it is gone", () => {
    const table = new Map<number, string | null>([[4242, "Mon Nov 16 09:00:00 2026"]]);
    const store = new SeatLeaseStore(root, probeOf(table));
    expect(store.acquire("dev-impl@rig", { holder: "ui-test-host", pid: 4242 })).toMatchObject({ ok: true });
    const dir = nodePath.join(root, encodeURIComponent("dev-impl@rig"));
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(nodePath.join(dir, "ui-test-host.json")).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(dir)).toEqual(["ui-test-host.json"]);
    expect(store.leases("dev-impl@rig")).toEqual([{ holder: "ui-test-host", pid: 4242, liveness: "alive" }]);
    table.delete(4242);
    expect(store.leases("dev-impl@rig")).toEqual([{ holder: "ui-test-host", pid: 4242, liveness: "gone" }]);
  });

  it("finding 3: a reused pid is another process: the lease is gone; a start time that cannot be read leaves it unknown", () => {
    const table = new Map<number, string | null>([[4242, "Mon Nov 16 09:00:00 2026"]]);
    const store = new SeatLeaseStore(root, probeOf(table));
    store.acquire("dev-impl@rig", { holder: "ui-test-host", pid: 4242 });
    table.set(4242, "Tue Nov 17 01:00:00 2026");
    expect(store.leases("dev-impl@rig")).toEqual([{ holder: "ui-test-host", pid: 4242, liveness: "gone" }]);
    table.set(4242, null);
    expect(store.leases("dev-impl@rig")).toEqual([{ holder: "ui-test-host", pid: 4242, liveness: "unknown" }]);
    // A lease registered when the start time could not be read is never alive.
    store.acquire("dev-impl@rig", { holder: "late", pid: 4242 });
    table.set(4242, "Tue Nov 17 01:00:00 2026");
    expect(store.leases("dev-impl@rig").find((l) => l.holder === "late")).toMatchObject({ liveness: "unknown" });
  });

  it("finding 3: the OS probe reads this process's own start time, and the same again", async () => {
    const { osLeaseProcessProbe } = await import("../src/adapters/seat-lease-store.js");
    const first = osLeaseProcessProbe.startedAt(process.pid);
    expect(first).toMatch(/\d{2}:\d{2}:\d{2} \d{4}$/);
    expect(osLeaseProcessProbe.startedAt(process.pid)).toBe(first);
    expect(osLeaseProcessProbe.exists(process.pid)).toBe(true);
  });

  it("a seat with no leases has none; a folder that cannot be read, or a file that is not a lease, throws (the check then warns)", () => {
    const store = new SeatLeaseStore(root);
    expect(store.leases("dev-impl@rig")).toEqual([]);
    const dir = nodePath.join(root, encodeURIComponent("dev-impl@rig"));
    fs.mkdirSync(dir);
    fs.writeFileSync(nodePath.join(dir, "broken.json"), "{}");
    expect(() => store.leases("dev-impl@rig")).toThrow(/not a lease/);
    expect(judgeLeases(() => store.leases("dev-impl@rig"), [])).toMatchObject({ verdict: "unknown" });
  });

  it("a holder that is not a plain name never names a file outside the seat's folder", () => {
    const store = new SeatLeaseStore(root);
    expect(store.acquire("dev-impl@rig", { holder: "../../escape", pid: 4242 })).toMatchObject({ ok: false, code: "invalid_lease_holder" });
    expect(store.release("dev-impl@rig", "../../escape")).toBe(false);
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it("the node port lists only the files in a seat's folder", () => {
    fs.writeFileSync(nodePath.join(root, "HANDOVER.md"), "x");
    fs.mkdirSync(nodePath.join(root, "HANDOVER-dir.md"));
    expect(nodeRelaunchChecks(new SeatLeaseStore(root)).folderFiles(root).map((file) => file.name)).toEqual(["HANDOVER.md"]);
  });
});
