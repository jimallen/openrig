/**
 * workspaces-o9o.3: the pane evidence a runtime adapter returns with an attention_required or failed launch or resume.
 * Restore stores it (restore.completed / restore.subset_completed, as attentionEvidence), redacted at its chokepoints
 * (startup-orchestrator fail(), the restore resume-attention site). A plain capture returns tmux's screen rows, so a
 * token tmux soft-wrapped across two rows comes back as two fragments, each too short for the redactor, and the stored
 * value gives the token back once the newline is removed. The evidence is therefore read as logical lines (`-J`): a
 * read of its own, so the probe captures that decide readiness are unchanged.
 */

/** The outbound port: a pane capture that can join soft-wrapped rows (TmuxAdapter, HcAdapter). */
export interface JoinedPaneCapture {
  capturePaneContent(target: string, lines: number, opts?: { joinWrappedLines?: boolean }): Promise<string | null>;
}

export const PANE_EVIDENCE_CAPTURE_LINES = 40;
export const PANE_EVIDENCE_TAIL_LINES = 12;

/** The last 12 logical lines of the pane, soft wraps joined. Not redacted here: the stored copy is redacted downstream. */
export async function joinedPaneEvidence(tmux: JoinedPaneCapture, target: string): Promise<string> {
  const content = (await tmux.capturePaneContent(target, PANE_EVIDENCE_CAPTURE_LINES, { joinWrappedLines: true })) ?? "";
  return content.split("\n").slice(-PANE_EVIDENCE_TAIL_LINES).join("\n");
}
