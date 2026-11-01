// hc cutover W37: a pane-hosted runner (the Pi runner, the pda runner) tells herdr-core what the seat is doing.
//
// Why. herdr-core reads a program's state from OSC 7501 in the program's own output (hc-runtime-requirements.ts). Bare Pi
// writes it; the OpenRig runners do not, because Pi runs behind them over RPC and its terminal output never reaches the pane.
// Measured live (live-pi-hc-20261101.md 1b): `hc get` on the runner's terminal stayed reported:false, status null, turn 0, so
// every send to a runner seat could only end `waiting` (hc-delivery.ts rows 3 and 5 need a turn).
//
// What. The runner already derives its activity from typed events, never from the screen (BR-1). That same activity is now
// also written to the pane as OSC 7501: `working` while a run is open, `idle` once it ends and when the runner becomes ready.
// Attention and held-head notices (Notification) are not mapped: `blocked` makes hc refuse a plain send, a product call this
// piece does not make.
//
// Wire format, measured on a private core (spike-hc-1-2 section 2.3): ESC ] 7501 ; state=<word> : app=<word> ESC \.
// An unknown key makes hc drop the whole record, so only `state` and `app` are written.
//
// Only node builtins, so a compiled runner entry stays runnable with no daemon dependencies.

/** The two states a runner reports. */
export type RunnerHcState = "idle" | "working";

/** What hc would be told for a runner activity post, or null when the activity says nothing about busy or idle. */
export function hcStateForActivity(hookEvent: string): RunnerHcState | null {
  switch (hookEvent) {
    case "active":
    case "PreToolUse":
      return "working";
    case "Stop":
      return "idle";
    default:
      return null;
  }
}

/** The OSC 7501 record for a state. `app` names the runner; it must not contain `:`, `;` or control bytes. */
export function hcStatusRecord(state: RunnerHcState, app: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(app)) throw new Error("hc status app name must be word characters");
  return `\u001b]7501;state=${state}:app=${app}\u001b\\`;
}

/** Writes status to the pane, only for a terminal that herdr-core hosts (it sets HC_TERMINAL_ID). Elsewhere (a tmux pane)
 *  the sink is absent and nothing is written. Repeats of the state last written are not written again. */
export type RunnerHcStatusSink = (state: RunnerHcState) => void;

export function createRunnerHcStatusSink(
  env: NodeJS.ProcessEnv,
  write: (text: string) => void,
  app: string,
): RunnerHcStatusSink | undefined {
  const terminal = env.HC_TERMINAL_ID;
  if (typeof terminal !== "string" || terminal === "") return undefined;
  let last: RunnerHcState | null = null;
  return (state) => {
    if (state === last) return;
    last = state;
    try { write(hcStatusRecord(state, app)); } catch { /* a closed pane is the runner's other handlers' business */ }
  };
}
