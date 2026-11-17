// workspaces-o9o.16: the From and reply lines of a message from another host, and this host's names for other hosts.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RegistryHostDirectory } from "../src/adapters/registry-host-directory.js";
import { arrivalBody, envelopeLabel, originOf, replyPathFor, restampArrival, type HostDirectory } from "../src/domain/seat-messaging/reply-path.js";

const STU = "host-148dbc2f";
const named: HostDirectory = { nameFor: (id) => (id === STU ? "stu" : null) };
const unnamed: HostDirectory = { nameFor: () => null };
const envelope = (from: string, text = "hello") => [`From: ${from}`, "To: exec-cos@openrig", "---", text, "---", `↩ Reply: rig send ${from} '...'`].join("\n");
const restamped = (from: string, reply: string, text = "hello") => [`From: ${from}`, "To: exec-cos@openrig", "---", text, "---", reply].join("\n");

describe("the bead's four strings", () => {
  it.each([
    ["(a) a seat, host named", named, { host: STU, seat: "build-impl@openrig", label: null }, "build-impl@openrig@stu", "↩ Reply: rig send build-impl@openrig@stu '...'"],
    ["(b) a seat, host not named", unnamed, { host: STU, seat: "build-impl@openrig", label: null }, `build-impl@openrig@${STU}`, `↩ No reply path from this host: ${STU} is not in this host's registry ('rig host ls')`],
    ["(c) a labelled shell, host named", named, { host: STU, seat: null, label: "openrig-23" }, "openrig-23 (a shell on stu)", "↩ No reply path: openrig-23 is a shell on stu, not a seat; no rig address answers it"],
    ["(c) a labelled shell, host not named", unnamed, { host: STU, seat: null, label: "openrig-23" }, `openrig-23 (a shell on ${STU})`, `↩ No reply path: openrig-23 is a shell on ${STU}, not a seat; no rig address answers it`],
    ["(d) a shell with no label", named, { host: STU, seat: null, label: null }, "a shell on stu", "↩ No reply path: a shell on stu is not a seat; no rig address answers it"],
  ] as const)("%s", (_name, hosts, origin, from, reply) => {
    expect(restampArrival(envelope("whatever the sender wrote"), origin, hosts)).toBe(restamped(from, reply));
  });

  it("only a seat on a named host is reachable, and its command is the one the reply line shows", () => {
    expect(replyPathFor({ host: STU, seat: "build-impl@openrig", label: null }, named)).toEqual({ kind: "reachable", command: "rig send build-impl@openrig@stu '...'" });
    expect(replyPathFor({ host: STU, seat: "build-impl@openrig", label: null }, unnamed).kind).toBe("none");
    expect(replyPathFor({ host: STU, seat: null, label: "openrig-23" }, named).kind).toBe("none");
  });
});

describe("what is read off an arrival", () => {
  it("the label is the From line's, and the CLI's no-sender marker is no label", () => {
    expect(envelopeLabel(envelope("openrig-23"))).toBe("openrig-23");
    expect(envelopeLabel(envelope("<unknown sender>"))).toBeNull();
    expect(envelopeLabel("plain words")).toBeNull();
  });

  it("an origin holds together only with a host id and a sender that is `unknown` or a seat of that host", () => {
    expect(originOf(STU, "unknown", envelope("openrig-23"))).toEqual({ host: STU, seat: null, label: "openrig-23" });
    expect(originOf(STU, `build-impl@openrig@${STU}`, envelope("x"))).toEqual({ host: STU, seat: "build-impl@openrig", label: "x" });
    expect(originOf(STU, "build-impl@openrig@host-other", envelope("x"))).toBeNull();
    expect(originOf(STU, "build-impl@openrig", envelope("x"))).toBeNull();
    expect(originOf("not a host", "unknown", envelope("x"))).toBeNull();
    expect(originOf(undefined, "unknown", envelope("x"))).toBeNull();
    expect(originOf(STU, 7, envelope("x"))).toBeNull();
  });

  it("text without the envelope's shape rides as written", () => {
    const origin = { host: STU, seat: null, label: null };
    for (const text of ["plain words", "From: x\n---\nno reply line", "From: x\nTo: y\n---\nhello\n---\nno reply line", "From: x\nTo: y\nhello\nthere\n↩ Reply: rig send x '...'", "↩ Reply: x\nTo: y\n---\nhello\n↩ Reply: z"]) {
      expect(restampArrival(text, origin, named)).toBe(text);
    }
  });
});

