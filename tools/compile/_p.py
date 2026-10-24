# -*- coding: utf-8 -*-
import io
p = r"D:\DeepseekHarness\test-game\tools\compile\build-v3.mjs"
s = io.open(p, encoding="utf-8").read()
old = """    // 章末兜底（只有最后一章且没有结局时才需要）
    if (!next) push({ id: ch.id + ':the-end', type: 'end', ending: ch.title });"""
new = """    // 章末兜底（只有最后一章且没有结局时才需要）
    const lastSeg = segs[segs.length - 1];
    if (!next && !(lastSeg && lastSeg.ending)) push({ id: ch.id + ':the-end', type: 'end', ending: ch.title });"""
assert old in s
s = s.replace(old, new, 1)
io.open(p, "w", encoding="utf-8", newline="\n").write(s)
print("ok")
