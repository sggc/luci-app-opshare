#!/bin/sh
# Offline test for src/usr/bin/opshare-ifaces.
#
# The fixture is the real interface table of the home router (ImmortalWrt on
# Imou LC-HX3001) that exposed the bug: lan3 was pulled out of br-lan for
# IPTV, tun0 is the OpenVPN server, pppoe-wan is the PPPoE session and eth0
# is the DSA CPU port. All four had traffic and none of them appeared in the
# old whitelist. No router is needed here - /sys/class/net and /proc/net/dev
# are stubbed through the OP_* test hooks in the script under test.
#
#   sh _dev/ifacetest.sh
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
PROG="$ROOT/src/usr/bin/opshare-ifaces"
T=$(mktemp -d /tmp/ifacetest.XXXXXX)
trap 'rm -rf "$T"' EXIT INT TERM

NET="$T/net"
mkdir -p "$NET/br-lan/brif"
for i in apcli0 apclix0 br-lan eth0 lan1 lan2 lan3 lo pppoe-wan ra0 ra1 rai1 rax0 tun0 wan; do
	mkdir -p "$NET/$i"
done
for i in lan1 lan2 ra0 rax0; do : > "$NET/br-lan/brif/$i"; done

cat > "$T/netdev" <<'EOS'
Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
apcli0: 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0
    lo: 141879891 846732 0 0 0 0 0 0 141879891 846732 0 0 0 0 0 0 0
apclix0: 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0
  lan1: 0 0 0 0 0 0 0 0 185931776 1334282 0 0 0 0 0 0
  tun0: 597135355 1583307 0 0 0 0 0 0 4527207577 4070699 0 64105 0 0 0 0
  eth0: 2223120627818 1817779347 35 0 0 0 0 0 1712343703294 1172820163 0 0 0 0 0 0
  rax0: 21682566363 69606183 0 0 0 0 0 36677 173714777487 177572659 0 0 0 0 0 0
br-lan: 29785071964 200028284 0 20 0 0 0 697573 1439473132525 123974561 0 0 0 0 0 0
  lan2: 19349082720 169229816 0 0 0 0 0 0 1426133737942 100239819 0 0 0 0 0 0
pppoe-wan: 44771069769 223645208 0 0 0 0 0 0 643644998335 496966335 0 0 0 0 0 0
   wan: 407419383660 492394287 806 330685 0 0 0 0 683627976885 590317207 0 0 0 0 0 0
   ra0: 264809974 1463533 4088553 0 0 0 0 4044 4111247012 3919588 0 0 0 0 0 0
   ra1: 264809974 1463533 4088553 0 0 0 0 4044 4111247012 3919588 0 0 0 0 0 0
  rai1: 21682566363 69606183 0 0 0 0 0 36677 173714777487 177572659 0 0 0 0 0 0
  lan3: 2161515042139 1593462158 0 330685 0 0 0 0 53731144 440909 0 0 0 0 0 0
EOS

printf 'ra0\nrax0\n' > "$T/wifis"

# uci show network would emit these `option device` values (wan twice: wan
# and wan6 both point at it). Duplicate candidates must collapse.
UCIDEVS='lo br-lan wan wan lan3 tun0'

run() {
	OP_NETDIR="$NET" OP_PROCDEV="$T/netdev" OP_UCIDEVS="$UCIDEVS" \
		sh "$PROG" "$@"
}

PASS=0; FAIL=0
ok()   { PASS=$((PASS + 1)); printf '[OK]   %s\n' "$1"; }
no()   { FAIL=$((FAIL + 1)); printf '[FAIL] %s\n' "$1"; }
has()  { printf '%s\n' "$1" | grep -qxF "$2" && ok "$3" || no "$3"; }
hasnt(){ printf '%s\n' "$1" | grep -q "$2" && no "$3" || ok "$3"; }

OUT=$(run wan br-lan "$T/wifis")
printf '%s\n' "$OUT" > "$T/out"

echo "--- built list ---"
cat "$T/out"
echo "------------------"

has "$OUT" 'br-lan|lan'        'LAN 桥仍为 lan'
has "$OUT" 'wan|wan'           'WAN 物理口仍为 wan'
has "$OUT" 'lan1|port'         '桥成员 lan1'
has "$OUT" 'lan2|port'         '桥成员 lan2'
has "$OUT" 'ra0|wifi'          '2.4G 无线 ra0'
has "$OUT" 'rax0|wifi'         '5G 无线 rax0'
has "$OUT" 'lan3|port'         'IPTV 独立口 lan3 已纳入'
has "$OUT" 'tun0|vpn'          'OpenVPN tun0 已纳入并标为 vpn'
has "$OUT" 'pppoe-wan|session' 'PPPoE 会话口已纳入'
has "$OUT" 'eth0|cpu'          'DSA CPU 汇聚口已纳入'
hasnt "$OUT" '^lo|'            'lo 被排除'
hasnt "$OUT" '^apcli'          '零流量 apcli 虚拟口不刷屏'
hasnt "$OUT" '^ra1|'           '与 ra0 计数相同的 guest VAP 被折叠'
hasnt "$OUT" '^rai1|'          '与 rax0 计数相同的 guest VAP 被折叠'

N=$(wc -l < "$T/out" | tr -d ' ')
[ "$N" = 10 ] && ok "恰好 10 个接口（原实现只有 6 个）" || no "接口数 $N，期望 10"

# first-run path: the sampler calls the builder without a wireless hint file;
# the name fallback must still classify the radios as wifi.
OUT2=$(run wan br-lan)
has "$OUT2" 'ra0|wifi'  '无 wifis 文件时 ra0 仍识别为 wifi'
has "$OUT2" 'rax0|wifi' '无 wifis 文件时 rax0 仍识别为 wifi'
has "$OUT2" 'tun0|vpn'  '无 wifis 文件时 tun0 仍纳入'

printf '\n==> %d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" = 0 ]
