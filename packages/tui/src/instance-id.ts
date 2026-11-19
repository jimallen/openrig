// workspaces-o9o.172 (verify-qa2, review 3): a TUI instance id is an address (A2: instances are addressable), and every control
// socket reply carries it in its envelope. The "view" reply is bounded in encoded bytes, and the digest can shrink to fit, but the
// envelope cannot: an id of 1,100,000 characters made a 1,100,154-byte line. So the id itself is bounded, and a TUI refuses an
// over-long one when it starts, naming the limit, instead of answering past the bound.
import { utf8Bytes } from "./observe/view-digest.js";

/** The longest instance id a TUI accepts, in UTF-8 bytes. Ids in use are short ("tui-1", "kernel"); 128 leaves room for a
 *  descriptive name, and keeps the envelope small whatever the characters (JSON writes at most 6 bytes per byte of the id). */
export const INSTANCE_ID_MAX_BYTES = 128;

/** Why `instanceId` is too long to be an instance id, or null when it fits. */
export function instanceIdProblem(instanceId: string): string | null {
  const bytes = utf8Bytes(instanceId);
  if (bytes > INSTANCE_ID_MAX_BYTES) return `the instance id is ${bytes} bytes; the limit is ${INSTANCE_ID_MAX_BYTES} bytes (UTF-8)`;
  return null;
}

/** Throws, naming the limit, when `instanceId` is too long to be an instance id. */
export function assertInstanceId(instanceId: string): void {
  const problem = instanceIdProblem(instanceId);
  if (problem) throw new Error(problem);
}
