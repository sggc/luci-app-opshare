"""Measure aggregate CPU busy % over a window while (optionally) polling the
page's live endpoint, so the cost of the precision profile is a real number."""
import subprocess, sys, threading, time, json, urllib.request

HOST = sys.argv[1]; WIN = int(sys.argv[2]); POLL = int(sys.argv[3] or 0)
TOKEN = "ops3beb03fd7226"
PW = {"192.168.1.1": "password", "192.168.10.1": "wangjunqi123"}[HOST]
# the AP only accepts key auth from the hub, so hop through it
JUMP = HOST == "192.168.10.1"
CONN = "192.168.1.1" if JUMP else HOST

def sh(cmd):
    import paramiko
    if JUMP:
        inner = cmd.replace("'", "'\\''")
        cmd = "ssh -y -q -i /etc/opshare/id_dropbear root@192.168.10.1 '" + inner + "'"
    c = paramiko.SSHClient(); c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(CONN, username="root", password="password", timeout=10, allow_agent=False, look_for_keys=False)
    try:
        _, o, _ = c.exec_command(cmd, timeout=WIN + 30)
        return o.read().decode()
    finally:
        c.close()

def snap():
    out = sh("awk '/^cpu /{print $2,$3,$4,$5,$6,$7,$8}' /proc/stat") or "0 0 0 0 0 0 0"
    v = [int(x) for x in out.split()]
    return sum(v[:3]) + v[4] + v[5] + v[6], sum(v)   # busy (incl iowait/irq/softirq), total

stop = False
def poller():
    while not stop:
        try:
            urllib.request.urlopen("http://%s/cgi-bin/opshare?t=%s&a=live" % (HOST, TOKEN), timeout=5).read()
        except Exception as e:
            print("poll fail", e)
        time.sleep(POLL)

b1, t1 = snap()
th = None
if POLL:
    th = threading.Thread(target=poller, daemon=True); th.start()
time.sleep(WIN)
stop = True
b2, t2 = snap()
busy = (b2 - b1) / max(1, t2 - t1) * 100
print("%s  win=%ds poll=%ss  busy=%.1f%% of %d cores  (%.2f%% per core)"
      % (HOST, WIN, POLL, busy, 4, busy / 4))
