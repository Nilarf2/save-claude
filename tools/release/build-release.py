#!/usr/bin/env python3
"""Build offline/Toy/VibeHub packages from an explicit runtime allowlist.

This command only writes local artifacts. It never uploads or publishes.
"""
from __future__ import annotations

import argparse
import hashlib
import html
import json
import re
import shutil
import zipfile
from pathlib import Path
from html.parser import HTMLParser
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[2]
WEB_FILES = ("index.html", "start.js", "game.js", "engine-runtime.js", "style.css", "story.json", "character-portraits.json")
HASH_LENGTH = 16


def fingerprint_name(logical: str, data: bytes) -> str:
    """Names depend on final shipped bytes, never the release version/date."""
    path = Path(logical)
    digest = hashlib.sha256(data).hexdigest()[:HASH_LENGTH]
    return path.with_name(f"{path.stem}.{digest}{path.suffix}").as_posix()


def mapped_url(value: str, mapping: dict[str, str]) -> str:
    parts = urlsplit(value)
    if parts.scheme or parts.netloc or value.startswith(("/", "#")):
        return value
    logical = unquote(parts.path).removeprefix("./")
    target = mapping.get(logical)
    if target is None:
        return value
    return target + ("?" + parts.query if parts.query else "") + ("#" + parts.fragment if parts.fragment else "")


URL_ATTR = re.compile(r"(\b(?:src|href|poster)\s*=\s*)(['\"])(.*?)\2", re.IGNORECASE)
CSS_URL = re.compile(r"url\(\s*(['\"]?)([^'\")\s]+)\1\s*\)", re.IGNORECASE)
JS_IMPORT = re.compile(r"\b(?:from\s*|import\s*\(\s*|import\s*)['\"]([^'\"]+)['\"]")


def rewrite_html(text: str, mapping: dict[str, str]) -> str:
    return URL_ATTR.sub(lambda m: m[1] + m[2] + html.escape(mapped_url(html.unescape(m[3]), mapping), quote=True) + m[2], text)


def rewrite_css(text: str, mapping: dict[str, str]) -> str:
    return CSS_URL.sub(lambda m: 'url("' + mapped_url(m[2], mapping) + '")', text)


def prepare_resources(assets: list[str]) -> tuple[dict[str, str], dict[str, bytes]]:
    """Build the external ESM dependency graph bottom-up, with no import map."""
    mapping: dict[str, str] = {}
    payload: dict[str, bytes] = {}

    def add(logical: str, data: bytes, fingerprint: bool = True):
        published = fingerprint_name(logical, data) if fingerprint else logical
        if published in payload and payload[published] != data:
            raise ValueError("Fingerprint collision: " + published)
        mapping[logical] = published
        payload[published] = data

    for logical in assets:
        # Attribution/license documents retain readable stable names and bytes.
        add(logical, (ROOT / "web" / logical).read_bytes(), Path(logical).suffix.lower() not in {".txt", ".md"})
    for logical in ("story.json", "character-portraits.json"):
        add(logical, (ROOT / "web" / logical).read_bytes())
    # The committed browser bundle avoids bare imports and inline-import-map
    # restrictions, and ordinary filenames avoid uploaders skipping dist/.
    add("engine-runtime.js", (ROOT / "web/engine-runtime.js").read_bytes())
    game = (ROOT / "web/game.js").read_text(encoding="utf-8")
    game, count = re.subn(r"(\bfrom\s*['\"])\./engine-runtime\.js(['\"])", lambda m: m[1] + "./" + mapping["engine-runtime.js"] + m[2], game)
    if count != 1:
        raise ValueError("Expected one engine-runtime.js import in game.js")
    add("game.js", game.encode("utf-8"))
    start = (ROOT / "web/start.js").read_text(encoding="utf-8")
    start, count = re.subn(r"(import\(\s*['\"])\./game\.js(['\"]\s*\))", lambda m: m[1] + "./" + mapping["game.js"] + m[2], start)
    if count != 1:
        raise ValueError("Expected one game.js dynamic import in start.js")
    add("start.js", start.encode("utf-8"))
    add("style.css", rewrite_css((ROOT / "web/style.css").read_text(encoding="utf-8"), mapping).encode("utf-8"))
    add("platform-vibehub.js", (ROOT / "tools/release/platform-vibehub.js").read_bytes())
    return mapping, payload


class ReleaseHTML(HTMLParser):
    def __init__(self):
        super().__init__()
        self.references = []
        self.has_importmap = False
        self.assets = {}
        self._script = None
        self._text = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        for name in ("src", "href", "poster"):
            if attrs.get(name):
                self.references.append(attrs[name])
        if tag == "script":
            self.has_importmap |= attrs.get("type") == "importmap"
            self._script = attrs.get("id") == "release-assets"
            self._text = []

    def handle_data(self, data):
        if self._script:
            self._text.append(data)

    def handle_endtag(self, tag):
        if tag == "script" and self._script:
            value = json.loads("".join(self._text))
            self.assets.update(value)
            self._script = None


