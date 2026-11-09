// OF-283: how a Pi launch or resume finds a seat's three retained spec fields (env_passthrough, model_overrides,
// pi.link_operator_models): by session name, from the node row in the DATABASE, every time. No launch path reads the spec for
// them; a spec change reaches a seat only through `rig seat apply-spec`, which rewrites the node. These three lookups were
// inline closures in startup.ts (unchanged here); they are a module so a test can drive the same lookups the daemon passes to
// PiRuntimeAdapter (launch) and PiResumeAdapter (resume and restore).
import type Database from "better-sqlite3";
import type { RigRepository } from "../domain/rig-repository.js";
import type { PiModelOverrides } from "./pi-runner-protocol.js";

export interface PiRetainedFieldLookups {
  /** A Pi or OMP seat's extra environment names (spec env_passthrough), by session name, for every launch and resume. */
  envPassthroughFor(sessionName: string): string[];
  /** A Pi seat's model overrides (spec model_overrides, OF-270). A stored value that is no longer valid throws, so that launch refuses. */
  modelOverridesFor(sessionName: string): PiModelOverrides | undefined;
  /** OF-279: the member's pi.link_operator_models. */
  linkOperatorModelsFor(sessionName: string): boolean;
}

export function piRetainedFieldLookups(db: Database.Database, rigRepo: RigRepository): PiRetainedFieldLookups {
  const nodeOf = (sessionName: string) => db.prepare("SELECT node_id AS nodeId FROM sessions WHERE session_name = ? ORDER BY rowid DESC LIMIT 1").get(sessionName) as { nodeId: string } | undefined;
  return {
    envPassthroughFor: (sessionName) => { const row = nodeOf(sessionName); return row ? rigRepo.getNodeEnvPassthrough(row.nodeId) : []; },
    modelOverridesFor: (sessionName) => { const row = nodeOf(sessionName); return row ? rigRepo.getNodeModelOverrides(row.nodeId) : undefined; },
    linkOperatorModelsFor: (sessionName) => { const row = nodeOf(sessionName); return row ? rigRepo.getNodeLinkOperatorModels(row.nodeId) : false; },
  };
}
