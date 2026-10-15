// Public surface for the agent_ref guard (domain/agent-ref-guard.ts), so the CLI's bundle audit reads a
// persona's agent.yaml with the same checks the daemon applies (regular file, one link, size cap,
// O_NOFOLLOW|O_NONBLOCK) instead of a plain read that a FIFO would hang.
export { readGuardedPersonaFile, PersonaFileRefused, PERSONA_FILE_MAX_BYTES } from "./domain/agent-ref-guard.js";
