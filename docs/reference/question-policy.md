# Unanswered questions take their recommended answer

A Claude Code seat that opens a question to the human (the `AskUserQuestion` dialog) waits for an answer. If nobody answers within the
rig's wait, OpenRig answers it with the option marked `(Recommended)`, records that it did, and tells the human.

```yaml
question_policy:
  auto_answer_after: 15   # minutes; 0 turns it off; the default is 15; the longest is 60
```

`question_policy` is a top-level rig key. It is saved on the rig, so `rig up --existing`, restores, forks and `rig export` keep it. It is not
a rig-mode setting.

## When it answers, and when it does not

- Every question in the dialog must be single-select and have exactly one option whose label contains `(Recommended)`. Then each takes that option.
- Otherwise the whole dialog is **held**: nothing is answered, ever. That covers a question with no recommended option, two recommended options,
  a multi-select question, two questions with the same text, and a dialog OpenRig cannot read. A held question is named in `rig health`
  until the human answers it, and the held-message count in `rig ps` keeps growing meanwhile.
- A human's answer always wins. The wait is counted from when the dialog opened; a daemon restart in the wait does not restart it, and a dialog
  that was answered while the daemon was down is not answered again.
- The rule has no exception for irreversible or outward-facing questions (Jim, 2026-11-08: "No exception, log it"). A rig that wants a human for
  those sets `auto_answer_after: 0`.

## What is recorded and told

- An event `seat.question_auto_answered` (rig, seat, question and option for each question, when it was asked, when the answer was taken, the
  wait it waited and the wait that was set). A held question records `seat.question_held` with the reason.
- One queue item to `human@kernel` per answer taken. It names the seat, each question and the option taken, when, and how to correct it:
  the model has the answer as the user's, so `rig send <seat> "<what you actually want>"`.
- `rig health` lists a question that is waiting or held, the messages waiting behind it, and the answers taken in the last 24 hours.

## How it works

Claude Code runs a `PermissionRequest` hook for the dialog while the dialog is open. OpenRig's `question-wait.cjs` asks the daemon, in a
long-poll, whether this question should take its answer; the daemon owns the wait and the record. When the wait ends the daemon sends the
answers and the hook returns the documented `allow` decision with them filled in; the model receives the same tool result as for a human's
answer. A hook that fails, times out or finds the daemon down prints nothing and leaves the dialog to the human.

The hook's own `timeout` is fixed in `hooks/claude.json` (the longest wait plus five minutes), so one setting serves every rig. A seat launched
before this release has no such hook until it is relaunched; its questions are not answered, and they were never at risk of being answered wrongly.

Measured on Claude Code 2.1.319: the hook runs while the dialog is open, a human answer given first wins, a hook killed at its timeout leaves the
dialog open, and a hook with `timeout` 1200 s was honoured at 960 s. Longer waits than that are unmeasured.

## A waiting question and the messages behind it

While a seat waits on a question, messages sent to it wait too (OpenRig never types into an open dialog). `rig ps` shows `N held, oldest Xm`
for any seat with messages waiting more than a minute, `rig send` says the same in its "Accepted, not yet received" line, and the seat's posture
reads `waiting on a question to the human`, not `permission_prompt`.
