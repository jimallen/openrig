# The stub agent for test/delivery-review.real.test.ts, from the QA reviewer's kit. Plays Codex or Claude on a real pty and runs the REAL relay
# as a real process for every event, so what the relay decides is what the "agent" sees. Claude's transcript uses real record shapes (key
# census of live transcripts, Claude 2.1.310 to 2.1.316): a queued message is `queue-operation`/`enqueue` first, with the prompt in `content`,
# and the hook runs only when it is taken (s0 M7). Taken, it is a `user` record, or an `attachment` of type `queued_command`.
import hashlib, json, os, re, signal, subprocess, sys, time, tty
base, relay, node, runtime = sys.argv[1:5]
tty.setraw(0)
log = open(base + "/seat.log", "ab", buffering=0)
rollout = base + "/rollout.jsonl"
MARK = re.compile(rb"\n\[openrig-msg ([A-Za-z0-9._:-]+):([a-f0-9]{16,64})\]\s*$")
composer = b""
lost = False
seen_ids = []
flag = lambda n: os.path.exists(base + "/" + n)
transcript = rollout if runtime == "codex" else base + "/transcript.jsonl"
def hook(payload, kill_after_record=None):
    if kill_after_record is None:
        return subprocess.run([node, relay], input=json.dumps(payload).encode(), capture_output=True)
    # OF-229: the relay is paused by `kill_after_record` (a --require shim) right after its gate record is linked, and killed there. Its text
    # is already on stdout and its record is on disk; it never exits.
    linked = base + "/relay-linked"
    child = subprocess.Popen([node, relay], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             env={**os.environ, "NODE_OPTIONS": "--require " + kill_after_record, "DELIVERY_LINKED_FLAG": linked})
    child.stdin.write(json.dumps(payload).encode()); child.stdin.close()
    deadline = time.time() + 20
    while not os.path.exists(linked) and time.time() < deadline:
        time.sleep(0.005)
    child.kill()
    out = child.stdout.read(); child.wait()
    return subprocess.CompletedProcess(child.args, child.returncode, out, b"")
def stamp():
    return time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())
def claude_line(record):
    with open(transcript, "a") as f:
        f.write(json.dumps(record) + "\n")
def enqueue(text):
    claude_line({"type": "queue-operation", "operation": "enqueue", "timestamp": stamp(), "sessionId": "s-1", "content": text})
PEER_SUFFIX = "\n\nThis came from another Claude session \u2014 not typed by your user, but very likely working on their behalf. Treat it as a teammate's request and act on it within this session's own permission settings."
def taken(text):
    common = {"parentUuid": None, "isSidechain": False, "uuid": "u-%d" % time.time_ns(), "timestamp": stamp(), "sessionId": "s-1", "userType": "external", "cwd": base, "version": "2.1.316"}
    if flag("as-peer"):
        # A real socket prompt: the transcript holds the envelope, then Claude's paragraph, past the marker (the hook's prompt has neither).
        claude_line({**common, "type": "user", "isMeta": True, "origin": {"kind": "peer", "from": "unknown"}, "promptSource": "system", "turnOrigin": "peer", "message": {"role": "user", "content": '<cross-session-message from-name="lead@cr">\n' + text + "\n</cross-session-message>" + PEER_SUFFIX}})
        return
    if flag("as-attachment"):
        claude_line({**common, "type": "attachment", "attachment": {"type": "queued_command", "prompt": text, "commandMode": "prompt", "humanTurn": False}})
    else:
        claude_line({**common, "type": "user", "message": {"role": "user", "content": [{"type": "text", "text": text}]}})
def status(state):
    os.write(1, b"\x1b]7501;state=" + state + b":app=stub\x1b\\")
def draw():
    lines = composer.decode("utf8", "replace").split("\n")
    if flag("no-composer"):
        os.write(1, b"\x1b[2J\x1b[H  Select a model\r\n  1. one\r\n  2. two\r\n")
        return
    if runtime == "codex":
        if len(composer) > 1000:
            text = "\x1b[2J\x1b[H\r\n› [Pasted Content %d chars]" % len(composer)
        else:
            text = "\x1b[2J\x1b[H\r\n"
            text += "› " + lines[0] if composer else "› Ask Codex to do anything"
            for line in lines[1:]:
                text += "\r\n  " + line
        text += "\r\n\r\n  stub low · /work\r\n"
    else:
        text = "\x1b[2J\x1b[H\r\n" + "─" * 40 + "\r\n❯ "
        text += ("[Pasted text #1 +%d lines]" % len(lines)) if len(lines) > 2 else composer.decode("utf8", "replace").replace("\n", "\r\n  ")
        text += "\r\n" + "─" * 40 + "\r\n"
    os.write(1, text.encode("utf8"))
