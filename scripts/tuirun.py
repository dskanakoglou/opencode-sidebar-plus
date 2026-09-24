"""Drive the OpenCode TUI in a pseudo-terminal and print rendered screens as text.

Used to check the plugin in the real TUI. Needs `pip install pyte`.

usage: python scripts/tuirun.py SCRIPT.json
script: {"cmd": ["opencode", "--standalone", DIR], "cwd": DIR, "env": {...}, "cols": 200, "rows": 50,
         "raw": "optional/path/to/raw-output.log",
         "steps": [["wait", 8], ["keys", "hello\r"], ["until", "TEXT", 60], ["click", "TEXT"], ["dump", "label"]]}

Tip: set env OPENCODE_CLI_CONFIG_CONTENT to a cli.json string to test a config
without touching ~/.config/opencode/cli.json.
"""
import json, os, pty, select, sys, time, signal
import pyte

spec = json.load(open(sys.argv[1]))
cols, rows = spec.get("cols", 180), spec.get("rows", 50)
screen = pyte.Screen(cols, rows)
stream = pyte.ByteStream(screen)
env = dict(os.environ, TERM="xterm-256color", COLUMNS=str(cols), LINES=str(rows), **spec.get("env", {}))

pid, fd = pty.fork()
if pid == 0:
    os.chdir(spec.get("cwd", "."))
    os.execvpe(spec["cmd"][0], spec["cmd"], env)

import fcntl, termios, struct
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
raw = open(spec.get("raw", "/dev/null"), "ab")

def pump(seconds):
    end = time.time() + seconds
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.1)
        if r:
            try:
                data = os.read(fd, 65536)
            except OSError:
                return False
            if not data:
                return False
            raw.write(data)
            # answer cursor-position / device queries so the TUI does not stall
            if b"\x1b[6n" in data:
                os.write(fd, f"\x1b[{screen.cursor.y+1};{screen.cursor.x+1}R".encode())
            stream.feed(data)
    return True

def text():
    return "\n".join(line.rstrip() for line in screen.display)

for step in spec["steps"]:
    kind = step[0]
    if kind == "wait":
        pump(step[1])
    elif kind == "keys":
        for ch in step[1]:
            os.write(fd, ch.encode())
            pump(0.03)
    elif kind == "until":
        end = time.time() + step[2]
        while time.time() < end and step[1] not in text():
            pump(0.5)
        print(f"--- until {step[1]!r}: {'FOUND' if step[1] in text() else 'TIMEOUT'}")
    elif kind == "click":
        # SGR mouse press + release on the first cell of the matching text
        hit = next(((y, line.find(step[1])) for y, line in enumerate(screen.display) if step[1] in line), None)
        print(f"--- click {step[1]!r}: {hit}")
        if hit:
            y, x = hit
            os.write(fd, f"\x1b[<0;{x+1};{y+1}M".encode()); pump(0.05)
            os.write(fd, f"\x1b[<0;{x+1};{y+1}m".encode()); pump(0.5)
    elif kind == "dump":
        print(f"===== {step[1]} =====")
        print(text())
        sys.stdout.flush()

try:
    os.kill(pid, signal.SIGTERM)
    pump(1)
    os.kill(pid, signal.SIGKILL)
except ProcessLookupError:
    pass
