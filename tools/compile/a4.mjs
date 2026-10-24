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
const results = [];
let guard = 0;
function walk(id, vars, tags, depth) {
  if (depth > 300 || guard++ > 2000000) return;
  const n = byId.get(id);
  if (!n) return;
  if (n.type === 'end') return;
  if (n.type === 'scene' || n.type === 'dialogue') return walk(n.next, vars, tags, depth+1);
  if (n.type === 'action') { const v={...vars}, t=new Set(tags); apply(n.actions,v,t); return walk(n.next,v,t,depth+1); }
  if (n.type === 'choice') {
    for (const o of n.options) { const v={...vars}, t=new Set(tags); apply(o.actions,v,t); walk(o.next,v,t,depth+1); }
    return;
  }
  if (n.type === 'branch') {
    if (id.startsWith('B11_judge')) { results.push({vars:{...vars}, tags:[...tags]}); return; }
    for (const b of n.branches) walk(b.next, vars, tags, depth+1);
    return walk(n.fallback, vars, tags, depth+1);
  }
}
walk('A00:scene', init, [], 0);
console.log('A线 B11_judge 状态数:', results.length, 'guard=' + guard);
if (results.length) {
  for (const k of Object.keys(story.variables)) {
    const a = results.map(r => r.vars[k] ?? 0);
    console.log('  ', k.padEnd(13), 'min=' + String(Math.min(...a)).padStart(4), 'max=' + String(Math.max(...a)).padStart(4));
  }
  const c = f => results.filter(f).length;
  console.log('   ate_rice', c(r=>r.tags.includes('ate_rice')), '/', results.length);
  console.log('   promise ', c(r=>r.tags.includes('promise')), '/', results.length);
  const noRice = results.filter(r => !r.tags.includes('ate_rice'));
  console.log('   无 ate_rice 的状态数:', noRice.length, noRice.slice(0,3).map(r=>JSON.stringify(r.tags)));
}
