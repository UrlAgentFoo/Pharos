"""
pharos_warm: keeps a Python tool's imports warm inside a warm ship's container.

  serve <script>         imports <script>'s modules once (numpy, scikit-image, ...), then waits on
                         /tmp/pharos-warm.sock; each request forks a child that runs <script> as
                         __main__ with the client's arguments, working folder and stdin/stdout/stderr,
                         so it starts in milliseconds instead of re-importing everything.
  run <script> [args...] asks the server to run <script> with args, streaming its output and
                         exiting with its exit code; without a server it runs <script> itself.

The ship's `warm.start` is `serve`, and its operation commands use `run`, so the same commands
also work in an ordinary (cold) container.
"""

import array
import json
import os
import runpy
import socket
import sys

SOCKET = "/tmp/pharos-warm.sock"


def run_script(script, argv):
    sys.argv = [script, *argv]
    try:
        runpy.run_path(script, run_name="__main__")
    except SystemExit as e:
        return e.code if isinstance(e.code, int) else (0 if e.code is None else 1)
    return 0


def serve(script):
    # import what the script imports, without running its main
    sys.path.insert(0, os.path.dirname(script))
    runpy.run_path(script, run_name="pharos_warm_preload")
    if os.path.exists(SOCKET):
        os.unlink(SOCKET)
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(SOCKET)
    server.listen(8)
    print(f"pharos_warm: {os.path.basename(script)} is warm", flush=True)
    while True:
        conn, _ = server.accept()
        msg, fds, _, _ = socket.recv_fds(conn, 65536, 3)
        request = json.loads(msg)
        pid = os.fork()
        if pid == 0:
            server.close()
            for i, fd in enumerate(fds):
                os.dup2(fd, i)
            os.chdir(request["cwd"])
            code = run_script(request["script"], request["argv"])
            sys.stdout.flush()
            sys.stderr.flush()
            conn.sendall(json.dumps({"exit": code}).encode())
            os._exit(0)
        for fd in fds:
            os.close(fd)
        os.waitpid(pid, 0)
        conn.close()


def run(script, argv):
    client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        client.connect(SOCKET)
    except OSError:
        # no warm server (an ordinary container): just run it here
        sys.exit(run_script(script, argv))
    request = json.dumps({"script": script, "argv": argv, "cwd": os.getcwd()}).encode()
    socket.send_fds(client, [request], [0, 1, 2])
    reply = b""
    while chunk := client.recv(4096):
        reply += chunk
    sys.exit(json.loads(reply or b'{"exit": 1}')["exit"])


if __name__ == "__main__":
    if len(sys.argv) < 3 or sys.argv[1] not in ("serve", "run"):
        sys.exit(__doc__)
    if sys.argv[1] == "serve":
        serve(sys.argv[2])
    else:
        run(sys.argv[2], sys.argv[3:])
