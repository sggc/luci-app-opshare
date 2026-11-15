#!/usr/bin/env python3
"""Assert that a built .ipk is actually installable.

Two failure modes have already bitten this package, so they are tested here:

  * container format - modern OpenWrt (>= 24.10) ships gzip(tar), the classic
    layout is ar(). opkg on 25.12 rejects the ar one outright.
  * CRLF - a shell script whose shebang is `#!/bin/sh\\r` fails with "not
    found" and the service lands in a procd crash loop. The working tree is
    edited on Windows, so this is a real risk.

Usage: python packaging/verify-ipk.py dist/luci-app-opshare_1.0.0_all.ipk
"""
from __future__ import annotations

import gzip
import io
import pathlib
import sys
import tarfile


def members(blob: bytes) -> dict[str, bytes]:
    if blob[:2] == b"\x1f\x8b":
        out = {}
        with tarfile.open(fileobj=io.BytesIO(gzip.decompress(blob))) as tf:
            for m in tf.getmembers():
                if m.isfile():
                    out[m.name.lstrip("./")] = tf.extractfile(m).read()
        return out
    if blob[:8] == b"!<arch>\n":
        out, off = {}, 8
        while off + 60 <= len(blob):
            h = blob[off:off + 60]
            name = h[:16].decode("ascii").strip()
            size = int(h[48:58].decode("ascii").strip())
            out[name] = blob[off + 60:off + 60 + size]
            off += 60 + size + (size % 2)
        return out
    raise SystemExit("unknown container: first bytes are %r" % blob[:8])


def tar_entries(blob: bytes) -> dict[str, tuple[bytes, int]]:
    out = {}
    with tarfile.open(fileobj=io.BytesIO(gzip.decompress(blob))) as tf:
        for m in tf.getmembers():
            if m.isfile():
                out[m.name.lstrip("./")] = (tf.extractfile(m).read(), m.mode)
    return out


def main(paths: list[str]) -> int:
    bad = 0
    for p in paths:
        f = pathlib.Path(p)
        blob = f.read_bytes()
        print("== %s (%.1f KB)" % (f.name, len(blob) / 1024.0))

        top = members(blob)
        need = {"debian-binary", "control.tar.gz", "data.tar.gz"}
        missing = need - set(top)
        if missing:
            print("  FAIL missing members: %s (got %s)" % (missing, sorted(top)))
            bad += 1
            continue
        if top["debian-binary"] != b"2.0\n":
            print("  FAIL debian-binary is %r" % top["debian-binary"])
            bad += 1

        ctl = tar_entries(top["control.tar.gz"])
        data = tar_entries(top["data.tar.gz"])
        control = ctl.get("control", (b"", 0))[0].decode("utf-8", "replace")
        fields = dict(
            line.split(": ", 1) for line in control.splitlines()
            if ": " in line and not line.startswith(" "))
        problems = []
        for k in ("Package", "Version", "Architecture", "Depends", "Description"):
            if k not in fields:
                problems.append("control has no " + k)
        if fields.get("Architecture") != "all":
            problems.append("Architecture is %r, expected all" % fields.get("Architecture"))
        for name in ("postinst", "prerm", "postrm"):
            if name not in ctl:
                problems.append("control.tar.gz has no " + name)
            elif ctl[name][1] & 0o111 == 0:
                problems.append("%s is not executable" % name)

        # every installed shell script: executable, LF endings, valid shebang
        for rel, (body, mode) in data.items():
            head = body.split(b"\n", 1)[0]
            if head.startswith(b"#!"):
                if b"\r\n" in body:
                    problems.append("%s has CRLF line endings" % rel)
                if mode & 0o111 == 0:
                    problems.append("%s has a shebang but is not executable" % rel)
            elif rel.startswith(("usr/bin/", "etc/init.d/", "www/cgi-bin/",
                                 "usr/libexec/rpcd/")):
                problems.append("%s: executable path without shebang" % rel)

        if "usr/libexec/rpcd/opshare" not in data:
            problems.append("ubus bridge (usr/libexec/rpcd/opshare) is missing")
        if "usr/share/rpcd/acl.d/luci-app-opshare.json" not in data:
            problems.append("rpcd ACL is missing")

        # Apache-2.0 4(a): a redistributed binary must carry the license text.
        # The .ipk is the redistributed artifact here, not the git repository.
        if b"Apache License" not in data.get("usr/share/opshare/LICENSE", (b"", 0))[0]:
            problems.append("LICENSE is not shipped inside the package")

        if problems:
            for x in problems:
                print("  FAIL " + x)
            bad += 1
        else:
            print("  ok   %s %s, %d files, control ok, no CRLF, ubus bridge present"
                  % (fields["Package"], fields["Version"], len(data)))
    return 1 if bad else 0


if __name__ == "__main__":
    args = sys.argv[1:]
    if not args:
        args = [str(p) for p in sorted(pathlib.Path("dist").glob("*.ipk"))]
    raise SystemExit(main(args))
