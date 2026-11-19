// workspaces-87f (verify-sec, attempt 3; Jim: "One more round, fix the root") and workspaces-rt2 (Jim: "Merge the fix, harden the test
// next"). Every hello the daemon makes to the hc core must be judged against the pin. This census fails on any core connection that is
// not: it resolves daemon src through the TypeScript type CHECKER (helpers/hc-connection-census.ts), so an alias, a variable holding the
// class, a renamed or namespace import, a re-export, a subclass or a wrapper module is caught the same as the plain spelling, and a
// require() or a computed import() (which the checker cannot see through) is listed for classification.
//   (A) An HcClient construction may turn the per-socket check off (a third argument other than the literal `true`) only in probeCore,
//       whose caller (HcCoreWatch.connectOnce) verifies and pins its hello itself.
//   (B) Every socket opening, require(), computed import() and every call that reaches a wrapper whose classification propagates is a
//       site, and the set of sites must equal the classified table below. A new one fails here until it is classified.
// Each of verify-sec's bypasses is a negative row: the finder must catch it in an in-memory program.
import fs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { censusHcConnections, fixtureProgram, type CensusSite } from "./helpers/hc-connection-census.js";

const DAEMON = fileURLToPath(new URL("../", import.meta.url));
const SRC = nodePath.join(DAEMON, "src");
const TYPES = nodePath.resolve(DAEMON, "../../node_modules/@types");

interface Classified {
  why: string;
  /** Whether the site's callers inherit it (they must then be classified too): false where the hello is judged, or the target is fixed. */
  propagates: boolean;
}

/** Every site in daemon src, and how its hello (when it is the hc core) is judged. */
const CLASSIFIED: Record<string, Classified> = {
  "adapters/hc-client.ts:HcClient.open": { why: "hc core: every hello passes greet, which runs checkHcHello (per-socket pin) and the client's ownCheck", propagates: false },
  "adapters/hc-attach.ts:HcAttach.connect": { why: "hc core: the attach wire's hello runs checkHcHello before anything is asked", propagates: false },
  "adapters/hc-viewer.ts:CoreSizeSource.watch": { why: "hc core: the size watch's hello runs checkHcHello before it subscribes", propagates: false },
  "adapters/hc-core-watch.ts:openStream": { why: "hc core: the watch's own stream; its caller judges and pins the hello", propagates: true },
  "adapters/hc-core-watch.ts:probeCore": { why: "hc core: the one HcClient with the per-socket check off; its caller judges and pins the hello", propagates: true },
  "adapters/hc-core-watch.ts:HcCoreWatch.connectOnce": { why: "where openStream's and probeCore's hellos are judged: verifyHello against the pin, then pinFromHello", propagates: false },
  "adapters/native-inbox-os.ts:writeSocketLines": { why: "not the hc core: the native inbox socket (lines out, nothing read back); its path comes from its caller", propagates: true },
  "startup.ts:createDaemon": { why: "writeSocketLines' only caller: the path is the native inbox's own socket, not the hc core's", propagates: false },
  "domain/gateway/transport.ts:connectGateway": { why: "not the hc core: the Slack connector's socket; its path comes from its caller", propagates: true },
  "domain/gateway/gateway-process.ts:dial": { why: "connectGateway's only caller: the path is the Slack connector's socket", propagates: false },
  "routes/hosts.ts:probeHost": { why: "not the hc core: a TCP reachability probe to a registered remote host's host and port", propagates: false },
  "domain/skill-mirror-drift.ts:checkMirrorDriftSafe": { why: "a computed import() of the skill-mirror check script by its file URL: loads a module, opens no connection", propagates: false },
};

const daemonProgram = (): ts.Program => {
  const cfg = ts.getParsedCommandLineOfConfigFile(nodePath.join(DAEMON, "tsconfig.json"), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => undefined });
  if (!cfg) throw new Error("tsconfig.json could not be read");
  return ts.createProgram(cfg.fileNames, cfg.options);
};
const propagates = (table: Record<string, Classified>) => (site: string) => table[site]?.propagates ?? true;

