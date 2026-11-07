"""Deploy the opshare plugin to the two lab routers and verify it end to end.

Usage:
  python _dev/deploy.py            # full deploy + verify
  python _dev/deploy.py --verify   # verification only
"""
import hashlib
import json
import os
import pathlib
import shlex
import subprocess
import sys
import tempfile
import time

import paramiko

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent
SRC = ROOT / "src"
def load_cfg():
    """Credentials come from _dev/devconf.json (git-ignored) or, preferably,
    from the environment so no password ever lands on disk."""
    p = HERE / "devconf.json"
    if p.exists():
        return json.loads(p.read_text(encoding="utf-8"))
    ac, ap = os.environ.get("OPSHARE_AC_PASS"), os.environ.get("OPSHARE_AP_PASS")
    if not (ac and ap):
        raise SystemExit("需要 _dev/devconf.json，或设置 OPSHARE_AC_PASS / OPSHARE_AP_PASS")
    return {
        "ac": {"host": os.environ.get("OPSHARE_AC_HOST", "192.168.1.1"),
               "user": "root", "password": ac},
        "ap": {"host": os.environ.get("OPSHARE_AP_HOST", "192.168.10.1"),
               "user": "root", "password": ap},
    }


CFG = load_cfg()
TOKEN = "ops" + hashlib.md5(b"ac+ap-share").hexdigest()[:12]

SSH_OPTS = [
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=no",
    "-o", "UserKnownHostsFile=/dev/null",
    "-o", "LogLevel=ERROR",
]
SKIP = {"etc/config/opshare"}


def ac_conn():
    c = CFG["ac"]
    cli = paramiko.SSHClient()
    cli._host_keys = paramiko.HostKeys()
    cli.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    cli.connect(c["host"], username="root", password=c["password"],
                timeout=10, look_for_keys=False, allow_agent=False)
    return cli


def run(dev, cmd, timeout=120):
    if dev == "ac":
        cli = ac_conn()
        try:
            _, out, err = cli.exec_command(cmd, timeout=timeout)
            text = out.read().decode("utf-8", "replace")
            rc = out.channel.recv_exit_status()
            return rc, text, err.read().decode("utf-8", "replace")
        finally:
            cli.close()
    host = "root@" + CFG["ap"]["host"]
    r = subprocess.run(["ssh", *SSH_OPTS, host, cmd],
                       capture_output=True, timeout=timeout)
    return (r.returncode, r.stdout.decode("utf-8", "replace"),
            r.stderr.decode("utf-8", "replace"))


def stream(dev, data, remote, mode=0o644):
    remote = "/" + remote.lstrip("/")
    q = shlex.quote(remote)
    if dev == "ac":
        cli = ac_conn()
        try:
            stdin, out, err = cli.exec_command("cat > " + q, timeout=60)
            stdin.write(data)
            stdin.channel.shutdown_write()
            rc = out.channel.recv_exit_status()
            if rc:
                raise RuntimeError("push failed: " + err.read().decode("utf-8", "replace"))
        finally:
            cli.close()
    else:
        host = "root@" + CFG["ap"]["host"]
        r = subprocess.run(["ssh", *SSH_OPTS, host, "cat > " + q],
                           input=data, capture_output=True, timeout=60)
        if r.returncode:
            raise RuntimeError("push failed: " + r.stderr.decode("utf-8", "replace"))
    run(dev, "chmod %o %s" % (mode, q))


def push_file(dev, path):
    rel = path.relative_to(SRC).as_posix()
    data = path.read_bytes().replace(b"\r\n", b"\n")
    mode = 0o755 if rel.startswith(("usr/bin/", "etc/init.d/", "www/cgi-bin/",
                                    "usr/libexec/rpcd/")) else 0o644
    stream(dev, data, rel, mode)


