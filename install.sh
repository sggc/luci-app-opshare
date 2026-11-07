#!/bin/sh
# opshare installer - run on the target OpenWrt device.
# Copy the whole project folder to the device (e.g. /tmp/opshare-src) and run:
#   sh /tmp/opshare-src/install.sh
#
# It auto-detects: ucode/Lua LuCI, procd vs. cron, dropbear, jshn, uhttpd.
# Existing /etc/config/opshare is preserved.

ROOT=$(cd "$(dirname "$0")" && pwd)
SRC="$ROOT/src"
[ -d "$SRC" ] || { echo "ERROR: src/ not found next to install.sh"; exit 1; }
PATH=/usr/sbin:/usr/bin:/sbin:/bin:$PATH
export PATH

echo "==> opshare installer"
echo "    firmware : $(cat /etc/openwrt_release 2>/dev/null | grep DISTRIB_DESCRIPTION | cut -d= -f2)"
echo "    LuCI     : $([ -d /usr/share/luci/menu.d ] && echo 'ucode/menu.d' || echo 'classic Lua')"
echo "    init     : $([ -x /sbin/procd ] && echo procd || echo 'sysv + cron')"
echo "    jshn     : $([ -r /usr/share/libubox/jshn.sh ] && echo OK || echo MISSING)"

# ---- copy files -----------------------------------------------------------
mkdir -p /usr/bin /etc/init.d /etc/config /www/cgi-bin /www/opshare \
	/www/luci-static/resources/view/opshare /usr/share/luci/menu.d \
	/usr/share/ucode/luci/controller /usr/lib/lua/luci/controller \
	/usr/lib/lua/luci/view/opshare /etc/opshare \
	/usr/libexec/rpcd /usr/share/rpcd/acl.d /usr/share/opshare

