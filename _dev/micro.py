"""Microscopic cost of one unit of work, which explains the macro numbers.

The interesting figure on an 880 MHz MIPS core is not "how much CPU did it
use" but "how often was the core woken up": every wake-up costs a scheduler
round trip, a cache refill and a page of code that has to be re-fetched from
flash. voluntary_ctxt_switches is exactly that count.

Usage: python _dev/micro.py <host> [seconds]
"""
import json
import os
import re
import statistics
import sys
import time
import urllib.request

HOST = sys.argv[1]
WIN = int(sys.argv[2] or 60)
TOKEN = "ops3beb03fd7226"
PW = {"192.168.1.1": "password", "192.168.10.1": "wangjunqi123"}[HOST]
JUMP = HOST == "192.168.10.1"
CONN = "192.168.1.1" if JUMP else HOST
CONN_PW = "password" if JUMP else PW   # the jump host has its own password
HZ = 100.0

for _k in ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY"):
    os.environ.pop(_k, None)
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def sh(cmd, timeout=300):
    import paramiko
    if JUMP:
        inner = cmd.replace("'", "'\\''")
        cmd = "ssh -y -q -i /etc/opshare/id_dropbear root@192.168.10.1 '" + inner + "'"
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(CONN, username="root", password=CONN_PW, timeout=10,
              allow_agent=False, look_for_keys=False)
    try:
        _, o, _ = c.exec_command(cmd, timeout=timeout)
        return o.read().decode("utf-8", "replace")
    finally:
        c.close()


def stat_of(pid):
    out = sh("awk '{print $14+$15, $16+$17}' /proc/%s/stat; "
             "awk '/^voluntary/{v=$2}/^nonvoluntary/{n=$2}END{print v, n}' "
             "/proc/%s/status" % (pid, pid))
    f = out.split()
    if len(f) < 4:
        return None
    return dict(jiffies=int(f[0]), forced=int(f[1]),
                vol=int(f[2]), nonvol=int(f[3]))


# ---- 1. idle wake-up rate --------------------------------------------------
pid = (sh("pidof opshare-sync").split() or [""])[0]
a = stat_of(pid)
time.sleep(WIN)
b = stat_of(pid)
wake = (b["vol"] - a["vol"]) / WIN
forced = (b["nonvol"] - a["nonvol"]) / WIN
cpu = (b["jiffies"] - a["jiffies"]) / HZ / WIN * 100

# ---- 2. one counter sample -------------------------------------------------
# Timing a single invocation from here would also time an SSH handshake, which
# on MIPS costs several hundred ms - far more than the work itself. Instead one
# session runs the command N times and divides, so the handshake is amortised
# down to noise. /proc/uptime gives 10 ms resolution without forking `date`.
BENCH = r"""
a=$(cat /proc/uptime); a=${a%% *}
i=0
while [ $i -lt %d ]; do %s; i=$((i+1)); done
b=$(cat /proc/uptime); b=${b%% *}
echo "$a $b"
"""


def per_run(cmd, n):
    out = sh(BENCH % (n, cmd), timeout=60 + n * 20)
    f = out.split()
    if len(f) < 2:
        return None
    return round((float(f[1]) - float(f[0])) / n * 1000, 1)


traffic_ms = per_run("/usr/bin/opshare-traffic >/dev/null 2>&1", 20)


def cpu_time(cmd):
    """Wall time and pure CPU time of one run. `collect` answers from cache when
    a snapshot exists, so it has to be forced or it measures nothing."""
    fmt = "/usr/bin/time -f 'W=%%e U=%%U S=%%S' %s 2>&1 >/dev/null | tail -1"
    out = sh(fmt % cmd, timeout=120)
    d = dict(re.findall(r"([WUS])=([\d.]+)", out))
    if not d:
        return None, None
    cpu = (float(d.get("U", 0)) + float(d.get("S", 0))) * 1000
    return round(float(d.get("W", 0)) * 1000, 1), round(cpu, 1)


collect_wall_ms, collect_cpu_ms = cpu_time(
    "env OP_SHARE_FORCE=1 /usr/bin/opshare-collect")

# ---- 3. one page hit (CGI round trip, over the real network) ---------------
url = "http://%s/cgi-bin/opshare?t=%s&a=live" % (HOST, TOKEN)
lat = []
size = 0
if JUMP:
    # same trick as above: loop on the far side, one session
    live_ms = per_run("wget -q -O /dev/null '%s'" % url, 10)
    size = int((sh("wget -q -O - '%s' | wc -c" % url, timeout=15) or "0").strip() or 0)
else:
    for _ in range(10):
        try:
            t = time.time()
            size = len(OPENER.open(url, timeout=5).read())
            lat.append((time.time() - t) * 1000)
        except Exception:
            pass
        time.sleep(0.2)
    live_ms = round(statistics.median(lat), 1) if lat else None

print(json.dumps({
    "host": HOST, "win": WIN,
    "wake_per_s": round(wake, 3),
    "forced_wake_per_s": round(forced, 3),
    "sync_cpu_one_core_pct": round(cpu, 2),
    "traffic_ms": traffic_ms, "collect_wall_ms": collect_wall_ms,
    "collect_cpu_ms": collect_cpu_ms,
    "live_ms": live_ms,
    "live_bytes": size,
}, ensure_ascii=False))
