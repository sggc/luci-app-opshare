#!/bin/sh
# Isolated test of the v5 counter-snapshot logic. The real collector is copied
# with its RUNDIR / /proc paths redirected into a temp directory, so nothing
# on the live router is touched.
T=/tmp/opshare_reset_test
rm -rf "$T"; mkdir -p "$T"
sed -e "s|RUNDIR=/tmp/opshare|RUNDIR=$T|" \
    -e "s|/proc/net/dev|$T/netdev|g" \
    -e "s|/proc/sys/kernel/random/boot_id|$T/boot_id|g" \
    /usr/bin/opshare-collect > "$T/collect"
chmod 755 "$T/collect"
printf 'boot-uuid-A\n' > "$T/boot_id"
printf 'wan\n' > "$T/traffic.ifaces"
printf 'wan|wan\n' > "$T/traffic.kinds"

netdev() {
	printf 'Inter-| Receive | Transmit\n face |bytes |bytes\n  wan: %s 0 0 0 0 0 0 0 %s 0 0 0 0 0 0 0\n' \
		"$1" "$2" > "$T/netdev"
}
step() {
	sleep 1   # realistic >0 second gap between two snapshots
	sh "$T/collect" --traffic-only >/dev/null 2>&1
	printf '%-24s %s\n' "$1" "$(head -1 "$T/traffic.snap" 2>/dev/null)"
}

netdev 1000 2000;     step '1 first sighting'
netdev 1500 2600;     step '2 normal delta'
netdev 100 200;       step '3 counter reset'
netdev 200 300;       step '4 after reset'
printf 'boot-uuid-B\n' > "$T/boot_id"
netdev 400 500;       step '5 reboot'
netdev 4290000000 4290000000; step '6 pre-rollover'
netdev 10000000 10000000;    step '7 32-bit rollover'
NOW=$(date +%s)
awk -F'|' -v OFS='|' -v OLD="$((NOW - 172800))" \
	'{ if ($1 == "wan") $2 = OLD; print }' "$T/traffic.state" > "$T/s.tmp" &&
	mv "$T/s.tmp" "$T/traffic.state"
netdev 11000000 11000000;    step '8 clock jump'
echo '---- state file (one previous snapshot only) ----'
cat "$T/traffic.state"
echo '---- boot id ----'
cat "$T/boot_id"
