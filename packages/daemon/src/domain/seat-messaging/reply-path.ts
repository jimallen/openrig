/**
 * Seat messaging, a cross-host arrival (workspaces-o9o.16): who sent a message from another host, and whether a seat here can answer it.
 *
 * The sending CLI writes the envelope (From, To, Sent, ---, body, ---, a reply line), but only this host knows its own host registry, so only
 * this host can say whether a reply works. On arrival the From line names the origin host by this registry's name for it, and the closing reply
 * line is either a command that reaches the sender from here or a plain statement that there is none. Everything else rides as written.
 *
 * Trust: the origin host is asserted by the sending daemon and the label is the sender's own claim, as before. This host only adds what it knows.
 */

/** The outbound port: this host's name for another host, by that host's own id. Null when this host cannot name it. */
export interface HostDirectory {
  nameFor(hostId: string): string | null;
}

/** Where a message came from: the origin host's own id, the sending seat (member@rig) when there is one, and the label a shell gave itself. */
export interface Origin {
  host: string;
  seat: string | null;
  label: string | null;
}

/** What a seat here can do to answer: run a command, or nothing, for a stated reason. */
export type ReplyPath = { kind: "reachable"; command: string } | { kind: "none"; reason: string };

/** A host's own id, as `/api/messages/accept` takes it. */
const HOST_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** A seat of a host: member@rig@host. */
const SEAT_OF_HOST = /^([^@\s]+@[^@\s]+)@([^@\s]+)$/;

/**
 * The origin of an arrival from what the sending side states: its host id, and its sender, which is `unknown` or a seat of that host
 * (member@rig@host). The label is read off the envelope. Null when the statement does not hold together: the text then rides as written.
 */
export function originOf(host: unknown, sender: unknown, body: string): Origin | null {
  if (typeof host !== "string" || !HOST_ID.test(host) || typeof sender !== "string") return null;
  if (sender === "unknown") return { host, seat: null, label: envelopeLabel(body) };
  const seat = SEAT_OF_HOST.exec(sender);
  return seat && seat[2] === host ? { host, seat: seat[1]!, label: envelopeLabel(body) } : null;
}

/** The CLI's marker for a send with no sender (wrapSendBody / wrapPaneEnvelope). It names nobody, so it is never a label. */
const NO_SENDER = "<unknown sender>";
const FROM = "From: ";
const REPLY = "↩ Reply";
const RULE = "---";

/** The sender as this host shows it. */
export function senderLine(origin: Origin, hosts: HostDirectory): string {
  const host = hosts.nameFor(origin.host) ?? origin.host;
  if (origin.seat) return `${origin.seat}@${host}`;
  return origin.label ? `${origin.label} (a shell on ${host})` : `a shell on ${host}`;
}

export function replyPathFor(origin: Origin, hosts: HostDirectory): ReplyPath {
  const name = hosts.nameFor(origin.host);
  if (origin.seat) {
    return name
      ? { kind: "reachable", command: `rig send ${origin.seat}@${name} '...'` }
      : { kind: "none", reason: `${origin.host} is not in this host's registry (rig host ls)` };
  }
  const shell = `a shell on ${name ?? origin.host}`;
  return { kind: "none", reason: origin.label ? `${origin.label} is ${shell}, not a seat; no rig address answers it` : `${shell} is not a seat; no rig address answers it` };
}

export function replyLine(origin: Origin, hosts: HostDirectory): string {
  const path = replyPathFor(origin, hosts);
  if (path.kind === "reachable") return `↩ Reply: ${path.command}`;
  return origin.seat ? `↩ No reply path from this host: ${path.reason}` : `↩ No reply path: ${path.reason}`;
}

/** The label on the envelope's From line, or null when it names nobody. */
export function envelopeLabel(body: string): string | null {
  const first = body.slice(0, body.indexOf("\n") === -1 ? body.length : body.indexOf("\n"));
  if (!first.startsWith(FROM)) return null;
  const label = first.slice(FROM.length).trim();
  return label && label !== NO_SENDER ? label : null;
}

/** Whether `body` has the envelope's shape: a From line first, a rule, and a reply line last. */
function isEnvelope(lines: string[]): boolean {
  return lines.length >= 5 && lines[0]!.startsWith(FROM) && lines.includes(RULE) && lines[lines.length - 1]!.startsWith(REPLY);
}

/** Rewrites only the envelope's first line and its last line. Text that is not an envelope is returned as it came. */
export function restampArrival(body: string, origin: Origin, hosts: HostDirectory): string {
  const lines = body.split("\n");
  if (!isEnvelope(lines)) return body;
  lines[0] = `${FROM}${senderLine(origin, hosts)}`;
  lines[lines.length - 1] = replyLine(origin, hosts);
  return lines.join("\n");
}

/** A directory that names no host: what an arrival looked like before this registry learned its origin. */
const NAMES_NONE: HostDirectory = { nameFor: () => null };

/**
 * The body to commit for an arrival whose id may already hold a row. A restamp depends on this host's registry, which can learn the origin's
 * name between an arrival and its repeat. When the earlier row is this same text restamped without a name for the origin, or with the name it
 * has now, it is the same message and keeps its first text, so the repeat is free. Any other earlier text is left to the store: a conflict
 * (that includes a registry that dropped or renamed the origin between the two, which this does not guess at).
 */
export function arrivalBody(earlier: string | null | undefined, body: string, origin: Origin, hosts: HostDirectory): string {
  const restamped = restampArrival(body, origin, hosts);
  if (earlier === null || earlier === undefined || earlier === restamped) return restamped;
  return earlier === restampArrival(body, origin, NAMES_NONE) ? earlier : restamped;
}
