import { afterEach, describe, expect, it } from "vitest";
import { OutboxUnsettledSource } from "../src/domain/rsi/outbox-source.js";
import { ProjectReportSource } from "../src/domain/rsi/stream-report-source.js";
import { INSTANCE, cleanupFixtures, fixture, iso, span } from "./rsi-a2b-fixture.js";

afterEach(cleanupFixtures);

type F = ReturnType<typeof fixture>;

describe("D8 outbox state never settles", () => {
  const source = (f: F, extra: { rowLimit?: number } = {}) => new OutboxUnsettledSource(f.deps(extra));
  const pending = (f: F, n: number, hoursAgo: number, prov: string | null = "transport:v1", state = "pending", retiredAt: string | null = null) => {
    const ids: number[] = [];
    for (let i = 0; i < n; i++) ids.push(f.outbox({ prov, state, hoursAgo, retiredAt }));
    return ids;
  };

  it("fires at exactly 10 stale pending rows and not at 9", () => {
    const at = fixture();
    pending(at, 10, 30);
    const below = fixture();
    pending(below, 9, 30);

    const [record, ...rest] = at.records(source(at));

    expect(rest).toEqual([]);
    expect(span(record!)).toMatchObject({ fingerprint: "rsi.outbox-unsettled/provenance:transport:v1", count: 10 });
    expect(record!.scope).toEqual({ type: "instance", instanceId: INSTANCE });
    expect(below.records(source(below))).toEqual([]);
  });

  it("counts a pending row only after 24 hours, so young pending rows never make up the threshold", () => {
    const f = fixture();
    pending(f, 9, 25);
    pending(f, 20, 23); // pending, but still young

    expect(f.records(source(f))).toEqual([]);
  });

  it("counts pending rows only: old rows in any settled or other state are quiet", () => {
    const f = fixture();
    for (const state of ["delivered", "indeterminate", "failed", "retained", "mystery"]) pending(f, 10, 50, "transport:v1", state);

    expect(f.records(source(f))).toEqual([]);
  });

  it("skips a retired row entirely", () => {
    const f = fixture();
    pending(f, 9, 50);
    pending(f, 5, 50, "transport:v1", "pending", iso(1));

    expect(f.records(source(f))).toEqual([]);
  });

  it("counts per identity provenance, and names a missing provenance as unattributed", () => {
    const f = fixture();
    pending(f, 6, 50, "transport:v1"); pending(f, 6, 50, "hook:v1");
    expect(f.records(source(f))).toEqual([]);
    pending(f, 4, 50, null); pending(f, 6, 50, null);

    expect(f.records(source(f)).map((r) => span(r).fingerprint)).toEqual(["rsi.outbox-unsettled/provenance:(unattributed)"]);
  });

  it("reads the firing provenance against the quiet ones and splits every un-retired entry over the closed state list", () => {
    const f = fixture();
    const ids = pending(f, 12, 40);
    pending(f, 3, 1); // young pending, same provenance
    pending(f, 2, 40, "transport:v1", "delivered"); pending(f, 1, 40, "transport:v1", "weird");
    pending(f, 2, 40, "hook:v1"); pending(f, 1, 40, "hook:v1", "failed");
    pending(f, 7, 40, "transport:v1", "pending", iso(2)); // retired: not judged

    const [record, ...rest] = f.records(source(f));

    expect(rest).toEqual([]);
    expect(span(record!)).toMatchObject({ count: 12, controlTotal: 1, population: 2, firstSeq: ids[0], lastSeq: ids[11] });
    // 12 + 3 + 2 + 1 + 2 + 1 = 21 un-retired entries: delivered 2, failed 1, other 1, pending 17.
    expect(record!.explanation).toContain("delivered 2, failed 1, other 1, pending 17 = 21");
    expect(record!.explanation).toContain("1 provenance(s) fire and 1 do not, out of 2");
  });

  it("never carries a row body, names a row cap as partial coverage and keeps a read-only handle", () => {
    const f = fixture();
    pending(f, 10, 40, "a:v1"); pending(f, 10, 40, "b:v1");

    const capped = source(f, { rowLimit: 1 });
    const observations = capped.read();
    expect(observations).toHaveLength(1);
    expect(JSON.stringify(observations)).not.toContain("BODY-CANARY");
    expect(capped.coverage()[0]).toMatchObject({ limit: 1, total: 2, evaluated: 1, omitted: 1, partial: true });
    expect(() => capped.readonlyHandle().exec("DELETE FROM outbox_entries")).toThrowError(expect.objectContaining({ code: "SQLITE_READONLY" }));
  });
});

