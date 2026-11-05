import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as surface from "../src/hc-surface.js";
import * as client from "../src/adapters/hc-client.js";
import * as placement from "../src/adapters/hc-placement.js";
import * as seat from "../src/adapters/hc-seat.js";
import * as version from "../src/adapters/hc-version.js";

// `@openrig/daemon/hc` is what the CLI uses instead of restating the hc pin, protocol generation, socket path, seat label,
// terminal name and placement labels. A change here reaches `rig destroy`, `rig whoami`, `rig doctor` and `rig setup`.
const SRC = join(dirname(fileURLToPath(import.meta.url)), "../src");

describe("the hc surface exports", () => {
  it("exactly the names the CLI needs, and no host, lifecycle, watch or placement driver", () => {
    expect(Object.keys(surface).sort()).toEqual([
      "HC_GENERATION", "HC_OLDEST_ACCEPTED_VERSION", "HC_TESTED_VERSION", "HC_TESTED_VERSIONS", "HcClient", "HcError", "HcOutcomeUnknownError", "HcUnavailableError",
      "KERNEL_RIG", "KERNEL_TAB", "SEAT_LABEL", "SPACE_LABEL", "TAB_ID_SEPARATOR", "TAB_LABEL",
      "coreRuntimeLocationRefusal", "hcTerminalName", "judgeHcVersion", "parseHcVersionOutput", "pickLead", "placementLabels", "planKernelTabs", "planLabels", "planRigTabs", "resolveHcSocket",
      "rigOfSeat", "rigSpaceId", "rigTabId",
    ]);
  });

  it("each name is the defining module's own value, not a copy", () => {
    for (const name of ["HC_GENERATION", "HcClient", "HcError", "HcOutcomeUnknownError", "HcUnavailableError", "resolveHcSocket"] as const) {
      expect(surface[name], name).toBe(client[name]);
    }
    for (const name of ["SEAT_LABEL", "hcTerminalName"] as const) expect(surface[name], name).toBe(seat[name]);
    for (const name of ["HC_OLDEST_ACCEPTED_VERSION", "HC_TESTED_VERSION", "HC_TESTED_VERSIONS", "judgeHcVersion", "parseHcVersionOutput"] as const) {
      expect(surface[name], name).toBe(version[name]);
    }
    for (const name of ["KERNEL_RIG", "KERNEL_TAB", "SPACE_LABEL", "TAB_ID_SEPARATOR", "TAB_LABEL", "pickLead", "placementLabels", "planKernelTabs", "planLabels", "planRigTabs", "rigOfSeat", "rigSpaceId", "rigTabId"] as const) {
      expect(surface[name], name).toBe(placement[name]);
    }
  });

  // These are persisted or on the wire: a seat's terminal is found by this name and this label across revisions, and a
  // core on another generation refuses `hello`. Restated here with the recipe spelled out, so each can fail on its own.
  it("keeps the durable values: terminal name recipe, seat label, generation, pin", () => {
    expect(surface.hcTerminalName("verify-qa@eztrack")).toBe("s-" + createHash("sha256").update("verify-qa@eztrack").digest("hex").slice(0, 24));
    expect(surface.hcTerminalName("a@b")).not.toBe(surface.hcTerminalName("a@c"));
    expect(surface.SEAT_LABEL).toBe("openrig.seat");
    expect(surface.HC_GENERATION).toBe(1);
    expect(surface.HC_TESTED_VERSION).toBe("0.1.17");
    expect([...surface.HC_TESTED_VERSIONS]).toEqual(["0.1.16", "0.1.17"]);
    expect(surface.HC_OLDEST_ACCEPTED_VERSION).toBe("0.1.15");
  });
});

describe("the hc surface pulls in nothing heavy", () => {
  /** The files reached from the surface by relative import, and every non-relative specifier met on the way. */
  function closure(entry: string): { files: string[]; external: string[] } {
    const seen = new Set<string>();
    const external = new Set<string>();
    const walk = (file: string): void => {
      if (seen.has(file)) return;
      seen.add(file);
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/(?:^|\n)\s*(?:import|export)\b[^;]*?\bfrom\s+"([^"]+)"|(?:^|\n)\s*import\s+"([^"]+)"|\bimport\(\s*"([^"]+)"\s*\)/g)) {
        const spec = m[1] ?? m[2] ?? m[3]!;
        if (spec.startsWith(".")) walk(resolve(dirname(file), spec.replace(/\.js$/, ".ts")));
        else external.add(spec);
      }
    };
    walk(entry);
    return { files: [...seen].map((f) => relative(SRC, f)).sort(), external: [...external].sort() };
  }

  it("reaches seven small files and only Node built-ins (the core watch is not among them)", () => {
    const { files, external } = closure(join(SRC, "hc-surface.ts"));
    expect(files).toEqual([
      "adapters/hc-client.ts", "adapters/hc-placement.ts", "adapters/hc-remote-control-env.ts", "adapters/hc-seat.ts", "adapters/hc-version.ts",
      "domain/parent-session-env.ts", "hc-surface.ts",
    ]);
    expect(external).toEqual(["node:crypto", "node:net", "node:os", "node:path"]);
  });

  it("the version rule is a leaf: it imports nothing, so judging a version never pulls in a client or a watch", () => {
    expect(closure(join(SRC, "adapters/hc-version.ts"))).toEqual({ files: ["adapters/hc-version.ts"], external: [] });
  });

  it("the closure walker sees a relative and a bare import (control)", () => {
    const { files, external } = closure(join(SRC, "adapters/hc-identity.ts"));
    expect(files.length).toBeGreaterThan(5);
    expect(files).toContain("adapters/hc-seat.ts");
    expect(external.length).toBeGreaterThan(0);
  });

  it("is exported as @openrig/daemon/hc", () => {
    const pkg = JSON.parse(readFileSync(join(SRC, "../package.json"), "utf8")) as { exports: Record<string, { types: string; import: string }> };
    expect(pkg.exports["./hc"]).toEqual({ types: "./dist/hc-surface.d.ts", import: "./dist/hc-surface.js" });
  });
});