# No hardcoded display names and no hardcoded master/slave wording: names fall
# back to each device's hostname, roles are explicit UCI settings.
AC_CONF = """config opshare 'main'
\toption enabled '1'
\toption mode 'auto'
\toption role 'auto'
\toption name ''
\toption color ''
\toption interval '30'
\toption yield_sec '1'
\toption traffic_interval '10'
\toption fast_traffic_interval '2'
\toption fast_interval '12'
\toption watch_ttl '45'
\toption live_ms '2000'
\toption cache_ttl '20'
\toption force_throttle '10'
\toption session_grace '60'
\toption stale_after '300'
\toption detail_level 'full'
\toption key '/etc/opshare/id_dropbear'
\toption token '%s'
\toption timeout '8'
\toption public_data '0'
\toption refresh_ms '10000'
\toption show_offline '1'
\toption realtime '0'
\toption traffic_enable '1'
\toption hub_host ''
\toption hub_token ''
\toption auto_pair '1'
\toption power_profile 'auto'
\toption hub_transport 'http'

config peer 'immortalwrt'
\toption enabled '1'
\toption name ''
\toption role 'auto'
\toption color ''
\toption host '192.168.10.1'
\toption user 'root'
\toption port '22'
\toption transport 'ssh'
\toption push '1'
""" % TOKEN

AP_CONF = """config opshare 'main'
\toption enabled '1'
\toption mode 'auto'
\toption role 'auto'
\toption name ''
\toption color ''
\toption interval '30'
\toption yield_sec '1'
\toption traffic_interval '10'
\toption fast_traffic_interval '2'
\toption fast_interval '12'
\toption watch_ttl '45'
\toption live_ms '2000'
\toption cache_ttl '20'
\toption force_throttle '10'
\toption session_grace '60'
\toption stale_after '300'
\toption detail_level 'full'
\toption key '/etc/opshare/id_dropbear'
\toption token '%s'
\toption timeout '8'
\toption public_data '0'
\toption refresh_ms '10000'
\toption show_offline '1'
\toption realtime '0'
\toption traffic_enable '1'
\toption hub_host ''
\toption hub_token ''
\toption auto_pair '1'
\toption power_profile 'auto'
\toption hub_transport 'http'
""" % TOKEN

SETUP_AC = """
mkdir -p /etc/opshare /tmp/opshare/cache /tmp/opshare/nodes /tmp/opshare/traffic /www/opshare
if [ ! -s /etc/opshare/id_dropbear ] && command -v dropbearkey >/dev/null; then
  dropbearkey -t ed25519 -f /etc/opshare/id_dropbear >/dev/null 2>&1
  chmod 600 /etc/opshare/id_dropbear
fi
dropbearkey -y -f /etc/opshare/id_dropbear 2>/dev/null | grep '^ssh-' > /etc/opshare/id_dropbear.pub
cat /etc/opshare/id_dropbear.pub
"""


