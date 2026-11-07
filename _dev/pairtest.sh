#!/bin/sh
# Offline test for opshare-peer. Stubs uci / wget / ip so the discovery,
# pairing and aggregator-decision logic can be checked without two routers.
#   sh _dev/pairtest.sh
set -e
ROOT=$(cd "$(dirname "$0")/.." && pwd)
T=$(mktemp -d /tmp/optest.XXXXXX)
STUB=$T/bin
mkdir -p "$STUB" "$T/run" "$T/etc"
export UCI_DB=$T/uci.db
: > "$UCI_DB"

cat > "$STUB/uci" <<'EOS'
#!/bin/sh
DB=${UCI_DB:?}
[ "$1" = "-q" ] && shift
cmd=$1; shift
case "$cmd" in
	get) v=$(grep -m1 "^$1=" "$DB" 2>/dev/null || :); printf '%s' "${v#*=}" ;;
	set) k=${1%%=*}; v=${1#*=}
		grep -v "^$k=" "$DB" > "$DB.n" 2>/dev/null || :
		printf '%s=%s\n' "$k" "$v" >> "$DB.n"; mv "$DB.n" "$DB" ;;
	delete) grep -v "^$1[.=]" "$DB" > "$DB.n" 2>/dev/null || :; mv "$DB.n" "$DB" ;;
	commit) : ;;
	show) cat "$DB" ;;
esac
exit 0
EOS

cat > "$STUB/wget" <<'EOS'
#!/bin/sh
for a in "$@"; do url=$a; done
case "$url" in
	*a=hello*)
		printf '{"ok":1,"proto":1,"id":"%s","name":"%s","token":"%s","pw":%s,"mode":"hub","n":"x","ts":1}\n' \
			"${FAKE_ID:-peer1234abcd}" "${FAKE_NAME:-PeerAP}" "${FAKE_TOKEN:-ptok123}" "${FAKE_PW:-2}" ;;
esac
exit 0
EOS

cat > "$STUB/ip" <<'EOS'
#!/bin/sh
if [ "$1" = "route" ]; then
	echo "default via 192.168.10.1 dev br-lan proto static"
	exit 0
fi
if [ "$1" = "-4" ]; then
	echo "    inet 192.168.1.1/24 brd 192.168.1.255 scope global br-lan"
	exit 0
fi
exit 0
EOS

