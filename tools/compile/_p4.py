# -*- coding: utf-8 -*-
import io
p = r"D:\DeepseekHarness\test-game\tools\compile\fix1.mjs"
s = io.open(p, encoding="utf-8").read()
s = s.replace("const b = byId.get('B11_judge:s0:b');", "const b = byId.get('B11_judge:s1:b');")
io.open(p, "w", encoding="utf-8", newline="\n").write(s)
print("ok")
