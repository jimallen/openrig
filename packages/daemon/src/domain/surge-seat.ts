// Surge seats: a second (third, ...) copy of a spec member, added to a running rig with `rig add` beside the member it
// copies, and named `<member><N>` in the member's own pod (N a whole number from 2, no leading zero: impl2, qa10; never
// impl1, impl02). The spec declares the member once, so the shared spec still describes a rig that carries surge seats.
// The naming rule is the one rig-here's `add-seat <pod> <member><N> --as <member>` enforces (its SURGE_SUFFIX and
// check_surge_seat); this module is OpenRig's copy of it.

/** The `<N>` of a surge seat id: a whole number from 2, with no leading zero. */
const SURGE_SUFFIX = /^(?:[2-9]|[1-9][0-9]+)$/;

/**
 * The spec member that declares a seat, by its logical id `<pod>.<member>`: the member with that exact id in that pod,
 * else (a surge seat) the one member `<base>` of that pod for which the seat's member id is `<base><N>`. An exact member
 * always wins (a spec that declares `impl2` describes `impl2` itself), and a seat id two members could read as a surge
 * (`qa12` beside `qa` and `qa1`) is not declared: the name does not say which persona the seat runs.
 */
export function specMemberForSeat<P extends { id: string; members: readonly { id: string }[] }>(
  pods: readonly P[],
  logicalId: string,
): { pod: P; member: P["members"][number]; surge: boolean } | null {
  const dot = logicalId.indexOf(".");
  if (dot <= 0) return null;
  const podId = logicalId.slice(0, dot);
  const memberId = logicalId.slice(dot + 1);
  if (!memberId) return null;
  const pod = pods.find((p) => p.id === podId);
  if (!pod) return null;
  const exact = pod.members.find((m) => m.id === memberId);
  if (exact) return { pod, member: exact, surge: false };
  const bases = pod.members.filter((m) => memberId.startsWith(m.id) && SURGE_SUFFIX.test(memberId.slice(m.id.length)));
  return bases.length === 1 ? { pod, member: bases[0]!, surge: true } : null;
}
