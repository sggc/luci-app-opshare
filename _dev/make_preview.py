"""Build a self-contained HTML preview from a merged snapshot.

Usage: python _dev/make_preview.py [snapshot.json] [out.html]
       (defaults: _dev/snapshot.json -> opshare-preview.html)
"""
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
WEB = ROOT / "src" / "www" / "opshare"
args = sys.argv[1:]
snap = pathlib.Path(args[0]) if args else ROOT / "_dev" / "snapshot.json"
data = snap.read_text(encoding="utf-8").strip()
html = (WEB / "index.html").read_text(encoding="utf-8")
css = (WEB / "style.css").read_text(encoding="utf-8")
js = (WEB / "app.js").read_text(encoding="utf-8")

# JSON is safe to inline as long as no literal </script> occurs
data = data.replace("</", "<\\/")

html = html.replace('<link rel="stylesheet" href="style.css">',
                    "<style>\n" + css + "\n</style>")
html = html.replace('<script src="app.js"></script>',
                    "<script>window.__OPSHARE_NO_AUTO__=true;\n"
                    "window.__OPSHARE_DATA__=" + data + ";</script>\n"
                    "<script>\n" + js + "\n</script>")

out = pathlib.Path(args[1]) if len(args) > 1 else ROOT / "opshare-preview.html"
out.write_text(html, encoding="utf-8")
print("wrote", out, len(html), "bytes")
