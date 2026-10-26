#!/usr/bin/env python3
"""Generate an offline portrait review from an explicit game-owned manifest."""
import argparse
from html import escape
import json
from pathlib import Path
import shutil


def build_review(manifest_path, asset_root, out):
    manifest_path, asset_root, out = Path(manifest_path).resolve(), Path(asset_root).resolve(), Path(out).resolve()
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    sections, assets = [], {}
    # Validate everything before writing; never fetch remote references or infer private paths.
    for cid, character in manifest["characters"].items():
        entries = [("默认", character.get("portrait")), *character.get("poses", {}).items(), *character.get("expressions", {}).items()]
        cards, seen = [], set()
        for label, src in entries:
            if not src or src in seen:
                continue
            seen.add(src)
            path = (asset_root / src).resolve()
            if not path.is_relative_to(asset_root) or not path.is_file() or path.suffix.lower() not in {".png", ".webp", ".jpg", ".jpeg"}:
                raise ValueError(f"立绘必须是素材目录内的本地图片：{cid}/{label}")
            if path.is_relative_to(out) or out == asset_root or manifest_path == out / "index.html":
                raise ValueError("输出目录必须独立于输入素材")
            if path not in assets:
                assets[path] = f"assets/{len(assets):04d}{path.suffix.lower()}"
            name = escape(str(character.get("name", cid)) + " / " + str(label))
            image = f'<img loading="lazy" src="{assets[path]}" alt="{name}">'
            cards.append(f'<figure><div class="pair"><div class="dark">{image}</div><div class="light">{image}</div></div><figcaption>{name}</figcaption></figure>')
        if cards:
            sections.append(f'<section><h2>{escape(str(character.get("name", cid)))}</h2><div class="cards">{"".join(cards)}</div></section>')
    if not assets:
        raise ValueError("manifest 中没有可审核立绘")
    title = escape(str(manifest.get("title", "立绘审核")))
    html = '''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
body{background:#16161b;color:#eee;font:16px/1.6 system-ui;margin:24px}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:20px}figure{margin:0;border:1px solid #777}figcaption{padding:8px}.pair{display:flex}.pair>div{width:50%}.dark{background:#181820}.light{background:#f2f0e9}img{display:block;width:100%;height:60vh;object-fit:contain}button{font:inherit}body.check .pair>div{background:repeating-conic-gradient(#555 0% 25%,#aaa 0% 50%) 50%/20px 20px}
</style>''' + f'<title>{title}</title><h1>{title}</h1><p>逐张检查：脸与服饰一致；头发/头纱/手/道具完整；上、左、右留边；透明边缘无色溢。半身底部允许有意截断。此页不能证明游戏内缩放和遮挡正确，仍需实机验收。</p><button onclick="document.body.classList.toggle(\'check\')">切换透明棋盘格</button>' + ''.join(sections) + '</html>\n'
    (out / "assets").mkdir(parents=True, exist_ok=True)
    for source, target in assets.items():
        shutil.copyfile(source, out / target)
    (out / "index.html").write_text(html, encoding="utf-8")
    return {"characters": len(sections), "images": len(assets), "review": str(out / "index.html")}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--asset-root", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    print(json.dumps(build_review(args.manifest, args.asset_root, args.out), ensure_ascii=False))

if __name__ == "__main__":
    main()
