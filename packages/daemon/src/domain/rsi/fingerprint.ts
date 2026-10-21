/**
 * The stable identity of a telemetry finding. It is NOT the health record id: that id is
 * hashed from the episode start (health-projection.ts healthEpisodeId), so every recurrence
 * of the same defect opens a record with a new id. Proposals, the finding-state store and
 * the filing check key on this fingerprint instead.
 *
 * fingerprint = detector id + "/" + normalised subject key. The subject key names WHAT is
 * wrong (for example `rig:<rigId>`), never when it was seen or how often.
 *
 * The finding class is NOT part of the fingerprint. A detector that emits more than one
 * finding class for the same subject (for example D1) MUST put the class into the subject
 * key (`rig:<rigId>:<class>`); otherwise its classes collapse into one fingerprint. D4 has a
 * single class, so its subject key is the rig alone.
 */
export function normaliseSubjectKey(subjectKey: string): string {
  const normalised = subjectKey.normalize("NFC").trim().toLowerCase();
  if (normalised === "") throw new Error("finding subject key must be non-empty");
  return normalised;
}

export function rsiFingerprint(detectorId: string, subjectKey: string): string {
  if (detectorId.trim() === "" || detectorId.includes("/")) throw new Error("detector id must be non-empty and contain no '/'");
  return `${detectorId}/${normaliseSubjectKey(subjectKey)}`;
}