def deploy():
    files = sorted(p for p in SRC.rglob("*") if p.is_file()
                   and p.relative_to(SRC).as_posix() not in SKIP)
    print("==> pushing %d files" % len(files))
    for dev in ("ac", "ap"):
        run(dev, "mkdir -p /usr/bin /etc/init.d /etc/config /etc/opshare "
                 "/www/cgi-bin /www/opshare /usr/share/luci/menu.d "
                 "/usr/share/ucode/luci/controller /usr/lib/lua/luci/controller "
                 "/usr/lib/lua/luci/view/opshare "
                 "/www/luci-static/resources/view/opshare /tmp/opshare/cache "
                 "/tmp/opshare/nodes /tmp/opshare/traffic")
        for p in files:
            push_file(dev, p)
        print("    %s: files pushed" % dev)

    print("==> writing configuration")
    stream("ac", AC_CONF.encode(), "etc/config/opshare")
    stream("ap", AP_CONF.encode(), "etc/config/opshare")

    print("==> SSH identity")
    rc, pub, err = run("ac", SETUP_AC)
    pub = pub.strip().splitlines()[-1] if pub.strip() else ""
    print("    hub public key:", pub[:60] + ("..." if len(pub) > 60 else ""))
    if pub.startswith("ssh-"):
        cmd = ("mkdir -p /etc/dropbear; touch /etc/dropbear/authorized_keys; "
               "grep -qF '%s' /etc/dropbear/authorized_keys || "
               "printf '%%s opshare@hub\\n' '%s' >> /etc/dropbear/authorized_keys; "
               "chmod 600 /etc/dropbear/authorized_keys" % (pub, pub))
        rc, out, err = run("ap", cmd)
        print("    peer authorized_keys updated (rc=%s)" % rc)

    # Pairing runs before the daemons start so /tmp/opshare/mode already holds
    # the decided role on the very first tick: neither box ever spends a moment
    # aggregating on the wrong side of the link.
    print("==> zero-config pairing")
    # Auto sections are derived state: drop them and let this run rebuild them.
    # A stale `auto_<id>` from a previous identity would otherwise stay behind
    # and show up as a duplicate node in the topology.
    clear_auto = ("for s in $(uci -q show opshare | sed -n 's/^opshare\\.\\(auto_[^.=]*\\)=peer$/\\1/p'); do "
                  "uci -q delete opshare.$s; done; uci -q commit opshare; echo cleared")
    for dev in ("ac", "ap"):
        run(dev, clear_auto)
    for dev in ("ac", "ap"):
        rc, out, err = run(dev, "/usr/bin/opshare-peer 2>&1 | tail -6")
        for line in (out or "").strip().splitlines():
            print("    %s: %s" % (dev, line))
    for dev in ("ac", "ap"):
        rc, out, err = run(dev, "cat /tmp/opshare/mode /tmp/opshare/power 2>/dev/null | tr '\n' ' '")
        print("    %s: mode/power = %s" % (dev, (out or "").strip()))

    print("==> starting services")
    for dev in ("ac", "ap"):
        run(dev, "rm -f /tmp/opshare/self.json /tmp/opshare/all.json "
                 "/tmp/opshare/cache/* /tmp/opshare/nodes/* "
                 "/tmp/opshare/traffic/* /tmp/opshare/traffic.state* /tmp/opshare/traffic.snap* "
                 "/tmp/opshare/sessions.state /tmp/opshare/self.ts "
                 "/tmp/luci-indexcache.* /tmp/luci-modulecache.* "
                 "/tmp/luci-*.json 2>/dev/null; "
                 "/etc/init.d/rpcd restart >/dev/null 2>&1; "
                 "/etc/init.d/opshare enable >/dev/null 2>&1; "
                 "/etc/init.d/opshare restart >/dev/null 2>&1; echo started")
    run("ac", "OP_SHARE_FORCE=1 /usr/bin/opshare-sync --once >/dev/null 2>&1; echo seeded")
    print("    done")


def check(name, ok, detail=""):
    print(("    [OK]   " if ok else "    [FAIL] ") + name + (" " + detail if detail else ""))
    return ok


