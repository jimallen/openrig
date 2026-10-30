// Native comms ncomms-3d: name the sender of a native message to Claude Code. A line written to a seat's inbox socket is
// labelled "unknown" by Claude Code (its `origin.from` is the line's own `from` reply address, which OpenRig never sets:
// replies go through the outbox). Claude Code takes a sender NAME from a `cross-session-message` envelope around the
// content, and only when the envelope is byte-identical to what its own builder makes from the parsed parts (read from
// the claude 2.1.314 binary; checked end to end on Sparky, design-native-comms-20261030 §8.5):
//   builder:  `<cross-session-message from-name="${name}">\n${escape(body)}\n</cross-session-message>`
//   escape:   replaces a `<`-class character that opens a closing-tag lookalike of `cross-session-message` with `<\`.
//             Between the tag's letters it allows invisible, combining and control characters and, for `-`, any dash or
//             connector punctuation; the letters themselves match ASCII only, case-insensitively (`giu`: `ſ` folds to `s`).
//   name:     control and format characters removed, trimmed, cut to 64 code points; `"`, `<`, `>` removed.
// OpenRig does not copy the escape (its confusable tables change between versions). It wraps only a body the escape
// provably leaves alone, and a name the normalisation leaves alone; anything else goes out plain, as before. A
// false positive costs the label, never the content.

export const NAME_ENVELOPE_TAG = "cross-session-message";
/** The parser's from-name group as it appears in the claude binary (2.1.314). The launch probe requires it. */
export const NAME_ENVELOPE_PARSER_LITERAL = '(?: from-name="([^"<>\\\\n\\\\r]+)")?';

/** A seat or daemon identity the name normalisation leaves unchanged (`build-ux@eztrack`, `watchdog@system`). */
const PLAIN_NAME_RE = /^[A-Za-z0-9@._:-]{1,64}$/;

/** True when the body MAY hold a closing-tag lookalike Claude Code would escape: the tag's letters in order once every
 *  other character is dropped. A superset of the escape's matches, so a false result means the escape is the identity. */
export function mayHoldClosingTag(body: string): boolean {
  const letters = body.replace(/[^A-Za-z\u017F]/g, "").toLowerCase().replace(/\u017F/g, "s");
  return letters.includes("crosssessionmessage");
}

/** The content with the sender's name envelope, or null when it must go out plain. */
export function nameEnvelope(senderSession: string, content: string): string | null {
  if (!PLAIN_NAME_RE.test(senderSession)) return null;
  if (mayHoldClosingTag(content)) return null;
  return `<${NAME_ENVELOPE_TAG} from-name="${senderSession}">\n${content}\n</${NAME_ENVELOPE_TAG}>`;
}
