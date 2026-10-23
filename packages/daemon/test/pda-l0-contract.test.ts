// pda L0 (pda-runtime-design-9l Rev 2; review delta D2): the registrations every later pda lane builds on.
//  - Migration numbers 115 and 116 are reserved under fixed names (L2b and L2c land them).
//  - `usage.pda_cost_facts` is registered in BOTH settings twins, default off, env OPENRIG_USAGE_PDA_COST_FACTS.
//  - The adapter contract's optional fields read as today's behaviour when absent.
//  - The pda checkReady codes that need a person are attention codes.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALL_MIGRATIONS, RESERVED_MIGRATION_NAMES } from "../src/db/all-migrations.js";
import { SettingsStore, SETTINGS_VALID_KEYS } from "../src/domain/user-settings/settings-store.js";
import { ConfigStore, VALID_KEYS } from "../../cli/src/config-store.js";
import {
  adapterFreshStart, adapterStartupContent, isAttentionRequiredReadinessCode,
} from "../src/domain/runtime-adapter.js";

describe("migration reservations", () => {
  it("reserves 115 and 116 for the pda runtime under fixed names", () => {
    expect(RESERVED_MIGRATION_NAMES).toEqual({ "115": "115_node_pda_binding.sql", "116": "116_pda_usage_entries.sql" });
  });
  it("every registered migration with a reserved number carries exactly the reserved name", () => {
    const numbered = ALL_MIGRATIONS.map((m) => m.name).filter((n) => /^\d{3}_/.test(n));
    expect(numbered.length).toBe(ALL_MIGRATIONS.length); // positive control: the filter saw every migration
    for (const name of numbered) {
      const reserved = RESERVED_MIGRATION_NAMES[name.slice(0, 3)];
      if (reserved !== undefined) expect(name).toBe(reserved);
    }
  });
});

describe("usage.pda_cost_facts (review D2): both twins, default off", () => {
  let dir: string;
  const saved = process.env.OPENRIG_USAGE_PDA_COST_FACTS;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pda-l0-settings-"));
    delete process.env.OPENRIG_USAGE_PDA_COST_FACTS;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (saved === undefined) delete process.env.OPENRIG_USAGE_PDA_COST_FACTS;
    else process.env.OPENRIG_USAGE_PDA_COST_FACTS = saved;
  });

  it("is a key of both registries", () => {
    expect(SETTINGS_VALID_KEYS as readonly string[]).toContain("usage.pda_cost_facts");
    expect(VALID_KEYS as readonly string[]).toContain("usage.pda_cost_facts");
  });
  it("defaults to false on both sides", () => {
    expect(new SettingsStore(join(dir, "config.json")).resolveOne("usage.pda_cost_facts"))
      .toMatchObject({ value: false, source: "default", defaultValue: false });
    expect(new ConfigStore(join(dir, "config.json")).resolveWithSource("usage.pda_cost_facts"))
      .toMatchObject({ value: false, source: "default" });
    expect(new ConfigStore(join(dir, "config.json")).resolve().usage.pdaCostFacts).toBe(false);
  });
  it("reads the env override and the file value on both sides, at the same path", () => {
    process.env.OPENRIG_USAGE_PDA_COST_FACTS = "true";
    expect(new SettingsStore(join(dir, "config.json")).resolveOne("usage.pda_cost_facts")).toMatchObject({ value: true, source: "env" });
    expect(new ConfigStore(join(dir, "config.json")).resolveWithSource("usage.pda_cost_facts")).toMatchObject({ value: true, source: "env" });
    delete process.env.OPENRIG_USAGE_PDA_COST_FACTS;
    writeFileSync(join(dir, "config.json"), JSON.stringify({ usage: { pdaCostFacts: true } }));
    expect(new SettingsStore(join(dir, "config.json")).resolveOne("usage.pda_cost_facts")).toMatchObject({ value: true, source: "file" });
    expect(new ConfigStore(join(dir, "config.json")).resolveWithSource("usage.pda_cost_facts")).toMatchObject({ value: true, source: "file" });
  });
});

describe("adapter contract fields read as today's behaviour when absent", () => {
  it("freshStart: absent is supported; only an explicit unsupported refuses", () => {
    expect(adapterFreshStart({})).toBe("supported");
    expect(adapterFreshStart(null)).toBe("supported");
    expect(adapterFreshStart({ freshStart: "supported" })).toBe("supported");
    expect(adapterFreshStart({ freshStart: "unsupported" })).toBe("unsupported");
  });
  it("startupContent: absent delivers; only an explicit withhold withholds", () => {
    expect(adapterStartupContent({})).toBe("deliver");
    expect(adapterStartupContent(undefined)).toBe("deliver");
    expect(adapterStartupContent({ startupContent: "withhold" })).toBe("withhold");
  });
});

describe("pda attention codes", () => {
  it.each(["pda_unauthorized", "pda_token_format", "pda_agent_missing", "pda_message_held"])("%s needs a person", (code) => {
    expect(isAttentionRequiredReadinessCode(code)).toBe(true);
  });
  it.each(["pda_unreachable", "pda_protocol", "pda_outbox_binding_mismatch"])("%s does not (retry, not a person)", (code) => {
    expect(isAttentionRequiredReadinessCode(code)).toBe(false);
  });
});
