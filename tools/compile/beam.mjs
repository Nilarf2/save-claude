import { readFile } from 'node:fs/promises';
const story = JSON.parse(await readFile('web/story.json', 'utf8'));
const byId = new Map(story.nodes.map(n => [n.id, n]));
const init = {};
for (const [k, v] of Object.entries(story.variables)) init[k] = v.default;

function apply(actions, v, t) {
  for (const a of actions || []) {
    if (a.type === 'add') v[a.variable] = (v[a.variable] ?? 0) + a.value;
    else if (a.type === 'set') v[a.variable] = a.value;
    else if (a.type === 'tag.add') t.add(a.tag);
    else if (a.type === 'tag.remove') t.delete(a.tag);
  }
}
function evalC(c, vars, tags) {
  if (!c) return true;
  switch (c.op) {
    case 'eq': return val(c.left,vars)===val(c.right,vars);
    case 'ne': return val(c.left,vars)!==val(c.right,vars);
    case 'gt': return val(c.left,vars)>val(c.right,vars);
    case 'gte': return val(c.left,vars)>=val(c.right,vars);
    case 'lt': return val(c.left,vars)<val(c.right,vars);
    case 'lte': return val(c.left,vars)<=val(c.right,vars);
    case 'and': return c.conditions.every(x=>evalC(x,vars,tags));
    case 'or': return c.conditions.some(x=>evalC(x,vars,tags));
    case 'not': return !evalC(c.condition,vars,tags);
    case 'tag': return tags.includes(c.tag);
    default: return false;
  }
}
function val(x,vars){ if(typeof x==='number')return x; if(x&&x.var)return vars[x.var]??0; return 0; }

// 从头跑到第一个交互点的推进器
function advance(s) {
  for (let i=0;i<20000;i++){
    const v=s.getView();
    if(v.awaiting==='continue'){ s.dispatch({type:'continue'}); continue; }
    return v;
  }
  return s.getView();
}

const { compileStory, createSession } = await import('@general-engine/engine/narrative');
const compiled = compileStory(story);

const endingsFound = new Map();
const best = new Map(); // nodeId|choiceIdx -> snapshot

// Beam: 保留 score 最高的若干 snapshots
function score(v, snap, target) {
  const st = snap.state;
  if (target === '404') return (st.variables.contamination ?? 0) * 10 - (st.tags.includes('ate_rice') ? 500 : 0);
  if (target === 'keys') {
    const k = ['key_godfather','key_station','key_father'].filter(x=>st.tags.includes(x)).length;
    return k * 1000 + (st.variables.humanity??0);
  }
  return 0;
}

function beamSearch(target, width = 60, maxDepth = 400) {
  let beam = [];
  {
    const s = createSession(compiled, { seed: 42 });
    s.start();
    const v = advance(s);
    beam.push({ snap: s.snapshot(), v });
  }
  const found = [];
  for (let d = 0; d < maxDepth && beam.length; d++) {
    const next = [];
    for (const item of beam) {
      const s = createSession(compiled, { seed: 42 });
      s.restore(item.snap);
      const v = s.getView();
      if (v.awaiting === 'ended') { found.push(v.ending?.id); continue; }
      if (v.awaiting === 'choice') {
        for (const o of v.choices.filter(c=>!c.disabled)) {
          const s2 = createSession(compiled, { seed: 42 });
          s2.restore(item.snap);
          s2.dispatch({ type:'choose', optionId:o.id });
          const vm = advance(s2);
          if (vm.awaiting === 'ended') { found.push(vm.ending?.id); continue; }
          next.push({ snap: s2.snapshot(), v: vm });
        }
        continue;
      }
      // continue 型
      const s2 = createSession(compiled, { seed: 42 });
      s2.restore(item.snap);
      s2.dispatch({ type:'continue' });
      const vm = advance(s2);
      if (vm.awaiting === 'ended') { found.push(vm.ending?.id); continue; }
      next.push({ snap: s2.snapshot(), v: vm });
    }
    // 去重 + 排序
    const seen = new Set(); const uniq = [];
    for (const it of next) {
      const st = it.snap.state;
      const k = JSON.stringify([st.nodeId, st.lineIndex, st.variables, st.tags.slice().sort()]);
      if (seen.has(k)) continue; seen.add(k); uniq.push(it);
    }
    uniq.sort((a,b)=>score(b.v,b.snap,target)-score(a.v,a.snap,target));
    beam = uniq.slice(0, width);
  }
  return found;
}

for (const [label, target] of [['404/容器', '404'], ['三钥匙', 'keys']]) {
  const f = beamSearch(target);
  const u = [...new Set(f)];
  console.log(label, '-> endings hit:', u.length ? u.join(', ') : '(none)');
}
