#!/usr/bin/env python3
"""Build luci-app-opshare into an .ipk without an OpenWrt SDK.

Everything in this package is shell + static web assets, so there is nothing to
compile and nothing that depends on the target CPU: `Architecture: all` makes a
single file installable on aarch64, mipsel, arm, x86 - whatever the router is.

An .ipk is a container with three members:

    debian-binary      the text "2.0\\n"
    data.tar.gz        the payload, paths relative to /
    control.tar.gz     ./control, ./conffiles, ./postinst, ./prerm, ./postrm

Two containers exist in the wild and the format changed under us:

    gzip(tar(...))   what OpenWrt 24.10 and later actually ship (checked against
                     downloads.openwrt.org: an .ipk there starts with 1f 8b, not
                     with the "!<arch>" magic). This is the default here.
    ar(...)          the classic Debian/ipk layout, still what 19.07 / 21.02 /
                     22.03 understand. Available with --legacy-ar.

Both are built here with the standard library only, so the same command works
on Windows, macOS and a CI runner, and produces byte-identical output for the
same input (SOURCE_DATE_EPOCH, root:root, sorted entries).

Usage:
    python packaging/build-ipk.py              # build the modern .ipk into dist/
    python packaging/build-ipk.py --legacy-ar  # also build the classic ar variant
    python packaging/build-ipk.py --check      # validate inputs, build nothing
    python packaging/build-ipk.py --version 1.2.3   # override the version

In CI the version comes from the git tag (v1.2.3 -> 1.2.3); locally it comes
from src/usr/share/opshare/version, which is also what the UI shows as
"about / version". A --version override never edits that file.
"""
from __future__ import annotations

import gzip
import hashlib
import io
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tarfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "src"
PKG = ROOT / "packaging"
DIST = ROOT / "dist"
NAME = "luci-app-opshare"

# Anything that must be executable on the device.
EXEC_PREFIXES = ("usr/bin/", "etc/init.d/", "www/cgi-bin/", "usr/libexec/rpcd/")
EXEC_FILES = ("etc/rc.common",)

# Reproducible builds: a fixed epoch keeps the tarballs stable across runs.
EPOCH = int(os.environ.get("SOURCE_DATE_EPOCH", "1700000000"))


def fail(msg: str) -> None:
    print("ERROR: " + msg, file=sys.stderr)
    raise SystemExit(1)


def mode_for(rel: str) -> int:
    if rel.startswith(EXEC_PREFIXES) or rel in EXEC_FILES:
        return 0o755
    return 0o644


def blob(path: pathlib.Path) -> bytes:
    """File contents with line endings normalised to LF.

    The working tree is edited on Windows, so plenty of files carry CRLF. A
    shell script whose shebang is `#!/bin/sh\\r` fails with "not found" (the
    kernel looks for an interpreter literally named "sh\\r"), and the whole
    service ends up in a procd crash loop. Normalise at pack time so the
    package is identical no matter which machine built it.
    """
    return path.read_bytes().replace(b"\r\n", b"\n")


def read_version() -> str:
    """Version from the file, unless --version overrode it.

    The version string surfaces in three places: the control file, the package
    filename, and the UI (which reads the packaged usr/share/opshare/version).
    An override therefore has to rewrite that file too, or a build tagged
    v1.0.1 would still introduce itself as 1.0.0 in the about box. Both are
    patched from the same value below, so they can never disagree.
    """
    override = None
    if "--version" in sys.argv:
        i = sys.argv.index("--version")
        if i + 1 >= len(sys.argv):
            fail("--version needs a value")
        override = sys.argv[i + 1].strip().lstrip("vV")
        if not override:
            fail("--version is empty")
        if override != override.split()[0] or "/" in override or "\\" in override:
            fail("--version %r is not a usable version string" % override)

    p = SRC / "usr/share/opshare/version"
    if not p.exists():
        fail("src/usr/share/opshare/version is missing")
    v = p.read_text(encoding="utf-8").strip()
    if not v:
        fail("src/usr/share/opshare/version is empty")
    if override:
        if override != v:
            print("warn    --version %s overrides file version %s "
                  "(packaged file is patched to match)" % (override, v),
                  file=sys.stderr)
        return override
    return v


