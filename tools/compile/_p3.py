# -*- coding: utf-8 -*-
import io
p = r"D:\DeepseekHarness\test-game\tools\compile\fix1.mjs"
s = io.open(p, encoding="utf-8").read()
s = s.replace("function evalC(c, vars, tags) {", "function evalC(c, vars, tagsIn) {\n  const tags = Array.isArray(tagsIn) ? tagsIn : [...tagsIn];")
io.open(p, "w", encoding="utf-8", newline="\n").write(s)
print("ok")