def collect_check(dev):
    rc, out, err = run(dev, "OP_SHARE_FORCE=1 /usr/bin/opshare-collect")
    try:
        d = json.loads(out)
    except Exception as e:
        check("%s collect" % dev, False, "bad json %s / %s" % (e, err[:120]))
        return None
    n = d.get("node") or {}
    clients = d.get("clients") or []
    wired = [c for c in clients if c.get("type") == "wired"]
    with_port = [c for c in wired if c.get("port") or c.get("port_speed")]
    with_v6 = [c for c in clients if c.get("ipv6")]
    ghost = [c for c in clients if "iqoo" in str(c.get("hostname") or "").lower()
             and c.get("type") == "wired"]
    check("%s collect v2" % dev, d.get("schema") == 2,
          "%s / role=%s / dhcp=%s / clients=%d / traffic=%d / v6=%d / wired_with_port=%d" %
          (n.get("hostname"), n.get("role"), n.get("dhcp"), len(clients),
           len(d.get("traffic") or []), len(with_v6), len(with_port)))
    check("%s IPv6 采集" % dev,
          bool(n.get("lan_ipv6") or n.get("wan_ipv6") or with_v6),
          "lan=%s wan=%s clients_with_v6=%d" %
          (n.get("lan_ipv6"), n.get("wan_ipv6"), len(with_v6)))
    check("%s ghost client" % dev, all(c.get("online") == 0 for c in ghost),
          "stale-lease rows=%d online=%s" % (len(ghost), [c.get("online") for c in ghost]))
    legal = {5, 10, 20, 40, 80, 160, 320}
    badmhz = [(c.get("hostname"), c.get("rx_mhz"), c.get("tx_mhz")) for c in clients
              if any(k in c and c[k] not in legal for k in ("rx_mhz", "tx_mhz"))]
    check("%s channel width sanitised" % dev, not badmhz, "bad=%s" % (badmhz[:3],))
    assoc = [c for c in clients if c.get("source") != "wired"
             and isinstance(c.get("signal"), (int, float)) and c["signal"] < 0]
    # A node may legitimately have no wireless clients at all (phones roamed
    # elsewhere), so only assert that any PRESENT association stays online.
    check("%s associated wifi stays online (no inactive-ms false offline)" % dev,
          all(c.get("online") == 1 for c in assoc)
          and all("长时间无活动" not in str(c.get("reason") or "") for c in clients),
          "associated=%d online=%s reasons=%s" %
          (len(assoc), [c.get("online") for c in assoc],
           sorted(set(str(c.get("reason") or "-") for c in clients))))
    check("%s free role + neutral suggestion" % dev,
          bool(n.get("role")) and bool(n.get("role_basis")) and
          bool(n.get("suggested_role")) and n.get("role_source") in ("auto", "config"),
          "role=%s source=%s suggested=%s" %
          (n.get("role"), n.get("role_source"), n.get("suggested_role")))
    sessions = [c for c in clients if c.get("online") == 1 and "connected_time" in c]
    check("%s session tracking" % dev,
          bool(sessions) and n.get("session_grace") == 60,
          "grace=%s tracked=%d sample=%s" %
          (n.get("session_grace"), len(sessions),
           sessions[0].get("connected_time") if sessions else "-"))
    tr = d.get("traffic") or []
    modern = bool(tr) and all(
        all(k in t for k in ("rx_total", "tx_total", "rx_delta", "tx_delta",
                             "ts", "prev_ts", "dt", "state")) for t in tr)
    legacy = any(("rx_bps" in t or "mean_rx" in t or "r" in t) for t in tr)
    check("%s traffic v5 (totals + delta, no bps/chart)" % dev, modern and not legacy,
          "ifaces=%d states=%s sample=%s" %
          (len(tr), sorted(set(str(t.get("state")) for t in tr)),
           ("%s Δrx=%s Δtx=%s %ss" % (tr[0].get("ifname"), tr[0].get("rx_delta"),
                                      tr[0].get("tx_delta"), tr[0].get("dt"))) if tr else "-"))
    return d


