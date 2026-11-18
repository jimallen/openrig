// OF-283: `rig seat apply-spec`. A seat retains some spec fields on its node, and launches read them from the database:
// - a Pi seat's three (env_passthrough, model_overrides, pi.link_operator_models), written when the node is created;
// - a Claude Code seat's three (remote_control, ask_in_modal, code_mode: nodes.remote_control, nodes.ask_in_modal, nodes.code_mode),
//   written at creation and
//   when `rig up` relaunches the member from the spec, and read by seat launch, restore and handover.
// So a later change to the spec reaches an existing seat only through `rig up` or this explicit step. This module is the pure
// part, for both runtimes: what the spec says, what the node retains, and the per-field difference between them. It reads no
// file and no database (the service does), and it prints no environment VALUE: an env_passthrough entry is a variable NAME,
// and nothing here ever holds a value.
import type { RigSpecPodMember } from "./types.js";

export type ModelOverrides = Record<string, Record<string, { contextWindow: number }>>;

/** The three fields as a node retains them. `modelOverrides` undefined = none; `piLinkOperatorModels` false = not declared. */
export interface RetainedPiFields {
  envPassthrough: string[];
  modelOverrides: ModelOverrides | undefined;
  piLinkOperatorModels: boolean;
}

export type PiRetainedFieldName = "env_passthrough" | "model_overrides" | "pi.link_operator_models";
export type ClaudeRetainedFieldName = "remote_control" | "ask_in_modal" | "code_mode";
export type RetainedFieldName = PiRetainedFieldName | ClaudeRetainedFieldName;

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

/** A Claude Code seat's three retained launch fields, as booleans: false = not declared. */
export interface RetainedClaudeFields {
  remoteControl: boolean;
  askInModal: boolean;
  codeMode: boolean;
}

/** The three fields as the spec member says them: an absent (or false) field withdraws the retained declaration. */
export function specClaudeFields(member: Pick<RigSpecPodMember, "remoteControl" | "askInModal" | "codeMode">): RetainedClaudeFields {
  return { remoteControl: member.remoteControl === true, askInModal: member.askInModal === true, codeMode: member.codeMode === true };
}

/** One row per field, in pi.link_operator_models' display form: ["true"] when declared, [] when not. */
export function diffRetainedClaudeFields(retained: RetainedClaudeFields, spec: RetainedClaudeFields): RetainedFieldDiff[] {
  const row = (field: ClaudeRetainedFieldName, read: (r: RetainedClaudeFields) => boolean): RetainedFieldDiff => {
    const a = read(retained);
    const b = read(spec);
    return { field, retained: a ? ["true"] : [], spec: b ? ["true"] : [], changed: a !== b };
  };
  return [row("remote_control", (r) => r.remoteControl), row("ask_in_modal", (r) => r.askInModal), row("code_mode", (r) => r.codeMode)];
}

// A seat's identity fields: agent_ref and profile (nodes.agent_ref, nodes.profile), the same columns for every runtime. A fresh
// launch from the spec refuses a seat whose recorded values differ from its member's ("a fresh launch never changes a seat's
// identity"). A seat removed and re-added with `rig add`, or a rig-here surge seat, records agent_ref as an absolute `path:`
// into the release it was added from, while the spec says `local:...`; apply-spec is the explicit, audited step that realigns
// them. The comparison is the one readSeatStartupFromSpec makes (absent = null), so a realigned seat passes it.
export type IdentityFieldName = "agent_ref" | "profile";

export interface IdentityFieldDiff {
  field: IdentityFieldName;
  retained: string | null;
  spec: string | null;
  changed: boolean;
}

export function diffSeatIdentity(
  retained: { agentRef: string | null; profile: string | null },
  spec: { agentRef: string | null | undefined; profile: string | null | undefined },
): IdentityFieldDiff[] {
  const row = (field: IdentityFieldName, a: string | null | undefined, b: string | null | undefined): IdentityFieldDiff =>
    ({ field, retained: a ?? null, spec: b ?? null, changed: (a ?? null) !== (b ?? null) });
  return [row("agent_ref", retained.agentRef, spec.agentRef), row("profile", retained.profile, spec.profile)];
}
