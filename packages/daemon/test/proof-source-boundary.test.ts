import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
const { readProjectReadiness, resolveProjectRoot } = vi.hoisted(() => ({
  readProjectReadiness: vi.fn(), resolveProjectRoot: vi.fn(),
}));
vi.mock("../src/domain/proof/judgments.js", () => ({ readProjectReadiness, resolveProjectRoot }));
import { watchProofSources, type SourceTreeWatcher } from "../src/domain/proof/source-watch.js";
import { EventBus } from "../src/domain/event-bus.js";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
// The domain drives its outbound port; this in-memory fake records each arm and reports full evidence.
const watch = vi.fn<SourceTreeWatcher["watch"]>();
const watcher: SourceTreeWatcher = { watch, unwatched: () => [] };
afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); });

it("keeps recursive watching local and filters the ancestor policy watch", () => {
  vi.useFakeTimers();
  const missions = path.resolve("fixture/ancestor/work/initiatives");
  const project = path.resolve("fixture/ancestor");
  resolveProjectRoot.mockReturnValue(project);
  readProjectReadiness.mockReturnValue({ missions: [] });
  const close = vi.fn();
  watch.mockImplementation(() => ({ close }));
  const instance = watchProofSources(missions, vi.fn(), { emit: vi.fn() } as unknown as EventBus, { watcher });
  expect(watch.mock.calls.map(([root, options]) => [root, options.recursive])).toEqual([
    [path.dirname(missions), true], [project, false],
  ]);
  const notifyProject = watch.mock.calls[1]![2];
  notifyProject("unrelated.txt");
  notifyProject("unrelated.txt");
  vi.advanceTimersByTime(50);
  expect(readProjectReadiness).toHaveBeenCalledTimes(1);
  notifyProject("project.yaml");
  vi.advanceTimersByTime(50);
  expect(readProjectReadiness).toHaveBeenCalledTimes(2);
  notifyProject(null);
  vi.advanceTimersByTime(50);
  expect(readProjectReadiness).toHaveBeenCalledTimes(3);
  instance.close();
  expect(close).toHaveBeenCalledTimes(2);
});

it("closes the recursive watcher when opening the extra policy watcher fails", () => {
  const missions = path.resolve("fixture/ancestor/work/initiatives");
  resolveProjectRoot.mockReturnValue(path.resolve("fixture/ancestor"));
  readProjectReadiness.mockReturnValue({ missions: [] });
  const close = vi.fn();
  watch.mockReturnValueOnce({ close }).mockImplementationOnce(() => { throw new Error("watch unavailable"); });
  const instance = watchProofSources(missions, vi.fn(), { emit: vi.fn() } as unknown as EventBus, { watcher });
  expect(instance.observation().state).toBe("unavailable");
  expect(close).toHaveBeenCalledOnce();
  instance.close();
  expect(close).toHaveBeenCalledOnce();
});

it("uses only the existing recursive watcher when the policy root is the same directory", () => {
  const missions = path.resolve("fixture/missions");
  resolveProjectRoot.mockReturnValue(path.dirname(missions));
  readProjectReadiness.mockReturnValue({ missions: [] });
  const close = vi.fn();
  watch.mockReturnValue({ close });
  const instance = watchProofSources(missions, vi.fn(), { emit: vi.fn() } as unknown as EventBus, { watcher });
  expect(watch).toHaveBeenCalledOnce();
  instance.close();
  expect(close).toHaveBeenCalledOnce();
});

// workspaces-o9o.38: the claim follows the port's evidence, never the watcher's own word.
function evidenceWatcher(gaps: { current: string[] | null }) {
  const errors: Array<(err: Error) => void> = [];
  const port: SourceTreeWatcher = {
    watch: (_dir, _options, _onChange, onError) => { errors.push(onError); return { close() {} }; },
    unwatched: () => gaps.current,
  };
  return { port, fail: (err: Error) => errors[0]!(err) };
}
/** A real bus over an in-memory events table; `pushed()` lists the revisions source-watch pushed on it. */
function realBus() {
  const db = createDb();
  migrate(db, [eventsSchema]);
  const bus = new EventBus(db);
  const emit = vi.spyOn(bus, "emit");
  const pushed = () => emit.mock.calls.flatMap(([event]) => (event.type === "proof.sources_changed" ? [event.revision] : []));
  return { bus, emit, pushed };
}
function legacyRoot() {
  const missions = path.resolve("fixture/missions");
  resolveProjectRoot.mockReturnValue(path.dirname(missions));
  readProjectReadiness.mockReturnValue({ missions: [] });
  return missions;
}