def payload() -> list[tuple[str, pathlib.Path]]:
    """Installed files, sorted, as (posix relative path, source path).

    Everything under src/ maps straight onto the device root. The root LICENSE
    is injected too: Apache-2.0 section 4(a) requires a copy of the license to
    travel with any redistribution, and the .ipk is what people actually
    download - a LICENSE that only exists in the git repo never reaches them.
    """
    out = []
    for p in sorted(SRC.rglob("*")):
        if p.is_file():
            out.append((p.relative_to(SRC).as_posix(), p))
    lic = ROOT / "LICENSE"
    if not lic.is_file():
        fail("LICENSE is missing - the package cannot be redistributed without it")
    out.append(("usr/share/opshare/LICENSE", lic))
    if len(out) <= 1:
        fail("src/ is empty")
    return sorted(out, key=lambda it: it[0])


def tar_bytes(entries: list[tuple[str, bytes, int]],
              with_dirs: bool = True, sort: bool = True) -> bytes:
    """Deterministic tar: root:root, fixed mtime, sorted, './' prefixed.

    Directory entries are emitted explicitly. opkg creates missing parents for
    most paths but not reliably for a brand new directory tree (a missing
    /usr/share/opshare/ turned into a wfopen error on a real box), and a real
    .ipk lists them anyway.
    """
    items: list[tuple[str, bytes, int, bool]] = []
    if with_dirs:
        dirs = set()
        for name, _, _ in entries:
            parts = name.split("/")[:-1]
            for i in range(1, len(parts) + 1):
                dirs.add("/".join(parts[:i]))
        for d in sorted(dirs):
            items.append((d + "/", b"", 0o755, True))
    items += [(name, data, mode, False) for name, data, mode in entries]
    if sort:
        items.sort(key=lambda it: it[0])

    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode="w", format=tarfile.USTAR_FORMAT) as tf:
        for name, data, mode, is_dir in items:
            ti = tarfile.TarInfo("./" + name)
            ti.mode = mode
            ti.mtime = EPOCH
            ti.uid = ti.gid = 0
            ti.uname = ti.gname = "root"
            if is_dir:
                ti.type = tarfile.DIRTYPE
                ti.size = 0
                tf.addfile(ti)
            else:
                ti.size = len(data)
                tf.addfile(ti, io.BytesIO(data))
    out = io.BytesIO()
    with gzip.GzipFile(fileobj=out, mode="wb", compresslevel=9, mtime=0) as gz:
        gz.write(raw.getvalue())
    return out.getvalue()


def ar_bytes(members: list[tuple[str, bytes]]) -> bytes:
    """Classic ar archive (what opkg expects), no symbol table."""
    out = io.BytesIO()
    out.write(b"!<arch>\n")
    for name, data in members:
        if len(name) > 16:
            fail("ar member name too long: " + name)
        header = (
            name.ljust(16)
            + str(EPOCH).ljust(12)
            + "0".ljust(6)
            + "0".ljust(6)
            + "100644".ljust(8)
            + str(len(data)).ljust(10)
        ).encode("ascii") + b"`\n"
        if len(header) != 60:
            fail("bad ar header length for " + name)
        out.write(header)
        out.write(data)
        if len(data) % 2:
            out.write(b"\n")
    return out.getvalue()


def check() -> None:
    """Cheap sanity checks so CI fails before producing a broken package."""
    problems = []

    json_files = ["usr/share/luci/menu.d/luci-app-opshare.json",
                  "usr/share/rpcd/acl.d/luci-app-opshare.json"]
    for rel in json_files:
        p = SRC / rel
        if not p.exists():
            problems.append("missing " + rel)
            continue
        try:
            json.loads(p.read_text(encoding="utf-8"))
        except Exception as exc:                      # noqa: BLE001
            problems.append("%s: %s" % (rel, exc))

    sh = shutil.which("sh")
    for rel, path in payload():
        data = blob(path)
        first = data.split(b"\n", 1)[0] if data else b""
        is_script = first.startswith(b"#!") and b"sh" in first
        if is_script:
            if sh:
                r = subprocess.run([sh, "-n", str(path)], capture_output=True)
                if r.returncode:
                    problems.append("%s: %s"
                                    % (rel, r.stderr.decode("utf-8", "replace").strip()))
        elif rel.startswith(EXEC_PREFIXES):
            problems.append("%s: installed 0755 but has no shell shebang" % rel)

    if problems:
        for p in problems:
            print("FAIL  " + p, file=sys.stderr)
        raise SystemExit(1)
    print("check   %d files, json ok, shell syntax ok" % len(payload()))