(cd "$SRC" && find . -type f | sed 's|^\./||') | while read -r rel; do
	[ -n "$rel" ] || continue
	# never overwrite an existing configuration
	if [ "$rel" = "etc/config/opshare" ] && [ -f /etc/config/opshare ]; then
		echo "    keep existing /etc/config/opshare"
		continue
	fi
	dest="/$rel"
	mkdir -p "$(dirname "$dest")"
	cp "$SRC/$rel" "$dest" || { echo "ERROR copying $rel"; exit 1; }
	# A tree edited on Windows carries CRLF, and a script whose first line is
	# "#!/bin/sh\r" fails with "not found" - the kernel looks for an interpreter
	# named "sh\r" and procd restarts it forever. The package strips this at
	# build time; install.sh copies raw files, so it has to strip them here too.
	sed -i '1s/\r$//' "$dest" 2>/dev/null
	grep -q "$(printf '\r')" "$dest" 2>/dev/null && sed -i 's/\r$//' "$dest" 2>/dev/null
	case "$rel" in
		usr/bin/*|etc/init.d/*|www/cgi-bin/*|usr/libexec/rpcd/*) chmod 755 "$dest" ;;
		*) chmod 644 "$dest" ;;
	esac
done

# ---- environment specific adjustments ------------------------------------
if [ ! -x /sbin/procd ]; then
	# pre-procd releases: use cron instead of the procd init script
	rm -f /etc/init.d/opshare
	touch /etc/crontabs/root
	grep -q 'opshare-sync' /etc/crontabs/root 2>/dev/null || \
		echo '* * * * * /usr/bin/opshare-collect --traffic-only; /usr/bin/opshare-sync --once' >> /etc/crontabs/root
	/etc/init.d/cron restart >/dev/null 2>&1
else
	/etc/init.d/opshare enable >/dev/null 2>&1
fi

# ---- SSH identity ----------------------------------------------------------
if command -v dropbearkey >/dev/null 2>&1; then
	if [ ! -s /etc/opshare/id_dropbear ]; then
		dropbearkey -t ed25519 -f /etc/opshare/id_dropbear >/dev/null 2>&1
	fi
	chmod 600 /etc/opshare/id_dropbear
	dropbearkey -y -f /etc/opshare/id_dropbear 2>/dev/null | grep '^ssh-' \
		> /etc/opshare/id_dropbear.pub
	PUBKEY=$(cat /etc/opshare/id_dropbear.pub 2>/dev/null)
else
	PUBKEY="(dropbearkey unavailable - configure SSH manually)"
fi

# ---- shared secret for the HTTP transport ---------------------------------
TOKEN=$(uci -q get opshare.main.token 2>/dev/null)
if [ -z "$TOKEN" ]; then
	TOKEN=$(head -c 24 /dev/urandom | md5sum | cut -c1-16)
	uci set opshare.main.token="$TOKEN"
	uci commit opshare
fi

# ---- caches / services -----------------------------------------------------
# v5 replaced the 30-point rate ring buffer with a single previous snapshot.
# Drop the old state so the first sample is an explicit baseline.
rm -f /tmp/opshare/traffic.state /tmp/opshare/traffic.snap \
	/tmp/opshare/traffic.state.tmp /tmp/opshare/traffic.snap.tmp 2>/dev/null
rm -f /tmp/luci-indexcache.* /tmp/luci-modulecache.* /tmp/luci-*.json 2>/dev/null
# rpcd re-scans /usr/libexec/rpcd on reload, so the ubus bridge shows up
# without dropping a logged-in LuCI session.
/etc/init.d/rpcd reload >/dev/null 2>&1
sleep 1
ubus list opshare >/dev/null 2>&1 || /etc/init.d/rpcd restart >/dev/null 2>&1
/etc/init.d/opshare restart >/dev/null 2>&1

# ---- first pairing ---------------------------------------------------------
# No need to wait for the 2-minute timer: probe right now, so the peer already
# shows up the first time the page is opened.
if [ -x /usr/bin/opshare-peer ] && [ "$(uci -q get opshare.main.auto_pair 2>/dev/null)" != "0" ]; then
	/usr/bin/opshare-peer -q 2>/dev/null | sed 's/^/    /'
fi

echo
echo "==> installed."
echo "    UI       : LuCI -> Status -> 设备总览   (or http://<router>/opshare/)"
echo "    config   : /etc/config/opshare  (edit peers, then: /etc/init.d/opshare restart)"
echo "    pubkey   : $PUBKEY"
echo "    token    : $TOKEN"
echo
echo "    Zero config: install the same package on the other box. Both sides"
echo "    probe the default gateway and the newest DHCP leases, then pair over"
echo "    plain HTTP within two minutes - nothing else to fill in."
echo "    Optional SSH transport: add the pubkey above to the peer's"
echo "    /etc/dropbear/authorized_keys and set the peer section transport 'ssh'."
echo
if [ "$(uci -q get opshare.main.interval 2>/dev/null)" = "10" ]; then
	echo "    NOTE: interval=10 is the old default (higher CPU). For v5 set"
	echo "          uci set opshare.main.interval=30 ; uci set opshare.main.traffic_interval=10"
fi
echo "    Cadence: counters every fast_traffic_interval=2s while the page is open"
echo "             (traffic_interval=10s when nobody looks), full collection every"
echo "             fast_interval=12s (interval=30s when idle), push every interval."
echo "             The page polls a ~1 KB counter payload, not the whole snapshot."
echo "    Cost   : opshare-traffic is one awk over /proc/net/dev (~35 ms); the full"
echo "             collector is sharded and runs in the background, so it can never"
echo "             block the counter ticker. Measured: +2.4% of a 4-core box while"
echo "             the page is open, at 2 s granularity."
echo "    Traffic: cumulative interface bytes + delta between two snapshots only;"
echo "             no bps, no chart, no history; resets/reboots are flagged."
echo "    Pairing: zero config. Every 2 min each box probes the default gateway"
echo "             and the newest DHCP leases, then pairs over plain HTTP - no IP"
echo "             to type, no SSH key to authorise. The stronger CPU aggregates,"
echo "             the other one goes passive. Bridge and dual NAT both work."
echo "             Off switch: uci set opshare.main.auto_pair=0"
echo "    Power  : power_profile=auto detects MT7621/MT7620/QCA953x class routers"
echo "             and drops to the low-power profile automatically: idle ticks"
echo "             12 s, nothing sampled while no page is open, full collection"
echo "             every 20-45 s, browser polls 3 s."
echo "    Topology: node card -> cable -> bus -> per-medium branch -> per-device tick."
echo "              Plain routers that cannot run this plugin can be declared with"
echo "              'config external' sections (dashed, unmanaged nodes)."
echo "    Want 1 s?  uci set opshare.main.fast_traffic_interval=1 ; uci set opshare.main.live_ms=1000"
echo "    Quieter?   uci set opshare.main.fast_traffic_interval=5 ; uci set opshare.main.fast_interval=20"
