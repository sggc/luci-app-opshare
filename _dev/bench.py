"""Quantify what the plugin actually costs, before and after an upgrade.

Three independent readings, because each answers a different question:

  * whole-box busy %   - does the router feel busier? (includes everything)
  * plugin CPU time    - jiffies burned by opshare-sync itself, from /proc
  * RSS / tmpfs        - how much RAM and RAM-disk the plugin holds

Usage:
  python _dev/bench.py <host> <seconds> [poll_seconds] [label]

poll_seconds = 0 keeps the page closed (idle profile); anything else drives
the live endpoint at that cadence, which is what an open browser does.
"""
import json
import os
import subprocess
import sys
import threading
import time
import urllib.request

# A desktop-wide proxy would swallow requests to 192.168.x.x and silently turn
# the "watch" run into an idle run, so the local opener never uses one.
for _k in ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY",
           "all_proxy", "ALL_PROXY"):
    os.environ.pop(_k, None)
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))

HOST = sys.argv[1]
WIN = int(sys.argv[2])
POLL = int(sys.argv[3] or 0)
LABEL = sys.argv[4] if len(sys.argv) > 4 else ""
TOKEN = "ops3beb03fd7226"
PW = {"192.168.1.1": "password", "192.168.10.1": "wangjunqi123"}[HOST]
JUMP = HOST == "192.168.10.1"
CONN = "192.168.1.1" if JUMP else HOST
CONN_PW = "password" if JUMP else PW   # the jump host has its own password

HZ = 100.0          # OpenWrt userland HZ on MIPS/ARM is 100
CORES = 4


def sh(cmd, timeout=600):
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


# One remote shell loop does all the sampling. The loop itself must stay cheap:
# a single awk per sample reading every file at once, and a 5 s period, so the
# observer costs well under 0.2 % and the numbers stay honest.
SAMPLER = r"""
N=%d
P=$(pidof opshare-sync)
FILES="/proc/stat /proc/meminfo /proc/[0-9]*/stat"
for p in $P; do FILES="$FILES /proc/$p/status"; done
T0=$(du -sk /tmp/opshare 2>/dev/null | awk '{print $1}')
i=0
while [ $i -lt $N ]; do
  awk '
    FILENAME=="/proc/stat" && /^cpu /{ b=$2+$3+$4+$7+$8; t=$2+$3+$4+$5+$6+$7+$8 }
    FILENAME=="/proc/meminfo" && /^MemAvailable/{ m=$2 }
    FILENAME ~ /\/status$/ && /^VmRSS/{ rss+=$2 }
    FILENAME ~ /^\/proc\/[0-9]+\/stat$/ {
      c = $2; gsub(/[()]/, "", c)
      # utime+stime is what the process itself burned; cutime+cstime is what
      # its already-reaped children burned. opshare-traffic and
      # opshare-collect are both children of the daemon, so leaving the latter
      # out would under-report by two thirds. uhttpd is deliberately NOT
      # counted: its cutime includes every LuCI page and unrelated CGI.
      if (c == "opshare-sync")    { js += $14+$15; jf += $14+$15+$16+$17 }

    }
    END { printf "%%d %%d %%d %%d %%d %%d\n", b, t, js, jf, rss, m }
  ' $FILES
  i=$((i+1))
  sleep 5
done
T1=$(du -sk /tmp/opshare 2>/dev/null | awk '{print $1}')
echo "TMPFS $T0 $T1"
""" % max(3, WIN // 5)

stop = False
polls = [0]


def poller():
    url = "http://%s/cgi-bin/opshare?t=%s&a=live" % (HOST, TOKEN)
    if JUMP:
        # One long-lived SSH session running the loop on the far side: opening
        # a new session every few seconds would cost the AP more CPU (dropbear
        # fork + key exchange) than the page itself does, which is exactly what
        # we are trying to measure.
        sh("i=0; while [ $i -lt %d ]; do wget -q -O /dev/null '%s'; "
           "i=$((i+1)); sleep %d; done" % (max(1, WIN // POLL) + 2,
                                            "http://192.168.10.1/cgi-bin/opshare"
                                            "?t=%s&a=live" % TOKEN, POLL),
           timeout=WIN + 60)
        polls[0] = max(1, WIN // POLL)
        return
    while not stop:
        try:
            OPENER.open(url, timeout=5).read()
            polls[0] += 1
        except Exception as e:
            if polls[0] == 0:
                print("poll error:", type(e).__name__, e, file=sys.stderr)
        time.sleep(POLL)


# The poller has to be running before the blocking sampler starts, otherwise
# the "watched" run is really an idle run with a confusing label.
if POLL:
    threading.Thread(target=poller, daemon=True).start()

# warm-up sample so the first diff is not polluted by a cold cache
sh("cat /proc/uptime >/dev/null")
raw = sh(SAMPLER, timeout=WIN + 90)
stop = True
tmpfs = 0
rows = []
for line in raw.strip().splitlines():
    f = line.split()
    if f and f[0] == "TMPFS" and len(f) >= 3:
        tmpfs = max(int(f[1] or 0), int(f[2] or 0))
    elif len(f) >= 5:
        rows.append(f)
if len(rows) < 3:
    print("not enough samples:", raw[:200])
    sys.exit(1)

b0, t0, js0, jf0 = (int(rows[0][i]) for i in range(4))
b1, t1, js1, jf1 = (int(rows[-1][i]) for i in range(4))
rss = max(int(r[4]) for r in rows)
free = [int(r[5]) for r in rows]
secs = 5 * max(1, len(rows) - 1)

dbusy = b1 - b0
dtot = max(1, t1 - t0)
box = dbusy / dtot * 100
own = (js1 - js0) / HZ / secs * 100        # sync's own threads, % of one core
family = (jf1 - jf0) / HZ / secs * 100     # + reaped children + CGI, % of one core
rss_kb = rss
free_drop = max(free) - min(free)

print(json.dumps({
    "label": LABEL, "host": HOST, "win": secs, "poll": POLL, "polls": polls[0],
    "box_busy_pct": round(box, 2),
    "own_cpu_one_core_pct": round(own, 2),
    "own_cpu_of_4_pct": round(own / CORES, 2),
    "family_cpu_one_core_pct": round(family, 2),
    "family_cpu_of_4_pct": round(family / CORES, 2),
    "sync_rss_kb": rss_kb,
    "tmpfs_kb": tmpfs,
    "memfree_delta_kb": free_drop,
}, ensure_ascii=False))
