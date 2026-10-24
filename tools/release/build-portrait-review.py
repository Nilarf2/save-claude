#!/usr/bin/env python3
"""Make a static review page from formal local production portraits only."""
from pathlib import Path
import json
from html import escape

root=Path(__file__).resolve().parents[2]
manifest=json.loads((root/'web/character-portraits.json').read_text())
labels={'normal':'默认','smile':'微笑','sad':'难过','serious':'认真','hollow':'空洞','tea':'托茶','calipers':'持游标卡尺'}
sections=[]
for cid,c in manifest['characters'].items():
    if not c.get('portrait'): continue
    seen=set();cards=[]
    entries=[('normal',c['portrait']),*c.get('poses',{}).items(),*c.get('expressions',{}).items()]
    for label,src in entries:
        if src in seen: continue
        seen.add(src)
        path=(root/'web'/src).resolve()
        if not path.is_relative_to((root/'web/assets/char-redrawn').resolve()) or not path.is_file():
            raise SystemExit('Review requires a new formal portrait: '+src)
        cards.append('<figure><img loading="lazy" src="'+escape(src,quote=True)+'" alt="'+escape(c['name']+' '+labels.get(label,label),quote=True)+'"><figcaption>'+escape(labels.get(label,label))+'</figcaption></figure>')
    sections.append('<section><h2>'+escape(c['name'])+'</h2><div class="cards">'+''.join(cards)+'</div></section>')
html='''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>正式立绘审阅 · 拯救 Claude 大小姐</title><style>
:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#111015;color:#eee6d5;font:16px/1.7 system-ui,sans-serif}main{max-width:1440px;margin:auto;padding:28px}h1{font-size:27px;color:#e8c979}h2{color:#d5b36a;margin-top:34px}a{color:#d5b36a}p{color:#bdb5a8}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,300px));gap:18px}figure{margin:0;border:1px solid #5c4d30;border-radius:6px;overflow:hidden;background:#25222a}img{display:block;width:100%;aspect-ratio:2/3;object-fit:contain;background:repeating-conic-gradient(#29262e 0% 25%,#343039 0% 50%) 50% / 24px 24px}figcaption{padding:10px 14px;color:#e8c979}@media(max-width:520px){main{padding:16px}.cards{grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}h1{font-size:22px}}
button{font:inherit;min-height:44px;padding:8px 16px;background:#302b36;color:#f2e7d3;border:1px solid #86724d;border-radius:4px;cursor:pointer}button:focus-visible{outline:3px solid #d9bd77}body[data-background="dark"] img{background:#191720}body[data-background="light"] img{background:#f2efe8}.themes{display:flex;gap:8px;flex-wrap:wrap}
</style><main><h1>正式半身立绘 · 本版审阅</h1><p>此页展示游戏实际登记的立绘。逐张检查表情、衣饰、手和道具；切换背景检查透明边缘。半身图只在底部作有意截断。游戏内的大小、遮挡和站位仍须另行试玩核对。</p><p><a href="index.html" target="_blank" rel="noopener">打开游戏 ↗</a></p><div class="themes" role="group" aria-label="立绘背景"><button data-background="check">透明棋盘格</button><button data-background="dark">深色背景</button><button data-background="light">浅色背景</button></div>'''+''.join(sections)+'''</main><script>document.querySelectorAll('button[data-background]').forEach(button=>{button.addEventListener('click',()=>{document.body.dataset.background=button.dataset.background;document.querySelectorAll('button[data-background]').forEach(item=>item.setAttribute('aria-pressed',String(item===button)));});});document.querySelector('button[data-background="check"]').click();</script></html>\n'''
(root/'web/portraits.html').write_text(html)
print(json.dumps({'review':'web/portraits.html','characters':len(sections),'images':sum(len(set([c.get('portrait'),*c.get('poses',{}).values(),*c.get('expressions',{}).values()])-{None}) for c in manifest['characters'].values() if c.get('portrait'))},ensure_ascii=False))
