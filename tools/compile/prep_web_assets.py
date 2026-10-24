# -*- coding: utf-8 -*-
"""准备前端资源：Claude 立绘 + 各场景占位背景"""
import os, json, shutil
from PIL import Image, ImageDraw, ImageFilter
import random, math

ROOT = r"D:\DeepseekHarness\test-game"
WEB = os.path.join(ROOT, "web")
CHAR = os.path.join(WEB, "assets", "char", "claude")
BG = os.path.join(WEB, "assets", "bg")
os.makedirs(CHAR, exist_ok=True)
os.makedirs(BG, exist_ok=True)

# 1) Claude 立绘
SRC = os.path.join(ROOT, "assets", "char", "claude")
for f in os.listdir(SRC):
    if f.endswith(".png"):
        im = Image.open(os.path.join(SRC, f)).convert("RGBA")
        # 裁掉过多空白，缩到 900 高
        bbox = im.getbbox()
        if bbox: im = im.crop(bbox)
        h = 1000
        w = int(im.size[0] * h / im.size[1])
        im = im.resize((w, h), Image.LANCZOS)
        out = os.path.join(CHAR, f.replace(".png", ".webp"))
        im.save(out, "WEBP", quality=88, method=6)
        print("char", f, "->", os.path.basename(out), im.size, os.path.getsize(out)//1024, "KB")

# 2) 场景占位背景
story = json.load(open(os.path.join(WEB, "story.json"), encoding="utf-8"))
bgs = sorted({a["src"].split("/")[-1].replace(".jpg","") for a in story["assets"].values() if a["type"]=="image" and "/bg/" in a["src"]})
print("bgs:", len(bgs))

PALETTES = {
    "church":   [(14,13,20), (52,38,26), (168,120,52)],
    "altar":    [(10,9,14), (40,28,22), (198,150,70)],
    "ruins":    [(12,12,16), (34,32,34), (120,110,96)],
    "conference":[(18,20,28), (46,52,68), (120,150,190)],
    "summit":   [(20,22,30), (54,60,78), (150,180,220)],
    "rain":     [(8,12,20), (24,36,54), (80,130,180)],
    "neon":     [(10,8,16), (40,20,50), (220,80,160)],
    "room":     [(16,16,20), (44,44,54), (200,180,140)],
    "snow":     [(16,18,24), (60,70,86), (200,215,235)],
    "backstage":[(14,14,18), (48,42,40), (190,150,110)],
    "dressing": [(16,14,18), (52,40,46), (200,160,170)],
    "default":  [(12,12,18), (44,44,56), (150,140,130)],
}
def pick(name):
    for k, v in PALETTES.items():
        if k in name: return v
    return PALETTES["default"]

W, H = 1600, 900
for name in bgs:
    top, mid, glow = pick(name)
    img = Image.new("RGB", (W, H), top)
    d = ImageDraw.Draw(img)
    # 垂直渐变
    for y in range(H):
        t = y / H
        c = tuple(int(top[i] + (mid[i]-top[i]) * min(1, t*1.4)) for i in range(3))
        d.line([(0,y),(W,y)], fill=c)
    # 光晕
    rnd = random.Random(hash(name) & 0xffff)
    for _ in range(3):
        cx = rnd.randint(int(W*0.2), int(W*0.8))
        cy = rnd.randint(int(H*0.1), int(H*0.6))
        r = rnd.randint(200, 520)
        layer = Image.new("RGB", (W,H), (0,0,0))
        ld = ImageDraw.Draw(layer)
        ld.ellipse([cx-r, cy-r, cx+r, cy+r], fill=glow)
        layer = layer.filter(ImageFilter.GaussianBlur(r//2))
        img = Image.blend(img, Image.blend(img, layer, 0.55), 0.5)
    # 暗角
    vig = Image.new("L", (W,H), 0)
    vd = ImageDraw.Draw(vig)
    vd.ellipse([-W*0.15, -H*0.25, W*1.15, H*1.25], fill=255)
    vig = vig.filter(ImageFilter.GaussianBlur(160))
    black = Image.new("RGB", (W,H), (0,0,0))
    img = Image.composite(img, black, vig)
    out = os.path.join(BG, name + ".jpg")
    img.save(out, quality=82, optimize=True)
    print("bg", name, os.path.getsize(out)//1024, "KB")
