#!/bin/sh
# Verify session continuity across a short (< grace) dropout.
S=/tmp/opshare/sessions.state
F=/usr/bin/opshare-collect
rm -f "$S"
OP_SHARE_FORCE=1 "$F" > /tmp/opshare/s1.json 2>/dev/null
sleep 12
OP_SHARE_FORCE=1 "$F" > /tmp/opshare/s2.json 2>/dev/null
# pretend every client was absent at the previous sample, 40 s ago
NOW=$(date +%s)
OLD=$((NOW - 40))
awk -F'|' -v OFS='|' -v O="$OLD" '{ $3=O; $4=0; print }' "$S" > "$S.t" && mv "$S.t" "$S"
OP_SHARE_FORCE=1 "$F" > /tmp/opshare/s3.json 2>/dev/null
# and now a 130 s gap, beyond the 60 s grace
OLD=$((NOW - 130))
awk -F'|' -v OFS='|' -v O="$OLD" '{ $3=O; $4=0; print }' "$S" > "$S.t" && mv "$S.t" "$S"
OP_SHARE_FORCE=1 "$F" > /tmp/opshare/s4.json 2>/dev/null
echo TEST_DONE
