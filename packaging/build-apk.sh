#!/bin/sh
# Build an APK v3 package for OpenWrt 25.12+ (apk-tools 3.x).
#
# OpenWrt switched from opkg/.ipk to apk-tools 3/.apk in 25.12. The new .apk
# is an ADB binary container (magic "ADBd"), not a tarball, and apk-tools 3
# refuses v2 packages outright ("v2 package format error"). Hand-rolling that
# binary schema is a bad idea, so this script delegates to the official
# `apk mkpkg` - the same call OpenWrt's include/package-pack.mk makes.
#
#   sh packaging/build-apk.sh [version]
#   APK_BIN=/path/to/apk.static sh packaging/build-apk.sh 1.0.1
#
# Needs apk-tools 3.x *with the mkpkg applet*. A router's runtime apk is
# usually a trimmed build (verified: OpenWrt/PonWrt 3.0.5 ships add/del/info
# but no mkpkg), so use an Alpine container or the static apk binary:
#   docker run --rm -v "$PWD":/work -w /work alpine:3.23 \
#       sh packaging/build-apk.sh
#
# Everything in this package is shell + static assets, so arch is `noarch`
# (OpenWrt maps PKGARCH=all to noarch) and one file serves every CPU.

set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
SRC="$ROOT/src"
DIST="$ROOT/dist"
NAME="luci-app-opshare"
APK=${APK_BIN:-apk}

VER=${1:-$(cat "$SRC/usr/share/opshare/version" 2>/dev/null)}
[ -n "$VER" ] || { echo "ERROR: version is empty" >&2; exit 1; }
APKVER="$VER-r1"

if command -v "$APK" >/dev/null 2>&1; then :
elif [ -x "$APK" ]; then :
else
	echo "ERROR: apk-tools 3.x with 'mkpkg' not found." >&2
	echo "       A router's runtime apk is often built without mkpkg." >&2
	echo "       Use an Alpine container or APK_BIN=/path/to/apk.static." >&2
	exit 1
fi

STAGE=$(mktemp -d /tmp/opshare-apkstage.XXXXXX 2>/dev/null) ||
	STAGE="/tmp/opshare-apkstage.$$"
SCRIPTS="/tmp/opshare-apk-scripts.$$"
trap 'rm -rf "$STAGE" "$SCRIPTS"' EXIT INT TERM 2>/dev/null
mkdir -p "$STAGE"
# mktemp creates 0700; apk records the root node's ACL, so normalise it or
# the package would advertise a 0700 root directory.
chmod 755 "$STAGE"

# ---- 1. payload: src/ maps straight onto the device root ------------------
# Keep the exact same executable rules as build-ipk.py, or a script whose
# shebang is not executable leaves procd in a crash loop.
(cd "$SRC" && find . -type f | sed 's|^\./||') | while IFS= read -r rel; do
	[ -n "$rel" ] || continue
	mkdir -p "$STAGE/$(dirname "$rel")"
	cp "$SRC/$rel" "$STAGE/$rel"
	case "$rel" in
		usr/bin/*|etc/init.d/*|www/cgi-bin/*|usr/libexec/rpcd/*) chmod 755 "$STAGE/$rel" ;;
		*) chmod 644 "$STAGE/$rel" ;;
	esac
done

# Apache-2.0 4(a): the license must travel with the redistributed artifact.
mkdir -p "$STAGE/usr/share/opshare"
cp "$ROOT/LICENSE" "$STAGE/usr/share/opshare/LICENSE"
chmod 644 "$STAGE/usr/share/opshare/LICENSE"

# apk v3 records conffiles in /lib/apk/packages/<name>.conffiles rather than
# in a CONTROL/conffiles member like ipk does.
mkdir -p "$STAGE/lib/apk/packages"
cp "$ROOT/packaging/conffiles" "$STAGE/lib/apk/packages/$NAME.conffiles"
chmod 644 "$STAGE/lib/apk/packages/$NAME.conffiles"

# ---- 2. maintainer scripts ------------------------------------------------
# ipk names -> apk v3 script types. Verified against apk-tools 3.0.9.
mkdir -p "$SCRIPTS"
for pair in "post-install:postinst" "pre-deinstall:prerm" "post-deinstall:postrm"; do
	apk_type=${pair%%:*}; ipk_name=${pair##*:}
	cp "$ROOT/packaging/$ipk_name" "$SCRIPTS/$apk_type"
	chmod 755 "$SCRIPTS/$apk_type"
done

mkdir -p "$DIST"
OUT="$DIST/$NAME-$APKVER.apk"

# SOURCE_DATE_EPOCH=0 is what OpenWrt's own packaging uses; it makes the ADB
# payload deterministic across builders.
SOURCE_DATE_EPOCH=0 "$APK" mkpkg \
	--info "name:$NAME" \
	--info "version:$APKVER" \
	--info "arch:noarch" \
	--info "description:多设备信息共享 - 合并多台路由器的客户端 / 无线 / 流量视图" \
	--info "license:Apache-2.0" \
	--info "origin:$NAME" \
	--info "url:https://github.com/sggc/luci-app-opshare" \
	--info "maintainer:sggc" \
	--info "depends:libc uhttpd rpcd jshn luci-base" \
	--script "post-install:$SCRIPTS/post-install" \
	--script "pre-deinstall:$SCRIPTS/pre-deinstall" \
	--script "post-deinstall:$SCRIPTS/post-deinstall" \
	--files "$STAGE" \
	--output "$OUT"

rm -rf "$SCRIPTS"
[ -s "$OUT" ] || { echo "ERROR: mkpkg produced no output" >&2; exit 1; }

# adbdump is the v3 equivalent of reading control: if the ADB container were
# malformed this is where it would fail.
if "$APK" adbdump "$OUT" > "$STAGE/dump.txt" 2>/dev/null; then
	grep -q "name: $NAME" "$STAGE/dump.txt" ||
		{ echo "ERROR: adbdump does not contain the package name" >&2; exit 1; }
	grep -q "version: $APKVER" "$STAGE/dump.txt" ||
		{ echo "ERROR: adbdump does not contain the version" >&2; exit 1; }
else
	echo "WARNING: adbdump unavailable, skipping metadata verification" >&2
fi

echo "build   ${OUT#$ROOT/}  ($(wc -c < "$OUT") bytes, arch noarch, APK v3)"
