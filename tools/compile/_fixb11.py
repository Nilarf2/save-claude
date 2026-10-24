# -*- coding: utf-8 -*-
import io
p = r"D:\DeepseekHarness\test-game\story\03-story.md"
s = io.open(p, encoding="utf-8").read()
old = """【分支】
[key_godfather 且 key_station 且 key_father 且 ate_rice 且 promise] → F01
[contamination>=70 或 !ate_rice] → B11_404
[humanity>=55 且 ate_rice 且 promise] → B11_true
[*] → B11_normal"""
new = """【分支】
[key_godfather 且 key_station 且 key_father 且 ate_rice 且 promise] → F01
[contamination>=45] → B11_404
[humanity>=130 且 ate_rice 且 promise] → B11_true
[*] → B11_normal"""
assert old in s, "pattern not found"
s = s.replace(old, new, 1)
io.open(p, "w", encoding="utf-8", newline="\n").write(s)
print("B11_judge patched")
