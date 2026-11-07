#!/usr/bin/env python3
"""Build an opkg feed index (Packages + Packages.gz) from dist/*.ipk.

Installing a single file over HTTP works:

    opkg install https://example.org/releases/download/v1.0.0/luci-app-opshare_1.0.0_all.ipk

but it has no upgrade path - opkg does not remember where the file came from,
so a later `opkg upgrade` cannot find a newer build. Publishing an index turns
the release into a real feed:

    src/gz opshare https://example.org/.../opkg
    opkg update && opkg install luci-app-opshare

The index is generated from the .ipk containers themselves rather than from
control.in, so what the feed advertises is exactly what the package contains.

Usage: python packaging/make-index.py [outdir]     # default: dist/
"""
from __future__ import annotations

import gzip
import hashlib
import io
import pathlib
import sys
import tarfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"

# The order opkg itself prints, so a generated entry looks like a real one.
# Description goes last because its continuation lines are indented and must
# follow the field they belong to - anything emitted after them would silently
# be absorbed into the description by opkg's parser.
ORDER = ("Package", "Version", "Depends", "Source", "Section", "Priority",
         "Maintainer", "Architecture", "Installed-Size", "Filename", "Size",
         "SHA256sum", "Description")


def member(blob: bytes, name: str) -> bytes:
    """Pull one member out of an .ipk, in either container format."""
    if blob[:2] == b"\x1f\x8b":
        with tarfile.open(fileobj=io.BytesIO(gzip.decompress(blob))) as tf:
            for m in tf.getmembers():
                if m.isfile() and m.name.lstrip("./") == name:
                    return tf.extractfile(m).read()
        raise SystemExit("no %s inside the container" % name)
    if blob[:8] == b"!<arch>\n":
        off = 8
        while off + 60 <= len(blob):
            h = blob[off:off + 60]
            n = h[:16].decode("ascii").strip().rstrip("/")
            size = int(h[48:58].decode("ascii").strip())
            if n == name:
                return blob[off + 60:off + 60 + size]
            off += 60 + size + (size % 2)
        raise SystemExit("no %s inside the container" % name)
    raise SystemExit("unknown container for %s" % name)


def control_of(ipk: pathlib.Path) -> str:
    ctl_tar = member(ipk.read_bytes(), "control.tar.gz")
    with tarfile.open(fileobj=io.BytesIO(gzip.decompress(ctl_tar))) as tf:
        for m in tf.getmembers():
            if m.isfile() and m.name.lstrip("./") == "control":
                return tf.extractfile(m).read().decode("utf-8")
    raise SystemExit("%s has no control file" % ipk.name)


def split_control(text: str) -> tuple[dict[str, str], list[str]]:
    """(fields, description continuation lines).

    Debian control syntax: `Key: value`, and any line starting with a space
    continues the field above it. Only the description actually uses
    continuations in practice, so they are collected separately - the parser
    rejects indented orphans, which is the failure this guards against.
    """
    fields: dict[str, str] = {}
    cont: list[str] = []
    last = ""
    for line in text.splitlines():
        if line.startswith((" ", "\t")):
            if last == "Description":
                cont.append(line)
            continue
        if ": " not in line:
            continue
        k, v = line.split(": ", 1)
        last = k.strip()
        fields[last] = v.strip()
    return fields, cont


def entry(ipk: pathlib.Path) -> str:
    fields, cont = split_control(control_of(ipk))
    blob = ipk.read_bytes()
    # These three describe the file in this directory, so they cannot come from
    # the control file - and must match what the server actually serves.
    fields["Filename"] = ipk.name
    fields["Size"] = str(len(blob))
    fields["SHA256sum"] = hashlib.sha256(blob).hexdigest()

    out = []
    for k in ORDER:
        if k == "Description":
            if k in fields:
                out.append("%s: %s" % (k, fields[k]))
                out.extend(cont)                     # indented, stay last
            continue
        if k in fields:
            out.append("%s: %s" % (k, fields[k]))
    for k, v in fields.items():                      # anything non-standard
        if k not in ORDER:
            out.append("%s: %s" % (k, v))
    return "\n".join(out) + "\n"


def verify(path: pathlib.Path, text: str) -> None:
    """A feed that names a missing or wrong-size file breaks opkg update."""
    fields, _ = split_control(control_of(path))
    for line in text.splitlines():
        if line.startswith("Filename: "):
            name = line.split(": ", 1)[1]
            assert name == path.name, "%s: feed says %s" % (path.name, name)
        if line.startswith("Size: "):
            assert int(line.split(": ", 1)[1]) == len(path.read_bytes()), \
                "%s: Size does not match the file" % path.name


def main() -> int:
    outdir = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else DIST
    # The index describes the directory it is written into, so read from there
    # too - `make-index.py dist/legacy` must describe the classic build, not
    # whatever happens to be in dist/.
    ipks = sorted(p for p in outdir.glob("*.ipk"))
    if not ipks:
        print("no .ipk in %s - build first" % outdir, file=sys.stderr)
        return 1

    chunks, seen = [], {}
    for p in ipks:
        text = entry(p)
        verify(p, text)
        fields, _ = split_control(control_of(p))
        key = (fields["Package"], fields["Version"])
        if key in seen:
            print("FAIL  %s and %s both provide %s %s; a feed cannot hold both"
                  % (seen[key], p.name, key[0], key[1]), file=sys.stderr)
            return 1
        seen[key] = p.name
        chunks.append(text)
        print("index   %s  %s  ok" % (p.name, len(p.read_bytes())))
    body = "\n".join(chunks)

    outdir.mkdir(parents=True, exist_ok=True)
    (outdir / "Packages").write_bytes(body.encode("utf-8"))
    # mtime=0 keeps the archive reproducible; opkg accepts plain gzip.
    with open(outdir / "Packages.gz", "wb") as fh:
        with gzip.GzipFile(fileobj=fh, mode="wb", compresslevel=9, mtime=0) as gz:
            gz.write(body.encode("utf-8"))
    print("index   %s/Packages (%d bytes, %d package(s))"
          % (outdir.as_posix(), len(body), len(chunks)))
    print("index   %s/Packages.gz (%d bytes)"
          % (outdir.as_posix(), (outdir / "Packages.gz").stat().st_size))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
