#!/usr/bin/env python3
"""Offline alpha/flood cutout, contain fitting and source-edge inspection. No model downloads."""
import argparse
from collections import deque
import json
from pathlib import Path
from statistics import median
from PIL import Image


def flood_cutout(image, tolerance=38, key=None):
    image = image.convert("RGBA")
    width, height = image.size
    pixels = image.load()
    if key is None:
        border = [pixels[x, y][:3] for x in range(width) for y in {0, height-1}]
        border += [pixels[x, y][:3] for y in range(height) for x in {0, width-1}]
        key = tuple(int(median(c[i] for c in border)) for i in range(3))
    seen, queue = bytearray(width * height), deque()
    def add(x, y):
        index = y * width + x
        if seen[index]:
            return
        seen[index] = 1
        pixel = pixels[x, y]
        # Python integer distances avoid an array dependency and retain exact channel differences.
        if sum((pixel[i] - key[i]) ** 2 for i in range(3)) <= tolerance ** 2:
            queue.append((x, y))
    for x in range(width):
        add(x, 0); add(x, height-1)
    for y in range(height):
        add(0, y); add(width-1, y)
    while queue:
        x, y = queue.popleft()
        pixels[x, y] = (*pixels[x, y][:3], 0)
        if x: add(x-1, y)
        if y: add(x, y-1)
        if x+1 < width: add(x+1, y)
        if y+1 < height: add(x, y+1)
    return image


def inspect_edges(image, margin=2, threshold=16):
    mask = image.getchannel("A").point(lambda a: 255 if a > threshold else 0)
    bbox = mask.getbbox()
    if bbox is None:
        raise ValueError("没有可见主体")
    width, height = image.size
    return {"bbox": list(bbox), "top": bbox[1] < margin, "left": bbox[0] < margin,
            "right": bbox[2] > width-margin, "bottom": bbox[3] > height-margin}


def prepare(source, output, width=1024, height=1400, padding=32, mode="alpha", tolerance=38, key=None, margin=2, bottom_padding=None):
    source, output = Path(source).resolve(), Path(output).resolve()
    bottom_padding = padding if bottom_padding is None else bottom_padding
    if source == output:
        raise ValueError("输出不得覆盖原始图")
    if min(width, height) <= 0 or padding < 0 or bottom_padding < 0 or width <= 2*padding or height <= padding+bottom_padding or not 0 <= tolerance <= 442 or margin < 1:
        raise ValueError("无效画布/留边/容差参数")
    if output.suffix.lower() not in {".png", ".webp"}:
        raise ValueError("透明输出必须使用 PNG 或 WebP")
    image = Image.open(source).convert("RGBA")
    if mode == "flood":
        image = flood_cutout(image, tolerance, key)
    elif image.getchannel("A").getextrema()[0] == 255:
        raise ValueError("输入没有透明区域；纯色背景请显式使用 --mode flood，并人工检查头发与道具")
    # Inspect BEFORE adding canvas margins: added padding cannot repair missing anatomy/hair.
    edges = inspect_edges(image, margin)
    subject = image.crop(image.getchannel("A").getbbox())
    ratio = min((width-2*padding)/subject.width, (height-padding-bottom_padding)/subject.height)
    size = (max(1, round(subject.width*ratio)), max(1, round(subject.height*ratio)))
    subject = subject.resize(size, Image.Resampling.LANCZOS)
    canvas = Image.new("RGBA", (width, height))
    # alpha_composite preserves partial alpha. paste(..., mask=subject) would square it.
    canvas.alpha_composite(subject, ((width-subject.width)//2, height-bottom_padding-subject.height))
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.suffix.lower() == ".webp":
        canvas.save(output, "WEBP", lossless=True)
    else:
        canvas.save(output, "PNG")
    return {"out": str(output), "size": [width, height], "subject_size": list(size), "source_edges": edges,
            "needs_redraw_review": any(edges[side] for side in ("top", "left", "right")),
            "note": "贴边仅是风险提示；透明留边不代表发丝、头纱、手或道具已完整。半身底部可有意截断。"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--src", required=True); parser.add_argument("--out", required=True)
    parser.add_argument("--width", type=int, default=1024); parser.add_argument("--height", type=int, default=1400)
    parser.add_argument("--padding", type=int, default=32)
    parser.add_argument("--bottom-padding", type=int, help="底部单独留边；半身图可用 0 将有意截断的下摆对齐舞台底线")
    parser.add_argument("--mode", choices=["alpha", "flood"], default="alpha")
    parser.add_argument("--tolerance", type=int, default=38)
    parser.add_argument("--key", help="Explicit solid background hex RGB, e.g. #ff00ff")
    parser.add_argument("--edge-margin", type=int, default=2)
    parser.add_argument("--fail-on-edge", action="store_true")
    args = parser.parse_args()
    key = tuple(bytes.fromhex(args.key.lstrip("#"))) if args.key else None
    if key is not None and len(key) != 3:
        parser.error("--key 必须是 6 位 RGB")
    result = prepare(args.src, args.out, args.width, args.height, args.padding, args.mode, args.tolerance, key, args.edge_margin, args.bottom_padding)
    print(json.dumps(result, ensure_ascii=False))
    return 2 if args.fail_on_edge and result["needs_redraw_review"] else 0

if __name__ == "__main__":
    raise SystemExit(main())