describe("a repeat of an arrival", () => {
  const origin = { host: STU, seat: null, label: null };
  const raw = envelope("<unknown sender>");
  const before = restampArrival(raw, origin, unnamed);
  const after = restampArrival(raw, origin, named);

  it("keeps its first text when the registry learned the origin in between", () => {
    expect(before).not.toBe(after);
    expect(arrivalBody(before, raw, origin, named)).toBe(before);
  });

  it("a first arrival, or an unchanged registry, is restamped as now", () => {
    expect(arrivalBody(undefined, raw, origin, named)).toBe(after);
    expect(arrivalBody(null, raw, origin, named)).toBe(after);
    expect(arrivalBody(after, raw, origin, named)).toBe(after);
  });

  it("another text, or another label, under the id is not adopted: the store calls it a conflict", () => {
    expect(arrivalBody(before, envelope("<unknown sender>", "other words"), origin, named)).toBe(restampArrival(envelope("<unknown sender>", "other words"), origin, named));
    const labelled = { ...origin, label: "openrig-23" };
    expect(arrivalBody(before, envelope("openrig-23"), labelled, named)).toBe(restampArrival(envelope("openrig-23"), labelled, named));
  });
});

describe("this host's registry as the directory", () => {
  let dir: string | undefined;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });
  const files = (registry: string | null, bindings: string | null) => {
    dir = mkdtempSync(join(tmpdir(), "o9o16-"));
    const paths = { registry: join(dir, "hosts.yaml"), bindings: join(dir, "host-bindings.json") };
    if (registry !== null) writeFileSync(paths.registry, registry);
    if (bindings !== null) writeFileSync(paths.bindings, bindings);
    return new RegistryHostDirectory(paths);
  };
  const REGISTRY = "hosts:\n  - id: stu\n    transport: http\n    url: http://stu.example:7433\n  - id: laptop\n    transport: http\n    url: http://laptop.example:7433\n    hostId: host-d4b45dec\n";

  it("names a host by its alias, its declared hostId, or the self-id the CLI learned for it, as rig send resolves it here", () => {
    const hosts = files(REGISTRY, JSON.stringify({ version: 1, bindings: { stu: { hostId: STU, firstObservedAt: "", lastObservedAt: "" } } }));
    expect(hosts.nameFor("stu")).toBe("stu");
    expect(hosts.nameFor("host-d4b45dec")).toBe("laptop");
    expect(hosts.nameFor(STU)).toBe("stu");
    expect(hosts.nameFor("host-00000000")).toBeNull();
  });

  it("reads the files on every call, so a host learned after the daemon started is named on the next arrival", () => {
    const hosts = files(REGISTRY, null);
    expect(hosts.nameFor(STU)).toBeNull();
    writeFileSync(join(dir!, "host-bindings.json"), JSON.stringify({ version: 1, bindings: { stu: { hostId: STU } } }));
    expect(hosts.nameFor(STU)).toBe("stu");
  });

  it("fails open: no registry, a broken registry, or a broken or future sidecar names nothing it cannot read", () => {
    expect(files(null, null).nameFor("stu")).toBeNull();
    expect(files("hosts: [", null).nameFor("stu")).toBeNull();
    expect(files(REGISTRY, "{ not json").nameFor(STU)).toBeNull();
    expect(files(REGISTRY, JSON.stringify({ version: 2, bindings: { stu: { hostId: STU } } })).nameFor(STU)).toBeNull();
    expect(files(REGISTRY, JSON.stringify({ version: 1, bindings: { stu: { hostId: "" } } })).nameFor(STU)).toBeNull();
    expect(files(REGISTRY, JSON.stringify({ version: 1, bindings: { stu: { hostId: STU } } })).nameFor("stu")).toBe("stu");
  });
});
