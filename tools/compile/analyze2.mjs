import { readFile } from 'node:fs/promises';
const story = JSON.parse(await readFile('web/story.json', 'utf8'));
const byId = new Map(story.nodes.map(n => [n.id, n]));
const init = {};
for (const [k, v] of Object.entries(story.variables)) init[k] = v.default;

const results = [];
let visits = 0;
const MAX_VISITS = 3000000;

// 限制回到 HUB 的次数，避免无限环
function walk(id, vars, tags, depth, hubLoops) {
  if (visits++ > MAX_VISITS || depth > 400) return;
  const node = byId.get(id);
  if (!node) return;
  if (id === 'HUB:scene') { if (hubLoops >= 2) return; hubLoops++; }

  switch (node.type) {
    case 'end': return;
    case 'scene': return walk(node.next, vars, tags, depth + 1, hubLoops);
    case 'dialogue': return walk(node.next, vars, tags, depth + 1, hubLoops);
    case 'action': {
      const v = { ...vars }, t = new Set(tags);
      apply(node.actions, v, t);
      return walk(node.next, v, t, depth + 1, hubLoops);
    }
    case 'choice': {
      for (const o of node.options) {
        const v = { ...vars }, t = new Set(tags);
        apply(o.actions, v, t);
        walk(o.next, v, t, depth + 1, hubLoops);
      }
      return;
    }
    case 'branch': {
      if (id.startsWith('B11_judge')) { results.push({ vars: { ...vars }, tags: [...tags], hubLoops }); return; }
      for (const b of node.branches) walk(b.next, vars, tags, depth + 1, hubLoops);
      walk(node.fallback, vars, tags, depth + 1, hubLoops);
      return;
    }
  }
}
function apply(actions, v, t) {
  for (const a of actions || []) {
    if (a.type === 'add') v[a.variable] = (v[a.variable] ?? 0) + a.value;
    else if (a.type === 'set') v[a.variable] = a.value;
    else if (a.type === 'tag.add') t.add(a.tag);
    else if (a.type === 'tag.remove') t.delete(a.tag);
  }
}
walk(story.start, init, [], 0, 0);

console.log('states reaching B11_judge:', results.length, '(visits=' + visits + ')');
const VARS = Object.keys(story.variables);
for (const k of VARS) {
  const arr = results.map(r => r.vars[k] ?? 0);
  console.log('  ', k.padEnd(13), 'min=' + String(Math.min(...arr)).padStart(4), 'max=' + String(Math.max(...arr)).padStart(4));
}
const cnt = (f) => results.filter(f).length;
console.log('   ate_rice      ', cnt(r => r.tags.includes('ate_rice')), '/', results.length);
console.log('   promise       ', cnt(r => r.tags.includes('promise')), '/', results.length);
console.log('   三钥匙        ', cnt(r => ['key_godfather','key_station','key_father'].every(k => r.tags.includes(k))), '/', results.length);

const rows = byId.get('B11_judge:s0:b') || [...byId.values()].find(n => n.type === 'branch' && n.id.startsWith('B11_judge'));
console.log('\nB11_judge 分支:');
for (const b of rows.branches) console.log('   ', JSON.stringify(b.when), '->', b.next);
console.log('    fallback ->', rows.fallback);

const hit = {};
for (const r of results) {
  let target = rows.fallback;
  for (const b of rows.branches) if (evalC(b.when, r.vars, r.tags)) { target = b.next; break; }
  hit[target] = (hit[target] || 0) + 1;
}
console.log('\n命中分布:');
for (const [k, v] of Object.entries(hit)) console.log('   ', k, '×', v);

function evalC(c, vars, tags) {
  if (!c) return true;
  switch (c.op) {
    case 'eq': return val(c.left, vars) === val(c.right, vars);
    case 'ne': return val(c.left, vars) !== val(c.right, vars);
    case 'gt': return val(c.left, vars) > val(c.right, vars);
    case 'gte': return val(c.left, vars) >= val(c.right, vars);
    case 'lt': return val(c.left, vars) < val(c.right, vars);
    case 'lte': return val(c.left, vars) <= val(c.right, vars);
    case 'and': return c.conditions.every(x => evalC(x, vars, tags));
    case 'or': return c.conditions.some(x => evalC(x, vars, tags));
    case 'not': return !evalC(c.condition, vars, tags);
    case 'tag': return tags.includes(c.tag);
    default: return false;
  }
}
function val(x, vars) {
  if (typeof x === 'number') return x;
  if (x && x.var) return vars[x.var] ?? 0;
  return 0;
}
