"""Run a command on a pseudo-terminal the way a tmux pane does, and hang it up the way `tmux kill-session` does.

usage: pty-hangup.py <output-file> <status-file> <command> [args...]

- The command's stdin/stdout/stderr are the pty slave. Everything it prints is appended to <output-file>; this
  process's own stdin is forwarded to the pty, so a test can type into the "pane".
- On SIGUSR1 the pty MASTER is closed and the command is sent SIGHUP: the order tmux uses when it kills a session.
  From then on the command's tty writes fail with EIO.
- When the command ends, <status-file> gets `exit=<n>` or `signal=<n>`.
No tmux and no real pane is involved. Test helper only.
"""
import os
import pty
import select
import signal
import sys

out_path, status_path, *cmd = sys.argv[1:]
pid, fd = pty.fork()
if pid == 0:
    os.execvp(cmd[0], cmd)

hangup = False


def on_usr1(*_args):
    global hangup
    hangup = True


signal.signal(signal.SIGUSR1, on_usr1)
out = open(out_path, "ab", buffering=0)
stdin_open = True
while not hangup:
    watch = [fd] + ([0] if stdin_open else [])
    try:
        ready, _, _ = select.select(watch, [], [], 0.05)
    except InterruptedError:
        continue
    if fd in ready:
        try:
            data = os.read(fd, 65536)
        except OSError:
            break
        if not data:
            break
        out.write(data)
    if 0 in ready:
        data = os.read(0, 65536)
        if not data:
            stdin_open = False
        else:
            os.write(fd, data)

if hangup:
    os.close(fd)
    os.kill(pid, signal.SIGHUP)

_, status = os.waitpid(pid, 0)
with open(status_path, "w") as f:
    f.write(f"exit={os.WEXITSTATUS(status)}" if os.WIFEXITED(status) else f"signal={os.WTERMSIG(status)}")
