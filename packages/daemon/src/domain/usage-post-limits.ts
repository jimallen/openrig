// OF-90: the limits of one usage post (pi-usage, pi-usage-charges, pda-usage), shared by the daemon routes that
// enforce them and the posters that must stay under them. A poster that sends more than this gets a 413, so it chunks.

/** The most facts (or charges) one usage post may carry. */
export const USAGE_MAX_FACTS = 5000;
/** The most bytes one usage post body may hold. */
export const USAGE_MAX_BODY_BYTES = 4 * 1024 * 1024;
/** OF-106: the most bytes one /api/activity/hooks body may hold. Every poster (the Claude relay, the stub, Pi and pda
 *  runners, `rig` startup proof) sends a flat object of a few hundred bytes; the longest field is a 1024-character
 *  session-file path. 64 KiB is two orders of magnitude over that and small enough that a token holder cannot make the
 *  daemon buffer more. */
export const ACTIVITY_HOOK_MAX_BODY_BYTES = 64 * 1024;
/** What a poster fills a chunk to: the cap less room for the envelope (session ids, flags) around the list. */
export const USAGE_CHUNK_BODY_BYTES = 3 * 1024 * 1024;

/** Split a list into consecutive chunks of at most `USAGE_MAX_FACTS` items whose serialized size stays within
 *  `USAGE_CHUNK_BODY_BYTES`. Order is kept. An item that is itself over the byte budget is a chunk of its own (the
 *  daemon will refuse it with a 413, which the poster handles); it never takes other items down with it. */
export function chunkUsagePost<T>(items: readonly T[]): T[][] {
  const chunks: T[][] = [];
  let current: T[] = [];
  let bytes = 0;
  for (const item of items) {
    const size = Buffer.byteLength(JSON.stringify(item), "utf8") + 1; // the comma
    if (current.length > 0 && (current.length >= USAGE_MAX_FACTS || bytes + size > USAGE_CHUNK_BODY_BYTES)) {
      chunks.push(current);
      current = [];
      bytes = 0;
    }
    current.push(item);
    bytes += size;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}
