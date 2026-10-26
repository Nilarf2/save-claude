const $ = id => document.getElementById(id);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const data = globalThis.STORY_MAP;
const { analyzeGraph, validateEvidence } = globalThis.StoryMapReview;
const analysis = analyzeGraph(data);
const nodes = new Map(data.nodes.map(n => [n.id,n]));
const chapterId = id => id.split(':')[0];
const chapters = [...new Set(data.nodes.map(n => chapterId(n.id)))];
const groups = new Map(chapters.map(c => [c,data.nodes.filter(n => chapterId(n.id) === c)]));
const kindName = {scene:'场景',dialogue:'正文',narration:'旁白',action:'动作',choice:'选择',branch:'条件',end:'结局',module:'机制'};
const fills = {scene:'#19334b',dialogue:'#1b344c',narration:'#1b344c',action:'#263348',choice:'#523e22',branch:'#3d2e54',end:'#502d3b',start:'#1c4438',chapter:'#1b3049'};
const strokes = {scene:'#537d9e',dialogue:'#5386b9',narration:'#5386b9',action:'#647790',choice:'#c9974a',branch:'#a682d8',end:'#d07c92',start:'#65bd99',chapter:'#537fae'};
let mode = 'overview', selected = data.start, selectedEdge = null, filter = '', positions = new Map();
let view = {x:30,y:40,k:1}, bounds = {w:1000,h:700};
let evidence = null, traceIndex = 0, visited = new Map();
const warnings = new Set([...analysis.unreachable, ...analysis.deadEnds, ...analysis.cannotReachEnd]);
const chapterTitle = c => data.chapterTitles?.[c] || c;
const title = n => n.type === 'end' ? n.ending : n.type === 'choice' ? n.prompt || '选择' : n.type === 'branch' ? '条件判断' : n.lines?.[0]?.text || n.scene || n.id;
const short = (s,max=28) => String(s).length > max ? String(s).slice(0,max)+'…' : String(s);
const value = v => typeof v === 'object' && v !== null ? v.var || JSON.stringify(v) : JSON.stringify(v);
function condition(c) {
  if (!c) return '无条件';
  if (c.op === 'and' || c.op === 'or') return '('+c.conditions.map(condition).join(c.op === 'and'?' 且 ':' 或 ')+')';
  if (c.op === 'not') return '非 '+condition(c.condition);
  if (c.op === 'tag') return '已记录 '+c.tag;
  if (c.op === 'visited') return '已访问 '+c.node+(c.count?' ≥ '+c.count+' 次':'');
  const op = {eq:'=',ne:'≠',gt:'>',gte:'≥',lt:'<',lte:'≤'}[c.op];
  return op ? `${value(c.left)} ${op} ${value(c.right)}` : JSON.stringify(c);
}
function action(a) {
  if (a.type === 'add') return a.variable+' '+(a.value>=0?'+':'')+a.value;
  if (a.type === 'set') return a.variable+' = '+value(a.value);
  if (a.type === 'tag.add') return '记录标签 '+a.tag;
  if (a.type === 'tag.remove') return '移除标签 '+a.tag;
  return a.type+' '+JSON.stringify(a);
}
const link = id => `<button class="link" data-node="${escape(id)}">${escape(id)}</button>`;
const chapterLink = c => `<button class="link" data-chapter="${escape(c)}">${escape(c+' '+chapterTitle(c))}</button>`;
const edgeDetails = e => `<div class="block"><b>${escape(e.label || '继续')}</b><p>${link(e.from)} → ${link(e.to)}</p>${e.when?'<p class="cond">生效条件：'+escape(condition(e.when))+'</p>':''}${e.disabledWhen?'<p class="cond">禁用条件：'+escape(condition(e.disabledWhen))+'</p>':''}${e.disabledReason?'<p>'+escape(e.disabledReason)+'</p>':''}<p class="action">${e.actions?.length ? e.actions.map(action).map(escape).join('<br>') : '此连线不改变数值或标签'}</p></div>`;
function detailNode(id) {
  const n = nodes.get(id); if (!n) return;
  const c=chapterId(id), incoming=data.edges.filter(e=>e.to===id), outgoing=data.edges.filter(e=>e.from===id);
  $('detail').innerHTML=`<small>${escape(kindName[n.type]||n.type)}${id===data.start?' · 当前起点':''}</small><h2>${escape(id)}</h2>${chapterLink(c)}${visited.has(id)?'<p class="evidence-label">证据 visits：'+escape(visited.get(id))+' 次</p>':''}<p><small>${escape(data.sourceDocument || data.source)}:${escape(data.chapterLines[c]||'?')} · 章节 ${escape(c)}</small></p>${n.ending?'<div class="block">结局：'+escape(n.ending)+'</div>':''}${n.lines?.length?'<h3>原文</h3>'+n.lines.map(l=>'<p>'+(l.speaker?'<b>'+escape(l.speaker)+'：</b>':'')+escape(l.text)+(l.expression?'<small> {'+escape(l.expression)+'}</small>':'')+'</p>').join(''):''}${n.scene?'<p>场景：'+escape(n.scene)+'</p>':''}${n.actions?.length?'<h3>节点动作</h3><pre>'+escape(n.actions.map(action).join('\n'))+'</pre>':''}${n.onEnter?.length?'<h3>进入节点的变化</h3><pre>'+escape(n.onEnter.map(action).join('\n'))+'</pre>':''}<h3>后续连线 (${outgoing.length})</h3>${outgoing.map(edgeDetails).join('')||'<p>没有后续节点。</p>'}<h3>从哪里来到这里 (${incoming.length})</h3>${incoming.map(e=>'<p>'+link(e.from)+' '+escape(short(e.label,34))+'</p>').join('')||'<p>没有入边。</p>'}<details><summary>完整节点数据</summary><pre>${escape(JSON.stringify(n,null,2))}</pre></details>`;
}
function detailChapter(c) {
  const ns=groups.get(c)||[];
  const incoming=data.edges.filter(e=>chapterId(e.to)===c&&chapterId(e.from)!==c), outgoing=data.edges.filter(e=>chapterId(e.from)===c&&chapterId(e.to)!==c);
  $('detail').innerHTML=`<small>章节 · ${escape(data.sourceDocument || data.source)}:${escape(data.chapterLines[c]||'?')}</small><h2>${escape(c+' '+chapterTitle(c))}</h2><p>${ns.length} 个节点；${incoming.length} 条外部入边，${outgoing.length} 条外部出边。</p><h3>章内节点</h3>${ns.map(n=>'<p>'+link(n.id)+' <small>'+escape(kindName[n.type]||n.type)+'</small> '+escape(short(title(n),48))+'</p>').join('')}<h3>离开本章</h3>${outgoing.map(edgeDetails).join('')||'<p>本章没有外部出边。</p>'}`;
}
function selectNode(id) { if(!nodes.has(id))return; selected=id; selectedEdge=null; mode='focus'; detailNode(id); render(); }
function selectChapter(c) { if(!groups.has(c))return; filter=c; $('chapter').value=c; selected=groups.get(c)[0].id; mode='chapter'; detailChapter(c); render(); refreshResults(); }
$('detail').addEventListener('click',e=>{const n=e.target.closest('[data-node]'),c=e.target.closest('[data-chapter]');if(n)selectNode(n.dataset.node);else if(c)selectChapter(c.dataset.chapter);});
function refreshResults() {
  const q=$('search').value.trim().toLowerCase();
  const list=data.nodes.filter(n=>(!filter||chapterId(n.id)===filter)&&(!q||JSON.stringify(n).toLowerCase().includes(q)||chapterTitle(chapterId(n.id)).toLowerCase().includes(q)));
  $('count').textContent=list.length;
  $('results').innerHTML=list.map(n=>`<button class="result ${selected===n.id?'selected':''} ${visited.has(n.id)?'evidence-node':''} ${warnings.has(n.id)?'static-warning':''}" data-id="${escape(n.id)}"><b>${escape(n.id)}</b><small>${escape((visited.has(n.id)?'已访问 '+visited.get(n.id)+' 次 · ':'')+(kindName[n.type]||n.type)+' · '+short(title(n),55))}</small></button>`).join('')||'<p class="empty">没有匹配节点</p>';
}
$('results').addEventListener('click',e=>{const b=e.target.closest('[data-id]');if(b)selectNode(b.dataset.id);});
$('search').addEventListener('input',refreshResults);
$('chapter').innerHTML+=[...chapters].map(c=>`<option value="${escape(c)}">${escape(c+' '+chapterTitle(c))}</option>`).join('');
$('chapter').addEventListener('change',e=>{filter=e.target.value;if(filter)selectChapter(filter);else{mode='overview';render();refreshResults();}});
const stat=type=>data.nodes.filter(n=>n.type===type).length;
$('meta').textContent=`${data.nodes.length} 节点 · ${data.edges.length} 连线 · ${stat('choice')} 选择 · ${stat('branch')} 条件 · ${stat('end')} 结局 · 源提交 ${data.revision} · 本地快照 ${new Date(data.generatedAt).toLocaleTimeString()}`;
function makeSvg(tag,attrs,text) { const el=document.createElementNS('http://www.w3.org/2000/svg',tag);for(const[k,v]of Object.entries(attrs||{}))el.setAttribute(k,v);if(text!==undefined)el.textContent=text;return el; }
function card(id,n,x,y,w,h,chapter=false) {
  const isStart=chapter?chapterId(data.start)===id:id===data.start;
  const containsEnd=chapter && groups.get(id).some(x=>x.type==='end');
  const kind=isStart?'start':chapter?(containsEnd?'end':groups.get(id).some(x=>x.type==='branch')?'branch':groups.get(id).some(x=>x.type==='choice')?'choice':'chapter'):n.type;
  const g=makeSvg('g',{class:'node'+(id===selected?' selected':'')+((chapter?groups.get(id).some(n=>visited.has(n.id)):visited.has(id))?' evidence-node':'')+((chapter?groups.get(id).some(n=>warnings.has(n.id)):warnings.has(id))?' static-warning':''),transform:`translate(${x},${y})`,'data-id':id});
  g.append(makeSvg('rect',{width:w,height:h,rx:9,fill:fills[kind]||fills.action,stroke:strokes[kind]||strokes.action}));
  g.append(makeSvg('text',{x:12,y:22},chapter?short(id+' '+chapterTitle(id),22):id));
  const sub=chapter?`${groups.get(id).length} 节点${containsEnd?' · 含结局':''}${isStart?' · 起点':''}${groups.get(id).some(n=>visited.has(n.id))?' · 已访 '+groups.get(id).filter(n=>visited.has(n.id)).length:''}`:(kindName[n.type]||n.type)+(isStart?' · 起点':'');
  g.append(makeSvg('text',{x:12,y:41,class:'sub'},sub));
  if(!chapter&&h>65)g.append(makeSvg('text',{x:12,y:61,class:'sub'},short(title(n),Math.floor(w/13))));
  g.addEventListener('click',e=>{e.stopPropagation();chapter?selectChapter(id):selectNode(id);});
  $('viewport').append(g);positions.set(id,{x,y,w,h});
}
function drawEdge(edge,from,to,aggregate=false) {
  const a=positions.get(from),b=positions.get(to);if(!a||!b)return;
  const same=from===to;
  const x1=a.x+a.w/2,y1=a.y+a.h,x2=b.x+b.w/2,y2=b.y;
  let d;
  if(same)d=`M ${a.x+a.w} ${a.y+20} C ${a.x+a.w+65} ${a.y-30},${a.x+a.w+65} ${a.y+a.h+40},${a.x+a.w} ${a.y+a.h-10}`;
  else if(Math.abs(x2-x1)>100)d=`M ${a.x+(x2>x1?a.w:0)} ${a.y+a.h/2} C ${(x1+x2)/2} ${a.y+a.h/2},${(x1+x2)/2} ${b.y+b.h/2},${b.x+(x2>x1?0:b.w)} ${b.y+b.h/2}`;
  else d=`M ${x1} ${y1} C ${x1+40} ${(y1+y2)/2},${x2+40} ${(y1+y2)/2},${x2} ${y2}`;
  const path=makeSvg('path',{d,class:'edge '+(edge.kind||''),'marker-end':'url(#arrow)'});
  const hit=makeSvg('path',{d,class:'edge-hit'});
  const clicked=e=>{e.stopPropagation();selectedEdge=edge.id;$('detail').innerHTML='<small>有向连线</small><h2>'+escape(aggregate?'章节之间的跳转':'节点之间的跳转')+'</h2>'+(aggregate?edge.originals.map(edgeDetails).join(''):edgeDetails(edge));};
  path.addEventListener('click',clicked);hit.addEventListener('click',clicked);
  $('viewport').insertBefore(hit,$('viewport').firstChild);$('viewport').insertBefore(path,$('viewport').firstChild);
  if(mode==='focus')$('viewport').append(makeSvg('text',{x:(x1+x2)/2+8,y:(y1+y2)/2-7,class:'edge-label'},short(edge.kind==='branch'?condition(edge.when):edge.label||'继续',22)));
}
function render() {
  positions=new Map();$('viewport').replaceChildren();
  const layoutChapters=mode==='overview'||mode==='all';
  let drawn=[];
  if(layoutChapters) {
    const lanes=new Map();const cursors=new Map();
    for(const c of chapters){const prefix=c[0];if(!lanes.has(prefix))lanes.set(prefix,lanes.size);const x=lanes.get(prefix)*240+25,y=cursors.get(prefix)||40;
      if(mode==='overview'){card(c,null,x,y,210,60,true);cursors.set(prefix,y+95);}
      else{let yy=y;for(const n of groups.get(c)){card(n.id,n,x,yy,210,74);drawn.push(n.id);yy+=94;}cursors.set(prefix,yy+50);}
    }
    if(mode==='overview'){const pairs=new Map();for(const e of data.edges){const a=chapterId(e.from),b=chapterId(e.to);if(a===b)continue;const key=a+'>'+b;if(!pairs.has(key))pairs.set(key,{id:key,from:a,to:b,label:'章节跳转',originals:[]});pairs.get(key).originals.push(e);}for(const e of pairs.values())drawEdge(e,e.from,e.to,true);}
  } else if(mode==='chapter') {
    const ns=groups.get(filter)||[];const outer=[...new Set(data.edges.filter(e=>ns.some(n=>n.id===e.from||n.id===e.to)).flatMap(e=>[e.from,e.to]).filter(id=>chapterId(id)!==filter))];
    ns.forEach((n,i)=>{card(n.id,n,380,i*115+60,275,82);drawn.push(n.id);});
    outer.forEach((id,i)=>{card(id,nodes.get(id),i%2?760:25,Math.floor(i/2)*115+60,275,82);drawn.push(id);});
  } else {
    const n=nodes.get(selected);const ins=[...new Set(data.edges.filter(e=>e.to===selected).map(e=>e.from))].filter(id=>id!==selected),outs=[...new Set(data.edges.filter(e=>e.from===selected).map(e=>e.to))].filter(id=>id!==selected);
    const rows=Math.max(ins.length,outs.length,1);card(selected,n,400,rows*52+30,290,100);drawn.push(selected);
    ins.forEach((id,i)=>{card(id,nodes.get(id),25,i*120+35,290,82);drawn.push(id);});
    outs.forEach((id,i)=>{if(positions.has(id))return;card(id,nodes.get(id),780,i*120+35,290,82);drawn.push(id);});
  }
  if(mode!=='overview'){const visible=new Set(drawn);for(const e of data.edges)if(visible.has(e.from)&&visible.has(e.to))drawEdge(e,e.from,e.to);}
  bounds={w:Math.max(400,...[...positions.values()].map(p=>p.x+p.w))+55,h:Math.max(250,...[...positions.values()].map(p=>p.y+p.h))+70};
  $('mode-label').textContent={overview:'章节总览 · 每个卡片是一章，箭头是跨章跳转',all:'全部节点 · 可拖动或搜索定位',chapter:'本章节点及相邻章节入口',focus:'选中节点的一跳入边与出边'}[mode];
  for(const id of ['overview','all','focus'])$(id).classList.toggle('active',mode===id);
  refreshResults();fit();
}
function transform(){ $('viewport').setAttribute('transform',`translate(${view.x},${view.y}) scale(${view.k})`); }
function fit(){const box=$('canvas').getBoundingClientRect();view.k=Math.min(1.2,(box.width-35)/bounds.w,(box.height-75)/bounds.h);view.x=(box.width-bounds.w*view.k)/2;view.y=35;transform();}
function zoom(f,x,y){const box=$('canvas').getBoundingClientRect();x??=box.width/2;y??=box.height/2;const next=Math.min(3.5,Math.max(.07,view.k*f));view.x=x-(x-view.x)*next/view.k;view.y=y-(y-view.y)*next/view.k;view.k=next;transform();}
$('overview').onclick=()=>{filter='';$('chapter').value='';mode='overview';render();};
$('all').onclick=()=>{filter='';$('chapter').value='';mode='all';render();};
$('focus').onclick=()=>selectNode(selected);$('fit').onclick=fit;$('zoom-in').onclick=()=>zoom(1.25);$('zoom-out').onclick=()=>zoom(.8);
$('graph').addEventListener('wheel',e=>{e.preventDefault();const b=$('graph').getBoundingClientRect();zoom(e.deltaY<0?1.12:.89,e.clientX-b.left,e.clientY-b.top);},{passive:false});
let drag=null;$('graph').addEventListener('pointerdown',e=>{if(e.target.closest('.node,.edge-hit'))return;drag={x:e.clientX,y:e.clientY,vx:view.x,vy:view.y};$('graph').setPointerCapture(e.pointerId);});
$('graph').addEventListener('pointermove',e=>{if(!drag)return;view.x=drag.vx+e.clientX-drag.x;view.y=drag.vy+e.clientY-drag.y;transform();});
$('graph').addEventListener('pointerup',()=>drag=null);$('graph').addEventListener('pointercancel',()=>drag=null);
function renderAnalysis() {
  const panel = $('analysis-list');
  panel.replaceChildren();
  const summary = document.createElement('p');
  summary.textContent = `已声明边可达 ${analysis.reachable.length}/${data.nodes.length} 节点；${analysis.conditionalEdges} 条条件连线。`;
  panel.append(summary);
  for (const [label, ids] of [
    ['未在声明边中可达', analysis.unreachable], ['可达性无法静态判断', analysis.unknownReachability],
    ['无已声明入边（非起点）', analysis.orphan], ['非结局静态死路', analysis.deadEnds],
    ['无静态结局路径', analysis.cannotReachEnd], ['结局路径无法判断', analysis.unknownEnd],
    ['含动态扩展或宿主模块', analysis.dynamicNodes]
  ]) {
    if (!ids.length) continue;
    const group = document.createElement('details'), title = document.createElement('summary');
    title.textContent = `${label} (${ids.length})`; group.append(title);
    for (const id of ids) {
      const button = document.createElement('button'); button.className = 'link'; button.textContent = id;
      button.onclick = () => selectNode(id); group.append(button);
    }
    panel.append(group);
  }
}
function showTrace() {
  if (!evidence) return;
  const entry = evidence.trace[traceIndex];
  $('trace-position').textContent = `${traceIndex + 1}/${evidence.trace.length} · ${entry.nodeId} · ${entry.awaiting}`;
  $('trace-state').textContent = JSON.stringify(entry, null, 2);
  $('trace-prev').disabled = traceIndex === 0;
  $('trace-next').disabled = traceIndex + 1 === evidence.trace.length;
  selectNode(entry.nodeId);
}
function installEvidence(value, label) {
  const checked = validateEvidence(value, data);
  evidence = checked; traceIndex = 0;
  visited = new Map(checked.visited.map(item => [item.id, item.count]));
  $('evidence-review').hidden = false; $('clear-evidence').disabled = false;
  $('evidence-summary').textContent = `${label} · 结局 ${checked.ending} · ${visited.size} 个已访问节点 · 种子 ${checked.seed}`;
  $('evidence-state').textContent = JSON.stringify(checked.snapshot.state, null, 2);
  $('evidence-status').textContent = '已导入匹配版本的路线记录；仅高亮 visits 节点，不标记未记录的边。';
  showTrace();
}
let evidenceImportSequence = 0;
$('evidence-file').addEventListener('change', async event => {
  const file = event.target.files?.[0], sequence = ++evidenceImportSequence;
  if (!file) return;
  try {
    if (file.size > 10 * 1024 * 1024) throw Error('路线文件超过 10 MiB');
    const value = JSON.parse(await file.text());
    if (sequence !== evidenceImportSequence) return;
    installEvidence(value, file.name);
  } catch (error) {
    if (sequence === evidenceImportSequence) $('evidence-status').textContent = '导入失败：'+error.message+'；保留原有审核记录。';
  }
  if (sequence === evidenceImportSequence) event.target.value = '';
});
$('clear-evidence').onclick = () => {
  evidenceImportSequence++; evidence = null; visited = new Map(); traceIndex = 0;
  $('evidence-review').hidden = true; $('clear-evidence').disabled = true;
  $('evidence-file').value = ''; $('evidence-status').textContent = '已清除路线记录。';
  $('trace-state').textContent = ''; $('evidence-state').textContent = ''; $('evidence-summary').textContent = ''; $('trace-position').textContent = '';
  detailNode(selected); render();
};
$('trace-prev').onclick = () => { if (evidence && traceIndex > 0) { traceIndex--; showTrace(); } };
$('trace-next').onclick = () => { if (evidence && traceIndex+1 < evidence.trace.length) { traceIndex++; showTrace(); } };
window.addEventListener('resize',fit); renderAnalysis(); render();
if (data.evidence) { try { installEvidence(data.evidence, '构建时导入'); } catch (error) { $('evidence-status').textContent = '内置证据无效：'+error.message; } }