def validate_references(dist: Path) -> None:
    """Check emitted HTML, the known ESM graph, CSS and the runtime asset map.

    Dynamic game paths are covered by the resolver contract and runtime tests;
    this is deliberately not a general JavaScript or HTML dependency parser.
    """
    def local_file(reference: str, owner: Path) -> Path | None:
        parts = urlsplit(reference)
        if parts.scheme or parts.netloc or not parts.path:
            return None
        path = (owner.parent / unquote(parts.path)).resolve()
        if not path.is_relative_to(dist.resolve()) or not path.is_file():
            raise ValueError(f"Missing/nonlocal release reference: {owner.relative_to(dist)} -> {reference}")
        return path

    entry = ReleaseHTML()
    entry.feed((dist / "index.html").read_text(encoding="utf-8"))
    if entry.has_importmap:
        raise ValueError("Release entry requires external ESM, not an inline import map")
    for value in entry.assets.values():
        local_file(value, dist / "index.html")
    for path in dist.glob("*.html"):
        page = ReleaseHTML()
        page.feed(path.read_text(encoding="utf-8"))
        for reference in page.references:
            local_file(reference, path)
    for path in dist.rglob("*.css"):
        for match in CSS_URL.finditer(path.read_text(encoding="utf-8")):
            local_file(match[2], path)
    for path in dist.rglob("*.js"):
        for match in JS_IMPORT.finditer(path.read_text(encoding="utf-8")):
            specifier = match[1]
            if specifier.startswith((".", "/")):
                local_file(specifier, path)
            elif not urlsplit(specifier).scheme:
                raise ValueError("Unmapped release module: " + specifier)
    # game.js resolves these logical document names through the injected map.
    for name in ("story.json", "character-portraits.json"):
        if name not in entry.assets:
            raise ValueError("Missing release document mapping: " + name)
        document = local_file(entry.assets[name], dist / "index.html")

        def check_logical_assets(value):
            if isinstance(value, dict):
                for item in value.values():
                    check_logical_assets(item)
            elif isinstance(value, list):
                for item in value:
                    check_logical_assets(item)
            elif isinstance(value, str) and value.startswith("assets/"):
                # Match the game's existing image/audio suffix normalization.
                logical = re.sub(r"\.(ogg|wav)$", ".mp3", value, flags=re.IGNORECASE)
                logical = re.sub(r"\.(png|jpg|jpeg)$", ".webp", logical, flags=re.IGNORECASE)
                if logical not in entry.assets:
                    raise ValueError(f"Missing logical release asset mapping: {name} -> {logical}")

        check_logical_assets(json.loads(document.read_text(encoding="utf-8")))


def write_manifest(dist: Path, mapping: dict[str, str]) -> None:
    reverse = {published: logical for logical, published in mapping.items()}
    files = {}
    for path in sorted(p for p in dist.rglob("*") if p.is_file()):
        published = path.relative_to(dist).as_posix()
        data = path.read_bytes()
        files[reverse.get(published, published)] = {
            "path": published, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest(),
            "fingerprinted": published in reverse and published != reverse[published],
        }
    manifest = {"schemaVersion": 1, "hashAlgorithm": "sha256", "fingerprintHexLength": HASH_LENGTH,
                "note": "Inventory excludes this manifest; cache reuse still depends on the hosting platform.", "files": files}
    (dist / "release-manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def copy(source: Path, target: Path) -> None:
    if not source.is_file():
        raise ValueError(f"Missing release input: {source.relative_to(ROOT)}")
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, target)


def asset_paths(story: dict, portraits: dict) -> list[str]:
    paths = set()
    for entry in story["assets"].values():
        source = entry.get("src", "")
        if not source:
            continue
        if entry.get("type") == "audio":
            source = re.sub(r"\.(ogg|wav)$", ".mp3", source)
        paths.add(source)

    def walk(value):
        if isinstance(value, dict):
            for item in value.values():
                walk(item)
        elif isinstance(value, list):
            for item in value:
                walk(item)
        elif isinstance(value, str) and value.startswith("assets/"):
            paths.add(value)

    walk(portraits)
    paths.update("assets/sfx/" + name + ".mp3" for name in ["page", "click", "choice", "bell"])
    paths.update(["assets/cover/title.webp", "assets/fonts/story-serif.woff2", "assets/fonts/OFL.txt", "assets/fonts/NOTICE.txt"])
    css = (ROOT / "web/style.css").read_text(encoding="utf-8")
    for source in re.findall(r"url\(\s*['\"]?([^'\")\s]+)", css):
        if source.startswith("assets/"):
            paths.add(source)
    assets_root = (ROOT / "web/assets").resolve()
    for source in paths:
        path = (ROOT / "web" / source).resolve()
        if not path.is_relative_to(assets_root) or not path.is_file():
            raise ValueError("Missing or nonlocal runtime asset: " + source)
    return sorted(paths)