def luci_check(host, password, label, hub=True):
    jar = tempfile.mktemp(prefix="opshare-cj-")
    base = "http://%s/cgi-bin/luci" % host
    try:
        subprocess.run(["curl", "-s", "--max-time", "10", "-c", jar, "-b", jar,
                        "-d", "luci_username=root&luci_password=" + password,
                        base, "-o", os.devnull], capture_output=True)
        r = subprocess.run(["curl", "-s", "--max-time", "10", "-b", jar,
                            "-w", "\n%{http_code}", base + "/admin/status/opshare/data"],
                           capture_output=True, text=True)
        parts = r.stdout.rsplit("\n", 1)
        code = parts[-1].strip() if len(parts) > 1 else "?"
        ok = code == "200" and parts[0].strip().startswith("{")
        check("%s LuCI data endpoint" % label, ok, "http=%s bytes=%d" % (code, len(parts[0])))
        r = subprocess.run(["curl", "-s", "--max-time", "10", "-b", jar,
                            "-w", "\n%{http_code}", base + "/admin/status/opshare/live"],
                           capture_output=True, text=True)
        parts = r.stdout.rsplit("\n", 1)
        code = parts[-1].strip() if len(parts) > 1 else "?"
        try:
            blob = json.loads(parts[0])
        except Exception:
            blob = {}
        check("%s LuCI live endpoint" % label,
              code == "200" and blob.get("schema") == 1 and blob.get("nodes"),
              "http=%s nodes=%d bytes=%d" % (code, len(blob.get("nodes") or []), len(parts[0])))
        def forced_data():
            q = subprocess.run(["curl", "-s", "--max-time", "20", "-b", jar,
                                base + "/admin/status/opshare/data?sync=1"],
                               capture_output=True, text=True)
            try:
                return json.loads(q.stdout).get("updated", 0)
            except Exception:
                return 0

        if hub:
            t1 = forced_data()
            time.sleep(11)  # force_throttle = 10 s
            t2 = forced_data()
            check("%s refresh (sync=1) 真正触发采集" % label,
                  t1 > 0 and t2 > t1, "updated %s -> %s" % (t1, t2))
        else:
            r = subprocess.run(["curl", "-s", "--max-time", "15", "-b", jar,
                                "-o", os.devnull, "-w", "%{http_code}",
                                base + "/admin/status/opshare/data?sync=1"],
                               capture_output=True, text=True)
            check("%s refresh endpoint" % label, r.stdout.strip() == "200",
                  "http=%s（从节点由主节点推送，不本地采集）" % r.stdout.strip())
        r3 = subprocess.run(["curl", "-s", "--max-time", "10", "-b", jar,
                             base + "/admin/status/opshare"], capture_output=True, text=True)
        check("%s LuCI menu page" % label, "设备总览" in r3.stdout, "")
        bad = subprocess.run(["curl", "-s", "--max-time", "10", "-b", jar,
                              base + "/admin/status/opshare/setrole?section=bad-name&role=x"],
                             capture_output=True, text=True)
        check("%s setrole rejects invalid section" % label,
              '"ok":false' in bad.stdout.replace(" ", ""), bad.stdout.strip()[:80])
        ok = subprocess.run(["curl", "-s", "--max-time", "10", "-b", jar,
                             base + "/admin/status/opshare/setrole?section=main&role=auto"],
                            capture_output=True, text=True)
        check("%s setrole endpoint" % label,
              '"ok":true' in ok.stdout.replace(" ", ""), ok.stdout.strip()[:80])
    finally:
        try:
            os.remove(jar)
        except OSError:
            pass