describe("no hc core connection without the check (resolved through the TypeScript checker)", () => {
  let sites: CensusSite[] = [];
  let fileCount = 0;
  it("the census runs over the daemon program (positive control: it saw the tree)", () => {
    const program = daemonProgram();
    fileCount = program.getSourceFiles().filter((f) => !f.isDeclarationFile && f.fileName.startsWith(SRC)).length;
    sites = censusHcConnections(program, SRC, propagates(CLASSIFIED));
    expect(fileCount).toBeGreaterThan(300);
    expect(sites.filter((s) => s.kind === "opening").length).toBeGreaterThan(3);
  }, 120_000);

  it("(A) every HcClient construction keeps the per-socket check, except the one deliberate probe", () => {
    expect(sites.filter((s) => s.kind === "unchecked-hc-client")).toEqual([{ site: "adapters/hc-core-watch.ts:probeCore", kind: "unchecked-hc-client", detail: "false" }]);
  });

  it("(B) every site is classified, and every classification names a site that is there", () => {
    expect([...new Set(sites.map((s) => s.site))].sort()).toEqual(Object.keys(CLASSIFIED).sort());
  });

  it("the classified hc openers really run the check (the text each classification names is in its file)", () => {
    const text = (f: string) => fs.readFileSync(nodePath.join(SRC, f), "utf8");
    expect(text("adapters/hc-client.ts")).toMatch(/if \(this\.enforcePin\) checkHcHello\(this\.socketPath, hello\);\s*this\.ownCheck\?\.\(hello\);/);
    expect(text("adapters/hc-attach.ts")).toContain("checkHcHello(socketPath, hello);");
    expect(text("adapters/hc-viewer.ts")).toContain("checkHcHello(this.socketPath, hello);");
    const watch = text("adapters/hc-core-watch.ts");
    expect(watch).toMatch(/verifyHello\(stream\.hello, \{ \.\.\.this\.options\.pin, coreId: this\.coreId \}\);[\s\S]*?this\.pinFromHello\(stream\.hello\);/);
    expect(watch).toMatch(/verifyHello\(presence\.hello, \{ \.\.\.this\.options\.pin, coreId: this\.coreId \}\);\s*this\.pinFromHello\(presence\.hello\);/);
  });
});

