// workspaces-o9o.161: the daemon's calls to another OpenRig daemon go through a port the domain declares (RemoteDaemonClient,
// src/domain/hosts/remote-daemon-client.ts); fetch and the HTTP mechanics live in its adapter (src/adapters/remote-daemon-http.ts),
// wired in startup.ts, server.ts and the routes. The hexagonal import census cannot see fetch (a global, not an import), so this file
// pins it: no domain file of the hosts context, and none of the callers moved onto the port, calls fetch, names its type, or reads the
// routes' fetch test seam. And the domain is driven here through an in-memory fake of the port, with no HTTP at all.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { HttpHostEntry } from "../src/domain/hosts/hosts-registry-reader.js";
import type { RemoteDaemonClient, RemoteJsonRequest, RemoteJsonResult } from "../src/domain/hosts/remote-daemon-client.js";
import { remoteUpLeaf } from "../src/domain/topology/remote-up-leaf.js";
import { FarDaemons } from "../src/domain/seat-messaging/far-daemon.js";
import { aggregateAttention } from "../src/domain/feed/attention-aggregator.js";
import { NO_CREDENTIAL_FILES } from "./helpers/credential-files.js";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
/** The callers moved onto the port; everything under domain/hosts is scanned as well. */
const CALLERS = [
  "domain/topology/remote-up-leaf.ts", "domain/seat-messaging/far-daemon.ts", "domain/feed/attention-aggregator.ts",
  "domain/review/fleet-compose.ts", "domain/provider/usage-across-hosts.ts", "domain/hosts/read-through.ts",
];
const HTTP_IN_DOMAIN = [/(^|[^.\w])fetch\(/, /typeof fetch\b/, /remoteFetchImpl/, /adapters\/remote-daemon-http/];

function hostsContextFiles(): string[] {
  const dir = join(SRC, "domain", "hosts");
  return readdirSync(dir).filter((f) => f.endsWith(".ts")).map((f) => relative(SRC, join(dir, f)));
}

/** Each line of a scanned file that names HTTP, as "file:line". Comment lines are skipped: a comment may say what the port replaced. */
export function httpInDomain(files: Record<string, string>): string[] {
  return Object.entries(files).flatMap(([file, text]) => text.split("\n").flatMap((line, i) =>
    /^\s*(\/\/|\*|\/\*)/.test(line) ? [] : HTTP_IN_DOMAIN.some((re) => re.test(line)) ? [`${file}:${i + 1}`] : []));
}

const HOST: HttpHostEntry = { id: "vps-b", transport: "http", url: "http://vps-b:7433" };

/** An in-memory far daemon: records each JSON request and answers with `answer`. */
function fakeRemote(answer: (path: string, request: RemoteJsonRequest) => RemoteJsonResult) {
  const calls: Array<{ hostId: string; path: string; request: RemoteJsonRequest }> = [];
  const client: RemoteDaemonClient = {
    requestJson: async (host, path, request) => { calls.push({ hostId: host.id, path, request }); return answer(path, request); },
    requestRaw: async () => { throw new Error("no raw read expected"); },
  };
  return { client, calls };
}

describe("workspaces-o9o.161: the domain reaches another daemon only through its RemoteDaemonClient port", () => {
  it("the scanner finds fetch, its type and the test seam, and skips comment lines (its own control)", () => {
    expect(httpInDomain({
      "a.ts": "const r = await fetch(url);\n// fetch(x) in a comment\nconst f: typeof fetch = g;",
      "b.ts": "const x = c.get(\"remoteFetchImpl\");\nconst ok = this.deps.remoteDaemons.requestJson(h, p, r);",
    })).toEqual(["a.ts:1", "a.ts:3", "b.ts:1"]);
  });

  it("no domain file of the hosts context, and no caller moved onto the port, names HTTP", () => {
    const scanned = [...new Set([...hostsContextFiles(), ...CALLERS])];
    expect(scanned.length).toBeGreaterThan(CALLERS.length);   // the hosts folder was read, not only the named callers
    const files = Object.fromEntries(scanned.map((f) => [f, readFileSync(join(SRC, f), "utf8")]));
    expect(httpInDomain(files)).toEqual([]);
  });

  it("remote up: the domain sends POST /api/up with the long-running deadline and maps a bearer failure, with no HTTP", async () => {
    const remote = fakeRemote(() => ({ ok: false, kind: "bearer", detail: "bearer env var X is not set" }));
    const res = await remoteUpLeaf({ sourceRef: "specs/a.yaml" }, HOST, { remoteDaemons: remote.client });
    expect(res).toEqual({ ok: false, error: "[permission-gate] bearer env var X is not set" });
    expect(remote.calls).toEqual([{ hostId: "vps-b", path: "/api/up", request: { method: "POST", body: { sourceRef: "specs/a.yaml" }, timeoutMs: 120_000 } }]);
  });

  it("far daemons: the capability read is GET /healthz through the port", async () => {
    const remote = fakeRemote(() => ({ ok: true, status: 200, payload: { ok: true } }));
    const far = new FarDaemons({ selfHost: () => "near", credentialFiles: NO_CREDENTIAL_FILES, remoteDaemons: remote.client,
      loadRegistry: () => ({ ok: true, registry: { hosts: [HOST] } }) });
    await far.capability("vps-b");
    expect(remote.calls.map((c) => [c.hostId, c.path, c.request.method])).toEqual([["vps-b", "/healthz", "GET"]]);
  });

  it("attention: a subscribed host's items arrive through the port, stamped with their host", async () => {
    const remote = fakeRemote(() => ({ ok: true, status: 200, payload: [{ qitemId: "b-1" }] }));
    const res = await aggregateAttention({
      remoteDaemons: remote.client, listLocalAttention: () => [], listSubscriptions: () => [{ hostId: "vps-b", enabled: true }],
      loadRegistry: () => ({ ok: true, registry: { hosts: [HOST] } }),
    });
    expect(res.items).toEqual([{ qitemId: "b-1", hostId: "vps-b" }]);
    expect(remote.calls.map((c) => c.path)).toEqual(["/api/queue/list?attention=1"]);
  });
});