def build(legacy_ar: bool = False) -> list[pathlib.Path]:
    version = read_version()
    files = payload()

    size_kb = (sum(p.stat().st_size for _, p in files) + 1023) // 1024
    control = (PKG / "control.in").read_text(encoding="utf-8") \
        .replace("@VERSION@", version).replace("@SIZE@", str(size_kb))

    def content(rel: str, path: pathlib.Path) -> bytes:
        """Packaged bytes for one file.

        Only usr/share/opshare/version is ever rewritten: when --version is in
        play the in-package copy must carry the same value as the control file,
        otherwise the UI reports a different release than the one installed.
        """
        if rel == "usr/share/opshare/version":
            return (version + "\n").encode("utf-8")
        return blob(path)

    data = tar_bytes([(rel, content(rel, p), mode_for(rel)) for rel, p in files])

    # Maintainer scripts must keep these exact names and modes inside control.
    ctl = [("control", control.encode("utf-8"), 0o644),
           ("conffiles", blob(PKG / "conffiles"), 0o644)]
    for name in ("postinst", "prerm", "postrm"):
        body = blob(PKG / name)
        ctl.append((name, body, 0o755))
    ctl_gz = tar_bytes(ctl)

    DIST.mkdir(exist_ok=True)
    built = []

    # Modern container: gzip(tar) with the three members at the top level.
    # This is what OpenWrt >= 24.10 ships and what its opkg expects. Member
    # order mirrors the official packages: debian-binary first, then the two
    # tarballs (opkg scans them by name, but matching the reference costs
    # nothing and keeps hexdumps comparable).
    outer = tar_bytes([
        ("debian-binary", b"2.0\n", 0o644),
        ("data.tar.gz", data, 0o644),
        ("control.tar.gz", ctl_gz, 0o644),
    ], with_dirs=False, sort=False)
    out = DIST / ("%s_%s_all.ipk" % (NAME, version))
    out.write_bytes(outer)
    built.append(out)
    _report(out, version, len(files), size_kb)

    # Classic ar container, for 21.02 / 22.03 and other older opkg builds.
    # It goes into dist/legacy/ because it declares the same Package/Version as
    # the modern build: sitting in the same directory it would collide in the
    # generated feed index (two identical entries, one of which cannot install).
    if legacy_ar:
        old = ar_bytes([
            ("debian-binary", b"2.0\n"),
            ("control.tar.gz", ctl_gz),
            ("data.tar.gz", data),
        ])
        (DIST / "legacy").mkdir(parents=True, exist_ok=True)
        out2 = DIST / "legacy" / ("%s_%s_all_legacy.ipk" % (NAME, version))
        out2.write_bytes(old)
        built.append(out2)
        _report(out2, version, len(files), size_kb)

    return built


def _report(path: pathlib.Path, version: str, nfiles: int, size_kb: int) -> None:
    blob = path.read_bytes()
    digest = hashlib.sha256(blob).hexdigest()
    print("build   %s" % path.relative_to(ROOT).as_posix())
    print("        version %s  arch all  %d files  %d KB payload  %d KB package"
          % (version, nfiles, size_kb, (len(blob) + 1023) // 1024))
    print("        sha256 %s" % digest)
    (path.parent / (path.name + ".sha256")).write_text(
        "%s  %s\n" % (digest, path.name), encoding="utf-8")


if __name__ == "__main__":
    if "--check" in sys.argv:
        check()
        raise SystemExit(0)
    check()
    build(legacy_ar="--legacy-ar" in sys.argv)
