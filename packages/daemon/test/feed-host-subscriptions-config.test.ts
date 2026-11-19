// OPR.0.4.4.15 (guard G15-P1 fold) — the ONE registered dynamic key class:
// feed.subscriptions.<hostId>.enabled. These tests pin the fold's whole
// contract: round-trip persistence, delimiter + reserved-segment guards
// (warn-and-ignore on the read side, reject-loud on the write side),
// unknown NON-matching keys keeping the existing 400/throw behavior
// byte-for-byte, and CLI/daemon twin parity (the host-registry twin
// discipline: shared fixtures through BOTH implementations).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsStore, parseFeedHostSubscriptionKey as daemonParse } from "../src/domain/user-settings/settings-store.js";
import { openSettingsStore } from "../src/adapters/node-settings-file.js";
import { parseFeedHostSubscriptionKey as cliParse } from "../../cli/src/config-store.js";

let dir: string;
let configPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "feed-host-cfg-"));
  configPath = join(dir, "config.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function store(): SettingsStore {
  return openSettingsStore(configPath);
}

describe("dynamic feed-host subscription keys — daemon store", () => {
  it("set/resolve/list round-trip; reset removes the whole host node", () => {
    const s = store();
    s.set("feed.subscriptions.vps-b.enabled", "true");
    s.set("feed.subscriptions.mac_mini2.enabled", "false");
    expect(s.resolveFeedHostSubscription("feed.subscriptions.vps-b.enabled")).toEqual({ value: true, source: "file", defaultValue: false });
    expect(s.resolveFeedHostSubscription("feed.subscriptions.never-set.enabled")).toEqual({ value: false, source: "default", defaultValue: false });
    expect(s.listFeedHostSubscriptions()).toEqual([
      { hostId: "vps-b", enabled: true },
      { hostId: "mac_mini2", enabled: false },
    ]);
    s.reset("feed.subscriptions.vps-b.enabled");
    expect(s.listFeedHostSubscriptions()).toEqual([{ hostId: "mac_mini2", enabled: false }]);
    // The file layout nests under feed.subscriptions.<hostId>.enabled.
    const fc = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, never>;
    expect(fc).toEqual({ feed: { subscriptions: { mac_mini2: { enabled: false } } } });
  });

  it("write side rejects loudly: non-boolean values, reserved segments, dotted host ids, and every non-matching unknown key (existing behavior byte-preserved)", () => {
    const s = store();
    expect(() => s.set("feed.subscriptions.vps-b.enabled", "yes")).toThrow(/expected "true" or "false"/);
    // Reserved segments never parse as host ids → the flat-key/unknown path owns them.
    expect(() => s.set("feed.subscriptions.approvals.enabled", "true")).toThrow(/Unknown config key/);
    expect(() => s.set("feed.subscriptions.auditLog.enabled", "true")).toThrow(/Unknown config key/);
    // Dotted host ids are inexpressible in dotted keys (delimiter case).
    expect(() => s.set("feed.subscriptions.vps.b.enabled", "true")).toThrow(/Unknown config key/);
    // Per-host key set is CLOSED to {enabled} in v1.
    expect(() => s.set("feed.subscriptions.vps-b.altitude", "high")).toThrow(/Unknown config key/);
    // The pre-existing unknown-key negative, untouched.
    expect(() => s.set("totally.unknown.key", "x")).toThrow(/Unknown config key/);
  });

  it("read side warn-and-ignores malformed persisted nodes without dropping valid ones (the ratified guard)", () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        feed: {
          subscriptions: {
            approvals: true, // flat toggle leaf — silently fine, not a host
            "vps-b": { enabled: true },
            auditLog: { enabled: true }, // reserved OBJECT node — warned + ignored
            "bad seg!": { enabled: true }, // invalid segment — warned + ignored
            "half-baked": { enabled: "yes" }, // non-boolean — warned + ignored
          },
        },
      }),
    );
    const warnings: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
      warnings.push(String(chunk));
      return true;
    }) as never);
    expect(store().listFeedHostSubscriptions()).toEqual([{ hostId: "vps-b", enabled: true }]);
    expect(warnings.join("")).toContain("auditLog");
    expect(warnings.join("")).toContain("bad seg!");
    expect(warnings.join("")).toContain("half-baked");
  });
});

describe("dynamic feed-host subscription keys — CLI/daemon twin parity", () => {
  const PARSE_FIXTURES: Array<{ key: string; hostId: string | null }> = [
    { key: "feed.subscriptions.vps-b.enabled", hostId: "vps-b" },
    { key: "feed.subscriptions.mac_mini2.enabled", hostId: "mac_mini2" },
    { key: "feed.subscriptions.approvals.enabled", hostId: null }, // reserved (key-level)
    { key: "feed.subscriptions.auditLog.enabled", hostId: null }, // reserved (file-level)
    { key: "feed.subscriptions.enabled.enabled", hostId: null }, // reserved
    { key: "feed.subscriptions.vps.b.enabled", hostId: null }, // delimiter
    { key: "feed.subscriptions.vps-b.altitude", hostId: null }, // closed per-host set
    { key: "feed.subscriptions..enabled", hostId: null }, // empty segment
    { key: "workspace.root", hostId: null }, // unrelated key
  ];

  it("both parsers agree fixture-for-fixture (a divergence = one twin drifted)", () => {
    for (const f of PARSE_FIXTURES) {
      const d = daemonParse(f.key);
      const c = cliParse(f.key);
      expect(d?.hostId ?? null).toBe(f.hostId);
      expect(c?.hostId ?? null).toBe(f.hostId);
    }
  });
});
