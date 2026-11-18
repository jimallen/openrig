import { TmuxAdapter } from "../../src/adapters/tmux.js";
import { probeSessionFromHasSession } from "./probe-from-has-session.js";

/**
 * A `TmuxAdapter` for a test that needs the type and a few of its methods, without a cast: the real class over an exec that
 * runs nothing, with the given methods laid over it. A method the test did not give throws when called (it reaches the exec),
 * so a call the test did not expect is a failure, not an `undefined`. A test that gives `hasSession` and no `probeSession`
 * gets the probe a decision site asks for, answered from that `hasSession`. Every method given is type-checked against
 * TmuxAdapter's own signature (workspaces-o9o.129).
 */
export function tmuxStub<T extends Partial<TmuxAdapter>>(methods: T): TmuxAdapter & T {
  const stub = Object.assign(new TmuxAdapter(async (cmd) => { throw new Error(`tmuxStub: unexpected command ${cmd}`); }, undefined, async (argv) => { throw new Error(`tmuxStub: unexpected command ${argv.join(" ")}`); }), methods);
  if ("hasSession" in methods && !("probeSession" in methods)) stub.probeSession = probeSessionFromHasSession;
  return stub;
}

/**
 * workspaces-o9o.129: a partial stub of any type, for a test that needs the type and a few of its members. Each member given is
 * type-checked against `T`; the object is exactly the plain object given (a member not given is absent, as before), and the one
 * plain cast to T here stands where every test used to write an unchecked double cast through unknown. A stub of a TmuxAdapter that
 * replaces a plain-object fake should use this, not tmuxStub: code feature-detects optional tmux methods (transcript rotation batches
 * when capturePanesContent exists; the identity reconciler calls readAllPaneProcesses when present), and tmuxStub's real instance has
 * them all, so a row would take another path. Use tmuxStub for a new test that wants every unexpected call to fail.
 */
export function stubOf<T extends object>(members: Partial<T>): T {
  return members as T;
}
