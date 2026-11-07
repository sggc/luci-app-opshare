#!/bin/sh
bench() {
	label="$1"; shift
	t0=$(cut -d' ' -f1 /proc/uptime)
	"$@" >/dev/null 2>&1
	t1=$(cut -d' ' -f1 /proc/uptime)
	awk -v a="$t0" -v b="$t1" -v l="$label" 'BEGIN { printf "%-38s %.3f s\n", l, b-a }'
}
echo "=== subcommand costs ==="
bench "ubus wireless status" ubus call network.wireless status
bench "ubus system board" ubus call system board
bench "ubus dhcp ipv6leases" ubus call dhcp ipv6leases
bench "bridge fdb show" bridge fdb show
bench "brctl showmacs" brctl showmacs br-lan
bench "ip -4 neigh" ip -4 neigh show dev br-lan
bench "ip -6 neigh" ip -6 neigh show dev br-lan
bench "iwinfo assoclist" iwinfo rai0 assoclist
echo "=== collect / sync ==="
export OP_SHARE_FORCE=1
bench "collect (force)" /usr/bin/opshare-collect
export OP_SHARE_FORCE=0
bench "collect (cache)" /usr/bin/opshare-collect
bench "sync --once" /usr/bin/opshare-sync --once
