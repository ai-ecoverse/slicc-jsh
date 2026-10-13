#!/usr/bin/env python3
"""Run a command on a pseudo-terminal and answer its prompts, expect-style.

    answer-tty.py [--expect REGEX --send TEXT]... -- command [args...]

The command's output is copied to stdout. Each --expect waits (in order) for
REGEX in the output since the previous match, then writes TEXT (with \\n
unescaped) to the terminal. Exits with the command's exit status, or 98 if an
--expect never matched, or 97 on a timeout. test/install/run.sh uses it to
say "yes" to install.sh's /dev/tty questions.
"""
import os
import pty
import re
import select
import sys
import time

TIMEOUT = float(os.environ.get('PTY_TIMEOUT', '600'))


def main(argv):
    pairs = []
    i = 0
    while i < len(argv) and argv[i] != '--':
        if argv[i] != '--expect' or i + 3 >= len(argv) or argv[i + 2] != '--send':
            sys.exit('usage: answer-tty.py [--expect REGEX --send TEXT]... -- command [args...]')
        pairs.append((re.compile(argv[i + 1]), argv[i + 3].replace('\\n', '\n')))
        i += 4
    cmd = argv[i + 1:]
    if not cmd:
        sys.exit('answer-tty.py: no command')

    pid, fd = pty.fork()
    if pid == 0:
        os.execvp(cmd[0], cmd)

    seen = ''
    deadline = time.monotonic() + TIMEOUT
    while True:
        left = deadline - time.monotonic()
        if left <= 0:
            os.kill(pid, 9)
            os.waitpid(pid, 0)
            print('\nanswer-tty.py: timed out', file=sys.stderr)
            return 97
        ready, _, _ = select.select([fd], [], [], min(left, 1.0))
        if not ready:
            continue
        try:
            data = os.read(fd, 4096)
        except OSError:
            data = b''
        if not data:
            break
        sys.stdout.write(data.decode('utf-8', 'replace'))
        sys.stdout.flush()
        seen += data.decode('utf-8', 'replace')
        while pairs:
            m = pairs[0][0].search(seen)
            if not m:
                break
            os.write(fd, pairs[0][1].encode())
            seen = seen[m.end():]
            pairs.pop(0)
    _, status = os.waitpid(pid, 0)
    code = os.waitstatus_to_exitcode(status)
    if pairs:
        print(f'\nanswer-tty.py: never saw {pairs[0][0].pattern!r}', file=sys.stderr)
        return 98
    return code if code >= 0 else 128 - code


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
