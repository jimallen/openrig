/**
 * Maps restore node result status to Tailwind text color class.
 * Vocabulary: resumed / rebuilt / fresh / failed / n-a
 */
export function getRestoreStatusColorClass(status: string): string {
  switch (status) {
    case "resumed":
      return "text-success-ink";
    case "rebuilt":
      return "text-success-ink";
    case "fresh":
      return "text-foreground-muted";
    case "failed":
      return "text-destructive";
    // Compat: old persisted values
    case "checkpoint_written":
      return "text-success-ink";
    case "fresh_no_checkpoint":
      return "text-foreground-muted";
    default:
      return "text-foreground-muted";
  }
}
