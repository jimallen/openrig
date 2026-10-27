// OPR.0.4.4.11 — topology-manifest parse/validate (FR-1: the CLOSED key set).
//
// The rejection legs are the load-bearing tests here: the key set being
// CLOSED is the thin-manifest enforcement itself (arch R11-1), and the
// edge/routing rejection must NAME the founder-ratified non-goal — silently
// ignoring an unknown key would reopen it by stealth.

import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  validateTopologyManifest,
  loadTopologyManifest,
  hasTopLevelRigsList,
  yamlTextHasTopLevelRigsList,
} from "../src/domain/topology/topology-manifest.js";

const SRC = "/fixture/factory.rigtopology";

function errorsOf(res: ReturnType<typeof validateTopologyManifest>): string[] {
  return res.ok ? [] : res.errors;
}

describe("topology-manifest — valid shapes", () => {
  it("minimal one-rig manifest normalizes to concurrency 1 (sequential default)", () => {
    const res = validateTopologyManifest({ rigs: [{ source: "factory.yaml" }] }, SRC);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.manifest).toEqual({ rigs: [{ source: "factory.yaml" }], concurrency: 1 });
    }
  });

  it("multi-rig with per-entry host placement + explicit concurrency, order preserved", () => {
    const res = validateTopologyManifest(
      {
        rigs: [
          { source: "./orch.yaml" },
          { source: "./workers/rig.yaml", host: "vps-b" },
          { source: "specs/watch.yaml" },
        ],
        concurrency: 2,
      },
      SRC,
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.manifest.concurrency).toBe(2);
      expect(res.manifest.rigs.map((r) => r.source)).toEqual(["./orch.yaml", "./workers/rig.yaml", "specs/watch.yaml"]);
      expect(res.manifest.rigs[1]!.host).toBe("vps-b");
      expect(res.manifest.rigs[0]!.host).toBeUndefined();
    }
  });

  it("extensionless PATH-form spec entries stay valid (a spec path needs no extension; bare NAMES are the rejected form)", () => {
    const res = validateTopologyManifest({ rigs: [{ source: "specs/myrig" }] }, SRC);
    expect(res.ok).toBe(true);
  });
});

describe("topology-manifest — CLOSED key set (FR-1 rejection legs)", () => {
  it("rejects a non-object document with the what/why/fix shape", () => {
    const res = validateTopologyManifest("nope", SRC);
    expect(res.ok).toBe(false);
    expect(errorsOf(res)[0]).toContain("must be a YAML object with a top-level 'rigs' list");
  });

  it("rejects missing/non-list/empty rigs per-case", () => {
    expect(errorsOf(validateTopologyManifest({}, SRC))[0]).toContain("'rigs' must be a list");
    expect(errorsOf(validateTopologyManifest({ rigs: {} }, SRC))[0]).toContain("'rigs' must be a list");
    expect(errorsOf(validateTopologyManifest({ rigs: [] }, SRC))[0]).toContain("'rigs' is empty");
  });

  it("rejects unknown MANIFEST-level keys naming the closed set", () => {
    const res = validateTopologyManifest({ rigs: [{ source: "a.yaml" }], banner: "x" }, SRC);
    expect(res.ok).toBe(false);
    expect(errorsOf(res)[0]).toContain("unknown key 'banner'");
    expect(errorsOf(res)[0]).toContain("CLOSED");
  });

  it("rejects unknown ENTRY-level keys naming the closed entry set", () => {
    const res = validateTopologyManifest({ rigs: [{ source: "a.yaml", retries: 3 }] }, SRC);
    expect(res.ok).toBe(false);
    expect(errorsOf(res)[0]).toContain("rigs[0]");
    expect(errorsOf(res)[0]).toContain("unknown key 'retries'");
  });

  it("REJECTS cross-rig edge/routing keys NAMING the founder-ratified non-goal (manifest level)", () => {
    for (const key of ["edges", "routing", "depends_on"]) {
      const res = validateTopologyManifest({ rigs: [{ source: "a.yaml" }], [key]: [] }, SRC);
      expect(res.ok).toBe(false);
      const msg = errorsOf(res).find((e) => e.includes(`'${key}'`));
      expect(msg).toBeDefined();
      expect(msg).toContain("founder-ratified non-goal");
      expect(msg).toContain("topology-Q1");
    }
  });

  it("REJECTS edge/routing keys at ENTRY level with the same non-goal message", () => {
    const res = validateTopologyManifest({ rigs: [{ source: "a.yaml", needs: ["b"] }] }, SRC);
    expect(res.ok).toBe(false);
    const msg = errorsOf(res)[0];
    expect(msg).toContain("rigs[0]");
    expect(msg).toContain("'needs'");
    expect(msg).toContain("founder-ratified non-goal");
  });

  it("rejects 'on_failure' with the removed-for-v0 stop-on-failure message", () => {
    const res = validateTopologyManifest({ rigs: [{ source: "a.yaml" }], on_failure: "continue" }, SRC);
    expect(res.ok).toBe(false);
    expect(errorsOf(res)[0]).toContain("'on_failure' was removed for v0");
    expect(errorsOf(res)[0]).toContain("stop-on-failure");
  });

  it("rejects bad source/host shapes per-entry", () => {
    const res = validateTopologyManifest(
      { rigs: [{ source: "  " }, { host: "h" }, { source: "ok.yaml", host: "" }, "not-an-object"] },
      SRC,
    );
    expect(res.ok).toBe(false);
    const errs = errorsOf(res);
    expect(errs.find((e) => e.includes("rigs[0].source"))).toBeDefined();
    expect(errs.find((e) => e.includes("rigs[1].source"))).toBeDefined();
    expect(errs.find((e) => e.includes("rigs[2].host"))).toBeDefined();
    expect(errs.find((e) => e.includes("rigs[3]") && e.includes("must be an object"))).toBeDefined();
  });

  it("collects ALL structural errors in one pass (per-entry reporting, not fail-fast)", () => {
    const res = validateTopologyManifest(
      { rigs: [{ source: "" }, { source: "b.yaml", extra: 1 }], concurrency: 0, edges: [] },
      SRC,
    );
    expect(res.ok).toBe(false);
    const errs = errorsOf(res);
    expect(errs.length).toBe(4); // edges + concurrency + rigs[0].source + rigs[1].extra
  });

  it("rejects non-positive-integer concurrency values", () => {
    for (const bad of [0, -1, 1.5, "2"]) {
      const res = validateTopologyManifest({ rigs: [{ source: "a.yaml" }], concurrency: bad }, SRC);
      expect(res.ok).toBe(false);
      expect(errorsOf(res)[0]).toContain("'concurrency' must be a positive integer");
    }
  });
});

