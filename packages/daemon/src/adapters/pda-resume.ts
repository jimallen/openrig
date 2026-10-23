// pda runtime L2a: resume for a pda seat restored through the legacy (non-pod) resume path. A pda seat resumes by
// re-attaching the runner to the agent its resume token names (`pda_agent`, D2); there is no conversation file to
// continue and no fresh start. The launch itself is the runtime adapter's, so the two paths cannot disagree on the
// binding, the one-seat-per-agent re-check, readiness, or how an outcome is classified.

import type { ResumeResult } from "./claude-resume.js";
import { PDA_RESUME_TYPE } from "./pda-runner-protocol.js";
import type { PdaRuntimeAdapter } from "./pda-runtime-adapter.js";

export class PdaResumeAdapter {
  constructor(private readonly adapter: Pick<PdaRuntimeAdapter, "launchHarness">) {}

  canResume(resumeType: string | null, resumeToken: string | null): boolean {
    return resumeType === PDA_RESUME_TYPE && !!resumeToken;
  }

  /** Never `retry_fresh`: a missing agent needs a person (attention_required), and pda has no fresh start. */
  async resume(nodeId: string, tmuxSessionName: string, resumeType: string | null, resumeToken: string | null, cwd: string): Promise<ResumeResult> {
    if (!this.canResume(resumeType, resumeToken)) return { ok: false, code: "no_resume", message: "pda resume not available" };
    const result = await this.adapter.launchHarness({
      id: "", nodeId, tmuxSession: tmuxSessionName, tmuxWindow: null, tmuxPane: null, cmuxWorkspace: null, cmuxSurface: null,
      updatedAt: "", cwd,
    }, { name: tmuxSessionName, resumeToken: resumeToken! });
    if (result.ok) return { ok: true };
    if (result.recovery === "attention_required") {
      return { ok: false, code: "attention_required", message: result.error, ...(result.evidence ? { evidence: result.evidence } : {}) };
    }
    return { ok: false, code: "resume_failed", message: result.error };
  }
}
