# -*- coding: utf-8 -*-
import io
p = r"D:\DeepseekHarness\test-game\tools\compile\build-story.mjs"
s = io.open(p, encoding="utf-8").read()
old = "    if (isLast) push({ id: ch.id + ':the-end', type: 'end', ending: ch.title });"
new = "    const lastSeg = real[real.length - 1];\n    if (isLast && !(lastSeg && lastSeg.entries)) push({ id: ch.id + ':the-end', type: 'end', ending: ch.title });"
assert old in s
s = s.replace(old, new, 1)
io.open(p, "w", encoding="utf-8", newline="\n").write(s)
print("ok")
