#!/bin/sh
# 1-second-resolution CPU sampler (busybox sleep has no fractional support).
# Usage: sh cpuprofile.sh [seconds] [trigger_sec]   TRIG_CMD env = command to fire
SECS=${1:-40}
TRIG=${2:-0}
OUT=/tmp/cpu.profile
: > "$OUT"

readstat() {
	IFS=' ' read -r _c _u _n _s _idle _io _irq _si _rest < /proc/stat
	T=$((_u + _n + _s + _idle + _io + _irq + _si))
	I=$_idle
}

readstat
pt=$T; pi=$I
n=0
while [ "$n" -lt "$SECS" ]; do
	sleep 1
	readstat
	dt=$((T - pt)); di=$((I - pi))
	busy=0
	[ "$dt" -gt 0 ] && busy=$(( (dt - di) * 1000 / dt ))  # per-mille of ALL cores
	printf '%s %s\n' "$n" "$busy" >> "$OUT"
	pt=$T; pi=$I
	n=$((n + 1))
	if [ "$TRIG" -gt 0 ] && [ "$n" = "$TRIG" ] && [ -n "${TRIG_CMD:-}" ]; then
		sh -c "$TRIG_CMD" >/dev/null 2>&1 &
	fi
done
echo "SAMPLES $(wc -l < "$OUT") TRIGGER_SEC=$TRIG"
echo "--- whole series (sec busy_permille; 1000 = one full core busy) ---"
cat "$OUT"
