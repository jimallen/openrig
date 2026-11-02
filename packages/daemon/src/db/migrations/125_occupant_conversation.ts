import type { Migration } from "../migrate.js";

/**
 * Deliver, labelled (review of 84a26669, F1): a message is labelled when the agent that reads it is not the one it was sent to. A generation
 * (`generation_uuid`) is minted at every launch, so a restart supersedes lifecycle text bound to the one before; but a launch that resumes the
 * saved conversation is the same agent. `conversation_uuid` names the conversation a tenure belongs to: NULL is the tenure's own (a launch that is
 * not a resume), and a resuming launch copies its predecessor's. Readers take `coalesce(conversation_uuid, generation_uuid)`, so every tenure written
 * before this migration is its own conversation, as it was. Nullable, no CHECK, no backfill; a rolled-back build ignores the column, so rollback
 * leaves this applied and needs no step of its own.
 */
export const occupantConversationSchema: Migration = {
  name: "125_occupant_conversation.sql",
  sql: `ALTER TABLE occupant_tenures ADD COLUMN conversation_uuid TEXT;`,
};
