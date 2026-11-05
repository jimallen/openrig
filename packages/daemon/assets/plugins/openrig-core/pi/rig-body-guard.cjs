"use strict";

// OF-249: the Pi half of the rig-body guard. Pi loads this file as an extension (`pi --extension <this file>`,
// added by the pi-runner for every seat) and calls it on every tool call BEFORE the tool runs. A bash command
// whose text would let the shell run a command substitution inside a `rig send` / `rig queue ... --body` is
// refused with a reason the model reads as the tool result; the shell never sees the command.
// The parser and the rules are in ../hooks/scripts/rig-body-guard.cjs, shared with the Claude PreToolUse hook.
//
// Never throws: a Pi `tool_call` handler that throws blocks the tool (Pi's fail-safe), which would stop every
// bash call of the seat on a guard bug. check() has its own fail-closed fallback for the commands that matter.

const { check } = require("../hooks/scripts/rig-body-guard.cjs");

module.exports = function rigBodyGuard(pi) {
  pi.on("tool_call", async (event) => {
    try {
      if (!event || event.toolName !== "bash") return undefined;
      const command = event.input && event.input.command;
      const verdict = check(command);
      if (verdict.block) return { block: true, reason: verdict.reason };
    } catch {
      /* a guard fault must not stop the seat's other bash calls */
    }
    return undefined;
  });
};
