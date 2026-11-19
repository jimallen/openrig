import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigStore } from "../src/config-store.js";
import { openSettingsStore } from "../../daemon/src/adapters/node-settings-file.js";
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true }); delete process.env.OPENRIG_UI_TIMEZONE; });
describe("one persistent local-time preference", () => {
  it("round-trips CLI and daemon settings without changing unrelated keys", () => {
    const dir = mkdtempSync(join(tmpdir(), "zone-")); dirs.push(dir); const file = join(dir, "config.json");
    writeFileSync(file, JSON.stringify({ host: { name: "kept" }, ui: { preview: { maxPins: 7 } } }));
    const cli = new ConfigStore(file); const daemon = openSettingsStore(file);
    expect(cli.get("ui.timezone")).toBe("America/Los_Angeles");
    cli.set("ui.timezone", "Europe/London");
    expect(new ConfigStore(file).get("ui.timezone")).toBe("Europe/London");
    expect(daemon.resolveOne("ui.timezone").value).toBe("Europe/London");
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ host: { name: "kept" }, ui: { preview: { maxPins: 7 }, timezone: "Europe/London" } });
    process.env.OPENRIG_UI_TIMEZONE = "UTC";
    expect(cli.resolveWithSource("ui.timezone")).toMatchObject({ value: "UTC", source: "env" });
    delete process.env.OPENRIG_UI_TIMEZONE; daemon.reset("ui.timezone");
    expect(cli.get("ui.timezone")).toBe("America/Los_Angeles");
  });
  it("rejects malformed writes and warns on fallback from file and env on both surfaces", () => {
    const dir = mkdtempSync(join(tmpdir(), "zone-")); dirs.push(dir); const file = join(dir, "config.json");
    const cli = new ConfigStore(file); const daemon = openSettingsStore(file);
    for (const value of ["Mars/Olympus", "", "+02:00"]) {
      expect(() => cli.set("ui.timezone", value)).toThrow(/IANA/);
      expect(() => daemon.set("ui.timezone", value)).toThrow(/IANA/);
    }
    const warning = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    writeFileSync(file, JSON.stringify({ ui: { timezone: false } }));
    expect(cli.get("ui.timezone")).toBe("America/Los_Angeles");
    expect(daemon.resolveOne("ui.timezone").value).toBe("America/Los_Angeles");
    process.env.OPENRIG_UI_TIMEZONE = "Mars/Olympus";
    expect(cli.get("ui.timezone")).toBe("America/Los_Angeles");
    expect(daemon.resolveOne("ui.timezone").value).toBe("America/Los_Angeles");
    expect(warning.mock.calls.flat().join(" ")).toMatch(/ui.timezone rejected/);
    warning.mockRestore();
  });
});
