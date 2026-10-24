#!/usr/bin/env python3
"""Build offline/Toy/VibeHub packages from an explicit runtime allowlist.

This command only writes local artifacts. It never uploads or publishes.
"""
from __future__ import annotations

import argparse
import html
import json
import re
import shutil
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PACKAGES = ("module-api", "content", "save", "core", "web-adapter")
WEB_FILES = ("index.html", "start.js", "game.js", "style.css", "story.json", "character-portraits.json")


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
    required += [ROOT / "engine/packages" / package / "dist/index.js" for package in PACKAGES]
    required += [ROOT / "marketing/release" / p for p in ["cover-16x9.jpg", "cover-4x3.jpg", "icon.jpg"]]
    required += [ROOT / p for p in ["LICENSE", "ASSET-LICENSE.md", "assets/ASSET-SOURCES.json", "engine/LICENSE", "engine/UPSTREAM.json"]]
    required += [ROOT / "web/portraits.html", ROOT / "tools/release/platform-vibehub.js"]
    required += [ROOT / "marketing" / p for p in ["description.md", "release-notes.md", "platforms.json"]]
    for path in required:
        if not path.is_file():
            raise ValueError("Missing release input: " + str(path.relative_to(ROOT)))
    upstream = json.loads((ROOT / "engine/UPSTREAM.json").read_text(encoding="utf-8"))
    if upstream.get("dirty") is not False:
        raise ValueError("Release requires a clean committed engine snapshot; sync the finalized engine first")
    if args.check_only:
        print(json.dumps({"ok": True, "runtimeAssets": len(assets), "nodes": len(story["nodes"]), "publishing": False}))
        return
    if out.exists():
        raise ValueError("Output already exists; use a new version directory: " + str(out))
    out.mkdir(parents=True)
    outputs = []
    for platform in ["offline", "toy", "vibehub"]:
        dist = out / platform
        dist.mkdir()
        for name in WEB_FILES:
            copy(ROOT / "web" / name, dist / name)
        index = (dist / "index.html").read_text(encoding="utf-8")
        # Deployment scanners can exclude nested build/dist directories. Publish
        # the five runtime modules under an ordinary asset directory instead.
        for package in PACKAGES:
            original = f"../engine/packages/{package}/dist/index.js"
            if index.count(original) != 1:
                raise ValueError("Unexpected runtime import map entry: " + package)
            index = index.replace(original, f"./runtime/{package}.js")
        if platform == "vibehub":
            bridge = (
                '<script async id="vibehub-sdk" src="https://gamesvibe.app/sdk/v3/vibehub.js"></script>\n'
                '<script defer src="platform-vibehub.js" data-work="' + html.escape(args.slug, quote=True) + '"></script>\n'
            )
            index = index.replace("</head>", bridge + "</head>")
            copy(ROOT / "tools/release/platform-vibehub.js", dist / "platform-vibehub.js")
        (dist / "index.html").write_text(index, encoding="utf-8")
        for source in assets:
            copy(ROOT / "web" / source, dist / source)
        for package in PACKAGES:
            rel = Path("engine/packages") / package / "dist/index.js"
            copy(ROOT / rel, dist / "runtime" / f"{package}.js")
        copy(ROOT / "LICENSE", dist / "LICENSE-code.txt")
        asset_license = (ROOT / "ASSET-LICENSE.md").read_text(encoding="utf-8").replace("(web/assets/fonts/", "(assets/fonts/")
        (dist / "ASSET-LICENSE.md").write_text(asset_license, encoding="utf-8")
        copy(ROOT / "assets/ASSET-SOURCES.json", dist / "assets/ASSET-SOURCES.json")
        copy(ROOT / "engine/LICENSE", dist / "engine/LICENSE")
        copy(ROOT / "engine/UPSTREAM.json", dist / "engine/UPSTREAM.json")
        for name in ["cover-16x9.jpg", "cover-4x3.jpg", "icon.jpg"]:
            copy(ROOT / "marketing/release" / name, dist / "media" / name)
        for screenshot in sorted((ROOT / "marketing/release/screenshots").glob("*.png")):
            copy(screenshot, dist / "media/screenshots" / screenshot.name)
        release = {"version": args.version, "gameId": story["id"], "contentVersion": story["version"], "start": story["start"], "nodes": len(story["nodes"]), "runtimeAssets": len(assets), "platform": platform, "engineCommit": upstream["commit"]}
        (dist / "release.json").write_text(json.dumps(release, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        if platform == "offline":
            copy(ROOT / "web/portraits.html", dist / "portraits.html")
            (dist / "run.py").write_text(OFFLINE_LAUNCHER, encoding="utf-8")
            (dist / "启动游戏-Windows.cmd").write_bytes(b'@echo off\r\ncd /d "%~dp0"\r\npy -3 run.py\r\nif errorlevel 9009 python run.py\r\npause\r\n')
            (dist / "start.sh").write_text('#!/bin/sh\ncd "$(dirname "$0")"\nexec python3 run.py\n', encoding="utf-8")
            (dist / "start.sh").chmod(0o755)
            (dist / "开始前请读.txt").write_text(OFFLINE_README.format(version=args.version), encoding="utf-8")
        if (dist / "index.html").stat().st_size > 1024 * 1024:
            raise ValueError("Entry HTML exceeds the current Toy 1 MiB limit")
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
