"""Replace the identifying bits of a captured snapshot before it is committed.

The fixture is what `node _dev/uitest.js` runs against in CI, so it has to stay
structurally identical: same node count, same clients, same ports and bands.
Only MACs, IPs, IPv6 addresses, hostnames and SSIDs are rewritten, and each
original value maps to a stable fake one so cross-references still resolve.
"""
import json
import pathlib
import re
import sys

src = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "_dev/snapshot.json")
data = json.loads(src.read_text(encoding="utf-8"))

macs, ips, v6s, names, ssids = {}, {}, {}, {}, {}


def mac(v):
    if not isinstance(v, str) or not re.fullmatch(r"[0-9a-fA-F:]{17}", v):
        return v
    return macs.setdefault(v.lower(), "02:00:00:%02x:%02x:%02x" % (
        len(macs) // 256, len(macs) % 256, (len(macs) * 7) % 256))


def ip(v):
    if not isinstance(v, str) or not re.fullmatch(r"\d+\.\d+\.\d+\.\d+", v):
        return v
    return ips.setdefault(v, "10.0.%d.%d" % (len(ips) // 200 + 1, len(ips) % 200 + 10))


def v6(v):
    if not isinstance(v, str) or ":" not in v:
        return v
    return v6s.setdefault(v, "fd00::%x" % (len(v6s) + 17))


def name(v):
    if not isinstance(v, str) or not v or "/" in v:
        return v
    return names.setdefault(v, "device-%d" % (len(names) + 1))


def ssid(v):
    if not isinstance(v, str) or not v:
        return v
    return ssids.setdefault(v, "SSID-%d" % (len(ssids) + 1))


def walk(o, key=""):
    if isinstance(o, dict):
        return {k: walk(v, k) for k, v in o.items()}
    if isinstance(o, list):
        return [walk(v, key) for v in o]
    if key in ("mac", "macaddr", "bssid"):
        return mac(o)
    if key in ("ip", "lan_ip", "wan_ip"):
        return ip(o)
    if key in ("ipv6", "lan_ipv6", "wan_ipv6"):
        return v6(o)
    if key in ("ssid",):
        return ssid(o)
    if key in ("hostname", "name") and key != "name":
        return name(o)
    if key == "host":
        return "local" if o == "local" else name(o)
    return o


out = walk(data)
out.setdefault("meta", {})["master"] = "QWRT"
src.write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
print("sanitised %s: %d macs, %d ips, %d v6, %d hostnames, %d ssids"
      % (src, len(macs), len(ips), len(v6s), len(names), len(ssids)))
