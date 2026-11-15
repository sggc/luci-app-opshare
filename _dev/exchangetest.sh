#!/bin/sh
# Offline protocol test for zero-config pairing (POST a=exchange).
#
# The whole point of exchange is that a downstream box behind NAT can share
# its data with zero router configuration: it POSTs its own snapshot to the
# hub and receives the merged view in the same response. The hub must never
# need to connect back. This test drives the real CGI with stubbed CGI
# environment variables and checks what it stores and what it returns.
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
CGI="$ROOT/src/www/cgi-bin/opshare"
SYNC="$ROOT/src/usr/bin/opshare-sync"
RD=/tmp/opshare
T=$(mktemp -d /tmp/exchangetest.XXXXXX)
trap 'rm -rf "$T" "$RD/reported/opsharetest.json" "$RD/reported/opsharetest.json."* \
      "$RD/reported/opsharetest.meta" "$RD/reported.new"; \
      [ "$HAD_ALL" = "1" ] || rm -f "$RD/all.json"' EXIT INT TERM

HAD_ALL=0
[ -s "$RD/all.json" ] && HAD_ALL=1
mkdir -p "$RD/reported"

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf '[OK]   %s\n' "$1"; }
no()  { FAIL=$((FAIL+1)); printf '[FAIL] %s\n' "$1"; }

# A merged view the hub would already have, so we can prove it is returned.
printf '{"schema":2,"updated":123,"nodes":[{"_meta":{"name":"hub"}}]}\n' > "$RD/all.json"
printf '{"schema":2,"updated":9,"node":{"hostname":"downstream"},"clients":[],"radios":[],"leases":[],"traffic":[]}\n' > "$T/self.json"

BODY=$(wc -c < "$T/self.json" | tr -d ' ')
OUT=$(QUERY_STRING='t=secret&a=exchange&id=opsharetest' CONTENT_LENGTH="$BODY" \
	REMOTE_ADDR=192.168.10.191 REQUEST_METHOD=POST \
	sh "$CGI" < "$T/self.json")
printf '%s\n' "$OUT" > "$T/out"

echo "--- CGI exchange response ---"
head -c 300 "$T/out"; echo
echo "-----------------------------"

printf '%s' "$OUT" | grep -q '"schema"' && ok "响应是 JSON" || no "响应不是 JSON"
printf '%s' "$OUT" | grep -q '"name":"hub"' && ok "响应带回 hub 当前的合并视图" || no "响应没有带回合并视图"

[ -s "$RD/reported/opsharetest.json" ] && ok "快照按 id 落盘" || no "快照没有落盘"
if [ -s "$RD/reported/opsharetest.json" ]; then
	cmp -s "$RD/reported/opsharetest.json" "$T/self.json" &&
		ok "落盘内容与上报的 self.json 一致" || no "落盘内容被改写"
fi
[ -s "$RD/reported/opsharetest.meta" ] && ok "写了 ts|来源地址 元数据" || no "缺少元数据"
grep -q '192.168.10.191' "$RD/reported/opsharetest.meta" 2>/dev/null &&
	ok "元数据记录了下游源地址（hub 无需反查 IP）" || no "元数据没记录源地址"
[ -e "$RD/reported.new" ] && ok "通知 daemon 立即合并（不必等下一轮采集）" || no "缺少立即合并通知"
grep -q 'reported.new' "$SYNC" && ok "daemon 会消费该通知" || no "daemon 未处理通知"

# A merged view (a=recv payload) has schema but no `node`; it must be refused
# so a misdirected push cannot masquerade as a node report.
printf '{"schema":2,"updated":1,"nodes":[]}\n' > "$T/merged.json"
B2=$(wc -c < "$T/merged.json" | tr -d ' ')
O2=$(QUERY_STRING='t=secret&a=exchange&id=opsharetest' CONTENT_LENGTH="$B2" \
	REMOTE_ADDR=192.168.10.191 REQUEST_METHOD=POST \
	sh "$CGI" < "$T/merged.json")
printf '%s' "$O2" | grep -q '"ok":0' && ok "拒绝把合并视图当节点快照" || no "未拒绝错误载荷"

O3=$(QUERY_STRING='t=secret&a=exchange&id=opsharetest' CONTENT_LENGTH=0 \
	REMOTE_ADDR=192.168.10.191 REQUEST_METHOD=POST \
	sh "$CGI" < /dev/null)
printf '%s' "$O3" | grep -q '"ok":0' && ok "空 body 被拒绝" || no "空 body 未拒绝"

# The client side must use an outbound POST with the snapshot, and the hub
# side must merge whatever was reported without any peer section.
grep -q 'post-file' "$SYNC" && ok "被动节点用 wget --post-file 上报" || no "缺少 POST 上报"
grep -q 'a=exchange\|exchange' "$SYNC" && ok "被动节点请求 a=exchange" || no "请求未指向 exchange"
grep -q 'http_url.*all' "$SYNC" && ok "保留 GET 回退以兼容旧 hub" || no "缺少旧版回退"
grep -q 'reported/\*.json\|reported/' "$SYNC" && ok "hub 扫描主动上报的节点并合并" || no "hub 未纳入上报节点"
grep -q '127\.\*|::1|localhost' "$SYNC" && ok "跳过指向自身的遗留 peer" || no "自指 peer 未处理"
grep -q 'passive refresh failed' "$SYNC" &&
	ok "被动节点每周期主动刷新（不会冻结在第一份缓存）" || no "被动节点缺少周期刷新"

printf '\n==> %d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" = 0 ]
