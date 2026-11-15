#!/usr/bin/env python3
"""Keep the three descriptions of the data contract in sync.

The merged snapshot crosses a language boundary with nothing in between:

    shell (src/usr/bin/*)         -> writes /tmp/opshare/all.json
    awk  (usr/libexec/rpcd/*)     -> pulls scalars out of that file by regex
    JS   (src/www/opshare/app.js) -> renders the same file
    docs/ubus-api.md              -> promises field names to a mobile app

There is no compiler and no schema on that path, so renaming a field on one
side fails silently: awk returns 0, JS renders an empty column, and the tests
still pass because they run against a recorded snapshot of the *old* shape.
This script is the missing check. It deliberately reads the real sources
rather than a hand-written schema, so there is no fourth copy to drift.

Checks:
  1. rpcd's method table and the ACL grant exactly the same method names.
  2. every field `info` pulls out of all.json exists in the fixture.
  3. the required field paths exist in the fixture.
  4. every required field name appears in the API documentation.
  5. the empty-payload skeleton has the same top-level keys as the fixture.
  6. every fenced ```json example in the docs is valid JSON.

Run: python _dev/check-contract.py
"""
from __future__ import annotations

import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SNAPSHOT = ROOT / "_dev/snapshot.json"
RPCD = ROOT / "src/usr/libexec/rpcd/opshare"
ACL = ROOT / "src/usr/share/rpcd/acl.d/luci-app-opshare.json"
DOC = ROOT / "docs/ubus-api.md"

# Paths the rest of the system cannot work without. [] means "a list whose
# elements are objects". This is the only hand-maintained list in the check;
# everything else is derived from the sources.
REQUIRED = [
    "schema", "updated", "ui", "aliases", "meta", "nodes",
    "meta.topology", "meta.master",
    "ui.eff_mode", "ui.live_ms", "ui.interval",
    "ui.fast_interval", "ui.fast_traffic", "ui.power", "ui.auto_peers",
    "nodes[]._meta.section", "nodes[]._meta.self", "nodes[]._meta.online",
    "nodes[].node.wan_ip", "nodes[].node.lan_ip", "nodes[].node.hostname",
    "nodes[].radios[].ssid",
    "nodes[].clients[].mac", "nodes[].clients[].ip",
    "nodes[].clients[].hostname", "nodes[].clients[].signal",
    "nodes[].leases[].mac",
    "nodes[].traffic[].ifname", "nodes[].traffic[].rx_total",
]

results: list[tuple[str, bool, str]] = []


def record(name: str, problems: list[str], detail: str = "") -> None:
    results.append((name, not problems, detail))
    if problems:
        for p in problems:
            print("  FAIL " + p, file=sys.stderr)


def all_keys(o) -> set[str]:
    out: set[str] = set()
    if isinstance(o, dict):
        for k, v in o.items():
            out.add(k)
            out |= all_keys(v)
    elif isinstance(o, list):
        for v in o:
            out |= all_keys(v)
    return out


def has_path(data, path: str) -> bool:
    cur = [data]
    for seg in path.split("."):
        is_list = seg.endswith("[]")
        key = seg[:-2] if is_list else seg
        nxt = []
        for obj in cur:
            if not isinstance(obj, dict) or key not in obj:
                continue
            v = obj[key]
            if is_list:
                if isinstance(v, list) and v:
                    nxt.extend(v)
            else:
                nxt.append(v)
        cur = nxt
        if not cur:
            return False
    return bool(cur)


