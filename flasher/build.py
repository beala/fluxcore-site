#!/usr/bin/env python3
"""Builds fluxcore.party: the landing page, the docs, and a static copy of the MeshCore web flasher
that serves firmware from your own releases.

  <out>/                        landing page (landing/)
  <out>/docs/                   docs page (flasher/docs), with the latest build filled in
  <out>/app/                    the fluxcore app (flasher/app): Bluetooth to a radio, aircraft on a map
  <out>/flash/                  the flasher, moved from / to /flash/ and restyled

The official flasher (meshcore-dev/flasher.meshcore.io) is a static site, but it gets its firmware
list from a server endpoint, /releases. This script replaces that endpoint with static files:

  <out>/flash/releases          JSON list of releases, as the flasher's /releases endpoint returns it
  <out>/flash/fw/<tag>/<file>   firmware files from those releases (same origin, so the browser can fetch them)
  <out>/flash/firmware/<file>   erase images and bootloaders referenced by the device catalog
  <out>/flash/config.json       the official device catalog, cut down to the devices in settings.json

Usage: build.py [--preview] <flasher checkout> <output dir>
--preview skips downloading firmware files; worker.js fetches them on demand instead (see dev.sh).
Set GITHUB_TOKEN to avoid API rate limits.
"""
import html
import json
import os
import re
import shutil
import socket
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).parent
OFFICIAL_STATIC = "https://flasher.meshcore.io/firmware"


# Errors worth another try: rate limiting and server-side failures. Anything else (404, 401, 403,
# a bad URL) fails at once, since trying again won't change the answer.
RETRY_STATUS = {429, 500, 502, 503, 504}
RETRY_WAITS = [5, 15, 30]   # seconds before each retry, so at most 4 attempts


def fetch(url, accept=None):
    headers = {"User-Agent": "fluxcore-flasher-build"}
    if accept:
        headers["Accept"] = accept
    if url.startswith("https://api.github.com/") and os.environ.get("GITHUB_TOKEN"):
        headers["Authorization"] = f"Bearer {os.environ['GITHUB_TOKEN']}"
    for attempt in range(len(RETRY_WAITS) + 1):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=120) as res:
                return res.read()
        except urllib.error.HTTPError as e:
            if e.code not in RETRY_STATUS or attempt == len(RETRY_WAITS):
                raise
            wait = RETRY_WAITS[attempt]
            if e.code == 429 and (e.headers.get("Retry-After") or "").isdigit():
                wait = min(int(e.headers["Retry-After"]), 60)
            reason = f"HTTP {e.code}"
        except (urllib.error.URLError, socket.timeout, ConnectionError) as e:
            if attempt == len(RETRY_WAITS):
                raise
            wait = RETRY_WAITS[attempt]
            reason = str(getattr(e, "reason", e))
        print(f"fetch {url}: {reason}, retrying in {wait} s", file=sys.stderr)
        time.sleep(wait)


# Links to the docs and the home page, pinned to a corner of the flasher
CORNER_LINKS = ('<div class="fc-corner"><a href="/">fluxcore.party</a>'
                '<a class="fc-primary" href="/docs/">Docs &amp; what\'s different</a></div>')

# fluxcore logo, in place of the MeshCore logo image in the flasher's header
LOGO_OLD = '<img :src="`/flash/img/${logoFile}`" v-if="!isIframe"> <span>flasher</span>'
LOGO_NEW = ('<span class="fc-logo"><a href="/">fluxcore<span class="fc-cursor"></span></a>'
            '<span class="fc-sub">flasher</span></span>')


def theme(page):
    """Restyles the flasher page to match fluxcore.party (flasher/theme/fluxcore.css)."""
    for old, new in [
        ('<link href="/flash/css/flasher.css" rel="stylesheet">',
         '<link href="/flash/css/flasher.css" rel="stylesheet">\n  <link href="/flash/css/fluxcore.css" rel="stylesheet">'),
        ('<body class="dark">', '<body class="dark fluxcore">'),
        (LOGO_OLD, LOGO_NEW),
    ]:
        if old not in page:
            print(f"WARNING: flasher page changed, theme step skipped: {old}")
        page = page.replace(old, new, 1)
    return page.replace("</body>", CORNER_LINKS + "</body>", 1)