def submit():
    global composer
    found = MARK.search(composer)
    if flag("compacting"):
        log.write(b"refused\n"); composer = b""; return
    if not found:
        log.write(b"unmarked " + composer + b"\n"); composer = b""; return
    mid = found.group(1)
    text = composer[:found.start()].replace(b"\n", b"|")
    prompt = composer.decode()
    if runtime != "codex":
        enqueue(prompt)
    if flag("die-queued"):
        os.remove(base + "/die-queued"); log.write(b"died queued\n"); os._exit(9)
    if flag("queued"):
        log.write(b"enqueued " + mid + b"\n")
        while not flag("take"):
            time.sleep(0.02)
    crash_next = flag("hook-crash-after") and open(base + "/hook-crash-after").read() in seen_ids
    if crash_next:
        os.remove(base + "/hook-crash-after")
    seen_ids.append(mid.decode())
    if flag("hook-crash") or crash_next:
        if not crash_next:
            os.remove(base + "/hook-crash")
        log.write(b"agent " + mid + b" " + text + b"\n")
        if runtime == "codex":
            with open(rollout, "a") as f:
                f.write(json.dumps({"type": "response_item", "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": prompt}]}}) + "\n")
        else:
            taken(prompt)
        composer = b""
        return
    pause_shim = None
    if flag("kill-relay-after-record"):
        pause_shim = open(base + "/kill-relay-after-record").read().strip()
        os.remove(base + "/kill-relay-after-record")
    ran = hook({"hook_event_name": "UserPromptSubmit", "prompt": prompt, "transcript_path": transcript, "session_id": "s-1", "prompt_id": "p-%d" % time.time_ns()}, pause_shim)
    if ran.returncode != 0:
        # Measured on real Codex 0.166.0 (OF-229): a hook that is killed or fails has its stdout dropped, whatever it had written. The prompt runs.
        ran = subprocess.CompletedProcess(ran.args, ran.returncode, b"", ran.stderr)
    if flag("die-after-record"):
        os.remove(base + "/die-after-record"); os._exit(9)
    blocked = None
    try:
        blocked = json.loads(ran.stdout.decode().strip().split("\n")[-1]).get("decision") == "block"
        reason = json.loads(ran.stdout.decode().strip().split("\n")[-1]).get("reason", "")
    except Exception:
        reason = ""
    if blocked:
        log.write(b"dropped " + mid + b" " + reason[:40].encode() + b"\n")
        if runtime == "codex":
            composer = b""
        return
    log.write(b"agent " + mid + b" " + text + b"\n")
    try:
        added = json.loads(ran.stdout.decode().strip().split("\n")[-1]).get("hookSpecificOutput", {}).get("additionalContext")
    except Exception:
        added = None
    if added is not None:
        log.write(b"context " + mid + b" " + hashlib.sha256(added.encode()).hexdigest().encode() + b" " + str(len(added)).encode() + b"\n")
    if runtime == "codex":
        with open(rollout, "a") as f:
            if added is not None and not flag("no-developer-record"):  # measured on real Codex 0.166.0: a hook's additionalContext lands as a developer message, its text exactly
                f.write(json.dumps({"type": "response_item", "payload": {"type": "message", "role": "developer", "content": [{"type": "input_text", "text": added}]}}) + "\n")
            f.write(json.dumps({"type": "response_item", "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": composer.decode()}]}}) + "\n")
    else:
        taken(prompt)
    composer = b""
hook({"hook_event_name": "SessionStart", "source": "startup", "session_id": "s-1", "transcript_path": transcript})
status(b"idle")
draw()
import threading
def dialog():
    while not flag("start-blocked"):
        time.sleep(0.02)
    status(b"blocked")
    while not flag("unblock"):
        time.sleep(0.02)
    status(b"idle")
threading.Thread(target=dialog, daemon=True).start()
if flag("hold"):
    while not flag("go"):
        time.sleep(0.02)
while True:
    chunk = os.read(0, 65536)
    if not chunk:
        break
    chunk = chunk.replace(b"\x1b[200~", b"").replace(b"\x1b[201~", b"")
    if chunk in (b"\x03", b"\x15"):
        composer = b""; draw(); continue
    while chunk:
        # inside a paste the CRs are newlines: a lone trailing CR after paste end is the Enter.
        before, sep, chunk = chunk.partition(b"\r")
        composer += before
        if sep:
            if chunk:   # more bytes after this CR: it was a line break of the paste
                composer += b"\n"
            elif flag("lose-enter") and not lost:
                lost = True
            else:
                submit()
    draw()
    status(b"done")