def main() -> int:
    for p in (SNAPSHOT, RPCD, ACL, DOC):
        if not p.is_file():
            print("missing input: %s" % p, file=sys.stderr)
            return 1

    fixture = json.loads(SNAPSHOT.read_text(encoding="utf-8"))
    keys = all_keys(fixture)
    rpcd = RPCD.read_text(encoding="utf-8")
    doc = DOC.read_text(encoding="utf-8")

    # 1. methods advertised by the plugin must be exactly what the ACL grants.
    # A new method with no ACL entry is invisible to a phone, which is a silent
    # failure - ubus returns "Access denied" only after the app already calls it.
    listed = re.findall(r"echo\s+'(\{.*?\})'", rpcd)
    methods = sorted(json.loads(listed[0]).keys()) if listed else []
    # ACL files wrap everything in a named group object, so look inside each
    # group rather than assuming read/ubus sits at the top level.
    acl_doc = json.loads(ACL.read_text(encoding="utf-8"))
    groups = [g for g in acl_doc.values() if isinstance(g, dict)]
    granted = sorted({m for g in groups
                      for m in g.get("read", {}).get("ubus", {}).get("opshare", [])})
    writes = sorted({m for g in groups
                     for m in g.get("write", {}).get("ubus", {}).get("opshare", [])})
    bad = []
    if not methods:
        bad.append("could not parse the rpcd list method table")
    if methods != granted:
        bad.append("rpcd advertises %s but ACL grants %s" % (methods, granted))
    if writes:
        bad.append("ACL grants write methods %s but the interface is read-only"
                   % writes)
    record("ubus 方法表与 ACL 一致", bad, ", ".join(methods))

    # 2. info_json() scrapes all.json with awk regexes. A key that is not there
    # makes awk return "0" or "" rather than an error - this is how `info`
    # once reported nodes:1 / mode:off on a passive node.
    scraped = sorted(set(re.findall(r'\b(?:num|str)\(buf,\s*"([^"]+)"\)', rpcd)))
    missing = [k for k in scraped if k not in keys]
    record("info 抠取的字段都在数据里",
           ["%s is scraped by rpcd but absent from the snapshot" % k
            for k in missing],
           "%d fields" % len(scraped))

    # 3. the fixture must still have the shape the renderer and the app need.
    # This is what caught the anonymiser flattening public WAN addresses.
    missing_paths = [p for p in REQUIRED if not has_path(fixture, p)]
    record("必需字段路径齐全",
           ["%s missing from snapshot" % p for p in missing_paths],
           "%d paths" % len(REQUIRED))

    # 4. the same names must be documented. Backticked identifiers only, so
    # prose mentions and command names do not count as coverage.
    # Fenced blocks use triple backticks too; without stripping them first the
    # single-backtick regex spans whole code blocks and swallows every field
    # name in between, so the token set comes out empty.
    prose = re.sub(r"```.*?```", "", doc, flags=re.S)
    tokens = {t for t in re.findall(r"`([^`]+)`", prose)
              if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_.\[\]]*", t)}
    undocumented = []
    for path in REQUIRED:
        field = path.split(".")[-1]
        if not any(t == field or t.endswith("." + field) for t in tokens):
            undocumented.append("%s (from %s)" % (field, path))
    record("字段都在接口文档里",
           ["%s is not mentioned in docs/ubus-api.md" % x
            for x in undocumented],
           "%d documented tokens" % len(tokens))

    # 5. when there is no data yet, rpcd returns a hard-coded empty skeleton.
    # If it loses a key that the real payload has, a client polling during the
    # first few seconds sees a different shape than it does afterwards.
    m = re.search(r"empty_all='([^']*)'", rpcd)
    bad = []
    if not m:
        bad.append("could not parse empty_all in the rpcd plugin")
    else:
        skeleton = set(json.loads(m.group(1)).keys())
        actual = set(fixture.keys())
        if skeleton != actual:
            bad.append("empty_all has %s, real payload has %s"
                       % (sorted(skeleton ^ actual), sorted(actual)))
    record("空数据骨架与真实载荷同形", bad,
           ", ".join(sorted(fixture.keys())))

    # 6. examples in the API doc are what an app developer copies first.
    # \s* before the closing fence: some examples sit inside an indented list.
    blocks = re.findall(r"```json\s*\n(.*?)\n\s*```", doc, re.S)
    bad = []
    for i, block in enumerate(blocks, 1):
        try:
            json.loads(block)
            continue
        except json.JSONDecodeError:
            pass
        for line in (l.strip() for l in block.splitlines() if l.strip()):
            try:
                json.loads(line)
            except json.JSONDecodeError as exc:
                bad.append("json example #%d: %s" % (i, exc))
    record("文档 JSON 示例合法", bad, "%d blocks" % len(blocks))

    for name, ok, detail in results:
        print("[%s] %s%s" % ("OK  " if ok else "FAIL", name,
                             "  " + detail if detail else ""))
    failed = sum(1 for _, ok, _ in results if not ok)
    print("%d checks, %d failed" % (len(results), failed))
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
