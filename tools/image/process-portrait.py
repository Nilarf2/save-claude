#!/usr/bin/env python3
"""Apply this game's framing to an approved transparent portrait. Never generates images."""
import argparse
import json
from pathlib import Path
import runpy
import tempfile
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--src', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    if args.out.suffix.lower() != '.webp':
        parser.error('游戏正式立绘输出使用 .webp')
    if args.out.exists() or args.src.resolve() == args.out.resolve():
        parser.error('请写入新的候选文件；人工审核后再替换正式立绘')
    image = Image.open(args.src).convert('RGBA')
    # Remove near-invisible export specks, retaining the visible translucent veil.
    image.putalpha(image.getchannel('A').point(lambda alpha: alpha if alpha > 8 else 0))
    prepare = runpy.run_path(str(ROOT / 'engine/tools/image/prepare-sprite.py'))['prepare']
    with tempfile.TemporaryDirectory() as directory:
        cleaned = Path(directory) / 'cleaned.png'
        normalized = Path(directory) / 'normalized.png'
        image.save(cleaned)
        result = prepare(cleaned, normalized, width=1536, height=1536, padding=48, bottom_padding=0)
        args.out.parent.mkdir(parents=True, exist_ok=True)
        Image.open(normalized).save(args.out, 'WEBP', quality=91, method=6)
        result['out'] = str(args.out.resolve())
    print(json.dumps(result, ensure_ascii=False))
    if result['needs_redraw_review']:
        raise SystemExit(2)


if __name__ == '__main__':
    main()
