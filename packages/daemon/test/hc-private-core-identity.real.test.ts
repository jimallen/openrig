// The identity check of a private core (PrivateCore.isMine), which the real-core kill rows rely on before they signal anything.
// hc 0.1.17's core is `hc --hc-launchd`, parent 1, with no environment in `ps -E`, so on macOS it is known by the socket it listens on.
// Both cores share one session name (same tag, same pid), so only the socket path tells them apart. Rows: this test's own core and holder are its own; another private core, an ordinary process and a pid that is gone are not.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HC, PrivateCore } from "./hc-private-core.js";

describe.skipIf(!HC)("PrivateCore.isMine", () => {
  const a = new PrivateCore("id");
  const b = new PrivateCore("id");
  beforeAll(() => { a.start(); b.start(); });
  afterAll(() => { a.stop(); b.stop(); });

  it("a core is its own: the pid its own socket answers with", async () => {
    expect(a.isMine(await a.corePid())).toBe(true);
    expect(b.isMine(await b.corePid())).toBe(true);
  });

  it("a core is not another private core's, and this process is nobody's", async () => {
    expect(a.isMine(await b.corePid())).toBe(false);
    expect(b.isMine(await a.corePid())).toBe(false);
    expect(a.isMine(process.pid)).toBe(false);
    expect(a.isMine(2_000_000_000)).toBe(false);
  });
});