def zip_directory(folder: Path, archive: Path) -> dict:
    files = sorted(p for p in folder.rglob("*") if p.is_file())
    forbidden = {".env", ".git", "node_modules", "refs", "raw", "tools", "credentials.env"}
    for path in files:
        if any(part in forbidden or part.startswith(".env.") for part in path.relative_to(folder).parts):
            raise ValueError("Private/development path in runtime package")
    with zipfile.ZipFile(archive, "x", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as bundle:
        for path in files:
            bundle.write(path, path.relative_to(folder).as_posix())
    return {"files": len(files), "unpackedBytes": sum(p.stat().st_size for p in files), "zipBytes": archive.stat().st_size}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out-dir", type=Path, required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--slug", default="save-claude", help="Proposed VibeHub project slug; confirm before deployment")
    parser.add_argument("--check-only", action="store_true", help="Check release inputs without writing a package")
    args = parser.parse_args()
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", args.version):
        parser.error("Invalid version")
    if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", args.slug):
        parser.error("Invalid project slug")
    out = args.out_dir.resolve()
    if out == ROOT or out.is_relative_to((ROOT / "web").resolve()):
        parser.error("Choose a separate output directory")
    story = json.loads((ROOT / "web/story.json").read_text(encoding="utf-8"))
    portraits = json.loads((ROOT / "web/character-portraits.json").read_text(encoding="utf-8"))
    assets = asset_paths(story, portraits)
    required = [ROOT / "web" / p for p in WEB_FILES]
    required += [ROOT / "marketing/release" / p for p in ["cover-16x9.jpg", "cover-4x3.jpg", "icon.jpg"]]
    required += [ROOT / p for p in ["LICENSE", "ASSET-LICENSE.md", "SOURCE-NOTICE.md", "assets/ASSET-SOURCES.json", "vendor/general-engine/LICENSE", "vendor/general-engine/PROVENANCE.json"]]
    required += [ROOT / "web/portraits.html", ROOT / "tools/release/platform-vibehub.js"]
    required += [ROOT / "marketing" / p for p in ["description.md", "release-notes.md", "platforms.json"]]
    for path in required:
        if not path.is_file():
            raise ValueError("Missing release input: " + str(path.relative_to(ROOT)))
    upstream = json.loads((ROOT / "vendor/general-engine/PROVENANCE.json").read_text(encoding="utf-8"))
    mapping, payload = prepare_resources(assets)
    if args.check_only:
        print(json.dumps({"ok": True, "runtimeAssets": len(assets), "fingerprintedFiles": sum(a != b for a, b in mapping.items()), "nodes": len(story["nodes"]), "publishing": False}))
        return
    if out.exists():
        raise ValueError("Output already exists; use a new version directory: " + str(out))
    out.mkdir(parents=True)
    outputs = []
    for platform in ["offline", "toy", "vibehub"]:
        dist = out / platform
        dist.mkdir()
        for name, data in payload.items():
            if name == mapping["platform-vibehub.js"] and platform != "vibehub":
                continue
            target = dist / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
        index = rewrite_html((ROOT / "web/index.html").read_text(encoding="utf-8"), mapping)
        # Read synchronously by game.js; development pages have no map and keep
        # using original logical URLs. Escape '<' to prevent script termination.
        asset_map = {name: mapping[name] for name in [*assets, "story.json", "character-portraits.json"]}
        asset_json = json.dumps(asset_map, ensure_ascii=False, separators=(",", ":")).replace("<", "\\u003c")
        asset_script = '<script type="application/json" id="release-assets">' + asset_json + '</script>\n'
        if index.count("</head>") != 1 or 'id="release-assets"' in index:
            raise ValueError("Unexpected release HTML head/assets map")
        index = index.replace("</head>", asset_script + "</head>")
        if platform == "vibehub":
            bridge = (
                '<script async id="vibehub-sdk" src="https://gamesvibe.app/sdk/v3/vibehub.js"></script>\n'
                '<script defer src="' + mapping["platform-vibehub.js"] + '" data-work="' + html.escape(args.slug, quote=True) + '"></script>\n'
            )
            index = index.replace("</head>", bridge + "</head>")
        (dist / "index.html").write_text(index, encoding="utf-8")
        copy(ROOT / "LICENSE", dist / "LICENSE-code.txt")
        copy(ROOT / "SOURCE-NOTICE.md", dist / "SOURCE-NOTICE.md")
        asset_license = (ROOT / "ASSET-LICENSE.md").read_text(encoding="utf-8").replace("(web/assets/fonts/", "(assets/fonts/")
        for name in assets:
            asset_license = asset_license.replace("(" + name + ")", "(" + mapping[name] + ")")
        (dist / "ASSET-LICENSE.md").write_text(asset_license, encoding="utf-8")
        copy(ROOT / "assets/ASSET-SOURCES.json", dist / "assets/ASSET-SOURCES.json")
        copy(ROOT / "vendor/general-engine/LICENSE", dist / "engine/LICENSE")
        copy(ROOT / "vendor/general-engine/PROVENANCE.json", dist / "engine/PROVENANCE.json")
        for name in ["cover-16x9.jpg", "cover-4x3.jpg", "icon.jpg"]:
            copy(ROOT / "marketing/release" / name, dist / "media" / name)
        for screenshot in sorted((ROOT / "marketing/release/screenshots").glob("*.png")):
            copy(screenshot, dist / "media/screenshots" / screenshot.name)
        release = {"version": args.version, "gameId": story["id"], "contentVersion": story["version"], "start": story["start"], "nodes": len(story["nodes"]), "runtimeAssets": len(assets), "platform": platform, "engineCommit": upstream["commit"], "manifest": "release-manifest.json"}
        (dist / "release.json").write_text(json.dumps(release, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        if platform == "offline":
            (dist / "portraits.html").write_text(rewrite_html((ROOT / "web/portraits.html").read_text(encoding="utf-8"), mapping), encoding="utf-8")
            (dist / "run.py").write_text(OFFLINE_LAUNCHER, encoding="utf-8")
            (dist / "启动游戏-Windows.cmd").write_bytes(b'@echo off\r\ncd /d "%~dp0"\r\npy -3 run.py\r\nif errorlevel 9009 python run.py\r\npause\r\n')
            (dist / "start.sh").write_text('#!/bin/sh\ncd "$(dirname "$0")"\nexec python3 run.py\n', encoding="utf-8")
            (dist / "start.sh").chmod(0o755)
            (dist / "开始前请读.txt").write_text(OFFLINE_README.format(version=args.version), encoding="utf-8")
        if (dist / "index.html").stat().st_size > 1024 * 1024:
            raise ValueError("Entry HTML exceeds the current Toy 1 MiB limit")
        validate_references(dist)
        write_manifest(dist, mapping)
        archive = out / f"save-claude-{platform}-{args.version}.zip"
        outputs.append({"platform": platform, "directory": platform, "archive": archive.name, **zip_directory(dist, archive)})
    for name in ["description.md", "release-notes.md", "platforms.json"]:
        copy(ROOT / "marketing" / name, out / name)
    (out / "package-result.json").write_text(json.dumps({"status": "prepared_not_published", "version": args.version, "packages": outputs}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"status": "prepared_not_published", "packages": outputs}, ensure_ascii=False, indent=2))


OFFLINE_LAUNCHER = '''#!/usr/bin/env python3
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import argparse
import threading
import webbrowser
parser = argparse.ArgumentParser()
parser.add_argument('--port', type=int, default=8124)
args = parser.parse_args()
root = Path(__file__).resolve().parent
server = ThreadingHTTPServer(('127.0.0.1', args.port), partial(SimpleHTTPRequestHandler, directory=str(root)))
url = 'http://127.0.0.1:%s/index.html' % server.server_port
print('Game:', url, '\\nKeep this window open. Ctrl+C stops the server.')
threading.Timer(.3, lambda: webbrowser.open(url)).start()
try:
    server.serve_forever()
except KeyboardInterrupt:
    pass
finally:
    server.server_close()
'''

OFFLINE_README = '''拯救 Claude 大小姐 · {version}

完整解压后运行 run.py（需要 Python 3）。
Windows：双击“启动游戏-Windows.cmd”，或运行 py -3 run.py。
macOS / Linux：运行 python3 run.py。
若端口被占用，可运行 python3 run.py --port 8125。
不要直接双击 index.html；浏览器会限制 file:// 的模块和剧情读取。

点击对白或按空格/回车继续，点击选项或按 A/B/C/D 选择。
菜单提供日志、六个手动存档、读档、自动播放及声音设置。
本包可离线使用，无须 API 密钥、生图服务或 npm。
存档保存在本机当前浏览器及网址下，换设备/浏览器/端口不会自动同步。
旧版的自动和手动存档会被清理，请从新版重新开局；此后的存读档正常保留。
portraits.html 展示正式立绘，可在同一服务中打开。
代码与素材的授权范围见包内 LICENSE-code.txt 和 ASSET-LICENSE.md。
'''


if __name__ == "__main__":
    main()