describe("D14 project-rig reports", () => {
  const source = (f: F, extra: { rowLimit?: number } = {}) => new ProjectReportSource(f.deps(extra));
  const report = (f: F, session: string, cls: string | null, hoursAgo = 2, extra: Partial<{ archivedAt: string; body: string }> = {}) =>
    f.stream({ session, tags: cls === null ? ["rsi-report"] : ["rsi-report", `rsi-class:${cls}`], hoursAgo, ...extra });

  it("raises one finding per reporting rig and class, from the rig named after the @ in the source session", () => {
    const f = fixture();
    const a = report(f, "exec-cos@rfp-rulz", "permission-stall");
    const b = report(f, "build-impl@rfp-rulz", "permission-stall");
    report(f, "exec-cos@rfp-rulz", "context-high-water");
    report(f, "exec-cos@eztrack", "permission-stall");

    const records = f.records(source(f));

    expect(records.map((r) => span(r).fingerprint).sort()).toEqual([
      "rsi.project-report/rig:eztrack:class:permission-stall",
      "rsi.project-report/rig:rfp-rulz:class:context-high-water",
      "rsi.project-report/rig:rfp-rulz:class:permission-stall",
    ]);
    const stalls = records.find((r) => span(r).fingerprint.endsWith("rfp-rulz:class:permission-stall"))!;
    expect(span(stalls)).toMatchObject({ count: 2, firstSeq: a, lastSeq: b });
    expect(stalls.scope).toEqual({ type: "instance", instanceId: INSTANCE });
  });

  it("files an unknown class and a missing class under other, and a session with no @ under unattributed", () => {
    const f = fixture();
    report(f, "x@proj", "made-up-class");
    report(f, "y@proj", null);
    report(f, "loner", "permission-stall");

    expect(f.records(source(f)).map((r) => span(r).fingerprint).sort()).toEqual([
      "rsi.project-report/rig:(unattributed):class:permission-stall",
      "rsi.project-report/rig:proj:class:other",
    ]);
    expect(span(f.records(source(f)).find((r) => span(r).fingerprint.endsWith("proj:class:other"))!).count).toBe(2);
  });

  it("matches the report tag exactly: lookalike tags, a missing tag, null tags and malformed tags are ordinary traffic", () => {
    const f = fixture();
    f.stream({ session: "a@p", tags: ["rsi-report-draft"], hoursAgo: 2 });
    f.stream({ session: "a@p", tags: ["not-rsi-report"], hoursAgo: 2 });
    f.stream({ session: "a@p", tags: ["rsi-class:permission-stall"], hoursAgo: 2 });
    f.stream({ session: "a@p", tags: null, hoursAgo: 2 });
    f.stream({ session: "a@p", tags: "{not json", hoursAgo: 2 });
    f.stream({ session: "a@p", tags: [1, null, "rsi-report-x"], hoursAgo: 2 });

    const s = source(f);
    expect(f.records(s)).toEqual([]);
    expect(s.coverage()[0]).toMatchObject({ total: 0, evaluated: 0, partial: false });
  });

  it("looks back 7 days and skips archived reports", () => {
    const f = fixture();
    report(f, "in@a", "permission-stall", 24 * 7 - 1);
    report(f, "out@b", "permission-stall", 24 * 7 + 1);
    report(f, "gone@c", "permission-stall", 2, { archivedAt: iso(1) });

    expect(f.records(source(f)).map((r) => span(r).fingerprint)).toEqual(["rsi.project-report/rig:a:class:permission-stall"]);
  });

  it("fires on a single report", () => {
    const f = fixture();
    report(f, "x@solo", "outbox-unsettled");

    expect(f.records(source(f))).toHaveLength(1);
  });

  it("never reads the body: no text of it reaches any observation", () => {
    const f = fixture();
    report(f, "x@proj", "permission-stall", 2, { body: "BODY-CANARY-pointer-text" });

    const observations = source(f).read();

    expect(observations).toHaveLength(1);
    expect(JSON.stringify(observations)).not.toContain("BODY-CANARY");
  });

  it("splits stream items into reports and ordinary traffic, and reports over the closed class list", () => {
    const f = fixture();
    report(f, "a@p", "permission-stall"); report(f, "a@p", "permission-stall"); report(f, "b@q", "delivery-failure");
    report(f, "c@r", "nonsense"); report(f, "c@r", null);
    f.stream({ session: "d@s", tags: ["daemon", "slow-operation"], hoursAgo: 2 });
    f.stream({ session: "d@s", tags: null, hoursAgo: 2 });
    f.stream({ session: "d@s", tags: ["x"], hoursAgo: 24 * 9 }); // outside the window
    report(f, "a@p", "permission-stall", 2, { archivedAt: iso(1) }); // archived

    const records = f.records(source(f));
    const stalls = records.find((r) => span(r).fingerprint.endsWith("rig:p:class:permission-stall"))!;

    expect(records).toHaveLength(3);
    // 5 reports + 2 ordinary = 7 live stream items; reports by class: delivery-failure 1, other 2, permission-stall 2.
    expect(span(stalls)).toMatchObject({ count: 2, controlTotal: 2, population: 7 });
    expect(stalls.explanation).toContain("delivery-failure 1, other 2, permission-stall 2 = 5");
    expect(stalls.explanation).toContain("5 report(s) among 7 stream items, 2 of them ordinary traffic");
  });

  it("names a row cap as partial coverage and keeps a read-only handle", () => {
    const f = fixture();
    report(f, "a@p", "permission-stall"); report(f, "a@q", "permission-stall");

    const capped = source(f, { rowLimit: 1 });
    expect(capped.read()).toHaveLength(1);
    expect(capped.coverage()[0]).toMatchObject({ limit: 1, total: 2, evaluated: 1, omitted: 1, partial: true });
    expect(() => capped.readonlyHandle().exec("DELETE FROM stream_items")).toThrowError(expect.objectContaining({ code: "SQLITE_READONLY" }));
  });
});
