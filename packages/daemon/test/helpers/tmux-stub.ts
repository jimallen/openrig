import { TmuxAdapter } from "../../src/adapters/tmux.js";
import { probeSessionFromHasSession } from "./probe-from-has-session.js";

/**
 * A `TmuxAdapter` for a test that needs the type and a few of its methods, without a cast: the real class over an exec that
 * runs nothing, with the given methods laid over it. A method the test did not give throws when called (it reaches the exec),
 * so a call the test did not expect is a failure, not an `undefined`. A test that gives `hasSession` and no `probeSession`
 * gets the probe a decision site asks for, answered from that `hasSession`.
 */
export function tmuxStub<T extends object>(methods: T): TmuxAdapter & T {
  const stub = Object.assign(new TmuxAdapter(async (cmd) => { throw new Error(`tmuxStub: unexpected command ${cmd}`); }, undefined, async (argv) => { throw new Error(`tmuxStub: unexpected command ${argv.join(" ")}`); }), methods);
  if ("hasSession" in methods && !("probeSession" in methods)) stub.probeSession = probeSessionFromHasSession;
  return stub;
}