def verify():
    print("==> verifying")
    for dev in ("ac", "ap"):
        collect_check(dev)

    rc, out, err = run("ac", "OP_SHARE_FORCE=1 /usr/bin/opshare-sync --once; echo SYNC_RC=$?")
    print("    sync:", out.strip()[-160:] or err.strip()[-160:])
    merged_outputs = []
    for dev in ("ac", "ap"):
        rc, out, err = run(dev, "cat /tmp/opshare/all.json")
        merged_outputs.append(out)
        try:
            d = json.loads(out)
            nodes = d.get("nodes") or []
            names = [(x.get("_meta") or {}).get("name") for x in nodes]
            roles = [(x.get("_meta") or {}).get("role") for x in nodes]
            basis = [(x.get("_meta") or {}).get("role_basis") for x in nodes]
            sections = [(x.get("_meta") or {}).get("section") for x in nodes]
            total = sum(len(x.get("clients") or []) for x in nodes)
            traffics = sum(len(x.get("traffic") or []) for x in nodes)
            ui = d.get("ui") or {}
            check("%s merged view v6" % dev,
                  d.get("schema") == 2 and len(nodes) >= 2 and all(basis) and all(sections),
                  "names=%s roles=%s sections=%s topology=%s clients=%d "
                  "traffic_ifaces=%d grace=%s interval=%s yield=%s" %
                  (names, roles, sections, (d.get("meta") or {}).get("topology"),
                   total, traffics, ui.get("session_grace"), ui.get("interval"),
                   ui.get("yield_sec")))
        except Exception as e:
            check("%s merged view" % dev, False, "bad json: %s (%s)" % (e, out[:100]))

    for dev in ("ac", "ap"):
        cmd = ("curl -s -o /dev/null -w '%{http_code}' "
               "'http://127.0.0.1/cgi-bin/opshare?t=" + TOKEN + "&a=collect'; echo; "
               "curl -s -o /dev/null -w '%{http_code}' "
               "'http://127.0.0.1/opshare/index.html'; echo; "
               "curl -s -o /dev/null -w '%{http_code}' "
               "'http://127.0.0.1/cgi-bin/opshare?t=" + TOKEN + "&a=sync'; echo")
        rc, out, err = run(dev, cmd)
        codes = [x for x in out.split() if x.isdigit()]
        check("%s web endpoints [cgi,page,sync]" % dev,
              len(codes) == 3 and codes[0] == "200" and codes[1] == "200",
              str(codes))

    luci_check("192.168.1.1", CFG["ac"]["password"], "AC", True)
    luci_check("192.168.10.1", CFG["ap"]["password"], "AP", False)

    js = (ROOT / "src" / "www" / "opshare" / "app.js").read_text(encoding="utf-8")
    check("frontend v8 (card topology + device wiring + live counter channel)",
          all(k in js for k in ("renderTopology", "topo-card", "topo-shelf", "topo-lane",
                                "topo-flow", "topo-bus", "topo-branch", "topo-spine",
                                "topo-tick", "fmtMhz", "group-off", "bo - ao", "locateRow",
                                "pollLive", "applyLive", "a=live"))
          and "data-topo-q" not in js and "fmtBps" not in js and "sparkline" not in js,
          "wiring=%s live=%s locate=%s offline-sink=%s no-chart=%s" %
          (all(k in js for k in ("topo-bus", "topo-branch", "topo-spine", "topo-tick")),
           "applyLive" in js, "locateRow" in js, "group-off" in js, "sparkline" not in js))

    # ---- zero-config pairing --------------------------------------------------
    peer_src = (ROOT / "src" / "usr" / "bin" / "opshare-peer").read_text(encoding="utf-8")
    check("auto-pairing script present",
          all(k in peer_src for k in ("a=hello", "auto_mode", "desired_mode",
                                      "dhcp.leases", "default")),
          "hello=%s auto=%s leases=%s" % ("a=hello" in peer_src,
                                          "auto_mode" in peer_src,
                                          "dhcp.leases" in peer_src))
    rc, out, err = run("ac", "test -x /usr/bin/opshare-peer && echo yes")
    check("opshare-peer installed and executable", "yes" in (out or ""), repr(err)[:60])
    rc, out, err = run("ac", "test -s /etc/opshare/identity && sed -n 's/^MYID=//p' "
                             "/etc/opshare/identity")
    myid = (out or "").strip()
    check("device identity generated", len(myid) >= 6, myid[:16])

    rc, out, err = run("ac", "curl -s --max-time 5 "
                             "'http://127.0.0.1/cgi-bin/opshare?a=hello'")
    hello = {}
    try:
        hello = json.loads(out or "")
    except Exception:
        hello = {}
    check("pairing handshake answers on AC",
          hello.get("ok") == 1 and bool(hello.get("id")) and bool(hello.get("token"))
          and str(hello.get("pw")) in ("1", "2"),
          str(out)[:90])
    check("handshake echoes our own id",
          hello.get("id") == myid or not myid, "%s vs %s" % (hello.get("id"), myid))

    rc, out, err = run("ac", "uci -q get opshare.main.auto_pair; "
                             "uci -q get opshare.main.power_profile; "
                             "cat /tmp/opshare/power 2>/dev/null")
    vals = (out or "").split()
    check("auto_pair / power_profile readable", len(vals) >= 2, str(vals))

    # ---- pairing must terminate, and must survive a one-way link -------------
    rc, out, err = run("ac", "a=$(cat /proc/uptime); a=${a%% *}; "
                             "/usr/bin/opshare-peer -q >/dev/null 2>&1; "
                             "b=$(cat /proc/uptime); b=${b%% *}; "
                             "echo $a $b")
    try:
        a, b = (float(x) for x in (out or "").split()[:2])
        took = b - a
    except Exception:
        took = 999
    check("pairing finishes within its time budget", took < 15,
          "%.1f s (a LAN full of silent phones must not stall it)" % took)

    rc, out, err = run("ap", "test -s /tmp/opshare/seen && wc -l < /tmp/opshare/seen")
    check("reverse learning records whoever spoke to us", (out or "").strip().isdigit(),
          "seen rows=%s" % (out or "").strip())

    rc, out, err = run("ap", "uci -q get opshare.main.auto_mode; cat /tmp/opshare/power")
    vals = (out or "").split()
    check("low-power box behind a one-way link stays passive",
          len(vals) >= 2 and vals[0] == "off" and vals[1] == "1", str(vals))

    # a stale counter snapshot must be refreshed by the request itself, because
    # an idle low-power box deliberately does not sample on a timer
    rc, out, err = run("ap",
        "awk -F'|' 'BEGIN{OFS=\"|\"}{$7=1;print}' /tmp/opshare/traffic.snap "
        "> /tmp/snap.old 2>/dev/null && mv /tmp/snap.old /tmp/opshare/traffic.snap; "
        "curl -s --max-time 8 'http://127.0.0.1/cgi-bin/opshare?t=%s&a=traffic' "
        ">/dev/null; awk -F'|' 'NR==1{print $7}' /tmp/opshare/traffic.snap" % TOKEN)
    rc2, now, _ = run("ap", "date +%s")
    try:
        age = int(now.strip()) - int((out or "0").strip())
    except Exception:
        age = 999
    check("a stale snapshot is refreshed on demand", 0 <= age <= 6, "age=%s s" % age)

    # ---- fine granularity: the counter channel --------------------------------
    rc, out, err = run("ac", "curl -s --max-time 8 "
                             "'http://127.0.0.1/cgi-bin/opshare?t=%s&a=live'" % TOKEN)
    live_raw = out or ""
    try:
        live = json.loads(live_raw)
    except Exception:
        live = {}
    secs = [nd.get("s") for nd in (live.get("nodes") or [])]
    cads = live.get("cad") or {}
    dts = sorted({row.split("|")[8] for nd in (live.get("nodes") or [])
                  for row in (nd.get("t") or []) if len(row.split("|")) > 8})
    check("live counter payload (%d B, sections=%s, dt=%s)" %
          (len(live_raw or ""), secs, dts),
          live.get("schema") == 1 and "main" in secs and len(secs) >= 2
          and cads.get("t") and cads.get("f"),
          "cad=%s nodes=%d bytes=%d" % (cads, len(secs), len(live_raw or "")))
    check("live payload is small (<= 2 KB for this lab)",
          len(live_raw or "") <= 2048, "%d bytes" % len(live_raw or ""))

    rc, out, _ = run("ac", "ls /tmp/opshare/live/*.snap 2>/dev/null | wc -l; "
                           "cat /tmp/opshare/token 2>/dev/null")
    lines = (out or "").strip().splitlines()
    peer_snaps = lines[0].strip() if lines else "0"
    check("hub polls peer counters over the fast channel", peer_snaps not in ("", "0"),
          "%s peer snapshot(s), token file=%s" % (peer_snaps, (lines[1].strip() if len(lines) > 1 else "-")))

    rc, out, _ = run("ac", "OP_TRAFFIC=1 /usr/bin/opshare-traffic; "
                           "head -1 /tmp/opshare/traffic.snap")
    row = (out or "").strip().splitlines()[-1] if (out or "").strip() else ""
    check("fork-minimal sampler produces a valid row", len(row.split("|")) == 10,
          row or "(empty)")
    def has_ext(raw):
        try:
            return isinstance((json.loads(raw).get("meta") or {}).get("externals"), list)
        except Exception:
            return False
    check("v6 externals field present",
          len(merged_outputs) == 2 and all(has_ext(o) for o in merged_outputs),
          "meta.externals is an array on both nodes")

    for dev in ("ac", "ap"):
        rc, out, err = run(dev,
                           "t0=$(cut -d' ' -f1 /proc/uptime); "
                           "OP_SHARE_FORCE=1 /usr/bin/opshare-collect >/dev/null 2>&1; "
                           "t1=$(cut -d' ' -f1 /proc/uptime); "
                           "awk -v a=\"$t0\" -v b=\"$t1\" 'BEGIN{printf \"%.3f s\", b-a}'")
        print("    %s full collect cost: %s" % (dev, out.strip() or err.strip()[:80]))
    print("==> verification finished")


if __name__ == "__main__":
    if "--verify" not in sys.argv:
        deploy()
    verify()