// The negative rows: each bypass verify-sec found in the spelling finder (and a few more of the same kind), in an in-memory program beside
// a stand-in hc-client module and the real node types. Each must be caught, at the site named.
describe("the checker finder catches every bypass of the spelling finder (in-memory programs)", () => {
  const ROOT = "/virt/src";
  const HC_CLIENT = `export class HcClient { constructor(readonly socketPath: string, readonly timeoutMs = 1000, private readonly enforcePin = true) {} }\n`;
  const run = (files: Record<string, string>, table: Record<string, Classified> = {}) => {
    const all: Record<string, string> = { [`${ROOT}/adapters/hc-client.ts`]: HC_CLIENT };
    for (const [name, text] of Object.entries(files)) all[`${ROOT}/${name}`] = text;
    return censusHcConnections(fixtureProgram(all, TYPES), ROOT, propagates(table));
  };
  const caught = (sites: CensusSite[], site: string, kind: CensusSite["kind"]) => expect(sites.filter((s) => s.site === site && s.kind === kind), `${kind} at ${site}`).not.toEqual([]);

  it("a variable holding the class: const C = HcClient; new C(p, undefined, false)", () => {
    caught(run({ "x.ts": `import { HcClient } from "./adapters/hc-client.js";\nexport function a(p: string) { const C = HcClient; return new C(p, undefined, false); }\n` }), "x.ts:a", "unchecked-hc-client");
  });
  it("an aliased import of HcClient", () => {
    caught(run({ "x.ts": `import { HcClient as Client } from "./adapters/hc-client.js";\nexport function b(p: string) { return new Client(p, 1, false); }\n` }), "x.ts:b", "unchecked-hc-client");
  });
  it("a namespace import of the hc-client module", () => {
    caught(run({ "x.ts": `import * as hc from "./adapters/hc-client.js";\nexport function b2(p: string, off: boolean) { return new hc.HcClient(p, 1, off); }\n` }), "x.ts:b2", "unchecked-hc-client");
  });
  it("a re-export of HcClient under another name", () => {
    caught(run({
      "re.ts": `export { HcClient as Plain } from "./adapters/hc-client.js";\n`,
      "x.ts": `import { Plain } from "./re.js";\nexport function b3(p: string) { return new Plain(p, 1, false); }\n`,
    }), "x.ts:b3", "unchecked-hc-client");
  });
  it("a subclass that turns the check off in super()", () => {
    caught(run({ "x.ts": `import { HcClient } from "./adapters/hc-client.js";\nexport class Quiet extends HcClient { constructor(p: string) { super(p, 1, false); } }\n` }), "x.ts:Quiet.constructor", "unchecked-hc-client");
  });
  it("a require() of HcClient (the checker cannot see through it, so the require itself is a site)", () => {
    caught(run({ "x.ts": `export function c(p: string) { const { HcClient: R } = require("./adapters/hc-client.js"); return new R(p, 1, false); }\n` }), "x.ts:c", "require");
  });
  it("a renamed createConnection: import { createConnection as dial } from node:net", () => {
    caught(run({ "x.ts": `import { createConnection as dial } from "node:net";\nexport function d(p: string) { return dial(p); }\n` }), "x.ts:d", "opening");
  });
  it("a namespace import: import * as tcp from node:net, then tcp.connect", () => {
    caught(run({ "x.ts": `import * as tcp from "node:net";\nexport function e(p: string) { return tcp.connect(p); }\n` }), "x.ts:e", "opening");
  });
  it("a namespace Socket: new tcp.Socket(), and its connect()", () => {
    const sites = run({ "x.ts": `import * as tcp from "node:net";\nexport function e2(p: string) { const s = new tcp.Socket(); s.connect(p); return s; }\n` });
    caught(sites, "x.ts:e2", "opening");
    expect(sites.filter((s) => s.site === "x.ts:e2" && s.kind === "opening").map((s) => s.detail).sort()).toEqual(["connect", "new Socket"]);
  });
  it("a typed dynamic import: (await import(\"node:net\")).createConnection", () => {
    caught(run({ "x.ts": `export async function e3(p: string) { const net = await import("node:net"); return net.createConnection(p); }\n` }), "x.ts:e3", "opening");
  });
  it("require(\"node:net\").connect (the require itself is a site)", () => {
    caught(run({ "x.ts": `export function f(p: string) { return require("node:net").connect(p); }\n` }), "x.ts:f", "require");
  });
  it("a computed import() (the checker cannot resolve it, so it is a site)", () => {
    caught(run({ "x.ts": `export async function f2(name: string) { return import(name); }\n` }), "x.ts:f2", "dynamic-import");
  });
  it("an imported wrapper module: its own opening is a site, and so is every call that reaches it, transitively", () => {
    const sites = run({
      "wrap.ts": `import { createConnection } from "node:net";\nexport const open = (p: string) => createConnection(p);\n`,
      "mid.ts": `import { open as o } from "./wrap.js";\nexport function relay(p: string) { return o(p); }\n`,
      "x.ts": `import { relay } from "./mid.js";\nexport function g(p: string) { return relay(p); }\n`,
    });
    caught(sites, "wrap.ts:open", "opening");
    caught(sites, "mid.ts:relay", "wrapper-call");
    caught(sites, "x.ts:g", "wrapper-call");
  });
  it("a wrapper classified as judging its own hello stops the inheritance; one that leaves it to its caller does not", () => {
    const files = {
      "wrap.ts": `import { createConnection } from "node:net";\nexport const checked = (p: string) => createConnection(p);\nexport const leaves = (p: string) => createConnection(p);\n`,
      "x.ts": `import { checked, leaves } from "./wrap.js";\nexport function h(p: string) { checked(p); }\nexport function i(p: string) { leaves(p); }\n`,
    };
    const sites = run(files, { "wrap.ts:checked": { why: "judges its hello", propagates: false }, "wrap.ts:leaves": { why: "caller judges", propagates: true } });
    expect(sites.filter((s) => s.site === "x.ts:h")).toEqual([]);
    caught(sites, "x.ts:i", "wrapper-call");
  });
  it("controls: the plain checked forms and a local function named connect are NOT sites", () => {
    const sites = run({ "x.ts": `import { HcClient } from "./adapters/hc-client.js";\nexport function j(p: string) { new HcClient(p); new HcClient(p, 5, true); connect(); }\nfunction connect() { return 1; }\n` });
    expect(sites.filter((s) => s.site.startsWith("x.ts"))).toEqual([]);
  });
});
