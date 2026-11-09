// OF-283: `rig seat apply-spec`. A Pi seat's three retained spec fields (env_passthrough, model_overrides,
// pi.link_operator_models) are written to its node when the node is created and read from the database at every launch, so a
// later change to the spec reaches an existing seat only through this explicit step. This module is the pure part: what the
// spec says, what the node retains, and the per-field difference between them. It reads no file and no database (the service
// does), and it prints no environment VALUE: an env_passthrough entry is a variable NAME, and nothing here ever holds a value.
import type { RigSpecPodMember } from "./types.js";

export type ModelOverrides = Record<string, Record<string, { contextWindow: number }>>;

/** The three fields as a node retains them. `modelOverrides` undefined = none; `piLinkOperatorModels` false = not declared. */
export interface RetainedPiFields {
  envPassthrough: string[];
  modelOverrides: ModelOverrides | undefined;
  piLinkOperatorModels: boolean;
}

export type RetainedFieldName = "env_passthrough" | "model_overrides" | "pi.link_operator_models";

export interface RetainedFieldDiff {
  field: RetainedFieldName;
  /** What the node holds, as display strings (names, override keys with their window, or "true"); [] = none. */
  retained: string[];
  /** What the spec says, in the same form. */
  spec: string[];
  changed: boolean;
}

/** The three fields as the spec member says them: an absent field is "none", which clears the retained one. */
export function specRetainedFields(member: Pick<RigSpecPodMember, "envPassthrough" | "modelOverrides" | "piLinkOperatorModels">): RetainedPiFields {
  return {
    envPassthrough: [...(member.envPassthrough ?? [])],
    modelOverrides: member.modelOverrides,
    piLinkOperatorModels: member.piLinkOperatorModels === true,
  };
}

/** One display entry per override: `<provider>/<model> contextWindow=<tokens>`. Sorted, so equal sets read equal. */
export function describeModelOverrides(overrides: ModelOverrides | undefined): string[] {
  if (!overrides) return [];
  return Object.entries(overrides).flatMap(([provider, models]) =>
    Object.entries(models).map(([model, entry]) => `${provider}/${model} contextWindow=${entry.contextWindow}`)).sort();
}

/** The env names are an ordered list (the spec's order is what is stored); a reorder is a change. */
export function diffRetainedPiFields(retained: RetainedPiFields, spec: RetainedPiFields): RetainedFieldDiff[] {
  const env = (r: RetainedPiFields) => [...r.envPassthrough];
  const models = (r: RetainedPiFields) => describeModelOverrides(r.modelOverrides);
  const link = (r: RetainedPiFields) => (r.piLinkOperatorModels ? ["true"] : []);
  const row = (field: RetainedFieldName, read: (r: RetainedPiFields) => string[]): RetainedFieldDiff => {
    const a = read(retained);
    const b = read(spec);
    return { field, retained: a, spec: b, changed: JSON.stringify(a) !== JSON.stringify(b) };
  };
  return [row("env_passthrough", env), row("model_overrides", models), row("pi.link_operator_models", link)];
}

/** The names the apply adds to and removes from env_passthrough, for the audit line. */
export function envNameChanges(retained: string[], spec: string[]): { added: string[]; removed: string[] } {
  return { added: spec.filter((n) => !retained.includes(n)), removed: retained.filter((n) => !spec.includes(n)) };
}