# The flasher's own words for the firmware it flashes: fluxcore here (links to MeshCore's tools and PRs stay)
TEXT_PATCHES = [
    ("index.html", "simply updating your MeshCore device", "simply updating your fluxcore device"),
    ("index.html", "erase your MeshCore identity", "erase your fluxcore identity"),
    ("index.html", "New to Meshcore?", "New to fluxcore?"),
    ("js/app.js", "Welcome to MeshCore serial console.", "Welcome to the fluxcore serial console."),
    ("js/app.js", "You can flash MeshCore now.", "You can flash fluxcore now."),
    ("js/catalog.js", 'href="https://github.com/meshcore-dev/MeshCore">Community firmware</a>',
     'href="https://github.com/beala/MeshCore">fluxcore firmware</a>'),
    ("config.json", "Please do not flash MeshCore firmware", "Please do not flash fluxcore firmware"),
]


def patch_text(out):
    for name, old, new in TEXT_PATCHES:
        f = out / name
        text = f.read_text()
        if old not in text:
            print(f"WARNING: flasher text changed, not replaced in {name}: {old}")
            continue
        f.write_text(text.replace(old, new))


BASE = "/flash"   # where the flasher lives on the site
BASE_RE = BASE.replace("/", "\\/")   # BASE inside a JavaScript regex literal

# The flasher is written to sit at the site root. These move it under BASE: the paths of its own
# files, and its router, which keeps the selection in the URL path (/device/role/version).
ROOT_PATH = re.compile(r"""(['"`])/(lib/|js/|css/|img/|flasher\.js|releases|\$\{configName\}\.json)""")
ROUTER_PATCHES = [
    ("export const CONSOLE_PATH = '/console';", f"export const CONSOLE_PATH = '{BASE}/console';"),
    ("  if(!device) return '/';\n  let path = `/",
     f"  if(!device) return '{BASE}/';\n  let path = `{BASE}/"),
    ("export function parsePath(config, path) {",
     f"export function parsePath(config, path) {{\n  path = path.replace(/^{BASE_RE}/, '');"),
    ("export function isSamePage(pathA, pathB) {",
     f"export function isSamePage(pathA, pathB) {{\n  pathA = pathA.replace(/^{BASE_RE}/, '');"
     f"\n  pathB = pathB.replace(/^{BASE_RE}/, '');"),
]
APP_PATCHES = [
    ("if(currentVersion.value?.customFile) return '/';", f"if(currentVersion.value?.customFile) return '{BASE}/';"),
]


def patch(path, patches):
    code = path.read_text()
    for old, new in patches:
        if old not in code:
            sys.exit(f"Flasher changed, can't move it under {BASE}: {path.name} has no {old!r}")
        code = code.replace(old, new, 1)
    path.write_text(code)


def move_under_base(flasher):
    """Rewrites the flasher's root-relative paths to BASE."""
    for f in [flasher / "index.html", flasher / "flasher.js", *(flasher / "js").glob("*.js")]:
        f.write_text(ROOT_PATH.sub(lambda m: f"{m.group(1)}{BASE}/{m.group(2)}", f.read_text()))
    patch(flasher / "js" / "router.js", ROUTER_PATCHES)
    patch(flasher / "js" / "app.js", APP_PATCHES)


def latest_build_html(release):
    """Summary of a release for the docs page: its name, and the branches it was built from."""
    name = html.escape(release["name"] or release["tag_name"])
    out = f'<p><a href="{html.escape(release["html_url"])}"><strong>{name}</strong></a>'
    out += f' &middot; tag <code>{html.escape(release["tag_name"])}</code></p>'
    body = release["body"] or ""
    branches = re.findall(r"^- \[([^\]]+)\]\((https?://[^)\s]+)\)", body, re.M)
    since = re.search(r"^Changes since (\S+):", body, re.M)
    if branches:   # older releases, built from upstream dev plus a list of branches
        out += "<p>Built from upstream <code>dev</code> plus:</p><ul>"
        out += "".join(f'<li><a href="{html.escape(u)}"><code>{html.escape(b)}</code></a></li>' for b, u in branches)
        out += "</ul>"
    elif since:    # releases from beala/main list what changed since the previous one
        changes = re.findall(r"^- (.+)$", body[since.end():], re.M)
        out += f"<p>Changes since <code>{html.escape(since.group(1))}</code>:</p><ul>"
        out += "".join(f"<li>{html.escape(c)}</li>" for c in changes)
        out += "</ul>"
    diff = re.search(r"https://github\.com/\S+/compare/\S+", release["body"] or "")
    if diff:
        out += f'<p><a href="{html.escape(diff.group(0))}">Full diff against upstream</a></p>'
    return out


