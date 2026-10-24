# -*- coding: utf-8 -*-
import io, sys
p = r"D:\DeepseekHarness\test-game\tools\compile\build-story.mjs"
s = io.open(p, encoding="utf-8").read()

def rep(old, new):
    global s
    if old not in s:
        print("MISS:", old[:60].replace("\n","\\n")); return False
    s = s.replace(old, new, 1)
    return True

rep("    const chapterEnd = nextChapter ? nextChapter.id + ':scene' : ch.id + ':the-end';",
    "    const chapterEnd = nextChapter ? nextChapter.id + ':scene' : ch.id + ':the-end';\n    const isLast = !nextChapter;")

rep("    push({ id: ch.id + ':the-end', type: 'end', ending: ch.title });",
    "    if (isLast) push({ id: ch.id + ':the-end', type: 'end', ending: ch.title });")

rep("""          if (tlines.length) push({ id: p.talkId, type: 'dialogue', lines: tlines, next: p.eid });
          push({ id: p.eid, type: 'end', ending: p.en.ending.name });""",
    """          if (tlines.length) push({ id: p.talkId, type: 'dialogue', lines: tlines, next: p.eid });
          else push({ id: p.talkId, type: 'action', actions: [], next: p.eid });
          push({ id: p.eid, type: 'end', ending: p.en.ending.name });""")

io.open(p, "w", encoding="utf-8", newline="\n").write(s)
print("patched, len", len(s))
