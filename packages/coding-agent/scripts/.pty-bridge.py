"""PTY bridge: run a command on a real pseudo-terminal of a fixed size and
relay bytes between that terminal and this process's stdin/stdout pipes.

macOS `script(1)` refuses a piped stdin ("tcgetattr/ioctl: Operation not
supported on socket"), so a TUI driven from a program needs its own pty. This
is the smallest thing that gives one.

Usage: python3 .pty-bridge.py <rows> <cols> <command> [args...]
"""

import fcntl
import os
import pty
import select
import struct
import sys
import termios

rows = int(sys.argv[1])
cols = int(sys.argv[2])
argv = sys.argv[3:]

pid, fd = pty.fork()
if pid == 0:
    os.environ["TERM"] = os.environ.get("TERM", "xterm-256color")
    os.environ["COLUMNS"] = str(cols)
    os.environ["LINES"] = str(rows)
    os.execvp(argv[0], argv)

fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
stdin_fd = sys.stdin.fileno()
out = sys.stdout.buffer

while True:
    ready, _, _ = select.select([fd, stdin_fd], [], [], 0.2)
    if fd in ready:
        try:
            data = os.read(fd, 65536)
        except OSError:
            break
        if not data:
            break
        out.write(data)
        out.flush()
    if stdin_fd in ready:
        data = os.read(stdin_fd, 65536)
        if not data:
            continue
        os.write(fd, data)
    pid_done, _ = os.waitpid(pid, os.WNOHANG)
    if pid_done == pid:
        try:
            data = os.read(fd, 65536)
            if data:
                out.write(data)
                out.flush()
        except OSError:
            pass
        break
