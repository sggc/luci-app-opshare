#!/bin/sh
# usage: sh _dev/shot.sh <name> "<hide-css>" <w,h> [scale]
NAME=$1; SEL=$2; SIZE=$3; SCALE=${4:-1}
ROOT="D:/00trae/ac+ap信息共享"
cd "$ROOT"
python _dev/make_preview.py >/dev/null
python - "$NAME" "$SEL" <<'PY'
import sys
name, sel = sys.argv[1], sys.argv[2]
h = open('opshare-preview.html', encoding='utf-8').read()
css = "<style>%s .wrap{padding:0 !important;max-width:none !important}</style>" % sel
open('_dev/shots/%s.html' % name, 'w', encoding='utf-8').write(h.replace('</head>', css + '</head>'))
PY
"/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" --headless=new --disable-gpu \
  --hide-scrollbars --force-device-scale-factor="$SCALE" --window-size="$SIZE" \
  --screenshot="$ROOT/_dev/shots/$NAME.png" "file:///$ROOT/_dev/shots/$NAME.html" 2>&1 | grep -i 'written' || true
