import { describe, it, expect } from "vitest";
import { checkAbi, openInChildProcess } from "../scripts/check-abi.mjs";

/** The refusal message of a failed check; a passing check has none, which fails the calling assertion loudly. */
function messageOf(result: ReturnType<typeof checkAbi>): string {
  if (result.ok) throw new Error("expected a refusal, but the ABI check passed");
  return result.message;
}

describe("postinstall ABI check", () => {
  it("passes on supported even-numbered LTS with working native addon", () => {
    const result = checkAbi({
      nodeVersion: "v22.22.1",
      loadNativeAddon: () => {},
    });
    expect(result).toEqual({ ok: true });
  });

  it("refuses Node 20 before loading the native addon", () => {
    let addonCalled = false;
    const result = checkAbi({
      nodeVersion: "v20.20.2",
      loadNativeAddon: () => { addonCalled = true; },
    });
    expect(result.ok).toBe(false);
    expect(addonCalled).toBe(false);
    expect(messageOf(result)).toContain("requires Node.js 22 or 24");
    expect(messageOf(result)).toContain("Node 20 is no longer supported");
    expect(messageOf(result)).toContain("v20.20.2");
    expect(messageOf(result)).toContain("nvm install 22");
  });

  it("passes on Node 24 LTS", () => {
    const result = checkAbi({
      nodeVersion: "v24.0.0",
      loadNativeAddon: () => {},
    });
    expect(result).toEqual({ ok: true });
  });

  it("fails on odd-numbered Node 25 with honest error + fix command", () => {
    const result = checkAbi({
      nodeVersion: "v25.8.0",
      loadNativeAddon: () => {},
    });
    expect(result.ok).toBe(false);
    expect(messageOf(result)).toContain("odd-numbered");
    expect(messageOf(result)).toContain("v25.8.0");
    expect(messageOf(result)).toContain("nvm install 22");
  });

  it("fails on odd-numbered Node 23 with honest error", () => {
    const result = checkAbi({
      nodeVersion: "v23.5.0",
      loadNativeAddon: () => {},
    });
    expect(result.ok).toBe(false);
    expect(messageOf(result)).toContain("odd-numbered");
  });

  it("fails on Node below 22 with version-too-low error", () => {
    const result = checkAbi({
      nodeVersion: "v18.20.0",
      loadNativeAddon: () => {},
    });
    expect(result.ok).toBe(false);
    expect(messageOf(result)).toContain("requires Node.js 22 or 24");
    expect(messageOf(result)).toContain("nvm install 22");
  });

  it("fails with ABI mismatch error when native addon throws on supported version", () => {
    const result = checkAbi({
      nodeVersion: "v22.22.1",
      loadNativeAddon: () => {
        throw new Error(
          "The module was compiled against a different Node.js version using NODE_MODULE_VERSION 127. " +
          "This version of Node.js requires NODE_MODULE_VERSION 131."
        );
      },
    });
    expect(result.ok).toBe(false);
    expect(messageOf(result)).toContain("native binary does not match");
    expect(messageOf(result)).toContain("npm rebuild better-sqlite3");
    expect(messageOf(result)).toContain("NODE_MODULE_VERSION");
  });

  it("reports generic native-load-failure for MODULE_NOT_FOUND (not ABI-mismatch text)", () => {
    const result = checkAbi({
      nodeVersion: "v22.22.1",
      loadNativeAddon: () => {
        const err = new Error("Cannot find module 'better-sqlite3'");
        (err as NodeJS.ErrnoException).code = "MODULE_NOT_FOUND";
        throw err;
      },
    });
    expect(result.ok).toBe(false);
    // Should NOT say "native binary does not match" — that's ABI-specific
    expect(messageOf(result)).not.toContain("native binary does not match");
    // Should say generic addon-load-failure
    expect(messageOf(result)).toContain("native addon failed to load");
    expect(messageOf(result)).toContain("Cannot find module");
    expect(messageOf(result)).toContain("npm rebuild better-sqlite3");
  });

  it("reports generic native-load-failure for filesystem permission errors", () => {
    const result = checkAbi({
      nodeVersion: "v22.22.1",
      loadNativeAddon: () => {
        throw new Error("EACCES: permission denied, open '/usr/local/lib/better_sqlite3.node'");
      },
    });
    expect(result.ok).toBe(false);
    expect(messageOf(result)).not.toContain("native binary does not match");
    expect(messageOf(result)).toContain("native addon failed to load");
    expect(messageOf(result)).toContain("EACCES");
  });

  it("skips native addon check entirely for odd versions (fast path)", () => {
    let addonCalled = false;
    const result = checkAbi({
      nodeVersion: "v25.8.0",
      loadNativeAddon: () => { addonCalled = true; },
    });
    expect(result.ok).toBe(false);
    // Version check short-circuits before trying to load the addon
    expect(addonCalled).toBe(false);
  });

  it("warns but passes on an untested even major above 24 when the database opens", () => {
    const result = checkAbi({
      nodeVersion: "v26.1.0",
      loadNativeAddon: () => {},
      openNativeDatabase: () => ({ ok: true }),
    });
    // The whole ok result, not a narrowed field: an ok:true that lost or changed its warning fails here.
    expect(result).toEqual({ ok: true, warning: expect.stringContaining("Node 26 is untested") });
    expect(result).toEqual({ ok: true, warning: expect.stringContaining("Supported: Node.js 22 and 24") });
  });

  it("does not warn on supported majors", () => {
    const result = checkAbi({
      nodeVersion: "v24.21.0",
      loadNativeAddon: () => {},
      openNativeDatabase: () => ({ ok: true }),
    });
    expect(result).toEqual({ ok: true });
  });

  it("fails when the addon loads but a database cannot be opened", () => {
    const result = checkAbi({
      nodeVersion: "v22.22.1",
      loadNativeAddon: () => {},
      openNativeDatabase: () => ({ ok: false, detail: "database open was killed by SIGSEGV" }),
    });
    expect(result.ok).toBe(false);
    expect(messageOf(result)).toContain("could not open a database");
    expect(messageOf(result)).toContain("SIGSEGV");
    expect(messageOf(result)).toContain("npm rebuild better-sqlite3");
  });

  it("does not open a database when the addon fails to load", () => {
    let opened = false;
    const result = checkAbi({
      nodeVersion: "v22.22.1",
      loadNativeAddon: () => { throw new Error("dlopen failed"); },
      openNativeDatabase: () => { opened = true; return { ok: true }; },
    });
    expect(result.ok).toBe(false);
    expect(opened).toBe(false);
  });
});

