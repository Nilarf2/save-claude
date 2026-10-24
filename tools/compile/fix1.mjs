import { readFile } from 'node:fs/promises';
const story = JSON.parse(await readFile('web/story.json', 'utf8'));
const byId = new Map(story.nodes.map(n => [n.id, n]));
const init = Object.fromEntries(Object.entries(story.variables).map(([k,v])=>[k,v.default]));

function apply(actions, v, t) {
  for (const a of actions || []) {
    if (a.type === 'add') v[a.variable] = (v[a.variable] ?? 0) + a.value;
    else if (a.type === 'set') v[a.variable] = a.value;
    else if (a.type === 'tag.add') t.add(a.tag);
    else if (a.type === 'tag.remove') t.delete(a.tag);
  }
}
// 只走真实条件分支（不是全走），枚举到 B11_judge
function evalC(c, vars, tagsIn) {
  const tags = Array.isArray(tagsIn) ? tagsIn : [...tagsIn];
  if (!c) return true;
  switch (c.op) {
    case 'gte': return val(c.left,vars)>=val(c.right,vars);
    case 'gt': return val(c.left,vars)>val(c.right,vars);
    case 'lte': return val(c.left,vars)<=val(c.right,vars);
    case 'lt': return val(c.left,vars)<val(c.right,vars);
    case 'eq': return val(c.left,vars)===val(c.right,vars);
    case 'ne': return val(c.left,vars)!==val(c.right,vars);
    case 'and': return c.conditions.every(x=>evalC(x,vars,tags));
    case 'or': return c.conditions.some(x=>evalC(x,vars,tags));
    case 'not': return !evalC(c.condition,vars,tags);
    case 'tag': return tags.includes(c.tag);
    default: return false;
  }
}
function val(x,v){ if(typeof x==='number')return x; if(x&&x.var)return v[x.var]??0; return 0; }

const states = [];
const seen = new Set();
let guard = 0;
const HUB_CAP = 5;

function walk(id, vars, tags, hub, depth) {
  if (depth > 400 || guard++ > 900000) return;
  const n = byId.get(id);
  if (!n) return;
  if (id === 'HUB:scene') { if (hub >= HUB_CAP) return; hub++; }
  const key = id + '|' + Object.entries(vars).sort().map(e=>e.join('=')).join(',') + '|' + [...tags].sort().join(',') + '|' + hub;
  if (seen.has(key)) return;
  seen.add(key);

  switch (n.type) {
    case 'end': return;
    case 'scene': case 'dialogue': return walk(n.next, vars, tags, hub, depth+1);
    case 'action': { const v={...vars}, t=new Set(tags); apply(n.actions,v,t); return walk(n.next,v,t,hub,depth+1); }
    case 'choice': {
      for (const o of n.options) {
        if (o.when && !evalC(o.when, vars, tags)) continue;
        if (o.disabledWhen && evalC(o.disabledWhen, vars, tags)) continue;
        const v={...vars}, t=new Set(tags); apply(o.actions,v,t);
        walk(o.next,v,t,hub,depth+1);
      }
      return;
    }
    case 'branch': {
      if (id.startsWith('B11_judge')) { states.push({vars:{...vars}, tags:[...tags]}); return; }
      for (const b of n.branches) if (evalC(b.when, vars, tags)) return walk(b.next,vars,tags,hub,depth+1);
      return walk(n.fallback, vars, tags, hub, depth+1);
    }
  }
}
walk(story.start, init, [], 0, 0);

console.log('到达 B11_judge 的状态数:', states.length, ' guard=' + guard);
const stat = k => { const a = states.map(s=>s.vars[k]??0); return [Math.min(...a), Math.max(...a)]; };
for (const k of ['humanity','conformity','bond','contamination']) {
  const [lo,hi] = stat(k);
  console.log('  ', k.padEnd(14), lo, '..', hi);
}
const cnt = f => states.filter(f).length;
console.log('   ate_rice  ', cnt(s=>s.tags.includes('ate_rice')), '/', states.length);
console.log('   promise   ', cnt(s=>s.tags.includes('promise')), '/', states.length);
console.log('   三钥匙    ', cnt(s=>['key_godfather','key_station','key_father'].every(k=>s.tags.includes(k))), '/', states.length);

// 当前条件的命中分布
const b = byId.get('B11_judge:s1:b');
console.log('\n当前 B11_judge 命中:');
const hit = {};
for (const s of states) {
  let t = b.fallback;
  for (const br of b.branches) if (evalC(br.when, s.vars, s.tags)) { t = br.next; break; }
  hit[t] = (hit[t]||0)+1;
}
for (const [k,v] of Object.entries(hit)) console.log('   ', k, '×', v);

// 分布：污染 vs 人性
console.log('\n污染分布:');
const buckets = {};
for (const s of states) { const c = s.vars.contamination; const k = Math.floor(c/10)*10; buckets[k]=(buckets[k]||0)+1; }
for (const k of Object.keys(buckets).map(Number).sort((a,b)=>a-b)) console.log('   ' + String(k).padStart(3) + '-' + (k+9) + ':', buckets[k]);
console.log('\n人性分布:');
const hb = {};
for (const s of states) { const c = s.vars.humanity; const k = Math.floor(c/25)*25; hb[k]=(hb[k]||0)+1; }
for (const k of Object.keys(hb).map(Number).sort((a,b)=>a-b)) console.log('   ' + String(k).padStart(3) + '-' + (k+24) + ':', hb[k]);
