// workspaces-o9o.182: host-bindings.json picks which registry entry (url + bearer) a reply hint resolves to, so it is read and
// rewritten under the credential rule for a file OpenRig owns: a link is never trusted or written through, the write never follows a
// link planted at its temp name, and a file of ours others could change is narrowed (go-w).
import { describe, it, expect, afterEach } from "vitest";
import { lstatSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync, chmodSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadHostBindings, recordHostObservation } from "../src/host-bindings.js";

const dirs: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "host-bindings-guarded-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const fixedNow = () => new Date("2026-08-21T02:00:00.000Z");
const bindingsText = (alias: string, hostId: string): string =>
  `${JSON.stringify({ version: 1, bindings: { [alias]: { hostId, firstObservedAt: "2026-08-20T00:00:00.000Z", lastObservedAt: "2026-08-20T00:00:00.000Z" } } }, null, 2)}\n`;

describe("host-bindings.json is read and rewritten as OpenRig's own file (workspaces-o9o.182)", () => {
  it("a symlinked host-bindings.json is not trusted: it reads as no bindings", () => {
    const d = tmpDir();
    const elsewhere = join(d, "planted.json");
    writeFileSync(elsewhere, bindingsText("mm2-host", "host-planted"), { mode: 0o600 });
    const path = join(d, "host-bindings.json");
    symlinkSync(elsewhere, path);
    expect(loadHostBindings(path).bindings).toEqual({});
  });

  it("recording through a symlinked host-bindings.json is refused, naming the file; the link and its target are left as they are", () => {
    const d = tmpDir();
    const elsewhere = join(d, "planted.json");
    const before = bindingsText("other", "host-other");
    writeFileSync(elsewhere, before, { mode: 0o600 });
    const path = join(d, "host-bindings.json");
    symlinkSync(elsewhere, path);
    const out = recordHostObservation({ alias: "mm2-host", observedHostId: "host-84c37990", now: fixedNow, path });
    expect(out.outcome).toBe("refused");
    expect(out.outcome === "refused" ? out.message : "").toContain(path);
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
    expect(readlinkSync(path)).toBe(elsewhere);
    expect(readFileSync(elsewhere, "utf-8")).toBe(before);
  });

  it("the write never follows a link planted at its temp name: the planted target is untouched and the bindings land", () => {
    const d = tmpDir();
    const victim = join(d, "victim.txt");
    writeFileSync(victim, "keep me\n", { mode: 0o600 });
    const path = join(d, "host-bindings.json");
    // The temp name a writer that derives it from the path and the pid would pick.
    symlinkSync(victim, `${path}.tmp-${process.pid}`);
    const out = recordHostObservation({ alias: "mm2-host", observedHostId: "host-84c37990", now: fixedNow, path });
    expect(out.outcome).toBe("bound");
    expect(readFileSync(victim, "utf-8")).toBe("keep me\n");
    expect(loadHostBindings(path).bindings["mm2-host"]?.hostId).toBe("host-84c37990");
  });

  it("a host-bindings.json of ours that others can change is narrowed (go-w) when it is recorded, and still read", () => {
    const d = tmpDir();
    const path = join(d, "host-bindings.json");
    writeFileSync(path, bindingsText("mm2-host", "host-84c37990"));
    chmodSync(path, 0o666);
    const out = recordHostObservation({ alias: "mm2-host", observedHostId: "host-84c37990", now: fixedNow, path });
    expect(out.outcome).toBe("confirmed");
    expect(statSync(path).mode & 0o022).toBe(0);
  });

  it("positive control: a first record creates the file with no group or other write, and leaves no temp file", () => {
    const d = tmpDir();
    const path = join(d, "host-bindings.json");
    const out = recordHostObservation({ alias: "mm2-host", observedHostId: "host-84c37990", now: fixedNow, path });
    expect(out.outcome).toBe("bound");
    expect(statSync(path).mode & 0o022).toBe(0);
    expect(readdirSync(d).filter((f) => f !== "host-bindings.json" && !f.endsWith(".lock"))).toEqual([]);
    expect(loadHostBindings(path).bindings["mm2-host"]?.hostId).toBe("host-84c37990");
  });
});