describe("topology-manifest — v0 source-form boundary (arch ruling 2026-07-05: SPEC PATHS ONLY, parse-time)", () => {
  it(".rigbundle entries reject naming the v0 boundary AND the direct single-rig rig-up workaround (stamped FR-1 wording)", () => {
    const res = validateTopologyManifest({ rigs: [{ source: "./workers.rigbundle" }] }, SRC);
    expect(res.ok).toBe(false);
    const msg = errorsOf(res)[0]!;
    expect(msg).toContain("rigs[0].source");
    expect(msg).toContain("SPEC PATHS ONLY");
    expect(msg).toContain("per-entry targetRoot");
    expect(msg).toContain("launch that rig directly — single-rig 'rig up ./workers.rigbundle'");
  });

  it("bare library/rig-name entries reject naming the deferral AND the rig-up-individually workaround", () => {
    const res = validateTopologyManifest({ rigs: [{ source: "orchestrator" }] }, SRC);
    expect(res.ok).toBe(false);
    const msg = errorsOf(res)[0]!;
    expect(msg).toContain("'orchestrator' is a bare library/rig name");
    expect(msg).toContain("SPEC PATHS ONLY");
    expect(msg).toContain("rig up orchestrator");
  });

  it("nested .rigtopology entries reject at parse time", () => {
    const res = validateTopologyManifest({ rigs: [{ source: "./inner.rigtopology" }] }, SRC);
    expect(res.ok).toBe(false);
    expect(errorsOf(res)[0]).toContain("nested topology manifests are not supported");
  });

  it("form rejections are per-entry and collected alongside the rest (not fail-fast)", () => {
    const res = validateTopologyManifest(
      { rigs: [{ source: "good.yaml" }, { source: "bad.rigbundle" }, { source: "barename" }] },
      SRC,
    );
    expect(res.ok).toBe(false);
    const errs = errorsOf(res);
    expect(errs.length).toBe(2);
    expect(errs[0]).toContain("rigs[1].source");
    expect(errs[1]).toContain("rigs[2].source");
  });
});

describe("topology-manifest — file loading", () => {
  it("missing file returns the canonical what/why/fix error, never a throw", () => {
    const res = loadTopologyManifest("/nonexistent/factory.rigtopology");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors[0]).toContain("topology manifest not found at /nonexistent/factory.rigtopology");
  });

  it("loads + validates a real file from disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "topo-manifest-"));
    const p = join(dir, "factory.rigtopology");
    writeFileSync(p, "rigs:\n  - source: ./orch.yaml\n  - source: ./workers/rig.yaml\n    host: vps-b\nconcurrency: 2\n");
    const res = loadTopologyManifest(p);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.manifest.rigs).toHaveLength(2);
      expect(res.manifest.rigs[1]).toEqual({ source: "./workers/rig.yaml", host: "vps-b" });
      expect(res.manifest.concurrency).toBe(2);
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("unparseable YAML errors AS a topology (declared kind binds — no rig-spec fall-through)", () => {
    const dir = mkdtempSync(join(tmpdir(), "topo-manifest-"));
    const p = join(dir, "broken.rigtopology");
    writeFileSync(p, "rigs: [unclosed\n  - :::\n");
    const res = loadTopologyManifest(p);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors[0]).toContain("failed to parse topology manifest YAML");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("topology-manifest — detection sniffs (the router's G-1 contract)", () => {
  it("hasTopLevelRigsList: true ONLY for a top-level rigs LIST", () => {
    expect(hasTopLevelRigsList({ rigs: [] })).toBe(true);
    expect(hasTopLevelRigsList({ rigs: [{ source: "a" }], concurrency: 2 })).toBe(true);
    expect(hasTopLevelRigsList({ rigs: {} })).toBe(false); // not a list — extension is the escape hatch
    expect(hasTopLevelRigsList({ name: "factory", pods: [] })).toBe(false); // rig-spec shape
    expect(hasTopLevelRigsList(null)).toBe(false);
    expect(hasTopLevelRigsList([])).toBe(false);
    expect(hasTopLevelRigsList("rigs")).toBe(false);
  });

  it("yamlTextHasTopLevelRigsList: sniffs raw text; unparseable text sniffs false (flows to existing handling)", () => {
    expect(yamlTextHasTopLevelRigsList("rigs:\n  - source: a\n")).toBe(true);
    expect(yamlTextHasTopLevelRigsList("name: factory\npods: []\n")).toBe(false);
    expect(yamlTextHasTopLevelRigsList("rigs: [unclosed\n  - :::\n")).toBe(false);
  });
});
