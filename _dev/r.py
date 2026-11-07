"""Dev helper: run commands / push / pull files on the two OpenWrt boxes.

Both boxes run dropbear without an SFTP server, so file transfer is done by
streaming through `cat` over the SSH exec channel (works everywhere).

Usage:
  python r.py <ac|ap> "<shell command>"
  python r.py <ac|ap> --push <local_path> <remote_path>
  python r.py <ac|ap> --pull <remote_path> <local_path>
"""
import json
import pathlib
import shlex
import subprocess
import sys

import paramiko

BASE = pathlib.Path(__file__).parent
CFG = json.loads((BASE / "devconf.json").read_text(encoding="utf-8"))

SSH_OPTS = [
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=no",
    "-o", "UserKnownHostsFile=/dev/null",
    "-o", "LogLevel=ERROR",
]


def ac_connect():
    cfg = CFG["ac"]
    cli = paramiko.SSHClient()
    cli._host_keys = paramiko.HostKeys()
    cli.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    cli.connect(cfg["host"], username="root", password=cfg["password"],
                timeout=10, look_for_keys=False, allow_agent=False)
    return cli


def main():
    key, mode = sys.argv[1], sys.argv[2]
    cfg = CFG[key]
    host = "root@" + cfg["host"]

    if key == "ap":
        if mode == "--push":
            a, b = sys.argv[3], sys.argv[4]
            with open(a, "rb") as f:
                r = subprocess.run(
                    ["ssh", *SSH_OPTS, host, "cat > " + shlex.quote(b)],
                    stdin=f, capture_output=True)
            print(f"pushed {a} -> ap:{b} (rc={r.returncode})")
            if r.returncode:
                sys.stderr.write(r.stderr.decode("utf-8", "replace"))
            sys.exit(r.returncode)
        if mode == "--pull":
            a, b = sys.argv[3], sys.argv[4]
            with open(b, "wb") as f:
                r = subprocess.run(
                    ["ssh", *SSH_OPTS, host, "cat " + shlex.quote(a)],
                    stdout=f, stderr=subprocess.PIPE)
            print(f"pulled ap:{a} -> {b} (rc={r.returncode})")
            if r.returncode:
                sys.stderr.write(r.stderr.decode("utf-8", "replace"))
            sys.exit(r.returncode)
        cmd = " ".join(sys.argv[2:]) if len(sys.argv) > 3 else sys.argv[2]
        r = subprocess.run(["ssh", *SSH_OPTS, host, cmd],
                           capture_output=True, text=True)
        sys.stdout.write(r.stdout)
        if r.stderr.strip():
            sys.stderr.write("[stderr]\n" + r.stderr)
        sys.exit(r.returncode)

    cli = ac_connect()
    try:
        if mode == "--push":
            a, b = sys.argv[3], sys.argv[4]
            data = pathlib.Path(a).read_bytes()
            stdin, out, err = cli.exec_command("cat > " + shlex.quote(b))
            stdin.write(data)
            stdin.channel.shutdown_write()
            rc = out.channel.recv_exit_status()
            print(f"pushed {a} -> ac:{b} (rc={rc})")
            if rc:
                sys.stderr.write(err.read().decode("utf-8", "replace"))
            sys.exit(rc)
        if mode == "--pull":
            a, b = sys.argv[3], sys.argv[4]
            _, out, err = cli.exec_command("cat " + shlex.quote(a))
            data = out.read()
            pathlib.Path(b).write_bytes(data)
            rc = out.channel.recv_exit_status()
            print(f"pulled ac:{a} -> {b} ({len(data)} bytes, rc={rc})")
            sys.exit(rc)
        cmd = " ".join(sys.argv[2:]) if len(sys.argv) > 3 else sys.argv[2]
        _, out, err = cli.exec_command(cmd, timeout=120)
        stdout = out.read().decode("utf-8", "replace")
        stderr = err.read().decode("utf-8", "replace")
        rc = out.channel.recv_exit_status()
        sys.stdout.write(stdout)
        if stderr.strip():
            sys.stderr.write("[stderr]\n" + stderr)
        sys.exit(rc)
    finally:
        cli.close()


if __name__ == "__main__":
    main()
