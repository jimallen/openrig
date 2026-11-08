# Unanswered questions take their recommended answer

A Claude Code seat that opens a question to the human (the `AskUserQuestion` dialog) waits for an answer. If nobody answers within the
rig's wait, OpenRig answers it with the option marked `(Recommended)`, records that it did, and tells the human.

```yaml
question_policy:
  auto_answer_after: 15   # minutes; 0 turns it off; the default is 15; the longest is 20
```

`question_policy` is a top-level rig key. It is saved on the rig, so `rig up --existing`, restores, forks and `rig export` keep it. It is not
a rig-mode setting.

## When it answers, and when it does not

- Every question in the dialog must be single-select and have exactly one option whose label contains `(Recommended)`. Then each takes that option.
- Otherwise the whole dialog is **held**: nothing is answered, ever. That covers a question with no recommended option, two recommended options,
  a multi-select question, two questions with the same text, a question whose text is `__proto__`, `constructor` or `prototype` (it cannot be a
  key of the answers), and a dialog OpenRig cannot read. A held question is named in `rig health`
  until the human answers it, and the held-message count in `rig ps` keeps growing meanwhile.
- The rig's setting is read again when the wait ends. A rig that turns `auto_answer_after` to 0 while a question waits gets no answer: the
  question is held and named.
- A human's answer always wins. The wait is counted from when the dialog opened; a daemon restart in the wait does not restart it, and a dialog
  that was answered while the daemon was down is not answered again.
- The rule has no exception for irreversible or outward-facing questions (Jim, 2026-11-08: "No exception, log it"). A rig that wants a human for
  those sets `auto_answer_after: 0`.

## What is recorded and told

- An event `seat.question_auto_answered` (rig, seat, question and option for each question, when it was asked, when the answer was taken, the
  wait it waited and the wait that was set). A held question records `seat.question_held` with the reason.
- One queue item to `human@kernel` per answer taken. The item is filed first, then the event, then the answer is sent: if the queue cannot take the
  item, no event is written and no answer is sent, and the hook asks again until it can. The event means the answer was sent; that the seat took it is
  said by `rig health` only when the seat reports it landed. It names the seat, each question and the option taken, when, and how to correct it:
  the model has the answer as the user's, so `rig send <seat> "<what you actually want>"`.
- `rig health` lists a question that is waiting or held, the messages waiting behind it, and the answers of the last 24 hours, said apart: "took their
  (Recommended) answer" only for an answer the seat reported landed; "sent and not yet reported landed"; and "withheld" while the item cannot be filed.

## How it works

Claude Code runs a `PermissionRequest` hook for the dialog while the dialog is open. OpenRig's `question-wait.cjs` asks the daemon, in a
long-poll, whether this question should take its answer; the daemon owns the wait and the record. When the wait ends the daemon sends the
answers and the hook returns the documented `allow` decision with them filled in; the model receives the same tool result as for a human's
answer. A hook that fails, times out or finds the daemon down prints nothing and leaves the dialog to the human.

The hook's own `timeout` is fixed in `hooks/claude.json` (1500 s: the longest wait, 20 min, plus five minutes), so one setting serves every rig.
The daemon refuses a request whose start time is not that of a live hook (400) and holds at most 4 waiting requests per seat and 64 in all (429). A seat launched
before this release has no such hook until it is relaunched; its questions are not answered, and they were never at risk of being answered wrongly.

Measured on Claude Code 2.1.319: the hook runs while the dialog is open, a human answer given first wins, a hook killed at its timeout leaves the
dialog open, and a hook with `timeout` 1200 s was honoured at 960 s. The longest wait is the longest measured; raising it needs a measured run.

## A waiting question and the messages behind it

While a seat waits on a question, messages sent to it wait too (OpenRig never types into an open dialog). `rig ps` shows `N held, oldest Xm`
for any seat with messages waiting more than a minute, `rig send` says the same in its "Accepted, not yet received" line, and the seat's posture
reads `waiting on a question to the human`, not `permission_prompt`.

## Residual risks

- **A phantom answer.** If the human answers close to the moment the wait ends and the seat's PostToolUse report is slow or lost, the daemon can still
  take, log and file an answer for a dialog that is already closed. The seat is not affected (its hook has ended); the record then names an answer that
  never landed. The window is about a tenth of a second in normal operation and was not measured.
- **A killed hook.** If Claude Code kills the hook at its timeout in the same instant the daemon sends the answer, the record says "answered" while the
  dialog is still open. `rig health` lists such an answer as not yet seen to land.
- **A late report from an earlier dialog.** A PostToolUse from dialog 1 that arrives after dialog 2 opened settles dialog 2 as answered by the human, so
  dialog 2 is not auto-answered. It stays open for the human.
- **A marker is the seat's own.** "(Recommended)" is written by the model that asks. A seat whose context was injected can mark a destructive option;
  it is taken after the wait, logged and filed. That is the policy as decided, with no exception for irreversible questions.
- **A start time is bounded by the longest wait, not by the rig's.** The daemon refuses a start older than 20 minutes plus 5 (a live hook's limit), not older than
  the rig's own wait. A caller with the shared hook token can therefore ask for a shorter wait than the rig set, for its own request. It needs the same token as
  `/api/activity/hooks` and answers only the caller's own request, never the seat's real dialog.
- **A seat's held waits are capped (4), and the daemon's (64).** A caller with the token can fill a seat's cap with requests of its own; the seat's real hook is
  then refused (429) and retries. The question stays open for the human, so this fails safe: the cost is that it is not auto-answered. A refused request writes nothing.
