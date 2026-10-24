# -*- coding: utf-8 -*-
import io
p = r"D:\DeepseekHarness\test-game\tools\compile\build-story.mjs"
s = io.open(p, encoding="utf-8").read()
old = """  let background = null, music = null, ambience = null;
  for (; i < lines.length; i++) {
    const m = /^\\[(bg|bgm|ambience):\\s*([^\\]]+)\\]\\s*$/.exec(lines[i]);
    if (!m) break;
    if (m[1] === 'bg') background = assetId(m[2]);
    else if (m[1] === 'bgm') music = assetId(m[2]);
    else ambience = assetId(m[2]);
  }"""
new = """  let background = null, music = null, ambience = null;
  for (; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (!raw) continue;
    const m = /^\\[(bg|bgm|ambience):\\s*([^\\]]+)\\]\\s*$/.exec(raw);
    if (!m) break;
    if (m[1] === 'bg') background = assetId(m[2]);
    else if (m[1] === 'bgm') music = assetId(m[2]);
    else ambience = assetId(m[2]);
  }"""
assert old in s, "pattern not found"
s = s.replace(old, new, 1)
io.open(p, "w", encoding="utf-8", newline="\n").write(s)
print("ok")
