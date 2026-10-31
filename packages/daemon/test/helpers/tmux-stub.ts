import { TmuxAdapter } from "../../src/adapters/tmux.js";

/**
 * A `TmuxAdapter` for a test that needs the type and a few of its methods, without a cast: the real class over an exec that
 * runs nothing, with the given methods laid over it. A method the test did not give throws when called (it reaches the exec),
 * so a call the test did not expect is a failure, not an `undefined`.
 */
export function tmuxStub<T extends object>(methods: T): TmuxAdapter & T {
  return Object.assign(new TmuxAdapter(async (cmd) => { throw new Error(`tmuxStub: unexpected command ${cmd}`); }, undefined, async (argv) => { throw new Error(`tmuxStub: unexpected command ${argv.join(" ")}`); }), methods);
}
