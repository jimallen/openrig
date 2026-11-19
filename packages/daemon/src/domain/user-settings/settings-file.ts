// settings-file.ts — the outbound port SettingsStore reads and writes config.json through (workspaces-6ul). The domain keeps the
// settings rules (env > file > default, validation, verify-after-write); the adapter (adapters/node-settings-file.ts) owns the file:
// the read under the credential rule, the link-following atomic write.
import type { CredentialFileRead } from "../credential-file.js";

export interface SettingsFile {
  /** Where config.json lives (shown to the operator and in errors). */
  readonly path: string;
  /** The file under OPENRIG_CONFIG_POLICY: its content, or the refusal ("missing" when there is none). Never throws for a file
   *  problem. */
  read(): CredentialFileRead;
  exists(): boolean;
  /** Publish `content` whole: the parent folder is created, a link is followed and its target replaced atomically, never truncated
   *  in place unless the folder refuses a rename. */
  write(content: string): void;
  /** Remove the file; an absent one is not an error. */
  remove(): void;
}