describe("openInChildProcess", () => {
  const fake = (r: Record<string, unknown>) => () => ({ status: null, signal: null, stderr: "", ...r });

  it("reports a native crash signal instead of dying", () => {
    const out = openInChildProcess("/x/better-sqlite3", fake({ signal: "SIGSEGV" }));
    expect(out).toEqual({ ok: false, detail: "database open was killed by SIGSEGV" });
  });

  it("reports a non-zero exit with the tail of stderr", () => {
    const out = openInChildProcess("/x/better-sqlite3", fake({ status: 1, stderr: "a\nb\nError: boom" }));
    expect(out).toEqual({ ok: false, detail: expect.stringContaining("exited 1") });
    expect(out).toEqual({ ok: false, detail: expect.stringContaining("Error: boom") });
  });

  it("passes the resolved addon path to a fresh Node process", () => {
    let argv: string[] = [];
    const out = openInChildProcess("/abs/better-sqlite3/lib/index.js", (_cmd: string, args: string[]) => {
      argv = args;
      return { status: 0, signal: null, stderr: "" };
    });
    expect(out).toEqual({ ok: true });
    expect(argv[0]).toBe("-e");
    expect(argv[1]).toContain('require("/abs/better-sqlite3/lib/index.js")');
    expect(argv[1]).toContain('new Database(":memory:")');
  });
});
