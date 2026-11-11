"""Runs a command in a real pseudo-terminal (no tmux), presses keys, and records every byte it writes.

    python3 pty-record.py <out-prefix> <cols> <rows> '<steps json>' <command...>

Steps: [{"keys": "c", "wait": 1.5, "mark": "c2pa"}, ...]. Keys are sent, output is collected for `wait` seconds, and
when `mark` is set the byte offset is recorded under that name. Writes <out-prefix>.bin (the stream) and
<out-prefix>.json ({name: offset}). The environment is inherited, so the caller decides TERM, HOME, IMGWAND_GRAPHICS.
Used by run.ts to screenshot what imgwand draws directly in a terminal (inline images, which tmux captures cannot show).
"""
import fcntl
import json
import os
import pty
import select
import struct
import sys
import termios
import time

prefix, cols, rows, steps_json, *command = sys.argv[1:]
cols, rows = int(cols), int(rows)
steps = json.loads(steps_json)

pid, fd = pty.fork()
if pid == 0:
    os.execvp(command[0], command)

fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
stream = bytearray()
marks = {}


def pump(seconds):
    end = time.time() + seconds
    while time.time() < end:
        ready, _, _ = select.select([fd], [], [], 0.05)
        if not ready:
            continue
        try:
            data = os.read(fd, 65536)
        except OSError:
            return
        if not data:
            return
        stream.extend(data)


for step in steps:
    if step.get("keys"):
        os.write(fd, step["keys"].encode())
    pump(float(step.get("wait", 1.5)))
    if step.get("mark"):
        marks[step["mark"]] = len(stream)

try:
    os.write(fd, b"\x03")  # Ctrl+C quits imgwand from any screen
    pump(1.0)
except OSError:
    pass
with open(prefix + ".bin", "wb") as f:
    f.write(bytes(stream))
with open(prefix + ".json", "w") as f:
    json.dump(marks, f)