def release_label(release):
    """'2026-11-02 14:05 UTC (fd14442)': date and time, so builds from the same day can be told apart."""
    when = (release.get("published_at") or release["created_at"]).replace("T", " ")[:16]
    sha = release["tag_name"].split("-", 1)[-1]
    return f"{when} UTC ({sha})"


def release_source_key(firmware):
    return next((k for k in firmware if k.startswith("github")), None)


def main(flasher_dir, out_dir, preview=False):
    settings = json.loads((HERE / "settings.json").read_text())
    flasher_dir, site = Path(flasher_dir), Path(out_dir)
    out = site / BASE.strip("/")

    # 1. Landing page, and the flasher itself
    if site.exists():
        shutil.rmtree(site)
    shutil.copytree(HERE.parent / "landing", site)
    shutil.copytree(flasher_dir, out, ignore=shutil.ignore_patterns(".git", ".github"))
    move_under_base(out)
    patch_text(out)
    index = out / "index.html"
    page = re.sub(r"<title>.*?</title>", f"<title>{settings['title']}</title>", index.read_text(), count=1)
    page = theme(page)
    index.write_text(page)
    shutil.copy(HERE / "theme" / "fluxcore.css", out / "css" / "fluxcore.css")
    # The flasher keeps its state in the URL path (/flash/device/role/version). There are no files at
    # those paths: worker.js serves /flash/index.html for them.
    # The release list and catalog are fetched by script, and a host may let browsers cache them for
    # minutes (a hard refresh doesn't cover script fetches). Revalidate every time instead: the
    # browser keeps its copy and only re-downloads when the file changed.
    util = out / "js" / "util.js"
    code = util.read_text()
    if "const res = await fetch(url);" in code:
        util.write_text(code.replace("const res = await fetch(url);", "const res = await fetch(url, { cache: 'no-cache' });", 1))
    else:
        print("WARNING: flasher's fetchJson changed, release list may be cached for up to 10 minutes")

    # 2. Device catalog: only our devices, and only firmware that comes from GitHub releases
    config = json.loads((out / "config.json").read_text())
    by_name = {d["name"]: d for d in config["device"]}
    # Boards the official catalog doesn't have: a copy of a similar official entry (bootloaders,
    # erase image, picture) with its own name and firmware files
    for extra in settings.get("extra_devices", []):
        base = by_name.get(extra["like"])
        if base is None:
            sys.exit(f"extra_devices: {extra['name']} is like {extra['like']}, which isn't in the flasher catalog")
        device = json.loads(json.dumps(base))
        device.update({k: v for k, v in extra.items() if k not in ("like", "maker_name")})
        by_name[extra["name"]] = device
        if device.get("maker") and device["maker"] not in config.get("maker", {}):   # a maker the catalog lacks
            config.setdefault("maker", {})[device["maker"]] = {"name": extra.get("maker_name", device["maker"])}
    missing = [n for n in settings["devices"] if n not in by_name]
    if missing:
        sys.exit(f"Devices not in the flasher catalog (check the names): {missing}")
    devices = []
    for name in settings["devices"]:
        device = by_name[name]
        device["firmware"] = [fw for fw in device["firmware"] if release_source_key(fw)]
        if device.get("icon", "").startswith("/"):
            device["icon"] = BASE + device["icon"]
        if "tooltip" in device:   # the board picture shown on hover: <img src='/img/...'>
            device["tooltip"] = re.sub(r"""(src=['"])/(?!/)""", rf"\1{BASE}/", device["tooltip"])
        devices.append(device)
    config["device"] = devices
    config["staticPath"] = BASE + config["staticPath"]   # erase images and bootloaders, under /flash/firmware
    (out / "config.json").write_text(json.dumps(config, indent=1))

    patterns = [re.compile(p) for d in devices for fw in d["firmware"]
                for p in fw[release_source_key(fw)]["files"].values()]
    release_types = sorted({fw[release_source_key(fw)]["type"] for d in devices for fw in d["firmware"]})

    # 3. Erase images and bootloaders, copied from the official flasher
    static_files = set()
    for d in devices:
        if d.get("erase"):
            static_files.add(d["erase"])
        static_files.update(d.get("bootloader", []))
    (out / "firmware").mkdir(exist_ok=True)
    for name in sorted(static_files):
        if preview:
            continue
        try:
            (out / "firmware" / name).write_bytes(fetch(f"{OFFICIAL_STATIC}/{name}"))
            print(f"static   {name}")
        except Exception as e:  # keep going: the flasher still works, only that link breaks
            print(f"WARNING: could not copy {name}: {e}")

    # 4. Our releases, newest first
    api = f"https://api.github.com/repos/{settings['firmware_repo']}/releases?per_page=100"
    releases = [r for r in json.loads(fetch(api, "application/vnd.github+json"))
                if not r["draft"] and r["tag_name"].startswith(settings["release_tag_prefix"])]
    # GitHub's order isn't reliably by date, and the flasher shows them in the order given
    # (first one selected), so sort by when each was published, newest first.
    releases.sort(key=lambda r: r.get("published_at") or r["created_at"], reverse=True)
    releases = releases[: settings["keep_releases"]]
    if not releases:
        sys.exit(f"No releases tagged {settings['release_tag_prefix']}* in {settings['firmware_repo']}")

    # Only firmware the newest release has: a role or board we no longer build drops out of the flasher
    # (the official catalog offers every role for its devices; we build a few)
    newest = [a["name"] for a in releases[0]["assets"]]
    for d in devices:
        d["firmware"] = [fw for fw in d["firmware"]
                         if any(re.search(p, n) for p in fw[release_source_key(fw)]["files"].values() for n in newest)]
        if not d["firmware"]:
            print(f"WARNING: {d['name']}: nothing in {releases[0]['tag_name']}")
    config["device"] = [d for d in devices if d["firmware"]]
    (out / "config.json").write_text(json.dumps(config, indent=1))
    patterns = [re.compile(p) for d in devices for fw in d["firmware"]
                for p in fw[release_source_key(fw)]["files"].values()]
    release_types = sorted({fw[release_source_key(fw)]["type"] for d in devices for fw in d["firmware"]})

    catalog = []
    for r in releases:
        tag = r["tag_name"]
        files = []
        for asset in r["assets"]:
            if not any(p.search(asset["name"]) for p in patterns):
                continue
            dest = out / "fw" / tag / asset["name"]
            dest.parent.mkdir(parents=True, exist_ok=True)
            if not preview:
                dest.write_bytes(fetch(asset["browser_download_url"]))
            files.append({"name": asset["name"], "url": f"{BASE}/fw/{tag}/{asset['name']}"})
        print(f"release  {tag}: {len(files)} files")
        # The flasher shows notes as plain text with URLs auto-linked, so flatten Markdown links
        notes = re.sub(r"\[([^\]]+)\]\((https?://[^)\s]+)\)", r"\1: \2", r["body"] or "")
        # One release holds every role, so list it once per release type the catalog asks for
        for t in release_types:
            label = release_label(r)
            catalog.append({"version": label, "type": t, "name": label,
                            "notes": notes, "files": files})

    (out / "releases").write_text(json.dumps(catalog))

    # 5. Docs page
    docs = site / "docs"
    shutil.copytree(HERE / "docs", docs)
    page = (docs / "index.html").read_text()
    (docs / "index.html").write_text(page.replace("<!--LATEST-->", latest_build_html(releases[0])))

    # 6. The app (/app/): Bluetooth to a fluxcore radio, aircraft on a map. Static files as they are
    shutil.copytree(HERE / "app", site / "app")


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if a != "--preview"]
    if len(args) != 2:
        sys.exit(__doc__)
    main(*args, preview="--preview" in sys.argv)