it("o9o.38: a gap in the evidence at arming is unavailable with its cause, logged and pushed once", () => {
  const missions = legacyRoot();
  const gaps = { current: ["/w/a", "/w/b"] as string[] | null };
  const { bus, pushed } = realBus(); const invalidate = vi.fn(); const log = vi.fn();
  const instance = watchProofSources(missions, invalidate, bus, { watcher: evidenceWatcher(gaps).port, log });
  expect(instance.observation()).toEqual({ state: "unavailable", revision: "unavailable", cause: expect.stringMatching(/no live watch on 2 of the watched path\(s\) .*first: \/w\/a$/) });
  expect(pushed()).toEqual(["unavailable"]);
  expect(invalidate).toHaveBeenCalledOnce();
  expect(log.mock.calls.join("\n")).toMatch(/unavailable \(no live watch on 2/);
  instance.close();
});

it("o9o.38: the re-check turns the claim back to watching only on full evidence, and pushes the revision", () => {
  vi.useFakeTimers();
  const missions = legacyRoot();
  const gaps = { current: ["/w/a"] as string[] | null };
  const { bus, pushed } = realBus();
  const instance = watchProofSources(missions, vi.fn(), bus, { watcher: evidenceWatcher(gaps).port, recheckMs: 1000 });
  vi.advanceTimersByTime(1000);
  expect(instance.observation().state).toBe("unavailable");
  gaps.current = [];
  vi.advanceTimersByTime(1000);
  expect(instance.observation()).toEqual({ state: "watching", revision: expect.stringMatching(/^[0-9a-f]{64}$/) });
  expect(pushed()).toEqual(["unavailable", instance.observation().revision]);
  instance.close();
});

it("o9o.38: a gap that appears later is caught by the re-check while nothing changes", () => {
  vi.useFakeTimers();
  const missions = legacyRoot();
  const gaps = { current: [] as string[] | null };
  const { bus, emit, pushed } = realBus();
  const instance = watchProofSources(missions, vi.fn(), bus, { watcher: evidenceWatcher(gaps).port, recheckMs: 1000 });
  expect(instance.observation().state).toBe("watching");
  expect(emit).not.toHaveBeenCalled();
  gaps.current = ["/w/new"];
  vi.advanceTimersByTime(1000);
  expect(instance.observation()).toEqual({ state: "unavailable", revision: "unavailable", cause: expect.stringMatching(/first: \/w\/new$/) });
  expect(pushed()).toEqual(["unavailable"]);
  vi.advanceTimersByTime(3000);
  expect(emit).toHaveBeenCalledOnce();
  instance.close();
});

it("o9o.38: with evidence, it decides even after a watcher error; without evidence, a watcher error stands", () => {
  vi.useFakeTimers();
  const missions = legacyRoot();
  const withEvidence = evidenceWatcher({ current: [] });
  const a = watchProofSources(missions, vi.fn(), realBus().bus, { watcher: withEvidence.port, recheckMs: 1000 });
  withEvidence.fail(new Error("ENOSPC"));
  expect(a.observation()).toEqual({ state: "unavailable", revision: "unavailable", cause: "the file watcher failed: ENOSPC" });
  vi.advanceTimersByTime(1000);
  expect(a.observation().state).toBe("watching");
  a.close();
  const noEvidence = evidenceWatcher({ current: null });
  const b = watchProofSources(missions, vi.fn(), realBus().bus, { watcher: noEvidence.port, recheckMs: 1000 });
  expect(b.observation().state).toBe("watching");
  noEvidence.fail(new Error("ENOSPC"));
  vi.advanceTimersByTime(3000);
  expect(b.observation()).toEqual({ state: "unavailable", revision: "unavailable", cause: "the file watcher failed: ENOSPC" });
  b.close();
});

it("o9o.38: close stops the re-check", () => {
  vi.useFakeTimers();
  const missions = legacyRoot();
  const unwatched = vi.fn(() => []);
  const instance = watchProofSources(missions, vi.fn(), realBus().bus, { watcher: { watch: () => ({ close() {} }), unwatched }, recheckMs: 1000 });
  const armed = unwatched.mock.calls.length;
  instance.close();
  vi.advanceTimersByTime(5000);
  expect(unwatched).toHaveBeenCalledTimes(armed);
  expect(instance.observation().state).toBe("unavailable");
});