cat > "$STUB/logger" <<'EOS'
#!/bin/sh
exit 0
EOS
chmod +x "$STUB"/*

sed -e "s|^RUNDIR=/tmp/opshare|RUNDIR=$T/run|" \
	-e "s|^IDENT=/etc/opshare/identity|IDENT=$T/etc/identity|" \
	-e "s|^PATH=.*|PATH=$STUB:/usr/sbin:/usr/bin:/sbin:/bin|" \
	-e "s|/etc/init.d/opshare|$T/etc/init.sh|" \
	"$ROOT/src/usr/bin/opshare-peer" > "$T/peer.sh"

PASS=0; FAIL=0
ok() { PASS=$((PASS + 1)); printf '[OK]   %s\n' "$1"; }
no() { FAIL=$((FAIL + 1)); printf '[FAIL] %s   %s\n' "$1" "${2:-}"; }
chk() { if [ "$2" = "$3" ]; then ok "$1"; else no "$1" "want [$3] got [$2]"; fi; }
has() { if grep -q "$2" <<EOF
$1
EOF
then ok "$3"; else no "$3"; fi }

# ---- 1. first run: identity + token + pair written ------------------------
printf 'opshare.main.mode=auto\n' >> "$T/uci.db"
OUT=$(FAKE_PW=1 sh "$T/peer.sh" 2>&1)
chk "首次生成共享密钥" "$([ -s "$T/uci.db" ] && grep -c 'main.token=' "$T/uci.db")" "1"
chk "身份文件已写入" "$([ -s "$T/etc/identity" ] && echo yes)" "yes"
chk "写入了 auto_ 对端段" "$(grep -c '^opshare\.auto_[0-9a-z]*=peer$' "$T/uci.db" || :)" "1"
chk "写入了 auto_ 主机" "$(grep -c '^opshare.auto_.*\.host=192.168.10.1' "$T/uci.db" || :)" "1"
chk "传输方式为 http" "$(grep -c '\.transport=http$' "$T/uci.db" || :)" "1"
chk "对端 token 已保存" "$(grep -c '\.token=ptok123$' "$T/uci.db" || :)" "1"
chk "对端较弱时本机当 hub" "$(uci() { :; }; cat "$T/run/mode")" "hub"
chk "auto_mode 已记录" "$(grep -c 'main.auto_mode=hub' "$T/uci.db" || :)" "1"
has "$OUT" "配对成功" "首次配对有提示"

# ---- 2. second run must be idempotent -------------------------------------
BEFORE=$(wc -l < "$T/uci.db")
OUT2=$(FAKE_PW=1 sh "$T/peer.sh" 2>&1)
AFTER=$(wc -l < "$T/uci.db")
chk "重复运行不新增配置" "$AFTER" "$BEFORE"
has "$OUT2" "已配对" "重复运行提示已配对"

# ---- 3. stronger peer steals the aggregator role --------------------------
OUT3=$(FAKE_PW=2 FAKE_ID=0000aaaa sh "$T/peer.sh" 2>&1)
chk "对端更强则本机让位" "$(cat "$T/run/mode")" "off"
chk "auto_mode 同步为 off" "$(grep -c 'main.auto_mode=off' "$T/uci.db" || :)" "1"

# ---- 4. same class: lower id keeps the role -------------------------------
# our own id is in the identity file; force the peer to be larger
MYID=$(sed -n 's/^MYID=//p' "$T/etc/identity")
BIGID="zzzzzzzz$MYID"
OUT4=$(FAKE_PW=2 FAKE_ID="$BIGID" sh "$T/peer.sh" 2>&1)
chk "同档时 id 小者当 hub" "$(cat "$T/run/mode")" "hub"

# ---- 4b. a hand-written peer for the same host must not be duplicated -----
printf 'opshare.legacy=peer\nopshare.legacy.host=192.168.10.1\nopshare.legacy.transport=http\n' >> "$T/uci.db"
AUTOBEFORE=$(grep -c '^opshare.auto_' "$T/uci.db" || :)
OUT4b=$(FAKE_PW=1 FAKE_ID=newpeer1234 sh "$T/peer.sh" 2>&1)
AUTOAFTER=$(grep -c '^opshare.auto_' "$T/uci.db" || :)
chk "手工段指向同一台时不重复配对" "$AUTOAFTER" "$AUTOBEFORE"
has "$OUT4b" "跳过自动配对" "跳过时说明原因"

# ---- 5. auto_pair=0 discovers but never writes ----------------------------
printf 'opshare.main.auto_pair=0\n' >> "$T/uci.db"
CNT=$(grep -c '^opshare.auto_' "$T/uci.db" || :)
OUT5=$(FAKE_ID=other9999999 FAKE_PW=1 sh "$T/peer.sh" 2>&1)
CNT2=$(grep -c '^opshare.auto_' "$T/uci.db" || :)
chk "关闭自动配对后不再写入" "$CNT2" "$CNT"
has "$OUT5" "未配对" "关闭后仍有发现提示"

# ---- 6. nothing reachable must not crash or write -------------------------
printf 'opshare.main.auto_pair=1\n' >> "$T/uci.db"
mv "$STUB/wget" "$STUB/wget.off"
OUT6=$(sh "$T/peer.sh" 2>&1) && ok "无对端时正常退出" || no "无对端时正常退出"
mv "$STUB/wget.off" "$STUB/wget"

printf '\n==> %d passed, %d failed\n' "$PASS" "$FAIL"
rm -rf "$T"
[ "$FAIL" = "0" ]
