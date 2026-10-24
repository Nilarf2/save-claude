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
// 只走 A 线（不回头 HUB），精确枚举到 B11_judge
const results = [];
function walk(id, vars, tags, depth) {
  if (depth > 300) return;
  const n = byId.get(id);
  if (!n) return;
  switch (n.type) {
    case 'end': return;
    case 'scene': return walk(n.next, vars, tags, depth+1);
    case 'dialogue': return walk(n.next, vars, tags, depth+1);
    case 'action': { const v={...vars}, t=new Set(tags); apply(n.actions,v,t); return walk(n.next,v,t,depth+1); }
    case 'choice': {
      for (const o of n.options) {
        const v={...vars}, t=new Set(tags); apply(o.actions,v,t);
        walk(o.next,v,t,depth+1);
      }
      return;
    }
    case 'branch': {
      if (id.startsWith('B11_judge')) { results.push({vars:{...vars}, tags:[...tags]}); return; }
      for (const b of n.branches) walk(b.next, vars, tags, depth+1);
      walk(n.fallback, vars, tags, depth+1);
      return;
    }
  }
}
// 从 A00 起（跳过 HUB 循环）
walk('A00:scene', init, [], 0);

console.log('A 线到达 B11_judge 的状态数:', results.length);
const V = Object.keys(story.variables);
for (const k of V) {
  const a = results.map(r => r.vars[k] ?? 0);
  console.log('  ', k.padEnd(13), 'min=' + String(Math.min(...a)).padStart(4), 'max=' + String(Math.max(...a)).padStart(4));
}
const cnt = f => results.filter(f).length;
console.log('   ate_rice ', cnt(r=>r.tags.includes('ate_rice')), '/', results.length);
console.log('   promise  ', cnt(r=>r.tags.includes('promise')), '/', results.length);
console.log('   三钥匙   ', cnt(r=>['key_godfather','key_station','key_father'].every(k=>r.tags.includes(k))), '/', results.length);

const b = byId.get('B11_judge:s0:b');
function evalC(c,vars,tags){
  if(!c)return true;
  switch(c.op){
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

const hit = {};
for (const r of results) {
  let t = b.fallback;
  for (const br of b.branches) if (evalC(br.when, r.vars, r.tags)) { t = br.next; break; }
  hit[t] = (hit[t]||0)+1;
}
console.log('\nB11 各结局命中:');
for (const [k,v] of Object.entries(hit)) console.log('   ', k, '×', v);
