# -*- coding: utf-8 -*-
import io
p = r"D:\DeepseekHarness\test-game\tools\compile\build-v3.mjs"
s = io.open(p, encoding="utf-8").read()

old = """  return {
    schemaVersion: '1', id: 'save-claude', version: '1.0.0',
    title: meta.title || '拯救 Claude 大小姐',
    start: startId, locale: 'zh-CN',
    variables, characters, assets, nodes,
  };"""
new = """  const chapterTitles = {};
  for (const ch of chapters) chapterTitles[ch.id] = ch.title;

  return {
    schemaVersion: '1', id: 'save-claude', version: '1.0.0',
    title: meta.title || '拯救 Claude 大小姐',
    start: startId, locale: 'zh-CN',
    variables, characters, assets, nodes, chapterTitles,
  };"""
assert old in s
s = s.replace(old, new, 1)
io.open(p, "w", encoding="utf-8", newline="\n").write(s)
print("ok")
