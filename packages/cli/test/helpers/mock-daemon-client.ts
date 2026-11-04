// Typed seam for hand-rolled DaemonClient test doubles. A test that needs only `get` / `post` (or a
// handful of verbs) builds that subset and hands it to a command's `clientFactory`; the command
// only calls the verbs the test stubbed. DaemonClient's verbs are generic (`get<T>` returns
// `Promise<DaemonResponse<T>>`), so a stub returning `{ status, data: unknown }` is not assignable
// to the real signature, and the subset cannot be checked against Partial<DaemonClient>. What the
// type does check is that every stubbed key is a real DaemonClient member, so a typo or a verb
// renamed in src fails to compile here instead of silently stubbing nothing.
import type { DaemonClient } from "../../src/client.js";

type KnownClientMembers<T> = { [K in keyof T]: K extends keyof DaemonClient ? T[K] : never };

/** View a stubbed subset of DaemonClient as the full client the command under test expects. */
export function asDaemonClient<T extends object>(stubs: T & KnownClientMembers<T>): DaemonClient {
  // The one deliberate widening: unstubbed members are absent, so a command that reaches one
  // fails loudly with "is not a function" rather than silently seeing a default.
  return stubs as unknown as DaemonClient;
}
