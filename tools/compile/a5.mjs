import { readFile } from 'node:fs/promises';
import { compileStory } from '../../engine/packages/content/dist/index.js';
import { createSession } from '../../engine/packages/core/dist/index.js';

const story = JSON.parse(await readFile('web/story.json', 'utf8'));
const compiled = compileStory(story);
const byId = new Map(story.nodes.map(n => [n.id, n]));

// 枚举 A 线所有到 B11_judge 的完整路径（含变量），找出最小 humanity / 最大 contamination
const paths = [];
let guard = 0;
function apply(actions, v, t) {
  for (const a of actions || []) {
    if (a.type === 'add') v[a.variable] = (v[a.variable] ?? 0) + a.value;
    else if (a.type === 'tag.add') t.add(a.tag);
    else if (a.type === 'tag.remove') t.delete(a.tag);
  }
}
function walk(id, vars, tags, depth, trail) {
  if (depth > 200 || guard++ > 500000) return;
  const n = byId.get(id);
  if (!n || n.type === 'end') return;
  if (n.type === 'scene' || n.type === 'dialogue') return walk(n.next, vars, tags, depth+1, trail);
  if (n.type === 'action') { const v={...vars}, t=new Set(tags); apply(n.actions,v,t); return walk(n.next,v,t,depth+1,trail); }
  if (n.type === 'choice') {
    n.options.forEach((o, i) => {
      const v={...vars}, t=new Set(tags); apply(o.actions,v,t);
      walk(o.next, v, t, depth+1, trail.concat([n.id + '#' + o.id]));
    });
    return;
  }
  if (n.type === 'branch') {
    if (id.startsWith('B11_judge')) { paths.push({vars:{...vars}, tags:[...tags], trail}); return; }
    for (const b of n.branches) walk(b.next, vars, tags, depth+1, trail);
    return walk(n.fallback, vars, tags, depth+1, trail);
  }
}
walk('A00:scene', Object.fromEntries(Object.entries(story.variables).map(([k,v])=>[k,v.default])), [], 0, []);

console.log('完整路径数:', paths.length);
paths.sort((a,b)=>a.vars.humanity-b.vars.humanity);
console.log('\n人性最低的 3 条:');
for (const p of paths.slice(0,3)) console.log('  humanity=' + p.vars.humanity, 'contamination=' + p.vars.contamination, 'tags=' + p.tags.join(','));
paths.sort((a,b)=>b.vars.contamination-a.vars.contamination);
console.log('\n污染最高的 3 条:');
for (const p of paths.slice(0,3)) console.log('  contamination=' + p.vars.contamination, 'humanity=' + p.vars.humanity);
